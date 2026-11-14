/** Check-in rows. */
import type { Checkin } from "@getfit/engine";
import type { Db } from "./db.js";

export function insertCheckin(db: Db, checkin: Checkin): number {
  const cur = db.prepare(
    "INSERT INTO checkins (kind, at, local_date, round_key, sleep, stress, fatigue, soreness, prs,"
      + " pain, pain_where, srpe, rir, stopper, per_muscle, readiness, note)"
      + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    checkin.kind, checkin.at, checkin.localDate, checkin.roundKey, checkin.sleep, checkin.stress,
    checkin.fatigue, checkin.soreness, checkin.prs, checkin.pain ? 1 : 0, checkin.painWhere,
    checkin.srpe, checkin.rir, checkin.stopper,
    checkin.perMuscle ? JSON.stringify(checkin.perMuscle) : null,
    checkin.readiness, checkin.note,
  );
  return Number(cur.lastInsertRowid);
}

export function setCheckinReadiness(db: Db, id: number, readiness: number): void {
  db.prepare("UPDATE checkins SET readiness = ? WHERE id = ?").run(readiness, id);
}
