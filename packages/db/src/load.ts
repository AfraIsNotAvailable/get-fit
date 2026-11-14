/** Read the whole state the engine needs, in one snapshot. */
import type {
  Attribution, Checkin, Exercise, MuscleState, ProfileParam, Round, RoundItem, RoundStatus,
  Settings, Snapshot, WearEvent,
} from "@getfit/engine";
import type { Db } from "./db.js";
import { iso } from "@getfit/engine";

type Row = Record<string, unknown>;

const str = (v: unknown): string => String(v ?? "");
const num = (v: unknown): number => Number(v ?? 0);
const nullableStr = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const nullableNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function loadSettings(db: Db): Settings {
  const row = db.prepare("SELECT * FROM settings WHERE id = 1").get() as Row | undefined;
  if (!row) {
    return {
      timezone: "Europe/Bucharest", intervalMinutes: 90, responseMinutes: 10,
      quietStart: "00:00", quietEnd: "07:00",
    };
  }
  return {
    timezone: str(row.timezone),
    intervalMinutes: num(row.interval_minutes),
    responseMinutes: num(row.response_minutes),
    quietStart: str(row.quiet_start),
    quietEnd: str(row.quiet_end),
  };
}

export function loadExercises(db: Db, activeOnly = true): Exercise[] {
  const sql = activeOnly
    ? "SELECT * FROM exercises WHERE active = 1 ORDER BY position, id"
    : "SELECT * FROM exercises ORDER BY position, id";
  const rows = db.prepare(sql).all() as Row[];
  return rows.map((r) => ({
    id: str(r.slug),
    name: str(r.name),
    min: num(r.min_reps),
    max: r.max_reps === null || r.max_reps === undefined ? null : num(r.max_reps),
    formUrl: nullableStr(r.form_url),
    active: Boolean(r.active),
    position: num(r.position),
  }));
}

export function loadClock(db: Db): Snapshot["clock"] {
  const row = db.prepare("SELECT * FROM app_state WHERE id = 1").get() as Row | undefined;
  return { bonus: num(row?.bonus), nextSetAt: nullableStr(row?.next_set_at) };
}

export function loadMuscles(db: Db): MuscleState[] {
  const rows = db.prepare("SELECT * FROM muscle_state").all() as Row[];
  return rows.map((r) => ({
    slug: str(r.muscle_slug),
    wear: num(r.wear),
    soreness: num(r.soreness),
    stopAt: num(r.stop_at),
    resumeAt: num(r.resume_at),
    restUntil: nullableStr(r.rest_until),
    lastLoadedAt: nullableStr(r.last_loaded_at),
    updatedAt: str(r.updated_at),
  }));
}

export function loadAttribution(db: Db): Attribution[] {
  const rows = db.prepare("SELECT * FROM exercise_muscles").all() as Row[];
  return rows.map((r) => ({
    exerciseSlug: str(r.exercise_slug),
    muscleSlug: str(r.muscle_slug),
    role: str(r.role) as Attribution["role"],
    weight: num(r.weight),
    k: num(r.k),
    exposure: num(r.exposure),
  }));
}

export function loadProfile(db: Db, now: Date): {
  profile: Record<string, number>;
  profileRows: ProfileParam[];
} {
  const rows = db.prepare("SELECT * FROM profile ORDER BY key").all() as Row[];
  const profile: Record<string, number> = {};
  const profileRows: ProfileParam[] = rows.map((r) => {
    profile[str(r.key)] = num(r.value);
    return {
      key: str(r.key), value: num(r.value), prior: num(r.prior), n: num(r.n),
      updatedAt: str(r.updated_at) || iso(now),
    };
  });
  return { profile, profileRows };
}

export function loadRounds(db: Db): Round[] {
  const rounds = db.prepare("SELECT * FROM rounds ORDER BY id").all() as Row[];
  const items = db.prepare("SELECT * FROM round_items ORDER BY id").all() as Row[];
  const byRound = new Map<number, RoundItem[]>();
  for (const item of items) {
    const id = num(item.round_id);
    const list = byRound.get(id) ?? [];
    list.push({
      exerciseSlug: str(item.exercise_slug),
      exerciseName: str(item.exercise_name),
      reps: num(item.reps),
    });
    byRound.set(id, list);
  }
  return rounds.map((r) => ({
    key: str(r.round_key),
    sentAt: str(r.sent_at),
    sentLocalDate: str(r.sent_local_date),
    deadlineAt: str(r.deadline_at),
    resolvedAt: nullableStr(r.resolved_at),
    status: str(r.status) as RoundStatus,
    bonusApplied: num(r.bonus_applied),
    targetReps: num(r.target_reps),
    source: nullableStr(r.source),
    items: byRound.get(num(r.id)) ?? [],
  }));
}

export function loadWearEvents(db: Db): WearEvent[] {
  const rows = db.prepare("SELECT * FROM wear_events ORDER BY id").all() as Row[];
  return rows.map((r) => ({
    roundKey: str(r.round_key),
    exerciseSlug: str(r.exercise_slug),
    muscleSlug: str(r.muscle_slug),
    reps: num(r.reps),
    predicted: num(r.predicted),
    observed: nullableNum(r.observed),
    at: str(r.at),
  }));
}

function parsePerMuscle(value: unknown): Record<string, number> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(String(value));
    if (!parsed || typeof parsed !== "object") return null;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) out[k] = Number(v);
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

export function loadCheckins(db: Db): Checkin[] {
  const rows = db.prepare("SELECT * FROM checkins ORDER BY id").all() as Row[];
  return rows.map((r) => ({
    id: num(r.id),
    kind: str(r.kind) as Checkin["kind"],
    at: str(r.at),
    localDate: nullableStr(r.local_date),
    roundKey: nullableStr(r.round_key),
    sleep: nullableNum(r.sleep),
    stress: nullableNum(r.stress),
    fatigue: nullableNum(r.fatigue),
    soreness: nullableNum(r.soreness),
    prs: nullableNum(r.prs),
    pain: Boolean(r.pain),
    painWhere: nullableStr(r.pain_where),
    srpe: nullableNum(r.srpe),
    rir: nullableNum(r.rir),
    stopper: (nullableStr(r.stopper) as Checkin["stopper"]) ?? null,
    perMuscle: parsePerMuscle(r.per_muscle),
    readiness: nullableNum(r.readiness),
    note: nullableStr(r.note),
  }));
}

export interface OpeningBalanceRow {
  exerciseSlug: string;
  exerciseName: string;
  reps: number;
}

export function loadOpeningBalance(db: Db): OpeningBalanceRow[] {
  const rows = db.prepare("SELECT * FROM opening_balance").all() as Row[];
  return rows.map((r) => ({
    exerciseSlug: str(r.exercise_slug),
    exerciseName: str(r.exercise_name),
    reps: num(r.reps),
  }));
}

/** Everything the engine reads, assembled. One query per table, no N+1. */
export function loadSnapshot(db: Db, now: Date): Snapshot {
  const { profile, profileRows } = loadProfile(db, now);
  return {
    settings: loadSettings(db),
    clock: loadClock(db),
    exercises: loadExercises(db, true),
    muscles: loadMuscles(db),
    attribution: loadAttribution(db),
    profile,
    profileRows,
    rounds: loadRounds(db),
    wearEvents: loadWearEvents(db),
    checkins: loadCheckins(db),
  };
}
