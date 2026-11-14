/** Boot: open, migrate, init a fresh db if empty, listen, schedule, stop cleanly. */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { initFresh, migrate, openDatabase } from "@getfit/db";
import { createApp } from "./app.js";
import { loadConfig } from "./env.js";
import { Services } from "./service.js";

const config = loadConfig();
mkdirSync(dirname(config.dbPath), { recursive: true });

const db = openDatabase(config.dbPath);
const { added } = migrate(db);
initFresh(db, new Date());
const services = new Services(db);

const app = createApp(services, { requireToken: config.requireToken, webRoot: config.webRoot });
const server = app.listen(config.port, config.host, () => {
  console.log(`[getfit] ${config.dbPath} on http://${config.host}:${config.port}`);
  if (added.length) console.log(`[getfit] migrated: ${added.join(", ")}`);
});

// One writer, one clock. 5 s so `seconds_left` is honest; every mutation is
// idempotent, so a slow tick cannot double-open a round.
let timer: NodeJS.Timeout | null = null;
if (config.scheduler) {
  timer = setInterval(() => {
    try {
      const outcome = services.tick();
      if (outcome.message) console.log(`[getfit] ${outcome.message.replace(/\n/g, " · ")}`);
      if (outcome.expired) console.log(`[getfit] round ${outcome.expired.key} missed`);
    } catch (error) {
      console.error("[getfit] tick failed", error);
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
