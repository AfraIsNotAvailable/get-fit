/** Exercise selection: what the next round should be, and why. */
import { MUSCLE_SORT } from "./data.js";
import { lastCircle, lastDoneMap } from "./schedule.js";
import { hoursBetween, parseIso, pyRound } from "./time.js";
import { effectiveStop, muscleRows, profileGet, readiness } from "./wear.js";
import type { Assignment, Exercise, PlanMeta, RankedExercise, Snapshot } from "./types.js";
import { compose } from "./schedule.js";

/** Score every exercise for this round. Low score wins. */
export interface RankOverrides {
  /** Test/CLI hook: pretend these were the last performed sets. */
  lastDone?: Record<string, string>;
  lastCircle?: Set<string>;
}

export function rank(snap: Snapshot, now: Date, overrides: RankOverrides = {}): RankedExercise[] {
  const ready = readiness(snap, now).score;
  const influence = profileGet(snap, "readiness_influence");
  const snapMuscles = new Map(muscleRows(snap, now, true).map((m) => [m.slug, m]));
  const lastDone = overrides.lastDone ?? lastDoneMap(snap);
  const circle = overrides.lastCircle ?? lastCircle(snap);

  const ranked: RankedExercise[] = snap.exercises.map((ex, pos) => {
    const pairs = snap.attribution
      .filter((a) => a.exerciseSlug === ex.id)
      .sort((a, b) => b.weight - a.weight || (MUSCLE_SORT[a.muscleSlug] ?? 0) - (MUSCLE_SORT[b.muscleSlug] ?? 0));
    if (pairs.length === 0) {
      return {
        id: ex.id, name: ex.name, pos, score: 60.0, hot: 0.0,
        blockedBy: "no attribution", why: "no attribution", muscles: [],
      };
    }

    let hot = 0.0;
    let blockedBy: string | null = null;
    let resumeOk = true;
    const muscles: RankedExercise["muscles"] = [];
    for (const pair of pairs) {
      const state = snapMuscles.get(pair.muscleSlug);
      if (!state) continue;
      muscles.push({ slug: pair.muscleSlug, name: state.name, role: pair.role, load: state.load });
      hot = Math.max(hot, state.load);
      if (state.resting) blockedBy = `${state.name} resting`;
      const stop = effectiveStop(state.stopAt, ready, influence);
      if (pair.role === "primary" && state.load >= stop) blockedBy = state.name;
      if (state.load >= 95.0) blockedBy = state.name;
      if (pair.role === "primary" && state.load > state.resumeAt) resumeOk = false;
    }

    const lastIso = lastDone[ex.id];
    const days = lastIso ? Math.min(7.0, hoursBetween(parseIso(lastIso), now) / 24.0) : 7.0;
    const overlap = muscles.filter((m) => circle.has(m.slug)).length;
    const score = hot - days * 4.0 - overlap * 8.0 - (resumeOk ? 12.0 : 0.0);
    const why = blockedBy
      ? `blocked: ${blockedBy}`
      : hot < 10
        ? "fresh"
        : `${pyRound(hot)}% loaded`;
    return {
      id: ex.id, name: ex.name, pos,
      score: pyRound(score, 1), hot: pyRound(hot, 1),
      blockedBy, why,
      muscles: [...muscles].sort((a, b) => b.load - a.load),
    };
  });

  ranked.sort((a, b) => {
    const blocked = Number(a.blockedBy !== null) - Number(b.blockedBy !== null);
    if (blocked !== 0) return blocked;
    if (a.score !== b.score) return a.score - b.score;
    return a.pos - b.pos;
  });
  return ranked;
}

/** The ordered stack for the next round, plus why. Blocked exercises are
 *  dropped; if nothing is eligible the round becomes a deload instead of silence. */
export function plan(snap: Snapshot, now: Date, overrides: RankOverrides = {}): { stack: Exercise[]; meta: PlanMeta } {
  const ranked = rank(snap, now, overrides);
  const byId = new Map(snap.exercises.map((ex) => [ex.id, ex]));
  const eligible = ranked.filter((r) => r.blockedBy === null);

  const meta: PlanMeta = {
    deload: false,
    blocked: ranked
      .filter((r) => r.blockedBy !== null)
      .map((r) => ({ id: r.id, name: r.name, why: String(r.blockedBy) })),
    ranked,
  };

  if (eligible.length === 0) {
    let best = ranked[0];
    for (const candidate of ranked) {
      if (!best) { best = candidate; continue; }
      const rankKey = (r: RankedExercise): [number, number] => [r.blockedBy === null ? 1 : 0, -r.score];
      const [a0, a1] = rankKey(candidate);
      const [b0, b1] = rankKey(best);
      if (a0 > b0 || (a0 === b0 && a1 > b1)) best = candidate;
    }
    meta.deload = true;
    meta.blocked = ranked.map((r) => ({
      id: r.id, name: r.name, why: r.blockedBy ?? "all groups near capacity",
    }));
    return { stack: best ? [byId.get(best.id) as Exercise] : [], meta };
  }

  return { stack: eligible.map((r) => byId.get(r.id) as Exercise), meta };
}

/** What the tick would send right now. */
export function planRound(snap: Snapshot, now: Date): { rows: Assignment[]; meta: PlanMeta } {
  const { stack, meta } = plan(snap, now);
  return { rows: compose(stack, snap.clock.bonus), meta };
}
