import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initFresh, migrate, openDatabase } from "@getfit/db";
import { consoleNotifier, logDelivery, telegramNotifier } from "../src/notify/index.js";

describe("notifiers", () => {
  it("telegram posts sendMessage to the right chat", async () => {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const notifier = telegramNotifier("BOT_TOKEN", "-100123", fakeFetch);
    const result = await notifier.send("Time to lock in:\nPush-ups 10", { event: "round_opened" });

    expect(result.ok).toBe(true);
    expect(seen[0]?.url).toContain("/botBOT_TOKEN/sendMessage");
    expect(seen[0]?.body.chat_id).toBe("-100123");
    expect(seen[0]?.body.text).toContain("Push-ups 10");
  });

  it("a failing api is reported, not thrown", async () => {
    const fakeFetch = (async () =>
      new Response("Bad Request: chat not found", { status: 400 })) as unknown as typeof fetch;
    const result = await telegramNotifier("T", "1", fakeFetch).send("x", {});
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("400");
  });

  it("the console notifier never fails", async () => {
    const lines: string[] = [];
    const result = await consoleNotifier((line) => lines.push(line)).send("hi\nthere", {});
    expect(result.ok).toBe(true);
    expect(lines[0]).toContain("hi · there");
  });

  it("delivery is logged so 'did it send?' is answerable", () => {
    const dir = mkdtempSync(join(tmpdir(), "getfit-notify-"));
    const db = openDatabase(join(dir, "t.db"));
    migrate(db);
    initFresh(db, new Date("2026-11-14T08:00:00Z"));
    logDelivery(db, new Date("2026-11-14T08:00:00Z"), {
      kind: "telegram", event: "round_opened", target: "-100123", status: "sent",
    });
    const row = db.prepare("SELECT kind, event, status FROM notification_log").get() as
      { kind: string; event: string; status: string };
    expect(row).toEqual({ kind: "telegram", event: "round_opened", status: "sent" });
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
