import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { initFresh, migrate, openDatabase, type Db } from "@getfit/db";
import { createApp } from "../src/app.js";
import { Services } from "../src/service.js";

const NOW = new Date("2026-11-14T08:00:00Z"); // 10:00 Bucharest, outside quiet hours

let dir: string;
let db: Db;
let server: Server;
let base: string;
let services: Services;

async function call(path: string, init: RequestInit = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body, headers: response.headers };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "getfit-api-"));
  db = openDatabase(join(dir, "test.db"));
  migrate(db);
  initFresh(db, NOW);
  db.prepare("UPDATE app_state SET next_set_at = ? WHERE id = 1")
    .run(NOW.toISOString().replace(/\.\d{3}Z$/, "Z"));
  services = new Services(db, () => NOW);
  const app = createApp(services);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the API over a real database", () => {
  let roundKey = "";

  it("health answers", async () => {
    const { status, body } = await call("/api/v1/health");
    expect(status).toBe(200);
    expect((body as { ok: boolean }).ok).toBe(true);
  });

  it("meta carries the taxonomy and the library", async () => {
    const { status, body } = await call("/api/v1/meta");
    expect(status).toBe(200);
    const meta = body as { muscles: unknown[]; library: unknown[] };
    expect(meta.muscles).toHaveLength(22);
    expect(meta.library).toHaveLength(29);
  });

  it("confirming a round that does not exist is a 409, not a 500", async () => {
    const { status, body } = await call("/api/v1/rounds/deadbeef0000/confirm", {
      method: "POST", body: JSON.stringify({ source: "web" }),
    });
    expect(status).toBe(409);
    expect((body as { code: string }).code).toBe("round_not_open");
  });

  it("a tick opens a round and the dashboard reports it", async () => {
    const outcome = services.tick();
    expect(outcome.opened).not.toBeNull();
    roundKey = String(outcome.opened?.key);
    expect(outcome.opened?.items.length).toBeGreaterThan(0);

    const { status, body } = await call("/api/v1/dashboard");
    expect(status).toBe(200);
    const dash = body as { roundOpen: boolean; nextSet: unknown; lifetime: { totalReps: number } };
    expect(dash.roundOpen).toBe(true);
    expect(dash.nextSet).toBeNull();
    expect(dash.lifetime.totalReps).toBe(0);
  });

  it("the dashboard sends an ETag and honours If-None-Match", async () => {
    const first = await call("/api/v1/dashboard");
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const second = await call("/api/v1/dashboard", { headers: { "if-none-match": String(etag) } });
    expect(second.status).toBe(304);
  });

  it("confirm logs the round, and the same key again is a 409", async () => {
    const { status, body } = await call(`/api/v1/rounds/${roundKey}/confirm`, {
      method: "POST", body: JSON.stringify({ source: "android" }),
    });
    expect(status).toBe(200);
    const confirmed = body as { status: string; receipt: string; clock: { bonus: number } };
    expect(confirmed.status).toBe("done");
    expect(confirmed.receipt).toContain("Logged:");
    expect(confirmed.clock.bonus).toBe(0);

    const again = await call(`/api/v1/rounds/${roundKey}/confirm`, {
      method: "POST", body: JSON.stringify({ source: "android" }),
    });
    expect(again.status).toBe(409);
    expect((again.body as { code: string }).code).toBe("round_already_resolved");

    const row = db.prepare("SELECT status, resolved_at, source FROM rounds WHERE round_key = ?")
      .get(roundKey) as { status: string; resolved_at: string; source: string };
    expect(row.status).toBe("done");
    expect(row.source).toBe("android");
    const events = db.prepare("SELECT COUNT(*) c FROM wear_events WHERE round_key = ?")
      .get(roundKey) as { c: number };
    expect(events.c).toBeGreaterThan(0);
  });

  it("the post-set questionnaire is due inside the window, once", async () => {
    const todo = await call("/api/v1/checkins/todo");
    const body = todo.body as { due: string; round: { roundKey: string } | null };
    expect(body.due).toBe("post");
    expect(body.round?.roundKey).toBe(roundKey);

    const answer = await call("/api/v1/checkins", {
      method: "POST",
      body: JSON.stringify({ kind: "post", roundKey, rir: 2, muscleSoreness: { chest: 3 } }),
    });
    expect(answer.status).toBe(201);

    const repeat = await call("/api/v1/checkins", {
      method: "POST",
      body: JSON.stringify({ kind: "post", roundKey, rir: 2, muscleSoreness: { chest: 3 } }),
    });
    expect(repeat.status).toBe(409);
    expect((repeat.body as { code: string }).code).toBe("checkin_already_answered");
  });

  it("an invented muscle for that round is refused", async () => {
    // open a fresh round so a window exists again: the clock has to say "due"
    db.prepare("UPDATE app_state SET next_set_at = ? WHERE id = 1")
      .run(NOW.toISOString().replace(/\.\d{3}Z$/, "Z"));
    const outcome = services.tick();
    const key = String(outcome.opened?.key);
    services.confirm(key, "test");
    const { status, body } = await call("/api/v1/checkins", {
      method: "POST", body: JSON.stringify({ kind: "post", roundKey: key, muscleSoreness: { neck: 4 } }),
    });
    expect(status).toBe(400);
    expect((body as { code: string }).code).toBe("checkin_refused");
  });

  it("a gate answer moves readiness and is stored", async () => {
    const { status, body } = await call("/api/v1/checkins", {
      method: "POST",
      body: JSON.stringify({ kind: "gate", sleep: 5, stress: 5, fatigue: 5, soreness: 5, prs: 1 }),
    });
    expect(status).toBe(201);
    const readiness = (body as { readiness: number }).readiness;
    expect(readiness).toBeLessThan(0.2);
    const row = db.prepare("SELECT COUNT(*) c FROM checkins WHERE kind = 'gate'").get() as { c: number };
    expect(row.c).toBe(1);
  });

  it("settings round-trip and retire an exercise", async () => {
    const before = (await call("/api/v1/settings")).body as {
      intervalMinutes: number; exercises: { id: string; name: string; min: number; max: number | null }[];
    };
    expect(before.exercises).toHaveLength(2);

    const { status } = await call("/api/v1/settings", {
      method: "PUT",
      body: JSON.stringify({
        timezone: "Europe/Bucharest",
        intervalMinutes: 60,
        responseMinutes: 10,
        quietStart: "00:00",
        quietEnd: "07:00",
        exercises: [before.exercises[0]],
      }),
    });
    expect(status).toBe(200);

    const after = (await call("/api/v1/settings")).body as {
      intervalMinutes: number; exercises: { id: string }[];
    };
    expect(after.intervalMinutes).toBe(60);
    expect(after.exercises).toHaveLength(1);
    expect(after.exercises[0]?.id).toBe("pushups");
    const retired = db.prepare("SELECT active FROM exercises WHERE slug = 'squats'").get() as { active: number };
    expect(retired.active).toBe(0);
  });

  it("every read endpoint answers", async () => {
    for (const path of [
      "/api/v1/now", "/api/v1/muscles", "/api/v1/profile", "/api/v1/calendar",
      "/api/v1/rounds", "/api/v1/checkins/todo",
    ]) {
      const { status } = await call(path);
      expect(status, path).toBe(200);
    }
    const missing = await call("/api/v1/nope");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toContain("application/problem+json");
  });
});
