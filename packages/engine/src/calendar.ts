/** Lifetime totals, the day grid and the monthly ceiling. */
import { addDays, daysInMonth, localDate, parseIso, pyRound, monthOf } from "./time.js";
import { compose } from "./schedule.js";
import type { Snapshot } from "./types.js";

export interface TotalRow {
  id: string;
  name: string;
  reps: number;
  order: number;
  active: boolean;
}

export interface OpeningBalanceRow {
  exerciseSlug: string;
  exerciseName: string;
  reps: number;
}

/** Lifetime reps per exercise, including retired exercises and legacy balances. */
export function totals(snap: Snapshot, opening: OpeningBalanceRow[] = []): TotalRow[] {
  const acc = new Map<string, TotalRow>();
  for (const row of opening) {
    acc.set(row.exerciseSlug, {
      id: row.exerciseSlug, name: row.exerciseName, reps: Math.trunc(row.reps),
      order: -50, active: false,
    });
  }
  for (const round of snap.rounds) {
    if (round.status !== "done" && round.status !== "late") continue;
    for (const item of round.items) {
      const slot = acc.get(item.exerciseSlug) ?? {
        id: item.exerciseSlug, name: item.exerciseName, reps: 0, order: 900, active: false,
      };
      slot.reps += Math.trunc(item.reps);
      slot.name = item.exerciseName;
      acc.set(item.exerciseSlug, slot);
    }
  }
  snap.exercises
    .filter((e) => e.active)
    .sort((a, b) => a.position - b.position)
    .forEach((ex, pos) => {
      const slot = acc.get(ex.id) ?? { id: ex.id, name: ex.name, reps: 0, order: pos, active: false };
      slot.name = ex.name;
      slot.order = pos;
      slot.active = true;
      acc.set(ex.id, slot);
    });
  return [...acc.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

export interface CalendarDay {
  rounds: number;
  done: number;
  reps: number;
  ratio: number;
  byEx: Record<string, number>;
}

export interface CalendarData {
  days: Record<string, CalendarDay>;
  today: string;
  start: string;
  maxReps: number;
}

export function buildCalendar(snap: Snapshot, now: Date): CalendarData {
  const days: Record<string, CalendarDay> = {};
  const slot = (day: string): CalendarDay => {
    days[day] ??= { rounds: 0, done: 0, reps: 0, ratio: 0, byEx: {} };
    return days[day] as CalendarDay;
  };

  for (const round of snap.rounds) {
    const day = round.sentLocalDate;
    const entry = slot(day);
    entry.rounds += 1;
    if (round.status === "done" || round.status === "late") {
      entry.done += 1;
      entry.reps += Math.trunc(round.targetReps);
      for (const item of round.items) {
        entry.byEx[item.exerciseSlug] = (entry.byEx[item.exerciseSlug] ?? 0) + Math.trunc(item.reps);
      }
    }
  }
  for (const entry of Object.values(days)) {
    entry.ratio = entry.rounds ? entry.done / entry.rounds : 0;
  }
  const today = localDate(now, snap.settings.timezone);
  return {
    days,
    today,
    start: addDays(today, -364),
    maxReps: Math.max(0, ...Object.values(days).map((d) => d.reps)),
  };
}

export interface CalendarMonth {
  month: string;
  label: string;
  year: number;
  days: number;
  target: number;
  reps: number;
  ratio: number;
  current: boolean;
}

export interface MonthsData {
  roundsPerDay: number;
  baseReps: number;
  current: CalendarMonth;
  history: CalendarMonth[];
}

function hmSeconds(value: string): number {
  const [hh, mm] = value.split(":");
  return Number(hh) * 3600 + Number(mm) * 60;
}

export function buildMonths(snap: Snapshot, now: Date): MonthsData {
  const settings = snap.settings;
  const qs = Math.floor(hmSeconds(settings.quietStart) / 60);
  const qe = Math.floor(hmSeconds(settings.quietEnd) / 60);
  const quietMinutes = qs === qe ? 0 : ((qe - qs) % 1440 || 1440);
  const activeMinutes = Math.max(settings.intervalMinutes, 1440 - quietMinutes);
  const roundsPerDay = Math.max(1, Math.floor(activeMinutes / settings.intervalMinutes));
  const baseReps = compose(snap.exercises, 0).reduce((sum, r) => sum + r.reps, 0) || 1;

  const done = new Map<string, number>();
  for (const round of snap.rounds) {
    if (round.status !== "done" && round.status !== "late") continue;
    const key = monthOf(round.sentLocalDate);
    done.set(key, (done.get(key) ?? 0) + Math.trunc(round.targetReps));
  }

  const today = localDate(now, snap.settings.timezone);
  const [todayYear, todayMonth] = today.split("-").map(Number) as [number, number];
  const months: CalendarMonth[] = [];
  for (let back = 11; back >= 0; back -= 1) {
    let y = todayYear;
    let m = todayMonth - back;
    while (m <= 0) {
      m += 12;
      y -= 1;
    }
    const key = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
    const days = daysInMonth(y, m);
    const target = days * roundsPerDay * baseReps;
    const reps = done.get(key) ?? 0;
    months.push({
      month: key,
      label: new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-GB", { month: "short", timeZone: "UTC" }),
      year: y,
      days,
      target,
      reps,
      ratio: target ? reps / target : 0,
      current: key === today.slice(0, 7),
    });
  }
  const current = months[months.length - 1] as CalendarMonth;
  return { roundsPerDay, baseReps, current, history: months.slice(-6) };
}

export { pyRound, parseIso };
