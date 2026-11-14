import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initFresh, loadAttribution, loadSnapshot, migrate, openDatabase, saveSettings } from "../src/index.js";

const NOW = new Date("2026-11-14T08:00:00Z");
const dirs: string[] = [];

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "getfit-db-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "test.db"));
  migrate(db);
  initFresh(db, NOW);
  return db;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the database layer", () => {
  it("a fresh database seeds settings, the starter stack, 22 muscles and the priors", () => {
    const db = freshDb();
    const snap = loadSnapshot(db, NOW);
    expect(snap.exercises.map((e) => e.id)).toEqual(["pushups", "squats"]);
    expect(snap.muscles).toHaveLength(22);
    expect(Object.keys(snap.profile).sort()).toEqual(
      ["readiness_influence", "stop_base", "wear_half_life"],
    );
    expect(snap.clock.nextSetAt).not.toBeNull();
    expect(loadAttribution(db).filter((a) => a.exerciseSlug === "pushups")).toHaveLength(7);
    db.close();
  });

  it("migrate() is idempotent", () => {
    const db = freshDb();
    const again = migrate(db);
    expect(again.added).toEqual([]);
    db.close();
  });

  it("an old schema gains form_url and local_date without losing rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "getfit-old-"));
    dirs.push(dir);
    const legacy = new DatabaseSync(join(dir, "old.db"));
    // the pre-2026-11 shape: no form_url, no local_date
    legacy.exec(`
      CREATE TABLE exercises (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL, min_reps INTEGER NOT NULL, max_reps INTEGER, position INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, retired_at TEXT);
      CREATE TABLE checkins (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, at TEXT NOT NULL,
        round_key TEXT, sleep INTEGER, prs INTEGER, pain INTEGER NOT NULL DEFAULT 0, per_muscle TEXT);
      INSERT INTO exercises (slug, name, min_reps, max_reps, position, created_at)
        VALUES ('pushups', 'Push-ups', 10, 20, 0, '2026-10-01T00:00:00Z');
      INSERT INTO checkins (kind, at) VALUES ('gate', '2026-10-01T00:00:00Z');
    `);
    legacy.close();

    const db = openDatabase(join(dir, "old.db"));
    const { added } = migrate(db);
    expect(added).toEqual(["exercises.form_url", "checkins.local_date"]);
    const ex = db.prepare("SELECT slug, form_url FROM exercises").get() as { slug: string; form_url: string | null };
    expect(ex.slug).toBe("pushups");
    const checkin = db.prepare("SELECT local_date FROM checkins").get() as { local_date: string | null };
    expect(checkin.local_date).toBeNull();
    db.close();
  });

  it("saving settings adds, reorders and retires", () => {
    const db = freshDb();
    saveSettings(db, {
      timezone: "Europe/Bucharest",
      intervalMinutes: 45,
      responseMinutes: 10,
      quietStart: "00:00",
      quietEnd: "07:00",
      exercises: [
        { id: "squats", name: "Squats", min: 5, max: null },
        { id: null, name: "Zercher carry", min: 5, max: null },
      ],
    }, NOW);

    const snap = loadSnapshot(db, NOW);
    expect(snap.settings.intervalMinutes).toBe(45);
    expect(snap.exercises.map((e) => e.id)).toEqual(["squats", "zercher-carry"]);
    const retired = db.prepare("SELECT active FROM exercises WHERE slug = 'pushups'").get() as { active: number };
    expect(retired.active).toBe(0);
    // the last exercise is always the uncapped sink
    expect(snap.exercises[1]?.max).toBeNull();
    db.close();
  });
});
