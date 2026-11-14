/** The interval clock, the quiet window and the bonus cascade. Pure. */
import type { Assignment, Exercise, Settings, Snapshot } from "./types.js";
import { localParts, pyRound, utcFromLocal, addDays } from "./time.js";

export function hmSeconds(value: string | undefined): number {
  const [hh, mm] = (value || "00:00").split(":");
  return Number(hh) * 3600 + Number(mm) * 60;
}

export function isActiveAt(date: Date, settings: Settings): boolean {
  const seconds = localParts(date, settings.timezone).secondsOfDay;
  const qs = hmSeconds(settings.quietStart);
  const qe = hmSeconds(settings.quietEnd);
  if (qs === qe) return true;
  if (qs < qe) return !(seconds >= qs && seconds < qe);
  return !(seconds >= qs || seconds < qe);
}

/** A time inside the quiet window moves to the moment it ends (today or tomorrow). */
export function clampToActive(date: Date, settings: Settings): Date {
  if (isActiveAt(date, settings)) return date;
  const local = localParts(date, settings.timezone);
  const qs = hmSeconds(settings.quietStart);
  const qe = hmSeconds(settings.quietEnd);
  let dayOffset = 0;
  if (qs < qe) {
    if (local.hour * 3600 + local.minute * 60 >= qe) dayOffset = 1;
  } else if (local.hour * 3600 + local.minute * 60 >= qs) {
    dayOffset = 1;
  }
  const targetDate = addDays(local.dateISO, dayOffset);
  return utcFromLocal(targetDate, qe, settings.timezone);
}

/** Turn (minimums, bonus) into the concrete set. The bonus fills exercise 1 to
 *  its max, then overflows to the next one at its own minimum, and so on; a
 *  null max is the sink, wherever rotation has put it. */
export function compose(stack: Exercise[], bonus: number): Assignment[] {
  const out: Assignment[] = [];
  let carry = Math.max(0, Math.trunc(bonus));
  let prevCapped = false;
  stack.forEach((ex, idx) => {
    const last = idx === stack.length - 1;
    const cap = last || ex.max === null ? null : Math.trunc(ex.max);
    const base = Math.trunc(ex.min ?? 0);
    if (idx > 0 && !prevCapped && carry <= 0) return;
    const asked = base + carry;
    const reps = cap === null ? asked : Math.min(asked, cap);
    carry = Math.max(0, asked - reps);
    prevCapped = cap !== null && reps >= cap;
    if (reps > 0) out.push({ id: ex.id, name: ex.name, reps, formUrl: ex.formUrl ?? null });
  });
  return out;
}

export function formatAssignment(rows: Assignment[]): string {
  return ["Time to lock in:", ...rows.map((r) => `${r.name} ${r.reps}`)].join("\n");
}

/** Days since each exercise was last performed (only done/late rounds). */
export function lastDoneMap(snap: Snapshot): Record<string, string> {
  const out: Record<string, string> = {};
  for (const round of snap.rounds) {
    if (round.status !== "done" && round.status !== "late") continue;
    const at = round.resolvedAt ?? round.sentAt;
    for (const item of round.items) {
      const prev = out[item.exerciseSlug];
      if (!prev || at > prev) out[item.exerciseSlug] = at;
    }
  }
  return out;
}

/** Muscle slugs the most recent performed round loaded. */
export function lastCircle(snap: Snapshot): Set<string> {
  const done = snap.rounds
    .filter((r) => r.status === "done" || r.status === "late")
    .sort((a, b) => (b.resolvedAt ?? b.sentAt).localeCompare(a.resolvedAt ?? a.sentAt));
  const last = done[0];
  if (!last) return new Set();
  return new Set(
    snap.wearEvents.filter((e) => e.roundKey === last.key).map((e) => e.muscleSlug),
  );
}

export function nextSetLabel(snap: Snapshot): { at: string; local: string; deferred: boolean; scheduled: string } | null {
  const next = snap.clock.nextSetAt;
  if (!next) return null;
  const when = new Date(next);
  const effective = clampToActive(when, snap.settings);
  const p = localParts(effective, snap.settings.timezone);
  return {
    at: effective.toISOString(),
    local: `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`,
    deferred: effective.getTime() !== when.getTime(),
    scheduled: when.toISOString(),
  };
}

export function secondsUntil(now: Date, isoValue: string): number {
  return Math.max(0, Math.trunc((new Date(isoValue).getTime() - now.getTime()) / 1000));
}

export { pyRound };
