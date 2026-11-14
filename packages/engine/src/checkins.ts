/** The two questionnaires, and what they do to the model. */
import { K_MAX, K_MIN, MUSCLE_NAME, SORENESS_TO_WEAR } from "./data.js";
import { addHours, iso, localDate, parseIso, pyRound } from "./time.js";
import { impliedWear, levelOf, profileGet, readiness, refit, type RefitResult } from "./wear.js";
import type { Checkin, CheckinKind, Round, Snapshot, Stropper } from "./types.js";

export class CheckinRefused extends Error {
  constructor(message: string, readonly code = 409) {
    super(message);
    this.name = "CheckinRefused";
  }
}

export interface CheckinPayload {
  kind: CheckinKind;
  roundKey?: string | null;
  sleep?: number | null;
  stress?: number | null;
  fatigue?: number | null;
  soreness?: number | null;
  prs?: number | null;
  pain?: boolean;
  painWhere?: string | null;
  srpe?: number | null;
  rir?: number | null;
  stopper?: Stropper | null;
  muscleSoreness?: Record<string, number> | null;
  note?: string | null;
}

export interface CheckinChange {
  muscle?: string;
  exercise?: string;
  soreness?: number;
  reported?: number;
  restUntil?: string;
  k?: number;
  predicted?: number;
  reportedWear?: number;
  ratio?: number;
  rir?: number;
  kMultiplier?: number;
}

export interface CheckinResult {
  ok: true;
  kind: CheckinKind;
  at: string;
  readiness: number | null;
  changes: CheckinChange[];
  profile: RefitResult["summary"] | null;
}

export interface PostWindow {
  round: Round;
  opensAt: Date;
  expiresAt: Date;
  secondsLeft: number;
}

/** The one round that is answerable right now, and when that window shuts. */
export function postWindow(snap: Snapshot, now: Date, windowMinutes = 10): PostWindow | null {
  // newest first, insertion order breaking ties (the Python query sorted by id too)
  const row = snap.rounds
    .map((round, index) => ({ round, index }))
    .filter(({ round }) => (round.status === "done" || round.status === "late") && round.resolvedAt)
    .sort((a, b) =>
      String(b.round.resolvedAt).localeCompare(String(a.round.resolvedAt)) || b.index - a.index,
    )[0]?.round;
  if (!row) return null;
  if (snap.checkins.some((c) => c.kind === "post" && c.roundKey === row.key)) return null;
  const start = parseIso(String(row.resolvedAt));
  const end = addHours(start, Math.max(1, windowMinutes) / 60);
  if (now.getTime() < start.getTime() || now.getTime() > end.getTime()) return null;
  return {
    round: row,
    opensAt: start,
    expiresAt: end,
    secondsLeft: Math.max(0, Math.trunc((end.getTime() - now.getTime()) / 1000)),
  };
}

function intOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "" || value === "null") return null;
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : null;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "" || value === "null") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function applyGate(snap: Snapshot, row: Checkin, now: Date): CheckinChange[] {
  const changes: CheckinChange[] = [];
  const stamp = iso(now);
  const implied = impliedWear(row.perMuscle);
  let muscles = snap.muscles.map((m) => ({ ...m }));

  for (const [slug, value] of Object.entries(implied)) {
    muscles = muscles.map((m) => {
      if (m.slug !== slug) return m;
      const next = Math.max(m.soreness, 0.7 * value);
      changes.push({ muscle: slug, soreness: pyRound(next, 1), reported: levelOf(value) });
      return { ...m, soreness: next, updatedAt: stamp };
    });
  }
  if (row.pain && row.painWhere && row.painWhere in MUSCLE_NAME) {
    const until = iso(addHours(now, 48));
    muscles = muscles.map((m) => (m.slug === row.painWhere ? { ...m, restUntil: until, updatedAt: stamp } : m));
    changes.push({ muscle: row.painWhere, restUntil: until });
  }
  snap.muscles = muscles;
  return changes;
}

function applyPost(snap: Snapshot, row: Checkin, now: Date): CheckinChange[] {
  const changes: CheckinChange[] = [];
  const roundKey = row.roundKey;
  if (!roundKey) return changes;
  const implied = impliedWear(row.perMuscle);
  const stamp = iso(now);
  const roundExercises = new Set(
    snap.wearEvents.filter((e) => e.roundKey === roundKey).map((e) => e.exerciseSlug),
  );

  for (const [slug, value] of Object.entries(implied)) {
    const dose = snap.wearEvents
      .filter((e) => e.roundKey === roundKey && e.muscleSlug === slug)
      .reduce((sum, e) => sum + Number(e.predicted), 0);
    if (dose < 1.0) continue;
    const ratio = Math.max(0.25, Math.min(3.0, value / dose));
    const pairs = snap.attribution.filter((a) => a.muscleSlug === slug && roundExercises.has(a.exerciseSlug));
    for (const pair of pairs) {
      const learn = pair.exposure <= 3 ? 0.35 : 0.15;
      const k = Math.max(K_MIN, Math.min(K_MAX, pair.k * ratio ** learn));
      pair.k = k;
      changes.push({
        muscle: slug, exercise: pair.exerciseSlug, k: pyRound(k, 2),
        predicted: pyRound(dose, 1), reportedWear: value, ratio: pyRound(ratio, 2),
      });
    }
    for (const event of snap.wearEvents) {
      if (event.roundKey === roundKey && event.muscleSlug === slug) event.observed = value;
    }
    snap.muscles = snap.muscles.map((m) =>
      m.slug === slug ? { ...m, soreness: Math.max(m.soreness, 0.7 * value), updatedAt: stamp } : m,
    );
  }

  if (row.rir !== null) {
    const factor = row.rir >= 3 ? 0.85 : row.rir === 0 ? 1.12 : 1.0;
    if (factor !== 1.0) {
      for (const pair of snap.attribution) {
        if (!roundExercises.has(pair.exerciseSlug)) continue;
        pair.k = Math.max(K_MIN, Math.min(K_MAX, pair.k * factor));
      }
      changes.push({ rir: row.rir, kMultiplier: factor });
    }
  }
  return changes;
}

/** Store a questionnaire and let it move the model. */
export function recordCheckin(
  snap: Snapshot,
  payload: CheckinPayload,
  now: Date,
  windowMinutes = 10,
): { snapshot: Snapshot; result: CheckinResult } {
  const kind = String(payload.kind ?? "");
  if (kind !== "gate" && kind !== "post") throw new Error("kind must be 'gate' or 'post'");

  const perMuscle: Record<string, number> = {};
  for (const [slug, value] of Object.entries(payload.muscleSoreness ?? {})) {
    if (slug in MUSCLE_NAME) perMuscle[slug] = Math.trunc(Number(value));
  }

  const draft: Checkin = {
    id: (snap.checkins.reduce((max, c) => Math.max(max, c.id), 0) + 1),
    kind,
    at: iso(now),
    localDate: localDate(now, snap.settings.timezone),
    roundKey: payload.roundKey ?? null,
    sleep: numOrNull(payload.sleep),
    stress: intOrNull(payload.stress),
    fatigue: intOrNull(payload.fatigue),
    soreness: intOrNull(payload.soreness),
    prs: intOrNull(payload.prs),
    pain: Boolean(payload.pain),
    painWhere: payload.painWhere ?? null,
    srpe: intOrNull(payload.srpe),
    rir: intOrNull(payload.rir),
    stopper: payload.stopper ?? null,
    perMuscle: Object.keys(perMuscle).length ? perMuscle : null,
    readiness: null,
    note: payload.note ?? null,
  };

  // work on a copy: a refused answer must not leave a half-applied change
  const next: Snapshot = {
    ...snap,
    muscles: snap.muscles.map((m) => ({ ...m })),
    attribution: snap.attribution.map((a) => ({ ...a })),
    wearEvents: snap.wearEvents.map((e) => ({ ...e })),
    checkins: [...snap.checkins],
  };

  let changes: CheckinChange[] = [];
  if (kind === "gate") {
    changes = applyGate(next, draft, now);
  } else {
    const known = next.rounds.some((r) => r.key === draft.roundKey);
    if (!known) throw new CheckinRefused(`unknown round ${JSON.stringify(draft.roundKey)}`, 404);
    if (next.checkins.some((c) => c.kind === "post" && c.roundKey === draft.roundKey)) {
      throw new CheckinRefused("that set has already been answered", 409);
    }
    const window = postWindow(next, now, windowMinutes);
    if (!window || window.round.key !== draft.roundKey) {
      throw new CheckinRefused(
        `the answer window for that set has closed (it is ${windowMinutes} minutes after the set)`,
        409,
      );
    }
    const loaded = new Set(
      next.wearEvents.filter((e) => e.roundKey === draft.roundKey).map((e) => e.muscleSlug),
    );
    const invented = Object.keys(perMuscle).filter((slug) => !loaded.has(slug)).sort();
    if (invented.length) {
      throw new CheckinRefused(`that set did not work ${invented.join(", ")}`, 400);
    }
    changes = applyPost(next, draft, now);
  }

  next.checkins.push(draft);
  let fitted: RefitResult["summary"] | null = null;
  if (kind === "gate") {
    draft.readiness = readiness(next, now).score;
  } else {
    try {
      const fittedResult = refit(next, now);
      next.profile = fittedResult.profile;
      next.muscles = fittedResult.muscles;
      fitted = fittedResult.summary;
    } catch {
      fitted = null;
    }
  }

  return {
    snapshot: next,
    result: {
      ok: true,
      kind,
      at: draft.at,
      readiness: draft.readiness,
      changes,
      profile: fitted,
    },
  };
}

export { profileGet, parseIso, SORENESS_TO_WEAR };
