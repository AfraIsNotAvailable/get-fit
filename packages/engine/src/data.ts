/** Static vocabulary: the 22 muscle groups, the movement library and the priors.
 *
 * Data, not code. Editing a weight here changes the model for every round.
 */
import type { Role } from "./types.js";

export type Muscle = readonly [slug: string, name: string, region: string, sort: number];

/** 22 groups: the 17 of the public exercise datasets, deltoids split in three,
 *  serratus split out, obliques split from abdominals. */
export const MUSCLES: readonly Muscle[] = [
  ["chest", "Chest", "upper", 1],
  ["anterior-deltoid", "Front delts", "upper", 2],
  ["lateral-deltoid", "Side delts", "upper", 3],
  ["posterior-deltoid", "Rear delts", "upper", 4],
  ["triceps", "Triceps", "upper", 5],
  ["biceps", "Biceps", "upper", 6],
  ["forearms", "Forearms", "upper", 7],
  ["serratus-anterior", "Serratus", "upper", 8],
  ["traps", "Traps", "upper", 9],
  ["lats", "Lats", "upper", 10],
  ["mid-back", "Mid back", "upper", 11],
  ["lower-back", "Lower back", "core", 12],
  ["abs", "Abs", "core", 13],
  ["obliques", "Obliques", "core", 14],
  ["glutes", "Glutes", "lower", 15],
  ["quads", "Quads", "lower", 16],
  ["hamstrings", "Hamstrings", "lower", 17],
  ["adductors", "Adductors", "lower", 18],
  ["abductors", "Abductors", "lower", 19],
  ["hip-flexors", "Hip flexors", "lower", 20],
  ["calves", "Calves", "lower", 21],
  ["neck", "Neck", "upper", 22],
] as const;

export const MUSCLE_NAME: Readonly<Record<string, string>> = Object.fromEntries(
  MUSCLES.map(([slug, name]) => [slug, name]),
);

export const MUSCLE_REGION: Readonly<Record<string, string>> = Object.fromEntries(
  MUSCLES.map(([slug, , region]) => [slug, region]),
);

export const MUSCLE_SORT: Readonly<Record<string, number>> = Object.fromEntries(
  MUSCLES.map(([slug, , , sort]) => [slug, sort]),
);

export const ROLE_BASE: Readonly<Record<Role, number>> = {
  primary: 1.0,
  secondary: 0.4,
  stabiliser: 0.15,
};

export const BASE_K = 1.0;
export const WEAR_HALF_LIFE_H = 40.0;
export const SORENESS_HALF_LIFE_H = 96.0;
export const WEAR_CAP = 140.0;
export const K_MIN = 0.1;
export const K_MAX = 4.0;
export const STOP_DEFAULT = 80.0;
export const RESUME_DEFAULT = 35.0;

export const PROFILE_PRIORS = {
  wear_half_life: WEAR_HALF_LIFE_H,
  readiness_influence: 20.0,
  stop_base: STOP_DEFAULT,
} as const;

export type ProfileKey = keyof typeof PROFILE_PRIORS;

export const HALF_LIFE_GRID = [16, 20, 24, 28, 32, 36, 40, 48, 56, 72, 96] as const;
export const MIN_FIT_OBS = 4;
export const MIN_HALF_LIFE_OBS = 8;
export const MIN_HALF_LIFE_BUCKETS = 2;
export const BUCKET_H = 6.0;

/** A reported 1..5 on the Hooper scale, as an implied wear level. */
export const SORENESS_TO_WEAR: Readonly<Record<number, number>> = {
  1: 0.0,
  2: 25.0,
  3: 50.0,
  4: 75.0,
  5: 100.0,
};

export type LibraryEntry = readonly [name: string, pairs: readonly (readonly [string, Role, number])[]];

/** Attribution priors. A push-up debits the chest 1.00 and the triceps 0.60 of
 *  a "chest point" per rep; calibration moves each pair's k away from these. */
export const LIBRARY: Readonly<Record<string, LibraryEntry>> = {
  pushups: ["Push-ups", [
    ["chest", "primary", 1.0], ["triceps", "primary", 0.6],
    ["anterior-deltoid", "primary", 0.45], ["serratus-anterior", "secondary", 0.35],
    ["abs", "secondary", 0.25], ["obliques", "stabiliser", 0.2],
    ["forearms", "stabiliser", 0.1]]],
  "incline-pushups": ["Incline push-ups", [
    ["chest", "primary", 0.8], ["anterior-deltoid", "primary", 0.5],
    ["triceps", "primary", 0.45], ["serratus-anterior", "secondary", 0.3],
    ["abs", "stabiliser", 0.18]]],
  "diamond-pushups": ["Diamond push-ups", [
    ["triceps", "primary", 1.0], ["chest", "primary", 0.7],
    ["anterior-deltoid", "secondary", 0.35], ["serratus-anterior", "secondary", 0.25],
    ["abs", "stabiliser", 0.2], ["forearms", "stabiliser", 0.12]]],
  "pike-pushups": ["Pike push-ups", [
    ["anterior-deltoid", "primary", 1.0], ["triceps", "primary", 0.55],
    ["chest", "secondary", 0.4], ["traps", "secondary", 0.3],
    ["serratus-anterior", "secondary", 0.3], ["abs", "stabiliser", 0.2]]],
  dips: ["Dips", [
    ["triceps", "primary", 1.0], ["chest", "primary", 0.8],
    ["anterior-deltoid", "primary", 0.45], ["serratus-anterior", "secondary", 0.25],
    ["abs", "stabiliser", 0.15]]],
  squats: ["Squats", [
    ["quads", "primary", 1.0], ["glutes", "primary", 0.6],
    ["adductors", "secondary", 0.35], ["lower-back", "stabiliser", 0.3],
    ["hamstrings", "secondary", 0.25], ["abs", "stabiliser", 0.2],
    ["calves", "stabiliser", 0.15]]],
  "split-squats": ["Split squats", [
    ["quads", "primary", 1.0], ["glutes", "primary", 0.7],
    ["hamstrings", "secondary", 0.35], ["adductors", "secondary", 0.3],
    ["calves", "stabiliser", 0.15], ["abs", "stabiliser", 0.15]]],
  lunges: ["Lunges", [
    ["quads", "primary", 1.0], ["glutes", "primary", 0.65],
    ["hamstrings", "secondary", 0.3], ["adductors", "secondary", 0.3],
    ["abs", "stabiliser", 0.2], ["calves", "stabiliser", 0.15]]],
  "step-ups": ["Step-ups", [
    ["quads", "primary", 1.0], ["glutes", "primary", 0.65],
    ["hamstrings", "secondary", 0.25], ["calves", "secondary", 0.2],
    ["abs", "stabiliser", 0.15]]],
  "jump-squats": ["Jump squats", [
    ["quads", "primary", 1.0], ["glutes", "primary", 0.7],
    ["calves", "primary", 0.5], ["hamstrings", "secondary", 0.3],
    ["abs", "stabiliser", 0.2]]],
  "wall-sit": ["Wall sit", [
    ["quads", "primary", 1.0], ["glutes", "secondary", 0.3],
    ["abs", "stabiliser", 0.2], ["calves", "stabiliser", 0.15]]],
  "glute-bridge": ["Glute bridge", [
    ["glutes", "primary", 1.0], ["hamstrings", "primary", 0.5],
    ["lower-back", "secondary", 0.25], ["abs", "stabiliser", 0.2],
    ["adductors", "stabiliser", 0.15]]],
  "hip-thrust": ["Hip thrust", [
    ["glutes", "primary", 1.0], ["hamstrings", "primary", 0.45],
    ["quads", "secondary", 0.3], ["abs", "stabiliser", 0.2],
    ["lower-back", "stabiliser", 0.2]]],
  "calf-raises": ["Calf raises", [
    ["calves", "primary", 1.0], ["hamstrings", "stabiliser", 0.15],
    ["quads", "stabiliser", 0.1]]],
  "pull-ups": ["Pull-ups", [
    ["lats", "primary", 1.0], ["biceps", "primary", 0.6],
    ["mid-back", "primary", 0.45], ["forearms", "secondary", 0.3],
    ["posterior-deltoid", "secondary", 0.25], ["abs", "stabiliser", 0.15]]],
  "chin-ups": ["Chin-ups", [
    ["biceps", "primary", 1.0], ["lats", "primary", 0.9],
    ["mid-back", "secondary", 0.4], ["forearms", "secondary", 0.3],
    ["chest", "stabiliser", 0.15]]],
  "inverted-rows": ["Inverted rows", [
    ["mid-back", "primary", 1.0], ["lats", "primary", 0.55],
    ["biceps", "primary", 0.45], ["posterior-deltoid", "secondary", 0.35],
    ["forearms", "secondary", 0.25], ["abs", "stabiliser", 0.2]]],
  "lateral-raises": ["Lateral raises", [
    ["lateral-deltoid", "primary", 1.0], ["traps", "secondary", 0.3],
    ["anterior-deltoid", "stabiliser", 0.15], ["forearms", "stabiliser", 0.1]]],
  plank: ["Plank", [
    ["abs", "primary", 1.0], ["obliques", "primary", 0.5],
    ["lower-back", "secondary", 0.3], ["glutes", "stabiliser", 0.2],
    ["serratus-anterior", "stabiliser", 0.2], ["hip-flexors", "stabiliser", 0.15]]],
  "side-plank": ["Side plank", [
    ["obliques", "primary", 1.0], ["abs", "primary", 0.4],
    ["abductors", "secondary", 0.35], ["glutes", "stabiliser", 0.2],
    ["serratus-anterior", "stabiliser", 0.2]]],
  "hollow-hold": ["Hollow hold", [
    ["abs", "primary", 1.0], ["hip-flexors", "primary", 0.55],
    ["obliques", "secondary", 0.4], ["quads", "stabiliser", 0.2]]],
  "dead-bug": ["Dead bug", [
    ["abs", "primary", 1.0], ["hip-flexors", "secondary", 0.4],
    ["obliques", "secondary", 0.35], ["lower-back", "stabiliser", 0.2]]],
  "leg-raises": ["Leg raises", [
    ["abs", "primary", 1.0], ["hip-flexors", "primary", 0.7],
    ["obliques", "secondary", 0.3], ["quads", "stabiliser", 0.15]]],
  "russian-twists": ["Russian twists", [
    ["obliques", "primary", 1.0], ["abs", "primary", 0.6],
    ["hip-flexors", "secondary", 0.25], ["forearms", "stabiliser", 0.1]]],
  "mountain-climbers": ["Mountain climbers", [
    ["abs", "primary", 0.8], ["hip-flexors", "primary", 0.7],
    ["anterior-deltoid", "primary", 0.4], ["quads", "secondary", 0.3],
    ["obliques", "secondary", 0.3], ["forearms", "stabiliser", 0.15]]],
  superman: ["Superman", [
    ["lower-back", "primary", 1.0], ["glutes", "primary", 0.5],
    ["hamstrings", "secondary", 0.35], ["traps", "secondary", 0.25],
    ["posterior-deltoid", "stabiliser", 0.15]]],
  burpees: ["Burpees", [
    ["quads", "primary", 0.7], ["chest", "primary", 0.55],
    ["anterior-deltoid", "primary", 0.45], ["triceps", "secondary", 0.4],
    ["abs", "secondary", 0.4], ["glutes", "secondary", 0.3],
    ["calves", "stabiliser", 0.2], ["hip-flexors", "stabiliser", 0.2]]],
  "jumping-jacks": ["Jumping jacks", [
    ["calves", "primary", 0.6], ["lateral-deltoid", "primary", 0.5],
    ["quads", "secondary", 0.3], ["hip-flexors", "secondary", 0.25],
    ["abs", "stabiliser", 0.15]]],
  "high-knees": ["High knees", [
    ["hip-flexors", "primary", 0.8], ["quads", "primary", 0.6],
    ["calves", "secondary", 0.45], ["abs", "secondary", 0.3],
    ["lateral-deltoid", "stabiliser", 0.15]]],
};

/** Verified form articles (HTTP 200 + matching title when checked). Split
 *  squats and leg raises are deliberately absent — a red flag beats a wrong link. */
export const FORM_URLS: Readonly<Record<string, string>> = {
  pushups: "https://en.wikipedia.org/wiki/Push-up",
  squats: "https://en.wikipedia.org/wiki/Squat_(exercise)",
  "diamond-pushups": "https://www.healthline.com/health/fitness-exercise/push-ups-for-triceps",
  "pike-pushups": "https://www.healthline.com/health/fitness/bodyweight-shoulder-exercises",
  "glute-bridge": "https://www.acefitness.org/resources/everyone/exercise-library/49/glute-bridge/",
  "calf-raises": "https://www.acefitness.org/resources/everyone/exercise-library/51/calf-raises",
  superman: "https://www.acefitness.org/resources/everyone/exercise-library/9/supermans",
  "dead-bug": "https://www.healthline.com/health/exercise-fitness/dead-bug-exercise",
  "mountain-climbers": "https://www.acefitness.org/resources/everyone/exercise-library/258/mountain-climbers",
};

/** Map an exercise row onto a library key by slug or normalised name. */
export function norm(text: string): string {
  return String(text).toLowerCase().replace(/[^a-z0-9]/g, "");
}

const LIB_BY_KEY: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const slug of Object.keys(LIBRARY)) map.set(norm(slug), slug);
  for (const [slug, entry] of Object.entries(LIBRARY)) map.set(norm(entry[0]), slug);
  return map;
})();

export function resolveLibraryKey(slug: string, name = ""): string | null {
  for (const candidate of [slug, name]) {
    if (!candidate) continue;
    if (candidate in LIBRARY) return candidate;
    const key = LIB_BY_KEY.get(norm(candidate));
    if (key) return key;
  }
  return null;
}
