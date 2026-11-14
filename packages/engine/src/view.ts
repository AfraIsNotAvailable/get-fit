/** The dashboard view model, assembled from one snapshot. */
import { MUSCLE_NAME, MUSCLE_SORT, PROFILE_PRIORS } from "./data.js";
import { buildCalendar, buildMonths, totals } from "./calendar.js";
import { postWindow } from "./checkins.js";
import { clampToActive, lastDoneMap, lastCircle, secondsUntil } from "./schedule.js";
import { planRound } from "./selection.js";
import { isActiveAt } from "./schedule.js";
import { addDays, hoursBetween, iso, localDate, localHM, parseIso, pyRound } from "./time.js";
import {
  calibration, effectiveStop, gateToday, muscleRows, profileGet, readiness,
} from "./wear.js";
import type { Assignment, Readiness, Round, Snapshot } from "./types.js";

export interface Dashboard {
  serverTime: {
    utc: string; local: string; dateLocal: string; timezone: string;
    quietNow: boolean; quietWindow: { start: string; end: string };
    secondsToNextEvent: number | null;
  };
  settings: Snapshot["settings"] & { exercises: Snapshot["exercises"] };
  clock: { bonus: number; nextSetAt: string | null };
  currentRound: (Round & { secondsLeft: number; localSent: string }) | null;
  roundOpen: boolean;
  nextSet: { at: string; local: string; deferred: boolean; scheduled: string; secondsLeft: number } | null;
  nextAssignment: Assignment[];
  lifetime: {
    totalReps: number; setsDone: number; setsMissed: number; startedAt: string | null;
    exercises: { id: string; name: string; reps: number; retired: boolean }[];
  };
  recentRounds: {
    roundKey: string; status: string; at: string; local: string; day: string;
    exercises: { name: string; reps: number }[];
  }[];
  calendar: ReturnType<typeof buildCalendar>;
  months: ReturnType<typeof buildMonths>;
  muscles: (ReturnType<typeof muscleRows>[number] & { stopEffective: number })[];
  readiness: Readiness;
  profile: {
    params: { key: string; value: number; prior: number; n: number; fitted: boolean; updatedAt: string }[];
    calibration: ReturnType<typeof calibration>;
  };
  checkinTodo: {
    due: "gate" | "post";
    round: {
      roundKey: string; at: string | null; expiresAt: string; secondsLeft: number;
      exercises: { name: string; reps: number }[];
      muscles: { slug: string; name: string; role: string }[];
    } | null;
    expiresAt: string | null;
    secondsLeft: number | null;
    windowMinutes: number;
    readiness: Readiness;
    gateAnswered: Record<string, number>;
    /** Which muscles the gate should ask about this morning, most loaded first. */
    askMuscles: { slug: string; name: string; load: number; lastLoadedAt: string; hoursAgo: number }[];
    lastGate: Record<string, unknown> | null;
  };
  selection: {
    deload: boolean;
    blocked: { name: string; why: string }[];
    ranked: { id: string; name: string; load: number; why: string; joined: boolean }[];
  };
  unattributed: { slug: string; name: string }[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-14" -> "14 Nov": the recent-rounds column, not an ISO date. */
function dayLabel(dateISO: string): string {
  const [, month, day] = dateISO.split("-");
  return `${Number(day)} ${MONTHS[Number(month) - 1] ?? month}`;
}

export function view(snap: Snapshot, now: Date, opening: Parameters<typeof totals>[1] = []): Dashboard {
  const tz = snap.settings.timezone;
  const totalRows = totals(snap, opening);
  const summary = totalRows.reduce((sum, t) => sum + t.reps, 0);
  const setsDone = snap.rounds.filter((r) => r.status === "done" || r.status === "late").length;
  const setsMissed = snap.rounds.filter((r) => r.status === "missed").length;
  const firstDone = snap.rounds
    .filter((r) => (r.status === "done" || r.status === "late") && r.resolvedAt)
    .map((r) => String(r.resolvedAt))
    .sort()[0] ?? null;

  const last = snap.rounds.length ? (snap.rounds[snap.rounds.length - 1] as Round) : null;
  const current = last
    ? {
        ...last,
        secondsLeft: Math.max(0, Math.trunc((parseIso(last.deadlineAt).getTime() - now.getTime()) / 1000)),
        localSent: localHM(parseIso(last.sentAt), tz),
      }
    : null;

  const recentRounds = [...snap.rounds]
    .sort((a, b) => b.sentAt.localeCompare(a.sentAt))
    .slice(0, 12)
    .map((r) => {
      const sent = parseIso(r.sentAt);
      return {
        roundKey: r.key,
        status: r.status,
        at: r.resolvedAt ?? r.sentAt,
        local: localHM(sent, tz),
        day: dayLabel(localParts(sent, tz).dateISO),
        exercises: r.items.map((i) => ({ name: i.exerciseName, reps: i.reps })),
      };
    });

  let nextSet = null as Dashboard["nextSet"];
  if (snap.clock.nextSetAt) {
    const when = parseIso(snap.clock.nextSetAt);
    const effective = clampToActive(when, snap.settings);
    nextSet = {
      at: iso(effective),
      local: localHM(effective, tz),
      deferred: effective.getTime() !== when.getTime(),
      scheduled: iso(when),
      secondsLeft: Math.max(0, Math.trunc((effective.getTime() - now.getTime()) / 1000)),
    };
  }

  const { rows, meta } = planRound(snap, now);
  const ready = readiness(snap, now);
  const influence = profileGet(snap, "readiness_influence");
  const muscles = muscleRows(snap, now, true).map((m) => ({
    ...m,
    stopEffective: pyRound(effectiveStop(m.stopAt, ready.score, influence), 1),
  }));

  const window = postWindow(snap, now, snap.settings.responseMinutes);
  const gate = gateToday(snap, now);
  const gateAnswered: Record<string, number> = {};
  for (const key of ["sleep", "stress", "fatigue", "soreness", "prs"] as const) {
    const value = gate[key];
    if (typeof value === "number") gateAnswered[key] = value;
  }
  // pain is a flag, not a scale: 0/1 so the gate can close on it like the others
  if (typeof gate.pain === "boolean") gateAnswered.pain = gate.pain ? 1 : 0;
  const lastGate = [...snap.checkins].filter((c) => c.kind === "gate").sort((a, b) => b.id - a.id)[0] ?? null;

  // What the morning gate should ask about: muscles that took load in the last two
  // days and have not been reported today. The decay fit needs the same muscle at
  // 12/24/36 hours, and that only comes from a daily answer — the after-set sheet is
  // minutes after the set and can say nothing about recovery.
  const ASK_LIMIT = 6;
  const today = localDate(now, snap.settings.timezone);
  const reportedToday = new Set(
    snap.checkins
      .filter((c) => c.kind === "gate" && c.localDate === today && c.perMuscle)
      .flatMap((c) => Object.keys(c.perMuscle ?? {})),
  );
  const lastLoad = new Map<string, Date>();
  for (const event of snap.wearEvents) {
    const at = parseIso(event.at);
    if (at.getTime() > now.getTime() || hoursBetween(at, now) > 48) continue;
    const seen = lastLoad.get(event.muscleSlug);
    if (!seen || at.getTime() > seen.getTime()) lastLoad.set(event.muscleSlug, at);
  }
  const askMuscles = muscles
    .filter((muscle) => !reportedToday.has(muscle.slug) && lastLoad.has(muscle.slug))
    .sort((a, b) => b.load - a.load)
    .slice(0, ASK_LIMIT)
    .map((muscle) => {
      const at = lastLoad.get(muscle.slug) as Date;
      return {
        slug: muscle.slug,
        name: muscle.name,
        load: pyRound(muscle.load, 1),
        lastLoadedAt: iso(at),
        hoursAgo: pyRound(hoursBetween(at, now), 1),
      };
    });

  const checkinMuscles = window
    ? [...new Set(
        snap.wearEvents
          .filter((e) => e.roundKey === window.round.key)
          .map((e) => e.muscleSlug),
      )].slice(0, 8).map((slug) => ({
        slug,
        name: MUSCLE_NAME[slug] ?? slug,
        role: snap.attribution.find((a) => a.muscleSlug === slug)?.role ?? "secondary",
      }))
    : [];

  const profileRows = snap.profileRows ?? Object.entries({ ...PROFILE_PRIORS, ...snap.profile }).map(([key, value]) => ({
    key,
    value,
    prior: (PROFILE_PRIORS as Record<string, number>)[key] ?? 0,
    n: 0,
    updatedAt: iso(now),
  }));

  return {
    serverTime: {
      utc: iso(now),
      local: localHM(now, tz, true),
      dateLocal: localDate(now, tz),
      timezone: tz,
      quietNow: !isActiveAt(now, snap.settings),
      quietWindow: { start: snap.settings.quietStart, end: snap.settings.quietEnd },
      secondsToNextEvent: nextSet ? nextSet.secondsLeft : window ? window.secondsLeft : null,
    },
    settings: { ...snap.settings, exercises: snap.exercises },
    clock: { ...snap.clock },
    currentRound: current,
    roundOpen: Boolean(last && last.status === "pending"),
    nextSet,
    nextAssignment: rows,
    lifetime: {
      totalReps: summary,
      setsDone,
      setsMissed,
      startedAt: firstDone,
      exercises: totalRows.map((t) => ({
        id: t.id, name: t.name, reps: t.reps, retired: !t.active,
      })),
    },
    recentRounds,
    calendar: buildCalendar(snap, now),
    months: buildMonths(snap, now),
    muscles,
    readiness: ready,
    profile: {
      params: profileRows.map((p) => ({
        key: p.key, value: pyRound(p.value, 2), prior: pyRound(p.prior, 2), n: p.n,
        fitted: p.n >= 4, updatedAt: p.updatedAt,
      })),
      calibration: calibration(snap),
    },
    checkinTodo: {
      due: window ? "post" : "gate",
      round: window
        ? {
            roundKey: window.round.key,
            at: window.round.resolvedAt,
            expiresAt: iso(window.expiresAt),
            secondsLeft: window.secondsLeft,
            exercises: window.round.items.map((i) => ({ name: i.exerciseName, reps: i.reps })),
            muscles: checkinMuscles,
          }
        : null,
      expiresAt: window ? iso(window.expiresAt) : null,
      secondsLeft: window ? window.secondsLeft : null,
      windowMinutes: snap.settings.responseMinutes,
      readiness: ready,
      gateAnswered,
      askMuscles,
      lastGate: lastGate as unknown as Record<string, unknown> | null,
    },
    selection: {
      deload: meta.deload,
      blocked: meta.blocked.map((b) => ({ name: b.name, why: b.why })),
      ranked: meta.ranked.map((r) => ({
        id: r.id, name: r.name, load: r.hot, why: r.why,
        joined: rows.some((row) => row.id === r.id),
      })),
    },
    unattributed: snap.exercises
      .filter((e) => e.active && !snap.attribution.some((a) => a.exerciseSlug === e.id))
      .sort((a, b) => a.position - b.position)
      .map((e) => ({ slug: e.id, name: e.name })),
  };
}

import { localParts } from "./time.js";
export { lastDoneMap, lastCircle, secondsUntil, hoursBetween, addDays, MUSCLE_SORT };
