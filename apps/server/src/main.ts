/** Boot: open, migrate, init a fresh db if empty, listen, schedule, stop cleanly. */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { initFresh, migrate, openDatabase } from "@getfit/db";
import { createApp } from "./app.js";
import { AuthService } from "./auth.js";
import { loadConfig } from "./env.js";
import { consoleNotifier, logDelivery, telegramNotifier, type Notifier } from "./notify/index.js";
import { Services } from "./service.js";

const config = loadConfig();
mkdirSync(dirname(config.dbPath), { recursive: true });

const db = openDatabase(config.dbPath, { readOnly: config.readOnly });
let migrated: string[] = [];
if (!config.readOnly) {
  migrated = migrate(db).added;
  initFresh(db, new Date());
}

const services = new Services(db, () => new Date(), config.readOnly);
const auth = new AuthService(db, () => new Date(), config.readOnly);

const notifier: Notifier = config.telegramBotToken && config.telegramChatId
  ? telegramNotifier(config.telegramBotToken, config.telegramChatId)
  : consoleNotifier();

const app = createApp(services, auth, {
  requireToken: config.requireToken,
  webRoot: config.webRoot,
  schedulerEnabled: config.scheduler && !config.readOnly,
});
const server = app.listen(config.port, config.host, () => {
  console.log(`[getfit] ${config.dbPath} on http://${config.host}:${config.port}`
    + `${config.readOnly ? " (read-only)" : ""} · notifier ${notifier.id}`);
  if (migrated.length) console.log(`[getfit] migrated: ${migrated.join(", ")}`);
});

// One writer, one clock. 5 s so `seconds_left` is honest; every mutation is
// idempotent, so a slow tick cannot double-open a round.
let timer: NodeJS.Timeout | null = null;
if (config.scheduler && !config.readOnly) {
  timer = setInterval(() => {
    let outcome;
    try {
      outcome = services.tick();
    } catch (error) {
      console.error("[getfit] tick failed", error);
      return;
    }
    if (outcome.expired) console.log(`[getfit] round ${outcome.expired.key} missed`);
    if (outcome.message) {
      const text = outcome.message;
      void notifier.send(text, { event: "round_opened", round: outcome.opened?.key ?? "" })
        .then((result) => logDelivery(db, new Date(), {
          kind: notifier.id,
          event: "round_opened",
          target: notifier.target,
          status: result.ok ? "sent" : "failed",
          detail: result.detail ?? null,
        }))
        .catch((error) => console.error("[getfit] delivery failed", error));
    }
  }, 5000);
}

const stop = (signal: string) => {
  console.log(`[getfit] ${signal}; closing`);
  if (timer) clearInterval(timer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
