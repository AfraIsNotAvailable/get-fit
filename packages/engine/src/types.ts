/** Domain types for the get-fit engine.
 *
 * These are plain data. Nothing here imports a database driver, an HTTP
 * framework or the clock — the engine is a pure function of its inputs.
 */

export type Role = "primary" | "secondary" | "stabiliser";
export type RoundStatus = "pending" | "done" | "late" | "missed";
export type CheckinKind = "gate" | "post";
export type Stropper = "muscle" | "breathing" | "joints" | "boredom";

export interface Settings {
  timezone: string;
  intervalMinutes: number;
  responseMinutes: number;
  quietStart: string; // "HH:MM"
  quietEnd: string; // "HH:MM"
}

export interface Exercise {
  id: string;
  name: string;
  min: number;
  max: number | null; // null = uncapped (the bonus sink)
  formUrl: string | null;
  active: boolean;
  position: number;
}

export interface MuscleState {
  slug: string;
  wear: number;
  soreness: number;
  stopAt: number;
  resumeAt: number;
  restUntil: string | null;
  lastLoadedAt: string | null;
  updatedAt: string;
}

export interface Attribution {
  exerciseSlug: string;
  muscleSlug: string;
  role: Role;
  weight: number;
  k: number;
  exposure: number;
}

export interface RoundItem {
  exerciseSlug: string;
  exerciseName: string;
  reps: number;
}

export interface Round {
  key: string;
  sentAt: string;
  sentLocalDate: string;
  deadlineAt: string;
  resolvedAt: string | null;
  status: RoundStatus;
  bonusApplied: number;
  targetReps: number;
  source: string | null;
  items: RoundItem[];
}

export interface WearEvent {
  roundKey: string;
  exerciseSlug: string;
  muscleSlug: string;
  reps: number;
  predicted: number;
  observed: number | null;
  at: string;
}

export interface Checkin {
  id: number;
  kind: CheckinKind;
  at: string;
  localDate: string | null;
  roundKey: string | null;
  sleep: number | null;
  stress: number | null;
  fatigue: number | null;
  soreness: number | null;
  prs: number | null;
  pain: boolean;
  painWhere: string | null;
  srpe: number | null;
  rir: number | null;
  stopper: Stropper | null;
  perMuscle: Record<string, number> | null;
  readiness: number | null;
  note: string | null;
}

export interface ProfileParam {
  key: string;
  value: number;
  prior: number;
  n: number;
  updatedAt: string;
}

/** Everything the engine reads. The db layer loads it, the engine never does. */
export interface Snapshot {
  settings: Settings;
  clock: { bonus: number; nextSetAt: string | null };
  exercises: Exercise[];
  muscles: MuscleState[];
  attribution: Attribution[];
  profile: Record<string, number>;
  /** Display rows (prior, sample size, when). Optional: the math only needs `profile`. */
  profileRows?: ProfileParam[];
  rounds: Round[];
  wearEvents: WearEvent[];
  checkins: Checkin[];
}

export interface Assignment {
  id: string;
  name: string;
  reps: number;
  formUrl: string | null;
}

export interface RankedExercise {
  id: string;
  name: string;
  pos: number;
  score: number;
  hot: number;
  blockedBy: string | null;
  why: string;
  muscles: { slug: string; name: string; role: Role; load: number }[];
}

export interface PlanMeta {
  deload: boolean;
  blocked: { id: string; name: string; why: string }[];
  ranked: RankedExercise[];
}

export interface MuscleSnapshotRow {
  slug: string;
  name: string;
  region: string;
  sort: number;
  wear: number;
  soreness: number;
  load: number;
  stopAt: number;
  resumeAt: number;
  lastLoadedAt: string | null;
  resting: boolean;
  restUntil: string | null;
}

export interface Readiness {
  score: number;
  prs: number | null;
  at: string | null;
  stale: boolean;
  pain: boolean;
  painWhere: string | null;
  hooper: number | null;
  answers: string[];
}
