/**
 * The 60-assertion suite from the Python app, ported one-to-one.
 *
 * Every "check(...)" in tests.py has a matching assertion here, in the same
 * order, with the same numbers. If this file passes and tests.py passes, the
 * engine rewrite is faithful.
 */
import { describe, expect, it } from "vitest";
import {
  BASE_K, HALF_LIFE_GRID, MUSCLES, SORENESS_TO_WEAR, accrue, buildMonths, calibration,
  compose, confirm, plan, decay, effectiveStop, impliedWear, lastRound, levelOf, muscleRows,
  postWindow, readiness, recordCheckin, refit, seedMuscles, tick, totals, view,
} from "../src/index.js";
import { iso, parseIso } from "../src/time.js";
import type { Checkin, Snapshot } from "../src/types.js";
import {
  defaultStack, ex, fakeRound, hoursAgo, muscleOf, resetMuscles, setMuscle, world,
} from "./helpers.js";

const START = new Date("2026-11-12T05:00:00Z"); // 07:00 Bucharest

describe("state machine", () => {
  let now = new Date(START);
  let snap: Snapshot = world(now);
  const advance = (minutes: number) => {
    now = new Date(now.getTime() + minutes * 60_000);
  };

  it("1. the first tick fires the base set and starts no interval clock", () => {
    const result = tick(snap, now);
    snap = result.snapshot;
    expect(result.message).toBe("Time to lock in:\nPush-ups 10");
    expect(lastRound(snap)?.status).toBe("pending");
    expect(snap.clock.nextSetAt).toBeNull();
  });

  it("1b. a tick during an open round must not fire another set", () => {
    advance(5);
    const result = tick(snap, now);
    snap = result.snapshot;
    expect(result.message).toBeNull();
  });

  it("2. confirming on time logs the set and starts the 90 minute clock", () => {
    advance(1);
    const result = confirm(snap, now, "test");
    snap = result.snapshot;
    expect(result.rc).toBe(0);
    expect(lastRound(snap)?.status).toBe("done");
    expect(Object.fromEntries(totals(snap).map((t) => [t.id, t.reps])).pushups).toBe(10);
    expect(snap.clock.bonus).toBe(0);
    expect(snap.clock.nextSetAt).toBe(iso(new Date(now.getTime() + 90 * 60_000)));
  });

  it("3. nine misses stack the bonus, the tenth set overflows into squats", () => {
    for (let i = 0; i < 9; i += 1) {
      now = parseIso(String(snap.clock.nextSetAt));
      snap = tick(snap, now).snapshot;                  // fire
      now = new Date(now.getTime() + 11 * 60_000);      // blow past the window
      snap = tick(snap, now).snapshot;                  // expire -> +1
    }
    expect(snap.clock.bonus).toBe(9);
    expect(snap.clock.nextSetAt).not.toBeNull();

    now = parseIso(String(snap.clock.nextSetAt));
    let result = tick(snap, now);
    snap = result.snapshot;
    expect(result.message?.endsWith("Push-ups 19")).toBe(true);

    now = new Date(now.getTime() + 11 * 60_000);
    snap = tick(snap, now).snapshot;
    expect(snap.clock.bonus).toBe(10);

    now = parseIso(String(snap.clock.nextSetAt));
    result = tick(snap, now);
    snap = result.snapshot;
    expect(result.message).toBe("Time to lock in:\nPush-ups 20\nSquats 5");
  });

  it("4. a late confirmation logs the set and resets to +2", () => {
    advance(15);
    const result = confirm(snap, now, "test");
    snap = result.snapshot;
    expect(result.rc).toBe(0);
    expect(result.receipt).toContain("Late");
    expect(snap.clock.bonus).toBe(2);
    const byId = Object.fromEntries(totals(snap).map((t) => [t.id, t.reps]));
    expect(byId.pushups).toBe(30);
    expect(byId.squats).toBe(5);
    expect(snap.clock.nextSetAt).toBe(iso(new Date(now.getTime() + 90 * 60_000)));
  });

  it("4b. the month gauge counts done rounds and knows its ceiling", () => {
    const months = buildMonths(snap, now);
    expect(months.current.reps).toBe(35);
    expect(months.current.target).toBe(
      months.current.days * months.roundsPerDay * months.baseReps,
    );
    expect(months.history).toHaveLength(6);
  });

  it("5. quiet hours stay silent", () => {
    now = new Date("2026-11-13T01:30:00Z"); // 03:30 local
    snap = { ...snap, clock: { ...snap.clock, nextSetAt: iso(now) } };
    expect(tick(snap, now).message).toBeNull();
  });

  it("6. a set that dies at 23:30 schedules the next one for 07:00", () => {
    now = new Date("2026-11-13T21:30:00Z"); // 23:30 local
    snap = { ...snap, clock: { bonus: 0, nextSetAt: iso(now) } };
    const fired = tick(snap, now);
    snap = fired.snapshot;
    expect(fired.message?.startsWith("Time to lock in")).toBe(true);

    now = new Date(now.getTime() + 11 * 60_000);
    snap = tick(snap, now).snapshot;
    const next = buildMonths(snap, now); // touch: the clock is what matters below
    expect(next.roundsPerDay).toBeGreaterThan(0);
    const local = new Date(String(snap.clock.nextSetAt));
    const hm = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Bucharest", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(local);
    expect(hm).toBe("07:00");
  });

  it("7. a retired exercise keeps its lifetime reps", () => {
    snap = fakeRound(snap, "legacy1", "oldjacks", "Jumping jacks", 12, new Date("2026-11-01T10:00:00Z"));
    const rows = totals(snap);
    const names = Object.fromEntries(rows.map((t) => [t.name, t.reps]));
    expect(names["Jumping jacks"]).toBe(12);
    const summary = rows.reduce((sum, t) => sum + t.reps, 0);
    expect(summary).toBe(10 + 20 + 5 + 12);
  });

  it("8. the view marks an open round and hides the next-set countdown", () => {
    now = new Date("2026-11-14T08:00:00Z");
    snap = { ...snap, clock: { ...snap.clock, nextSetAt: iso(now) } };
    snap = tick(snap, now).snapshot;
    const v = view(snap, now);
    expect(v.roundOpen).toBe(true);
    expect(v.nextSet).toBeNull();
  });

  it("9. the calendar groups rounds by local day with a completion ratio", () => {
    const v = view(snap, now);
    const slot = v.calendar.days[v.calendar.today];
    expect(slot).toBeDefined();
    expect(slot!.rounds).toBeGreaterThanOrEqual(1);
    expect(slot!.reps).toBeGreaterThanOrEqual(0);
  });

  it("10. the taxonomy and the attribution the model stands on", () => {
    const v = view(snap, now);
    expect(v.muscles).toHaveLength(22);
    expect(v.muscles.every((m) => m.stopAt === 80 && m.resumeAt === 35)).toBe(true);

    const push = Object.fromEntries(
      snap.attribution.filter((a) => a.exerciseSlug === "pushups").map((a) => [a.muscleSlug, a]),
    );
    const squat = Object.fromEntries(
      snap.attribution.filter((a) => a.exerciseSlug === "squats").map((a) => [a.muscleSlug, a]),
    );
    expect(push.chest?.weight).toBe(1.0);
    expect(Object.keys(push)).toHaveLength(7);
    expect(push.triceps?.role).toBe("primary");
    expect(push["anterior-deltoid"]?.weight).toBe(0.45);
    expect(squat.quads?.weight).toBe(1.0);
    expect(squat.glutes?.weight).toBe(0.6);
  });
});

describe("the muscle model", () => {
  let now = new Date(START);
  let snap: Snapshot = world(now);
  const reset = () => {
    snap = resetMuscles(snap, now);
  };

  it("11. performing a set debits the muscles that set uses", () => {
    reset();
    snap = fakeRound(snap, "r-accrue", "pushups", "Push-ups", 10, now);
    const result = accrue(snap, "r-accrue", [{ id: "pushups", reps: 10 }], now);
    snap = {
      ...snap, muscles: result.muscles, attribution: result.attribution,
      wearEvents: [...snap.wearEvents, ...result.events],
    };
    expect(Math.abs(muscleOf(snap, "chest").wear - 10)).toBeLessThan(0.01);
    expect(Math.abs(muscleOf(snap, "triceps").wear - 6)).toBeLessThan(0.01);
    expect(muscleOf(snap, "quads").wear).toBe(0);
  });

  it("12. wear halves over one half-life", () => {
    snap = { ...snap, muscles: decay(snap, new Date(now.getTime() + 40 * 3_600_000)) };
    expect(Math.abs(muscleOf(snap, "chest").wear - 5)).toBeLessThan(0.05);
    reset();
  });

  it("13. 80% is a ceiling: a hot chest drops push-ups out of the plan", () => {
    snap = setMuscle(snap, "chest", { wear: 85, updatedAt: iso(now) });
    const result = view(snap, now);
    const ids = result.nextAssignment.map((r) => r.id);
    expect(ids).not.toContain("pushups");
    expect(ids).toEqual(["squats"]);
    expect(result.selection.blocked.some((b) => b.name === "Push-ups")).toBe(true);
  });

  it("14. rotation: the exercise that has been waiting goes first", () => {
    reset();
    const fresh = plan(snap, now, { lastDone: {}, lastCircle: new Set() }).stack.map((e) => e.id);
    expect(fresh[0]).toBe("pushups");
    const recent = plan(snap, now, {
      lastDone: { pushups: iso(now) }, lastCircle: new Set(),
    }).stack.map((e) => e.id);
    expect(recent[0]).toBe("squats");
  });

  it("15. a bad-readiness gate lowers everyone's ceiling", () => {
    const result = recordCheckin(snap, {
      kind: "gate", sleep: 5, stress: 5, fatigue: 5, soreness: 5, prs: 1,
    }, now);
    snap = result.snapshot;
    const ready = readiness(snap, now);
    expect(ready.score).toBeLessThan(0.2);
    const stop = effectiveStop(80, ready.score);
    expect(stop).toBeGreaterThanOrEqual(58);
    expect(stop).toBeLessThanOrEqual(62);
  });

  it("16. a worse-than-predicted set raises the chest coefficient", () => {
    reset();
    snap = fakeRound(snap, "r-loop", "pushups", "Push-ups", 10, now);
    const accrual = accrue(snap, "r-loop", [{ id: "pushups", reps: 10 }], now);
    snap = {
      ...snap, muscles: accrual.muscles, attribution: accrual.attribution,
      wearEvents: [...snap.wearEvents, ...accrual.events],
    };
    const before = Object.fromEntries(snap.attribution.map((a) => [a.muscleSlug, a.k]));
    const result = recordCheckin(snap, {
      kind: "post", roundKey: "r-loop", rir: 1, muscleSoreness: { chest: 5 },
    }, now);
    snap = result.snapshot;
    const after = Object.fromEntries(snap.attribution.map((a) => [a.muscleSlug, a.k]));
    expect(after.chest!).toBeGreaterThan(before.chest!);
    expect(after.triceps).toBe(before.triceps);
  });

  it("17. an easy set with nothing left to give shrinks k", () => {
    reset();
    snap = fakeRound(snap, "r-easy", "pushups", "Push-ups", 10, now);
    const accrual = accrue(snap, "r-easy", [{ id: "pushups", reps: 10 }], now);
    snap = {
      ...snap, muscles: accrual.muscles, attribution: accrual.attribution,
      wearEvents: [...snap.wearEvents, ...accrual.events],
    };
    const result = recordCheckin(snap, {
      kind: "post", roundKey: "r-easy", rir: 3, muscleSoreness: { chest: 1, triceps: 1 },
    }, now);
    snap = result.snapshot;
    const low = Object.fromEntries(snap.attribution.map((a) => [a.muscleSlug, a.k]));
    expect(low.chest!).toBeLessThan(1.0);
    expect(low.triceps!).toBeLessThan(0.6);
  });

  it("18. an unattributed exercise is visible, not silently skipped", () => {
    const stack = [...snap.exercises, ex("zercher-carry", "Zercher carry", 5, null, 9)];
    const withUnknown: Snapshot = { ...snap, exercises: stack };
    expect(view(withUnknown, now).unattributed.map((u) => u.name)).toContain("Zercher carry");
    reset();
  });
});

describe("the profile", () => {
  let now = new Date(START);
  let snap: Snapshot = world(now);

  const wipe = () => {
    snap = {
      ...resetMuscles(snap, now),
      rounds: [],
      wearEvents: [],
      checkins: [],
      profile: {},
    };
  };

  let nextId = 1;
  const synthetic = (
    key: string, dose: number, t0: Date, t1: Date, level: number,
    rir: number | null = null, muscle = "chest",
  ) => {
    snap = fakeRound(snap, key, "pushups", "Push-ups", Math.trunc(dose), t0);
    snap = {
      ...snap,
      rounds: snap.rounds.map((r) => (r.key === key ? { ...r, resolvedAt: iso(t1) } : r)),
      wearEvents: [...snap.wearEvents, {
        roundKey: key, exerciseSlug: "pushups", muscleSlug: muscle,
        reps: 1, predicted: dose, observed: null, at: iso(t0),
      }],
      checkins: [...snap.checkins, {
        id: nextId++, kind: "post", at: iso(t1), localDate: iso(t1).slice(0, 10),
        roundKey: key, sleep: null, stress: null, fatigue: null, soreness: null,
        prs: null, pain: false, painWhere: null, srpe: null, rir,
        stopper: null, perMuscle: { [muscle]: level }, readiness: null, note: null,
      } as Checkin],
    };
  };

  it("19. with no check-ins the profile stays on its priors", () => {
    wipe();
    const empty = refit(snap, now);
    expect(empty.summary.wear_half_life.fitted).toBe(false);
    expect(empty.summary.wear_half_life.value).toBe(40.0);
    expect(calibration(snap).mae).toBeNull();
  });

  const synthSeries = (prefix: string, hTrue: number, hours: number[], doses: number[]) => {
    hours.forEach((h, i) => {
      doses.forEach((dose, j) => {
        const value = dose * 2 ** (-h / hTrue);
        const level = Object.entries(SORENESS_TO_WEAR)
          .map(([k, v]) => [Number(k), v] as const)
          .sort((a, b) => Math.abs(a[1] - value) - Math.abs(b[1] - value))[0]![0];
        synthetic(`${prefix}${i}${j}`, dose, hoursAgo(now, h), now, level);
      });
    });
  };

  it("20. reports still sore two days out fit a long half-life", () => {
    wipe();
    synthSeries("slow", 96.0, [24, 60], [40, 55, 70, 85]);
    const slow = refit(snap, now);
    expect(slow.summary.wear_half_life.fitted).toBe(true);
    expect(slow.summary.wear_half_life.value).toBeGreaterThan(40);
  });

  it("21. reports that clear in a day fit a short one", () => {
    wipe();
    synthSeries("fast", 16.0, [8, 24], [50, 65, 80, 95]);
    const fast = refit(snap, now);
    expect(fast.summary.wear_half_life.fitted).toBe(true);
    expect(fast.summary.wear_half_life.value).toBeLessThan(40);
  });

  it("22. a muscle that keeps cratering gets a lower ceiling", () => {
    wipe();
    for (let i = 0; i < 3; i += 1) {
      const t0 = hoursAgo(now, 30 * (i + 1));
      synthetic(`crater${i}`, 80, t0, new Date(t0.getTime() + 2 * 3_600_000), 5, 0);
    }
    const fitted = refit(snap, now);
    const chest = fitted.muscles.find((m) => m.slug === "chest")!;
    const calves = fitted.muscles.find((m) => m.slug === "calves")!;
    expect(chest.stopAt).toBeLessThan(80);
    expect(calves.stopAt).toBe(80);
  });

  it("23. a bad gate that never costs anything loses its influence", () => {
    wipe();
    for (let i = 0; i < 3; i += 1) {
      const t0 = hoursAgo(now, 20 * (i + 1));
      synthetic(`resisted${i}`, 40, t0, new Date(t0.getTime() + 3_600_000), 2, 3);
      snap = {
        ...snap,
        checkins: [...snap.checkins, {
          id: nextId++, kind: "gate", at: iso(new Date(t0.getTime() - 3_600_000)),
          localDate: iso(t0).slice(0, 10), roundKey: null, sleep: null, stress: null,
          fatigue: null, soreness: null, prs: 3, pain: false, painWhere: null,
          srpe: null, rir: null, stopper: null, perMuscle: null, readiness: null, note: null,
        } as Checkin],
      };
    }
    const fitted = refit(snap, now);
    expect(fitted.summary.readiness_influence.fitted).toBe(true);
    expect(fitted.profile.readiness_influence!).toBeLessThan(20);
  });

  it("24. the profile view reports value, prior and sample size", () => {
    wipe();
    const params = view(snap, now).profile.params;
    expect(new Set(params.map((p) => p.key))).toEqual(
      new Set(["wear_half_life", "readiness_influence", "stop_base"]),
    );
    for (const p of params) {
      expect(p).toHaveProperty("value");
      expect(p).toHaveProperty("prior");
      expect(p).toHaveProperty("n");
      expect(p).toHaveProperty("fitted");
    }
  });
});
