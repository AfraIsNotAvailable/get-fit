import {
  BASE_K, FORM_URLS, LIBRARY, PROFILE_PRIORS, resolveLibraryKey, seedMuscles,
} from "../src/index.js";
import { iso } from "../src/time.js";
import type { Attribution, Exercise, Round, Snapshot } from "../src/types.js";

export const TZ = "Europe/Bucharest";

export function ex(id: string, name: string, min: number, max: number | null, position = 0): Exercise {
  return {
    id, name, min, max,
    formUrl: FORM_URLS[id] ?? null,
    active: true,
    position,
  };
}

export function defaultStack(): Exercise[] {
  return [
    ex("pushups", "Push-ups", 10, 20, 0),
    ex("squats", "Squats", 5, null, 1),
  ];
}

export function seedAttribution(exercises: Exercise[]): Attribution[] {
  const out: Attribution[] = [];
  for (const exercise of exercises) {
    const key = resolveLibraryKey(exercise.id, exercise.name);
    if (!key) continue;
    for (const [muscleSlug, role, weight] of LIBRARY[key]![1]) {
      out.push({ exerciseSlug: exercise.id, muscleSlug, role, weight, k: BASE_K * weight, exposure: 0 });
    }
  }
  return out;
}

export function world(now: Date, exercises = defaultStack()): Snapshot {
  return {
    settings: {
      timezone: TZ,
      intervalMinutes: 90,
      responseMinutes: 10,
      quietStart: "00:00",
      quietEnd: "07:00",
    },
    clock: { bonus: 0, nextSetAt: iso(now) },
    exercises,
    muscles: seedMuscles(now),
    attribution: seedAttribution(exercises),
    profile: { ...PROFILE_PRIORS },
    rounds: [],
    wearEvents: [],
    checkins: [],
  };
}

export function setMuscle(snap: Snapshot, slug: string, patch: Partial<Snapshot["muscles"][number]>): Snapshot {
  return { ...snap, muscles: snap.muscles.map((m) => (m.slug === slug ? { ...m, ...patch } : m)) };
}

export function muscleOf(snap: Snapshot, slug: string) {
  const row = snap.muscles.find((m) => m.slug === slug);
  if (!row) throw new Error(`no muscle ${slug}`);
  return row;
}

export function fakeRound(
  snap: Snapshot, key: string, slug: string, name: string, reps: number, at: Date,
): Snapshot {
  const round: Round = {
    key,
    sentAt: iso(at),
    sentLocalDate: iso(at).slice(0, 10),
    deadlineAt: iso(at),
    resolvedAt: iso(at),
    status: "done",
    bonusApplied: 0,
    targetReps: reps,
    source: "test",
    items: [{ exerciseSlug: slug, exerciseName: name, reps }],
  };
  return { ...snap, rounds: [...snap.rounds, round] };
}

export function resetMuscles(snap: Snapshot, now: Date): Snapshot {
  return {
    ...snap,
    muscles: seedMuscles(now).map((m) => ({ ...m, updatedAt: iso(now) })),
    attribution: snap.attribution.map((a) => ({ ...a, k: BASE_K * a.weight, exposure: 0 })),
    wearEvents: [],
    checkins: [],
  };
}

export function hoursAgo(now: Date, hours: number): Date {
  return new Date(now.getTime() - hours * 3_600_000);
}
