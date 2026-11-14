/** Rounds and the interval clock. */
import type { Round, RoundStatus, Snapshot } from "@getfit/engine";
import type { Db } from "./db.js";

export function insertRound(db: Db, round: Round): number {
  const cur = db.prepare(
    "INSERT INTO rounds (round_key, sent_at, sent_local_date, deadline_at, status, bonus_applied, target_reps)"
      + " VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(round.key, round.sentAt, round.sentLocalDate, round.deadlineAt, round.status,
    round.bonusApplied, round.targetReps);
  const id = Number(cur.lastInsertRowid);
  const item = db.prepare(
    "INSERT INTO round_items (round_id, exercise_slug, exercise_name, reps) VALUES (?, ?, ?, ?)",
  );
  for (const i of round.items) item.run(id, i.exerciseSlug, i.exerciseName, i.reps);
  return id;
}

export function resolveRound(
  db: Db, key: string, status: RoundStatus, resolvedAt: string, source: string | null,
): void {
  db.prepare("UPDATE rounds SET status = ?, resolved_at = ?, source = ? WHERE round_key = ?")
    .run(status, resolvedAt, source, key);
}

export function saveClock(db: Db, clock: Snapshot["clock"]): void {
  db.prepare("UPDATE app_state SET bonus = ?, next_set_at = ? WHERE id = 1")
    .run(clock.bonus, clock.nextSetAt);
}
