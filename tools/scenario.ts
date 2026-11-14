/** A mock quiz and two weeks of rounds, driven through the real service layer.
 *
 * Run: apps/server/node_modules/.bin/tsx tools/scenario.ts [db-path]
 *
 * Prints JSON: the gate in → readiness/stop line/assignment out, then what the
 * calibration loop did to the profile and to each pair's k. Nothing here touches
 * a live database; it makes a fresh one unless you pass a path.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initFresh, migrate, openDatabase } from "../packages/db/src/index.js";
import { Services } from "../apps/server/src/service.js";

const path = process.argv[2] ?? join(mkdtempSync(join(tmpdir(), "getfit-scenario-")), "scenario.db");
const db = openDatabase(path);
migrate(db);

const start = new Date("2026-10-01T08:00:00Z"); // 11:00 local, past quiet hours
initFresh(db, start);

let clock = start;
const services = new Services(db, () => clock);
const at = (iso: string) => { clock = new Date(iso); };

const summary = (label: string) => {
  const { body } = services.dashboard();
  return {
    label,
    at: clock.toISOString().replace(".000Z", "Z"),
    readiness: Number(body.readiness.score.toFixed(3)),
    stale: body.readiness.stale,
    stopLine: Math.round(body.muscles.find((m) => m.slug === "chest")!.stopAt),
    stopEffective: Math.round(body.muscles.find((m) => m.slug === "chest")!.stopEffective),
    calvesResting: body.muscles.find((m) => m.slug === "calves")!.resting,
    assignment: body.nextAssignment.map((a) => `${a.reps} ${a.name}`).join(", "),
    shut: body.muscles.filter((m) => m.resting || m.load >= m.stopEffective).map((m) => m.slug),
    gateAnswered: Object.keys(body.checkinTodo.gateAnswered).sort(),
  };
};

const out: unknown[] = [];

// ---------------------------------------------------------------- the quiz
out.push(summary("no gate yet"));

at("2026-10-01T08:05:00Z");
services.checkin({ kind: "gate", sleep: 2.5, stress: 5, fatigue: 5, soreness: 5, prs: 2, pain: true, painWhere: "calves" });
out.push(summary("bad day: slept 2.5h, stress 5, fatigue 5, soreness 5, PRS 2, calf pain"));

at("2026-10-02T08:05:00Z");
services.checkin({ kind: "gate", sleep: 8.5, stress: 1, fatigue: 1, soreness: 1, prs: 9, pain: false });
out.push(summary("good day: slept 8.5h, stress 1, fatigue 1, soreness 1, PRS 9"));

at("2026-10-03T08:05:00Z");
services.checkin({ kind: "gate", sleep: 6, stress: 3, fatigue: 3, soreness: 3, prs: 5, pain: false });
out.push(summary("average day: slept 6h, middling Hooper, PRS 5"));

// ------------------------------------------------- two weeks of sets + check-ins
const pairsBefore = new Map<string, number>();
for (const a of services.snapshot().attribution) pairsBefore.set(`${a.exerciseSlug}/${a.muscleSlug}`, a.k);

let rounds = 0;
let checkins = 0;
const refusals: string[] = [];
for (let day = 0; day < 16; day += 1) {
  const morning = new Date(Date.UTC(2026, 9, 4 + day, 8, 0, 0));
  at(morning.toISOString());

  // a gate every morning: alternating good and bad, so readiness is never stale
  const bad = day % 2 === 0;
  services.checkin({
    kind: "gate",
    sleep: bad ? 3 : 8.5,
    stress: bad ? 5 : 1,
    fatigue: bad ? 5 : 1,
    soreness: bad ? 4 : 1,
    prs: bad ? 3 : 9,
    pain: false,
  });

  const tick = services.tick();
  if (!tick.opened) continue;
  rounds += 1;
  const key = tick.opened.key;

  // three answer latencies: on the clock, six hours late, thirteen hours late.
  // the half-life fit only sees observations four hours or more after the dose.
  const lag = [3 * 60_000, 6 * 3600_000, 13 * 3600_000][day % 3] as number;
  at(new Date(morning.getTime() + lag).toISOString());
  services.confirm(key, "scenario");

  at(new Date(clock.getTime() + 60_000).toISOString());
  const worked = [...new Set(
    services.snapshot().wearEvents.filter((e) => e.roundKey === key).map((e) => e.muscleSlug),
  )];
  if (worked.length === 0) continue;

  // alternate the report: a crater (sore, nothing left) and an easy day (fresh),
  // so the ceiling and the k multipliers are pulled in both directions
  const soreness = Object.fromEntries(worked.map((slug) => [slug, day % 2 === 0 ? 5 : 1]));
  try {
    services.checkin({
      kind: "post",
      roundKey: key,
      srpe: 7,
      rir: day % 2 === 0 ? 0 : 3,
      muscleSoreness: soreness,
    });
    checkins += 1;
  } catch (error) {
    refusals.push(`${key}: ${String(error).slice(0, 90)}`);
  }
}

const final = services.dashboard().body;
const pairsAfter = [...services.snapshot().attribution]
  .map((a) => ({ pair: `${a.exerciseSlug}/${a.muscleSlug}`, k: Number(a.k.toFixed(3)), exposure: a.exposure }))
  .filter((row) => {
    const before = pairsBefore.get(row.pair);
    return before !== undefined && Math.abs(before - row.k) > 0.001;
  });

console.log(JSON.stringify({
  db: path,
  rounds,
  postCheckins: checkins,
  refusals,
  quiz: out,
  profile: final.profile.params.map((p) => ({ key: p.key, value: p.value, prior: p.prior, n: p.n, fitted: p.fitted })),
  calibration: final.profile.calibration,
  kMoved: pairsAfter,
  stops: final.muscles
    .filter((m) => m.stopAt !== 80)
    .map((m) => ({ slug: m.slug, stopAt: Math.round(m.stopAt) })),
  readinessNow: Number(final.readiness.score.toFixed(3)),
  totals: { reps: final.lifetime.totalReps, done: final.lifetime.setsDone, missed: final.lifetime.setsMissed },
}, null, 2));
