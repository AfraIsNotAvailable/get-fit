import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { initFresh, migrate, openDatabase, type Db } from "@getfit/db";
import { createApp } from "../src/app.js";
import { AuthService } from "../src/auth.js";
import { Services } from "../src/service.js";

const NOW = new Date("2026-11-14T08:00:00Z");
let dir: string;
let db: Db;
let server: Server;
let base: string;
let auth: AuthService;

async function call(path: string, init: RequestInit = {}, token?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${base}${path}`, {
    ...init, headers: { ...headers, ...(init.headers as Record<string, string> ?? {}) },
  });
  const text = await response.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "getfit-auth-"));
  db = openDatabase(join(dir, "test.db"));
  migrate(db);
  initFresh(db, NOW);
  auth = new AuthService(db, () => NOW);
  const app = createApp(new Services(db, () => NOW), auth, { requireToken: true });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("auth", () => {
  it("the public surface stays reachable without a token", async () => {
    expect((await call("/api/v1/health")).status).toBe(200);
    expect((await call("/api/v1/meta")).status).toBe(200);
  });

  it("everything else is a 401 without one", async () => {
    for (const path of ["/api/v1/dashboard", "/api/v1/settings", "/api/v1/muscles", "/api/v1/checkins/todo"]) {
      const { status, body } = await call(path);
      expect(status, path).toBe(401);
      expect((body as { code: string }).code).toBe("unauthorized");
    }
    const garbage = await call("/api/v1/dashboard", {}, "gf_not-a-real-token");
    expect(garbage.status).toBe(401);
  });

  it("a pairing code is single use and mints a working token", async () => {
    const { code } = auth.codeForCli("Pixel 9", "android", 300);
    const paired = await call("/api/v1/auth/pair", {
      method: "POST",
      body: JSON.stringify({ code, deviceName: "Pixel 9", platform: "android" }),
    });
    expect(paired.status).toBe(201);
    const token = (paired.body as { token: string }).token;
    expect(token.startsWith("gf_")).toBe(true);

    expect((await call("/api/v1/dashboard", {}, token)).status).toBe(200);
    const me = await call("/api/v1/auth/me", {}, token);
    expect((me.body as { name: string }).name).toBe("Pixel 9");
    expect((me.body as { platform: string }).platform).toBe("android");

    const replay = await call("/api/v1/auth/pair", {
      method: "POST",
      body: JSON.stringify({ code, deviceName: "thief", platform: "android" }),
    });
    expect(replay.status).toBe(401);
  });

  it("a bad or expired code does not create a token", async () => {
    const before = db.prepare("SELECT COUNT(*) c FROM api_tokens").get() as { c: number };
    const { status } = await call("/api/v1/auth/pair", {
      method: "POST", body: JSON.stringify({ code: "00000000", deviceName: "x", platform: "android" }),
    });
    expect(status).toBe(401);
    const after = db.prepare("SELECT COUNT(*) c FROM api_tokens").get() as { c: number };
    expect(after.c).toBe(before.c);

    const codes = auth.list();
    expect(codes.length).toBeGreaterThan(0);
  });

  it("only the hash is stored", async () => {
    const { code } = auth.codeForCli("Hashed", "cli", 60);
    const paired = await call("/api/v1/auth/pair", {
      method: "POST", body: JSON.stringify({ code, deviceName: "Hashed", platform: "cli" }),
    });
    const token = (paired.body as { token: string }).token;
    const row = db.prepare("SELECT token_hash FROM api_tokens WHERE name = 'Hashed'").get() as { token_hash: string };
    expect(row.token_hash).not.toBe(token);
    expect(row.token_hash).toMatch(/^[a-f0-9]{64}$/);
    const leaked = db.prepare("SELECT COUNT(*) c FROM api_tokens WHERE token_hash = ?").get(token) as { c: number };
    expect(leaked.c).toBe(0);
  });

  it("revoking a device kills its token", async () => {
    const issued = auth.issueForCli("Lost phone", "android");
    expect((await call("/api/v1/dashboard", {}, issued.token)).status).toBe(200);
    const revoked = await call("/api/v1/auth/me", { method: "DELETE" }, issued.token);
    expect(revoked.status).toBe(204);
    expect((await call("/api/v1/dashboard", {}, issued.token)).status).toBe(401);
  });

  it("validation happens before the database, with field paths", async () => {
    const issued = auth.issueForCli("Validator", "cli");
    const { status, body } = await call("/api/v1/settings", {
      method: "PUT",
      body: JSON.stringify({ timezone: "Europe/Bucharest", intervalMinutes: 0, responseMinutes: 10,
        quietStart: "00:00", quietEnd: "07:00", exercises: [{ name: "Push-ups", min: 10 }] }),
    }, issued.token);
    expect(status).toBe(422);
    const problem = body as { code: string; errors: { path: string }[] };
    expect(problem.code).toBe("validation_failed");
    expect(problem.errors.map((e) => e.path)).toContain("intervalMinutes");
    // and nothing was written
    const row = db.prepare("SELECT interval_minutes FROM settings WHERE id = 1").get() as { interval_minutes: number };
    expect(row.interval_minutes).toBe(90);
  });

  it("a malformed check-in is a 422, not a 500", async () => {
    const issued = auth.issueForCli("Badbody", "cli");
    const { status, body } = await call("/api/v1/checkins", {
      method: "POST", body: JSON.stringify({ kind: "post", rir: 2 }),
    }, issued.token);
    expect(status).toBe(422);
    expect((body as { errors: { path: string }[] }).errors[0]?.path).toContain("roundKey");
  });
});
