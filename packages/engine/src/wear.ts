/** The fatigue model: decay, accrual, readiness, calibration, refit.
 *
 * Every function here is pure. `decay` returns new muscle rows instead of
 * writing them, and `accrue` returns the ledger rows it would insert — the db
 * layer decides whether to persist.
 */
import {
  BASE_K, BUCKET_H, HALF_LIFE_GRID, K_MAX, K_MIN, MIN_FIT_OBS, MIN_HALF_LIFE_BUCKETS,
  MIN_HALF_LIFE_OBS, MUSCLES, MUSCLE_NAME, MUSCLE_REGION, MUSCLE_SORT, PROFILE_PRIORS,
  SORENESS_HALF_LIFE_H, SORENESS_TO_WEAR, WEAR_CAP, WEAR_HALF_LIFE_H,
} from "./data.js";
import { clamp, hoursBetween, iso, localDate, median, parseIso, pyRound } from "./time.js";
import type {
  Attribution, Checkin, MuscleSnapshotRow, MuscleState, Readiness, Snapshot, WearEvent,
} from "./types.js";

export interface ProfileHistoryEntry {
  at: string;
  key: string;
  value: number;
  previous: number | null;
  n: number;
  reason: string | null;
}

function profileGet(snap: Snapshot, key: string): number {
  const value = snap.profile[key];
  if (typeof value === "number") return value;
  return (PROFILE_PRIORS as Record<string, number>)[key] ?? 0;
}

/** Exponential decay since each row was last written. Rows touched less than
 *  half an hour ago are left exactly as they are. */
export function decay(snap: Snapshot, now: Date): MuscleState[] {
  const halfLife = profileGet(snap, "wear_half_life") || WEAR_HALF_LIFE_H;
  const stamp = iso(now);
  return snap.muscles.map((m) => {
    const last = m.updatedAt ? parseIso(m.updatedAt) : now;
    const hours = hoursBetween(last, now);
    if (hours < 0.5) return m;
    return {
      ...m,
      wear: m.wear * 2 ** (-hours / halfLife),
      soreness: m.soreness * 2 ** (-hours / SORENESS_HALF_LIFE_H),
      updatedAt: stamp,
    };
  });
}

export interface AccrualResult {
  muscles: MuscleState[];
  attribution: Attribution[];
  events: WearEvent[];
}

/** Debit wear for a round that was actually performed. A missed round debits nothing. */
export function accrue(
  snap: Snapshot,
  roundKey: string,
  items: { id: string; reps: number }[],
  now: Date,
): AccrualResult {
  let muscles = decay(snap, now);
  const attribution = snap.attribution.map((a) => ({ ...a }));
  const events: WearEvent[] = [];
  const stamp = iso(now);

  for (const item of items) {
    const pairs = attribution
      .filter((a) => a.exerciseSlug === item.id)
      .sort((a, b) => b.weight - a.weight || (MUSCLE_SORT[a.muscleSlug] ?? 0) - (MUSCLE_SORT[b.muscleSlug] ?? 0));
    if (pairs.length === 0) continue;
    for (const pair of pairs) {
      const dose = Number(item.reps) * Number(pair.k);
      muscles = muscles.map((m) =>
        m.slug === pair.muscleSlug
          ? { ...m, wear: Math.min(WEAR_CAP, m.wear + dose), lastLoadedAt: stamp, updatedAt: stamp }
          : m,
      );
      events.push({
        roundKey,
        exerciseSlug: item.id,
        muscleSlug: pair.muscleSlug,
        reps: Math.trunc(item.reps),
        predicted: dose,
        observed: null,
        at: stamp,
      });
      pair.exposure += 1;
    }
  }
  return { muscles, attribution, events };
}

export interface GateToday {
  at: string | null;
  sleep: number | null;
  stress: number | null;
  fatigue: number | null;
  soreness: number | null;
  prs: number | null;
  pain: boolean | null;
  painWhere: string | null;
}

/** Today's gate answers, merged per question: several partial submissions are normal. */
export function gateToday(snap: Snapshot, now: Date): GateToday {
  const day = localDate(now, snap.settings.timezone);
  const out: GateToday = {
    at: null, sleep: null, stress: null, fatigue: null,
    soreness: null, prs: null, pain: null, painWhere: null,
  };
  const gates = snap.checkins
    .filter((c) => c.kind === "gate")
    .sort((a, b) => b.id - a.id)
    .slice(0, 40);
  for (const row of gates) {
    const rowDay = row.localDate ?? localDate(parseIso(row.at), snap.settings.timezone);
    if (rowDay !== day) continue;
    out.at = out.at ?? row.at;
    if (out.sleep === null && row.sleep !== null) out.sleep = row.sleep;
    if (out.stress === null && row.stress !== null) out.stress = row.stress;
    if (out.fatigue === null && row.fatigue !== null) out.fatigue = row.fatigue;
    if (out.soreness === null && row.soreness !== null) out.soreness = row.soreness;
    if (out.prs === null && row.prs !== null) out.prs = row.prs;
    if (out.pain === null && row.pain !== null) out.pain = row.pain;
    if (out.painWhere === null && row.painWhere !== null) out.painWhere = row.painWhere;
  }
  return out;
}

export function sleepScore(hours: unknown): number {
  const h = Number(hours);
  if (!Number.isFinite(h)) return 3.0;
  if (h >= 8) return 1.0;
  if (h >= 7) return 2.0;
  if (h >= 6) return 3.0;
  if (h >= 5) return 4.0;
  return 5.0;
}

/** 0..1 capacity for right now, from today's gate. Older than 18 h is stale. */
export function readiness(snap: Snapshot, now: Date): Readiness {
  const gate = gateToday(snap, now);
  const answers = (["sleep", "stress", "fatigue", "soreness", "prs"] as const).filter(
    (k) => gate[k] !== null,
  );
  const out: Readiness = {
    score: 0.7, prs: null, at: null, stale: true, pain: false,
    painWhere: null, hooper: null, answers: [...answers],
  };
  if (!gate.at) return out;
  const ageHours = hoursBetween(parseIso(gate.at), now);
  if (ageHours > 18) {
    return { ...out, at: gate.at, prs: gate.prs, pain: Boolean(gate.pain), painWhere: gate.painWhere };
  }
  const items: number[] = [];
  if (gate.sleep !== null) items.push(sleepScore(gate.sleep));
  for (const key of ["stress", "fatigue", "soreness"] as const) {
    const value = gate[key];
    if (value !== null) items.push(value);
  }
  const hooper = items.length ? items.reduce((a, b) => a + b, 0) / items.length : 3.0;
  const scoreHooper = clamp((5.0 - hooper) / 4.0, 0, 1);
  const scorePrs = clamp((gate.prs ?? 6) / 10.0, 0, 1);
  let score = 0.5 * scoreHooper + 0.5 * scorePrs;
  if (gate.pain) score = Math.min(score, 0.35);
  return {
    score: pyRound(score, 3),
    prs: gate.prs,
    at: gate.at,
    stale: false,
    pain: Boolean(gate.pain),
    painWhere: gate.painWhere,
    hooper: pyRound(hooper, 2),
    answers: [...answers],
  };
}

/** A bad day lowers the ceiling; a good day never raises it past the model's. */
export function effectiveStop(stopAt: number, ready: number, influence = 20.0): number {
  return Math.max(30.0, Number(stopAt) - (1.0 - clamp(ready, 0, 1)) * influence);
}

export function impliedWear(soreness: Record<string, number> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [slug, value] of Object.entries(soreness ?? {})) {
    const n = Math.trunc(Number(value));
    if (Number.isFinite(n) && n in SORENESS_TO_WEAR) out[slug] = SORENESS_TO_WEAR[n] as number;
  }
  return out;
}

export function levelOf(value: number): number {
  for (const [level, wear] of Object.entries(SORENESS_TO_WEAR)) {
    if (wear === value) return Number(level);
  }
  return 0;
}

/** The snapshot rows the dashboard paints: rounded, sorted by load, resting flagged. */
export function muscleRows(snap: Snapshot, now: Date, doDecay = false): MuscleSnapshotRow[] {
  const states = doDecay ? decay(snap, now) : snap.muscles;
  const rows = states.map((m) => {
    const restUntil = m.restUntil;
    return {
      slug: m.slug,
      name: MUSCLE_NAME[m.slug] ?? m.slug,
      region: MUSCLE_REGION[m.slug] ?? "",
      sort: MUSCLE_SORT[m.slug] ?? 0,
      wear: pyRound(m.wear, 1),
      soreness: pyRound(m.soreness, 1),
      load: pyRound(Math.max(m.wear, m.soreness), 1),
      stopAt: pyRound(m.stopAt, 1),
      resumeAt: pyRound(m.resumeAt, 1),
      lastLoadedAt: m.lastLoadedAt,
      resting: Boolean(restUntil && parseIso(restUntil) > now),
      restUntil,
    };
  });
  rows.sort((a, b) => b.load - a.load || a.sort - b.sort);
  return rows;
}

export function seedMuscles(now: Date): MuscleState[] {
  const stamp = iso(now);
  return MUSCLES.map(([slug]) => ({
    slug,
    wear: 0,
    soreness: 0,
    stopAt: PROFILE_PRIORS.stop_base,
    resumeAt: 35,
    restUntil: null,
    lastLoadedAt: null,
    updatedAt: stamp,
  }));
}

// ---------------------------------------------------------------- fitting

export interface Observation {
  checkin: number;
  muscle: string;
  round: string;
  dose: number;
  t0: Date;
  t1: Date;
  hours: number;
  reported: number;
  level: number;
  rir: number | null;
}

export function observations(snap: Snapshot): Observation[] {
  const out: Observation[] = [];
  for (const row of snap.checkins.filter((c) => c.kind === "post" && c.perMuscle).sort((a, b) => a.id - b.id)) {
    for (const [muscle, rawLevel] of Object.entries(row.perMuscle ?? {})) {
      const events = snap.wearEvents.filter((e) => e.roundKey === row.roundKey && e.muscleSlug === muscle);
      const dose = events.reduce((sum, e) => sum + Number(e.predicted), 0);
      if (!events.length || dose < 1.0) continue;
      const t0 = events.map((e) => parseIso(e.at)).sort((a, b) => a.getTime() - b.getTime())[0];
      if (!t0) continue;
      const level = Math.trunc(Number(rawLevel));
      if (!Number.isFinite(level) || !(level in SORENESS_TO_WEAR)) continue;
      const t1 = parseIso(row.at);
      out.push({
        checkin: row.id,
        muscle,
        round: String(row.roundKey),
        dose,
        t0,
        t1,
        hours: hoursBetween(t0, t1),
        reported: SORENESS_TO_WEAR[level] as number,
        level,
        rir: row.rir,
      });
    }
  }
  return out;
}

function predicted(obs: Observation, halfLife: number): number {
  return obs.dose * 2 ** (-obs.hours / halfLife);
}

export function calibration(snap: Snapshot): { mae: number | null; n: number; series: { checkin: number; error: number }[] } {
  const obs = observations(snap);
  if (obs.length === 0) return { mae: null, n: 0, series: [] };
  const half = profileGet(snap, "wear_half_life");
  const byCheckin = new Map<number, number[]>();
  for (const o of obs) {
    const list = byCheckin.get(o.checkin) ?? [];
    list.push(Math.abs(predicted(o, half) - o.reported));
    byCheckin.set(o.checkin, list);
  }
  const errors = [...byCheckin.values()].flat();
  const series = [...byCheckin.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([checkin, values]) => ({
      checkin,
      error: pyRound(values.reduce((a, b) => a + b, 0) / values.length, 1),
    }));
  return {
    mae: pyRound(errors.reduce((a, b) => a + b, 0) / errors.length, 1),
    n: errors.length,
    series: series.slice(-16),
  };
}

export interface RefitResult {
  profile: Record<string, number>;
  muscles: MuscleState[];
  history: ProfileHistoryEntry[];
  summary: {
    wear_half_life: { value: number; n: number; fitted: boolean };
    stop_base: { value: number; n: number; fitted: boolean };
    readiness_influence: { value: number; n: number; fitted: boolean };
    calibration: { mae: number | null; n: number; series: { checkin: number; error: number }[] };
    observations: number;
  };
}

export function refit(snap: Snapshot, now: Date): RefitResult {
  const stamp = iso(now);
  const profile: Record<string, number> = { ...(PROFILE_PRIORS as Record<string, number>) , ...snap.profile };
  const history: ProfileHistoryEntry[] = [];
  const obs = observations(snap);

  const store = (key: string, value: number, n: number, reason = "") => {
    const previous = key in profile ? (profile[key] as number) : null;
    profile[key] = value;
    if (previous === null || Math.abs(previous - value) > 0.009) {
      history.push({
        at: stamp, key, value, previous, n,
        reason: reason || (n >= MIN_FIT_OBS ? "fitted" : "prior"),
      });
    }
  };

  // 1. recovery half-life: fit on the fraction still reported, so a wrong k
  // cannot masquerade as a wrong recovery rate.
  const timed = obs.filter((o) => o.hours >= 4.0 && o.reported > 0);
  const buckets = new Set(timed.map((o) => pyRound(o.hours / BUCKET_H)));
  const prior = PROFILE_PRIORS.wear_half_life;
  let halfSummary: { value: number; n: number; fitted: boolean };
  if (timed.length >= MIN_HALF_LIFE_OBS && buckets.size >= MIN_HALF_LIFE_BUCKETS) {
    let best = HALF_LIFE_GRID[0] as number;
    let bestErr = Infinity;
    for (const candidate of HALF_LIFE_GRID) {
      const err = median(timed.map((o) => Math.abs(o.reported / o.dose - 2 ** (-o.hours / candidate))));
      if (err < bestErr) {
        bestErr = err;
        best = candidate;
      }
    }
    best = clamp(best, prior * 0.5, prior * 2.0);
    store("wear_half_life", best, timed.length);
    halfSummary = { value: best, n: timed.length, fitted: true };
  } else {
    store("wear_half_life", prior, 0);
    halfSummary = { value: prior, n: timed.length, fitted: false };
  }

  const half = profile.wear_half_life as number;
  const base = profile.stop_base as number;

  // 2. per-muscle ceiling: where this user's work actually starts to crater.
  const events = new Map<string, { at: Date; predicted: number }[]>();
  for (const e of [...snap.wearEvents].sort((a, b) => a.at.localeCompare(b.at)).slice(0, 4000)) {
    const list = events.get(e.muscleSlug) ?? [];
    list.push({ at: parseIso(e.at), predicted: Number(e.predicted) });
    events.set(e.muscleSlug, list);
  }
  const evidence = new Map<string, { easy: number; crater: number; n: number }>();
  for (const o of obs) {
    if (o.rir === null || o.level < 1) continue;
    const state = (events.get(o.muscle) ?? [])
      .filter((e) => e.at.getTime() <= o.t0.getTime())
      .reduce((sum, e) => sum + e.predicted * 2 ** (-hoursBetween(e.at, o.t0) / half), 0);
    const slot = evidence.get(o.muscle) ?? { easy: 0, crater: 0, n: 0 };
    slot.n += 1;
    if ((o.rir as number) <= 1 && o.level >= 4 && state >= 40) slot.crater += 1;
    else if ((o.rir as number) >= 2 && o.level <= 2 && state >= 30) slot.easy += 1;
    evidence.set(o.muscle, slot);
  }
  let muscles = snap.muscles.map((m) => ({ ...m }));
  let moved = 0;
  for (const [muscle, slot] of evidence) {
    let stop = base;
    if (slot.n >= 3) {
      stop = clamp(base + 2.0 * slot.easy - 4.0 * slot.crater, 60.0, 90.0);
      moved += 1;
    }
    muscles = muscles.map((m) => (m.slug === muscle ? { ...m, stopAt: stop } : m));
  }

  // 3. readiness influence: does a bad gate actually cost this user anything?
  let resisted = 0;
  let affected = 0;
  const recentRounds = snap.rounds
    .filter((r) => (r.status === "done" || r.status === "late") && r.resolvedAt)
    .sort((a, b) => String(b.resolvedAt).localeCompare(String(a.resolvedAt)))
    .slice(0, 200);
  for (const round of recentRounds) {
    const resolved = String(round.resolvedAt);
    const gate = snap.checkins
      .filter((c) => c.kind === "gate" && c.at < resolved)
      .sort((a, b) => b.at.localeCompare(a.at))[0];
    const post = snap.checkins
      .filter((c) => c.kind === "post" && c.roundKey === round.key)
      .sort((a, b) => b.id - a.id)[0];
    const prs = gate?.prs ?? null;
    const rir = post?.rir ?? null;
    if (prs === null || prs > 4 || rir === null) continue;
    if (rir >= 2) resisted += 1;
    else if (rir === 0) affected += 1;
  }
  let influenceSummary: { value: number; n: number; fitted: boolean };
  if (resisted + affected >= 3) {
    const influence = clamp(20.0 + 6.0 * affected - 6.0 * resisted, 0, 40);
    store("readiness_influence", influence, resisted + affected);
    influenceSummary = { value: influence, n: resisted + affected, fitted: true };
  } else {
    store("readiness_influence", PROFILE_PRIORS.readiness_influence, 0);
    influenceSummary = { value: PROFILE_PRIORS.readiness_influence, n: resisted + affected, fitted: false };
  }

  const after: Snapshot = { ...snap, muscles, profile };
  return {
    profile,
    muscles,
    history,
    summary: {
      wear_half_life: halfSummary,
      stop_base: { value: base, n: moved, fitted: moved > 0 },
      readiness_influence: influenceSummary,
      calibration: calibration(after),
      observations: obs.length,
    },
  };
}

export { profileGet, predicted };
