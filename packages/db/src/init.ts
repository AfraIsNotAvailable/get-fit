/** What a brand-new database needs: settings, the starter stack, the clock, seeds. */
import type { Db } from "./db.js";
import { seed } from "./muscles.js";

export const DEFAULT_SETTINGS = {
  timezone: "Europe/Bucharest",
  intervalMinutes: 90,
  responseMinutes: 10,
  quietStart: "00:00",
  quietEnd: "07:00",
};

const STARTER_STACK = [
  { slug: "pushups", name: "Push-ups", min: 10, max: 20 },
  { slug: "squats", name: "Squats", min: 5, max: null },
];

const stamp = (now: Date): string => now.toISOString().replace(/\.\d{3}Z$/, "Z");

export function initFresh(db: Db, now: Date): void {
  const s = DEFAULT_SETTINGS;
  if (!db.prepare("SELECT 1 FROM settings WHERE id = 1").get()) {
    db.prepare(
      "INSERT INTO settings (id, timezone, interval_minutes, response_minutes, quiet_start, quiet_end)"
        + " VALUES (1, ?, ?, ?, ?, ?)",
    ).run(s.timezone, s.intervalMinutes, s.responseMinutes, s.quietStart, s.quietEnd);
    STARTER_STACK.forEach((ex, position) => {
      db.prepare(
        "INSERT INTO exercises (slug, name, min_reps, max_reps, position, active, created_at)"
          + " VALUES (?, ?, ?, ?, ?, 1, ?)",
      ).run(ex.slug, ex.name, ex.min, ex.max, position, stamp(now));
    });
  }
  if (!db.prepare("SELECT 1 FROM app_state WHERE id = 1").get()) {
    db.prepare("INSERT INTO app_state (id, bonus, next_set_at, created_at) VALUES (1, 0, ?, ?)")
      .run(stamp(now), stamp(now));
  }
  seed(db, now);
}
