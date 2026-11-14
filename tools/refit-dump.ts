/** What refit() decides for a database — diff it against muscles.refit().
 *
 * Run: apps/server/node_modules/.bin/tsx tools/refit-dump.ts <db> [iso-now]
 */
import { loadSnapshot, openDatabase } from "../packages/db/src/index.js";
import { refit } from "../packages/engine/src/index.js";

const db = openDatabase(process.argv[2]!);
const now = new Date(process.argv[3] ?? "2026-11-30T09:00:00Z");
const result = refit(loadSnapshot(db, now), now);

console.log(JSON.stringify({
  summary: result.summary,
  profile: result.profile,
  stops: result.muscles.filter((m) => Math.round(m.stopAt) !== 80).map((m) => [m.slug, Math.round(m.stopAt)]),
  k: loadSnapshot(db, now).attribution.map((a) => [`${a.exerciseSlug}/${a.muscleSlug}`, Number(a.k.toFixed(6)), a.exposure]),
}, null, 1));
