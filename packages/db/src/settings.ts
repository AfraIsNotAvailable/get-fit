/** Settings and the exercise stack: the one PUT that replaces a lot. */
import type { Exercise, Settings } from "@getfit/engine";
import type { Db } from "./db.js";
import { loadExercises, loadSettings } from "./load.js";
import { seedAttribution } from "./muscles.js";

export interface ExerciseInput {
  id?: string | null;
  name: string;
  min: number;
  max: number | null;
  formUrl?: string | null;
}

export interface SettingsInput {
  timezone: string;
  intervalMinutes: number;
  responseMinutes: number;
  quietStart: string;
  quietEnd: string;
  exercises: ExerciseInput[];
}

function slugify(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "exercise";
  let slug = base;
  let i = 2;
  while (taken.has(slug)) {
    slug = `${base}-${i}`;
    i += 1;
  }
  return slug;
}

const stamp = (now: Date): string => now.toISOString().replace(/\.\d{3}Z$/, "Z");

/** Full replacement: the posted list becomes the stack, anything missing is retired. */
export function saveSettings(db: Db, input: SettingsInput, now: Date): Settings {
  db.prepare(
    "UPDATE settings SET timezone = ?, interval_minutes = ?, response_minutes = ?,"
      + " quiet_start = ?, quiet_end = ? WHERE id = 1",
  ).run(input.timezone, input.intervalMinutes, input.responseMinutes, input.quietStart, input.quietEnd);

  const known = new Set(
    (db.prepare("SELECT slug FROM exercises").all() as { slug: string }[]).map((r) => r.slug),
  );
  const keep = new Set<string>();
  input.exercises.forEach((raw, position) => {
    const max = position === input.exercises.length - 1 ? null : raw.max;
    const existing = (raw.id ?? "").trim();
    if (existing && known.has(existing)) {
      db.prepare(
        "UPDATE exercises SET name = ?, min_reps = ?, max_reps = ?, position = ?, active = 1,"
          + " retired_at = NULL, form_url = ? WHERE slug = ?",
      ).run(raw.name, raw.min, max, position, raw.formUrl ?? null, existing);
      keep.add(existing);
      return;
    }
    const slug = slugify(raw.name, known);
    known.add(slug);
    db.prepare(
      "INSERT INTO exercises (slug, name, min_reps, max_reps, position, active, created_at, form_url)"
        + " VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
    ).run(slug, raw.name, raw.min, max, position, stamp(now), raw.formUrl ?? null);
    keep.add(slug);
  });

  for (const row of db.prepare("SELECT slug FROM exercises WHERE active = 1").all() as { slug: string }[]) {
    if (keep.has(row.slug)) continue;
    db.prepare("UPDATE exercises SET active = 0, retired_at = ? WHERE slug = ?")
      .run(stamp(now), row.slug);
  }

  // a new exercise without attribution is invisible to the model
  seedAttribution(db, now);
  return { ...loadSettings(db), exercises: loadExercises(db, true) } as Settings & { exercises: Exercise[] };
}
