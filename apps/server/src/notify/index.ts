/** Delivery adapters. The scheduler publishes events; these send them.
 *
 * Telegram is temporary (the bot goes away when the native app ships), but it
 * is the only channel the house actually uses today, so it is the first one.
 */
import type { Db } from "@getfit/db";

export interface DeliveryResult {
  ok: boolean;
  detail?: string;
}

export interface Notifier {
  readonly id: string;
  readonly target: string;
  send(text: string, meta: Record<string, string>): Promise<DeliveryResult>;
}

export function telegramNotifier(
  botToken: string,
  chatId: string,
  fetchImpl: typeof fetch = fetch,
): Notifier {
  return {
    id: "telegram",
    target: chatId,
    async send(text) {
      try {
        const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            disable_web_page_preview: true,
            disable_notification: false,
          }),
        });
        if (!response.ok) {
          const body = await response.text();
          return { ok: false, detail: `${response.status} ${body.slice(0, 200)}` };
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

/** A notifier that only writes to the journal — the default in dev and tests. */
export function consoleNotifier(log: (line: string) => void = console.log): Notifier {
  return {
    id: "console",
    target: "stdout",
    async send(text) {
      log(`[notify] ${text.replace(/\n/g, " · ")}`);
      return { ok: true };
    },
  };
}

export function logDelivery(
  db: Db,
  now: Date,
  entry: { kind: string; event: string; target: string; status: string; detail?: string | null },
): void {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  try {
    db.prepare(
      "INSERT INTO notification_log (kind, event, target, status, attempts, detail, at)"
        + " VALUES (?, ?, ?, ?, 1, ?, ?)",
    ).run(entry.kind, entry.event, entry.target, entry.status, entry.detail ?? null, stamp);
  } catch {
    // a delivery log must never take the scheduler down
  }
}
