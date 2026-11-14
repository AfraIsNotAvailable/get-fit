/** The round state machine: tick, confirm, and the text a confirmation earns. */
import { randomUUID } from "node:crypto";
import { addMinutes, iso, localDate, localHM, parseIso, pyRound } from "./time.js";
import { clampToActive, formatAssignment, isActiveAt } from "./schedule.js";
import { planRound } from "./selection.js";
import { accrue, muscleRows } from "./wear.js";
import type { Assignment, Round, RoundItem, Snapshot } from "./types.js";

export function lastRound(snap: Snapshot): Round | null {
  return snap.rounds.length ? (snap.rounds[snap.rounds.length - 1] as Round) : null;
}

function closeRound(snap: Snapshot, now: Date): { bonus: number; nextSetAt: string | null } {
  return {
    bonus: snap.clock.bonus,
    nextSetAt: iso(clampToActive(addMinutes(now, snap.settings.intervalMinutes), snap.settings)),
  };
}

function newKey(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

export interface TickResult {
  snapshot: Snapshot;
  message: string | null;
  expired: Round | null;
  opened: Round | null;
}

/** One scheduler tick. Silent unless a set is due or one just expired. */
export function tick(snap: Snapshot, now: Date, opts: { force?: boolean; dryRun?: boolean; key?: string } = {}): TickResult {
  const dryRun = opts.dryRun ?? false;
  let next: Snapshot = { ...snap, clock: { ...snap.clock } };
  let expired: Round | null = null;

  const cur = lastRound(next);
  let roundOpen = Boolean(cur && cur.status === "pending");
  if (cur && roundOpen && now.getTime() >= parseIso(cur.deadlineAt).getTime()) {
    expired = { ...cur, status: "missed", resolvedAt: iso(now) };
    if (!dryRun) {
      next.rounds = next.rounds.map((r) => (r.key === cur.key ? expired as Round : r));
      next.clock = closeRound({ ...next, clock: { ...next.clock, bonus: next.clock.bonus + 1 } }, now);
    }
    roundOpen = false;
  }

  const nextAt = next.clock.nextSetAt;
  const due = !roundOpen && nextAt !== null && now.getTime() >= parseIso(nextAt).getTime();
  const active = isActiveAt(now, next.settings);
  if (!due || !(opts.force || active)) {
    return { snapshot: next, message: null, expired, opened: null };
  }

  const { rows } = planRound(next, now);
  let opened: Round | null = null;
  if (!dryRun) {
    opened = {
      key: opts.key ?? newKey(),
      sentAt: iso(now),
      sentLocalDate: localDate(now, next.settings.timezone),
      deadlineAt: iso(addMinutes(now, next.settings.responseMinutes)),
      resolvedAt: null,
      status: "pending",
      bonusApplied: next.clock.bonus,
      targetReps: rows.reduce((sum, r) => sum + r.reps, 0),
      source: null,
      items: rows.map((r) => ({ exerciseSlug: r.id, exerciseName: r.name, reps: r.reps })),
    };
    next = { ...next, rounds: [...next.rounds, opened], clock: { ...next.clock, nextSetAt: null } };
  }
  return { snapshot: next, message: formatAssignment(rows), expired, opened };
}

export interface ConfirmResult {
  snapshot: Snapshot;
  rc: number;
  receipt: string;
  round: Round | null;
}

/** Log the open round. rc 3 means there was nothing pending. */
export function confirm(snap: Snapshot, now: Date, source = ""): ConfirmResult {
  const cur = lastRound(snap);
  if (!cur || (cur.status !== "pending" && cur.status !== "missed")) {
    return { snapshot: snap, rc: 3, receipt: "", round: null };
  }

  const late = cur.status === "missed" || now.getTime() > parseIso(cur.deadlineAt).getTime();
  const resolved: Round = {
    ...cur,
    status: late ? "late" : "done",
    resolvedAt: iso(now),
    source: source || null,
  };
  const accrual = accrue(snap, cur.key, cur.items.map((i) => ({ id: i.exerciseSlug, reps: i.reps })), now);
  const withAccrual: Snapshot = {
    ...snap,
    muscles: accrual.muscles,
    attribution: accrual.attribution,
    wearEvents: [...snap.wearEvents, ...accrual.events],
    rounds: snap.rounds.map((r) => (r.key === cur.key ? resolved : r)),
  };
  const clock = closeRound(snap, now);
  const next: Snapshot = {
    ...withAccrual,
    clock: { bonus: late ? 2 : 0, nextSetAt: clock.nextSetAt },
  };

  return { snapshot: next, rc: 0, receipt: receipt(next, resolved, late, now), round: resolved };
}

/** The sentence the Telegram hook posts. Canned, never model-generated. */
export function receipt(snap: Snapshot, round: Round, late: boolean, now: Date): string {
  const rows = round.items.map((i) => `${i.reps} ${i.exerciseName.toLowerCase()}`).join(", ");
  let out = late
    ? `Late, but logged: ${rows}.\nReset — next set is +2 push-ups.`
    : `Logged: ${rows}. Back to base next set.`;
  const hot = muscleRows(snap, now, false).filter((m) => m.load >= 5).slice(0, 3);
  if (hot.length) {
    out += "\nWear: " + hot.map((m) => `${m.name.toLowerCase()} ${pyRound(m.load)}%`).join(", ") + ".";
  }
  if (snap.clock.nextSetAt) {
    out += ` Next set ${localHM(parseIso(snap.clock.nextSetAt), snap.settings.timezone)}.`;
  }
  return out;
}

export function assignmentOf(round: Round | null, snap: Snapshot): Assignment[] {
  if (!round) return [];
  return round.items.map((i: RoundItem) => ({
    id: i.exerciseSlug,
    name: i.exerciseName,
    reps: i.reps,
    formUrl: snap.exercises.find((e) => e.id === i.exerciseSlug)?.formUrl ?? null,
  }));
}
