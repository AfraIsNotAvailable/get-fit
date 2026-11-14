/** Writes for muscle_state, exercise_muscles, wear_events, profile and history. */
import {
  BASE_K, FORM_URLS, LIBRARY, MUSCLES, PROFILE_PRIORS, resolveLibraryKey,
  type Attribution, type MuscleState, type WearEvent,
} from "@getfit/engine";
import type { Db } from "./db.js";
import type { ProfileHistoryEntry } from "@getfit/engine";

export function saveMuscles(db: Db, muscles: MuscleState[]): void {
  const stmt = db.prepare(
    "UPDATE muscle_state SET wear = ?, soreness = ?, stop_at = ?, resume_at = ?," +
      " rest_until = ?, last_loaded_at = ?, updated_at = ? WHERE muscle_slug = ?",
  );
  for (const m of muscles) {
    stmt.run(m.wear, m.soreness, m.stopAt, m.resumeAt, m.restUntil, m.lastLoadedAt, m.updatedAt, m.slug);
  }
}

export function saveAttribution(db: Db, pairs: Attribution[], now: Date): void {
  const stmt = db.prepare(
    "UPDATE exercise_muscles SET k = ?, exposure = ?, updated_at = ?"
      + " WHERE exercise_slug = ? AND muscle_slug = ?",
  );
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  for (const p of pairs) stmt.run(p.k, p.exposure, stamp, p.exerciseSlug, p.muscleSlug);
}

export function insertWearEvents(db: Db, events: WearEvent[]): void {
  const stmt = db.prepare(
    "INSERT INTO wear_events (round_key, exercise_slug, muscle_slug, reps, predicted, observed, at)"
      + " VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const e of events) {
    stmt.run(e.roundKey, e.exerciseSlug, e.muscleSlug, e.reps, e.predicted, e.observed, e.at);
  }
}

export function markObserved(db: Db, roundKey: string, muscleSlug: string, value: number): void {
  db.prepare("UPDATE wear_events SET observed = ? WHERE round_key = ? AND muscle_slug = ?")
    .run(value, roundKey, muscleSlug);
}

export function saveProfile(
  db: Db,
  profile: Record<string, number>,
  history: ProfileHistoryEntry[],
  now: Date,
  counts: Record<string, number> = {},
): void {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const upsert = db.prepare(
    "INSERT INTO profile (key, value, prior, n, updated_at) VALUES (?, ?, ?, ?, ?)"
      + " ON CONFLICT(key) DO UPDATE SET value = excluded.value, n = excluded.n,"
      + " updated_at = excluded.updated_at",
  );
  for (const [key, value] of Object.entries(profile)) {
    const prior = (PROFILE_PRIORS as Record<string, number>)[key] ?? value;
    const current = db.prepare("SELECT n FROM profile WHERE key = ?").get(key) as { n: number } | undefined;
    upsert.run(key, value, prior, counts[key] ?? current?.n ?? 0, stamp);
  }
  const hist = db.prepare(
    "INSERT INTO profile_history (at, key, value, previous, n, reason) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const h of history) hist.run(h.at, h.key, h.value, h.previous, h.n, h.reason);
}

/** Attach library attribution to exercises that have none, and fill missing
 *  form links for the movements we vouch for. Idempotent. */
export function seedAttribution(db: Db, now: Date): string[] {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const missing: string[] = [];
  const rows = db.prepare("SELECT slug, name, form_url FROM exercises").all() as {
    slug: string; name: string; form_url: string | null;
  }[];
  for (const row of rows) {
    const key = resolveLibraryKey(row.slug, row.name);
    if (key && FORM_URLS[key] && !row.form_url) {
      db.prepare("UPDATE exercises SET form_url = ? WHERE slug = ?").run(FORM_URLS[key], row.slug);
    }
    const have = db.prepare("SELECT 1 FROM exercise_muscles WHERE exercise_slug = ? LIMIT 1")
      .get(row.slug);
    if (have) continue;
    if (!key) {
      missing.push(row.name);
      continue;
    }
    const insert = db.prepare(
      "INSERT OR IGNORE INTO exercise_muscles"
        + " (exercise_slug, muscle_slug, role, weight, k, exposure, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
    );
    for (const [muscleSlug, role, weight] of LIBRARY[key]![1]) {
      insert.run(row.slug, muscleSlug, role, weight, BASE_K * weight, stamp);
    }
  }
  return missing;
}

/** Seeds the taxonomy, the state rows and the priors, exactly like muscles.seed. */
export function seed(db: Db, now: Date, stopDefault = 80, resumeDefault = 35): void {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const insertMuscle = db.prepare(
    "INSERT OR IGNORE INTO muscles (slug, name, region, sort) VALUES (?, ?, ?, ?)",
  );
  const insertState = db.prepare(
    "INSERT OR IGNORE INTO muscle_state (muscle_slug, wear, soreness, stop_at, resume_at, updated_at)"
      + " VALUES (?, 0, 0, ?, ?, ?)",
  );
  const insertProfile = db.prepare(
    "INSERT OR IGNORE INTO profile (key, value, prior, n, updated_at) VALUES (?, ?, ?, 0, ?)",
  );
  // the taxonomy lives in the engine; the db only stores it
  for (const [slug, name, region, sort] of MUSCLES) {
    insertMuscle.run(slug, name, region, sort);
    insertState.run(slug, stopDefault, resumeDefault, stamp);
  }
  for (const [key, prior] of Object.entries(PROFILE_PRIORS)) insertProfile.run(key, prior, prior, stamp);
  seedAttribution(db, now);
}
