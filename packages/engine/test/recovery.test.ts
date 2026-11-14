/** The daily recovery report, and why it is the only one that can fit a decay rate.
 *
 * The after-set sheet is answered minutes after the set, so every observation it
 * produces has hours ≈ 0 and the half-life fit (which needs ≥4 h) never engages.
 * The morning gate is answered 12–24 h after the load, which is the range that can
 * separate "recovers fast" from "we overcharged the set".
 */
import { describe, expect, it } from "vitest";
import { observations, recordCheckin, refit, view } from "../src/index.js";
import { addHours, iso } from "../src/time.js";
import { world } from "./helpers.js";
import type { Snapshot } from "../src/types.js";

const T0 = new Date("2026-10-01T06:00:00Z"); // 09:00 Bucharest

/** One set of push-ups that the model charges 100 points of chest wear. */
function loadedChest(): Snapshot {
  const snap = world(T0);
  snap.wearEvents.push({
    roundKey: "r1",
    exerciseSlug: "pushups",
    muscleSlug: "chest",
    reps: 20,
    predicted: 100,
    observed: null,
    at: iso(T0),
  });
  return snap;
}

/** Delays and the soreness level a 24 h half-life would produce for a dose of 100:
 *  12 h -> ~71 (level 4 = 75), 24 h -> 50 (level 3), 36 h -> ~35 (level 2 = 25),
 *  48 h -> 25 (level 2). */
const DELAYS = [12, 13, 24, 25, 36, 37, 48, 47];
const LEVEL: Record<number, number> = { 12: 4, 13: 4, 24: 3, 25: 3, 36: 2, 37: 2, 48: 2, 47: 2 };

function answerMornings(from: Snapshot): Snapshot {
  let snap = from;
  for (const delay of DELAYS) {
    const at = addHours(T0, delay);
    snap = recordCheckin(snap, { kind: "gate", muscleSoreness: { chest: LEVEL[delay]! } }, at).snapshot;
  }
  return snap;
}

describe("the morning answer is what fits the decay rate", () => {
  it("a gate report becomes an observation with a real gap and no RIR", () => {
    const snap = answerMornings(loadedChest());
    const rows = observations(snap).filter((o) => o.muscle === "chest");
    expect(rows).toHaveLength(DELAYS.length);
    expect(rows.every((o) => o.source === "gate")).toBe(true);
    expect(rows.every((o) => o.rir === null)).toBe(true);
    expect(rows.map((o) => Math.round(o.hours)).sort((a, b) => a - b))
      .toEqual([12, 13, 24, 25, 36, 37, 47, 48]);
  });

  it("after eight daily answers the half-life fits to 24 h", () => {
    const snap = answerMornings(loadedChest());
    const summary = refit(snap, addHours(T0, 49)).summary;
    expect(summary.wear_half_life.fitted).toBe(true);
    expect(summary.wear_half_life.value).toBe(24);
    expect(summary.wear_half_life.n).toBeGreaterThanOrEqual(8);
  });

  it("the same reports filed after the set (minutes, not hours) never fit", () => {
    // a post-set answer needs a real round and its wear events
    const base = loadedChest();
    base.rounds.push({
      key: "r1", sentAt: iso(T0), sentLocalDate: "2026-10-01",
      deadlineAt: iso(addHours(T0, 0.16)), resolvedAt: iso(T0), status: "done",
      bonusApplied: 0, targetReps: 20, source: "web",
      items: [{ exerciseSlug: "pushups", exerciseName: "Push-ups", reps: 20 }],
    });
    let snap = base;
    for (let day = 0; day < 4; day += 1) {
      const at = addHours(T0, day * 24 + 0.05);
      snap = recordCheckin(
        snap,
        { kind: "post", roundKey: "r1", rir: 1, muscleSoreness: { chest: 4 } },
        at,
      ).snapshot;
      break; // one answer per round is the rule; the point is the gap, not the count
    }
    const summary = refit(snap, addHours(T0, 1)).summary;
    expect(summary.wear_half_life.fitted).toBe(false);
    expect(summary.wear_half_life.value).toBe(40);
  });

  it("a gate answer refits immediately, and one answer does not teleport the value", () => {
    const first = recordCheckin(loadedChest(), { kind: "gate", muscleSoreness: { chest: 4 } }, addHours(T0, 12));
    // one observation is not evidence: the prior holds until the fit has enough of them
    expect(first.snapshot.profile.wear_half_life).toBe(40);
    expect(first.result.profile?.wear_half_life.fitted).toBe(false);

    const snap = answerMornings(loadedChest());
    expect(snap.profile.wear_half_life).toBe(24);
  });
});

describe("the gate asks about the right muscles", () => {
  it("lists recently loaded muscles, most loaded first, and forgets the answered one", () => {
    const snap = loadedChest();
    const todo = view(snap, addHours(T0, 12)).checkinTodo;
    expect(todo.askMuscles[0]?.slug).toBe("chest");
    expect(todo.askMuscles[0]?.hoursAgo).toBe(12);
    expect(todo.askMuscles.length).toBeGreaterThan(0);
    expect(todo.askMuscles.length).toBeLessThanOrEqual(6);

    const answered = recordCheckin(snap, { kind: "gate", muscleSoreness: { chest: 4 } }, addHours(T0, 12)).snapshot;
    const after = view(answered, addHours(T0, 12.5)).checkinTodo;
    expect(after.askMuscles.map((m) => m.slug)).not.toContain("chest");
  });

  it("asks nothing about a muscle that has not been loaded in two days", () => {
    const snap = loadedChest();
    const later = view(snap, addHours(T0, 60)).checkinTodo;
    expect(later.askMuscles.map((m) => m.slug)).not.toContain("chest");
  });
});
