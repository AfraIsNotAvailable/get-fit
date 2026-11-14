#!/usr/bin/env python3
"""Per-muscle state for get-fit: attribution, decay, exercise selection, calibration.

The model
---------
Each of 22 muscle groups carries two numbers, both in 0..100 wear points:

  wear      mechanical cost of recent work. Half-life 40 h.
  soreness  perceptual residue. Half-life 96 h, and pulled toward whatever the
            user reports at a check-in.

What gates an exercise is ``load = max(wear, soreness)`` — whichever says the
muscle is more spent wins. A muscle stops receiving work at its ``stop_at``
(default 80, lowered on a bad-readiness day) and is preferred again at
``resume_at`` (default 35).

Wear accrues per rep: every (exercise, muscle) pair has its own ``k`` in wear
points per rep. ``k`` starts at ``BASE_K * weight`` and is then *learned* from
check-ins — that learning is the negative feedback loop. The repeated-bout
effect is why early exposures learn faster: an unaccustomed exercise really is
more expensive than the same exercise performed for the tenth time.

References for the numbers are in ``docs/fatigue-model-research.md``.
"""
from __future__ import annotations

import json
import sqlite3
import sys
from datetime import datetime, timedelta, timezone

# ---------------------------------------------------------------- taxonomy
# 22 groups: the 17 of the public exercise datasets, with the deltoid split
# into three heads (+3), serratus anterior split out (+1), and obliques split
# from abdominals (+1).
MUSCLES = [
    ("chest", "Chest", "upper", 1),
    ("anterior-deltoid", "Front delts", "upper", 2),
    ("lateral-deltoid", "Side delts", "upper", 3),
    ("posterior-deltoid", "Rear delts", "upper", 4),
    ("triceps", "Triceps", "upper", 5),
    ("biceps", "Biceps", "upper", 6),
    ("forearms", "Forearms", "upper", 7),
    ("serratus-anterior", "Serratus", "upper", 8),
    ("traps", "Traps", "upper", 9),
    ("lats", "Lats", "upper", 10),
    ("mid-back", "Mid back", "upper", 11),
    ("lower-back", "Lower back", "core", 12),
    ("abs", "Abs", "core", 13),
    ("obliques", "Obliques", "core", 14),
    ("glutes", "Glutes", "lower", 15),
    ("quads", "Quads", "lower", 16),
    ("hamstrings", "Hamstrings", "lower", 17),
    ("adductors", "Adductors", "lower", 18),
    ("abductors", "Abductors", "lower", 19),
    ("hip-flexors", "Hip flexors", "lower", 20),
    ("calves", "Calves", "lower", 21),
    ("neck", "Neck", "upper", 22),
]

MUSCLE_NAME = {m[0]: m[1] for m in MUSCLES}

ROLE_BASE = {"primary": 1.0, "secondary": 0.4, "stabiliser": 0.15}
BASE_K = 1.0                  # wear points per rep at weight 1.00
WEAR_HALF_LIFE_H = 40.0
SORENESS_HALF_LIFE_H = 96.0
WEAR_CAP = 140.0
K_MIN, K_MAX = 0.10, 4.00
STOP_DEFAULT, RESUME_DEFAULT = 80.0, 35.0

# What the model can fit about *this* user, and the prior it starts from. Every
# one of these is a guess until enough check-ins exist; `refit` replaces it.
PROFILE_PRIORS = {
    "wear_half_life": WEAR_HALF_LIFE_H,      # hours to lose half the wear
    "readiness_influence": 20.0,             # points a bad day takes off the ceiling
    "stop_base": STOP_DEFAULT,               # global ceiling before per-muscle evidence
}
HALF_LIFE_GRID = (16.0, 20.0, 24.0, 28.0, 32.0, 36.0, 40.0, 48.0, 56.0, 72.0, 96.0)
MIN_FIT_OBS = 4          # below this, a fitted parameter is noise dressed as knowledge
MIN_HALF_LIFE_OBS = 8    # a 5-point soreness scale needs company before it says anything
MIN_HALF_LIFE_BUCKETS = 2
BUCKET_H = 6.0           # "how long after the set" grouped into 6-hour buckets


class CheckinRefused(ValueError):
    """A questionnaire the model will not accept, with the HTTP code it deserves."""

    def __init__(self, message: str, code: int = 409):
        super().__init__(message)
        self.code = code

# a reported 1..5 maps onto an implied wear level, used only to compare
# against what the model predicted (soreness is a noisy sensor, not a gauge)
SORENESS_TO_WEAR = {1: 0.0, 2: 25.0, 3: 50.0, 4: 75.0, 5: 100.0}

# ---------------------------------------------------------------- library
# Attribution for the exercises this app is likely to see. Weights are
# fractions of the exercise's own rep, so a push-up debits the chest 1.00 and
# the triceps 0.60 of one "chest point" per rep. These are priors: the
# calibration loop moves each pair's k away from them.
LIBRARY = {
    "pushups": ("Push-ups", [
        ("chest", "primary", 1.00), ("triceps", "primary", 0.60),
        ("anterior-deltoid", "primary", 0.45), ("serratus-anterior", "secondary", 0.35),
        ("abs", "secondary", 0.25), ("obliques", "stabiliser", 0.20),
        ("forearms", "stabiliser", 0.10)]),
    "incline-pushups": ("Incline push-ups", [
        ("chest", "primary", 0.80), ("anterior-deltoid", "primary", 0.50),
        ("triceps", "primary", 0.45), ("serratus-anterior", "secondary", 0.30),
        ("abs", "stabiliser", 0.18)]),
    "diamond-pushups": ("Diamond push-ups", [
        ("triceps", "primary", 1.00), ("chest", "primary", 0.70),
        ("anterior-deltoid", "secondary", 0.35), ("serratus-anterior", "secondary", 0.25),
        ("abs", "stabiliser", 0.20), ("forearms", "stabiliser", 0.12)]),
    "pike-pushups": ("Pike push-ups", [
        ("anterior-deltoid", "primary", 1.00), ("triceps", "primary", 0.55),
        ("chest", "secondary", 0.40), ("traps", "secondary", 0.30),
        ("serratus-anterior", "secondary", 0.30), ("abs", "stabiliser", 0.20)]),
    "dips": ("Dips", [
        ("triceps", "primary", 1.00), ("chest", "primary", 0.80),
        ("anterior-deltoid", "primary", 0.45), ("serratus-anterior", "secondary", 0.25),
        ("abs", "stabiliser", 0.15)]),
    "squats": ("Squats", [
        ("quads", "primary", 1.00), ("glutes", "primary", 0.60),
        ("adductors", "secondary", 0.35), ("lower-back", "stabiliser", 0.30),
        ("hamstrings", "secondary", 0.25), ("abs", "stabiliser", 0.20),
        ("calves", "stabiliser", 0.15)]),
    "split-squats": ("Split squats", [
        ("quads", "primary", 1.00), ("glutes", "primary", 0.70),
        ("hamstrings", "secondary", 0.35), ("adductors", "secondary", 0.30),
        ("calves", "stabiliser", 0.15), ("abs", "stabiliser", 0.15)]),
    "lunges": ("Lunges", [
        ("quads", "primary", 1.00), ("glutes", "primary", 0.65),
        ("hamstrings", "secondary", 0.30), ("adductors", "secondary", 0.30),
        ("abs", "stabiliser", 0.20), ("calves", "stabiliser", 0.15)]),
    "step-ups": ("Step-ups", [
        ("quads", "primary", 1.00), ("glutes", "primary", 0.65),
        ("hamstrings", "secondary", 0.25), ("calves", "secondary", 0.20),
        ("abs", "stabiliser", 0.15)]),
    "jump-squats": ("Jump squats", [
        ("quads", "primary", 1.00), ("glutes", "primary", 0.70),
        ("calves", "primary", 0.50), ("hamstrings", "secondary", 0.30),
        ("abs", "stabiliser", 0.20)]),
    "wall-sit": ("Wall sit", [
        ("quads", "primary", 1.00), ("glutes", "secondary", 0.30),
        ("abs", "stabiliser", 0.20), ("calves", "stabiliser", 0.15)]),
    "glute-bridge": ("Glute bridge", [
        ("glutes", "primary", 1.00), ("hamstrings", "primary", 0.50),
        ("lower-back", "secondary", 0.25), ("abs", "stabiliser", 0.20),
        ("adductors", "stabiliser", 0.15)]),
    "hip-thrust": ("Hip thrust", [
        ("glutes", "primary", 1.00), ("hamstrings", "primary", 0.45),
        ("quads", "secondary", 0.30), ("abs", "stabiliser", 0.20),
        ("lower-back", "stabiliser", 0.20)]),
    "calf-raises": ("Calf raises", [
        ("calves", "primary", 1.00), ("hamstrings", "stabiliser", 0.15),
        ("quads", "stabiliser", 0.10)]),
    "pull-ups": ("Pull-ups", [
        ("lats", "primary", 1.00), ("biceps", "primary", 0.60),
        ("mid-back", "primary", 0.45), ("forearms", "secondary", 0.30),
        ("posterior-deltoid", "secondary", 0.25), ("abs", "stabiliser", 0.15)]),
    "chin-ups": ("Chin-ups", [
        ("biceps", "primary", 1.00), ("lats", "primary", 0.90),
        ("mid-back", "secondary", 0.40), ("forearms", "secondary", 0.30),
        ("chest", "stabiliser", 0.15)]),
    "inverted-rows": ("Inverted rows", [
        ("mid-back", "primary", 1.00), ("lats", "primary", 0.55),
        ("biceps", "primary", 0.45), ("posterior-deltoid", "secondary", 0.35),
        ("forearms", "secondary", 0.25), ("abs", "stabiliser", 0.20)]),
    "lateral-raises": ("Lateral raises", [
        ("lateral-deltoid", "primary", 1.00), ("traps", "secondary", 0.30),
        ("anterior-deltoid", "stabiliser", 0.15), ("forearms", "stabiliser", 0.10)]),
    "plank": ("Plank", [
        ("abs", "primary", 1.00), ("obliques", "primary", 0.50),
        ("lower-back", "secondary", 0.30), ("glutes", "stabiliser", 0.20),
        ("serratus-anterior", "stabiliser", 0.20), ("hip-flexors", "stabiliser", 0.15)]),
    "side-plank": ("Side plank", [
        ("obliques", "primary", 1.00), ("abs", "primary", 0.40),
        ("abductors", "secondary", 0.35), ("glutes", "stabiliser", 0.20),
        ("serratus-anterior", "stabiliser", 0.20)]),
    "hollow-hold": ("Hollow hold", [
        ("abs", "primary", 1.00), ("hip-flexors", "primary", 0.55),
        ("obliques", "secondary", 0.40), ("quads", "stabiliser", 0.20)]),
    "dead-bug": ("Dead bug", [
        ("abs", "primary", 1.00), ("hip-flexors", "secondary", 0.40),
        ("obliques", "secondary", 0.35), ("lower-back", "stabiliser", 0.20)]),
    "leg-raises": ("Leg raises", [
        ("abs", "primary", 1.00), ("hip-flexors", "primary", 0.70),
        ("obliques", "secondary", 0.30), ("quads", "stabiliser", 0.15)]),
    "russian-twists": ("Russian twists", [
        ("obliques", "primary", 1.00), ("abs", "primary", 0.60),
        ("hip-flexors", "secondary", 0.25), ("forearms", "stabiliser", 0.10)]),
    "mountain-climbers": ("Mountain climbers", [
        ("abs", "primary", 0.80), ("hip-flexors", "primary", 0.70),
        ("anterior-deltoid", "primary", 0.40), ("quads", "secondary", 0.30),
        ("obliques", "secondary", 0.30), ("forearms", "stabiliser", 0.15)]),
    "superman": ("Superman", [
        ("lower-back", "primary", 1.00), ("glutes", "primary", 0.50),
        ("hamstrings", "secondary", 0.35), ("traps", "secondary", 0.25),
        ("posterior-deltoid", "stabiliser", 0.15)]),
    "burpees": ("Burpees", [
        ("quads", "primary", 0.70), ("chest", "primary", 0.55),
        ("anterior-deltoid", "primary", 0.45), ("triceps", "secondary", 0.40),
        ("abs", "secondary", 0.40), ("glutes", "secondary", 0.30),
        ("calves", "stabiliser", 0.20), ("hip-flexors", "stabiliser", 0.20)]),
    "jumping-jacks": ("Jumping jacks", [
        ("calves", "primary", 0.60), ("lateral-deltoid", "primary", 0.50),
        ("quads", "secondary", 0.30), ("hip-flexors", "secondary", 0.25),
        ("abs", "stabiliser", 0.15)]),
    "high-knees": ("High knees", [
        ("hip-flexors", "primary", 0.80), ("quads", "primary", 0.60),
        ("calves", "secondary", 0.45), ("abs", "secondary", 0.30),
        ("lateral-deltoid", "stabiliser", 0.15)]),
}

# Verified form articles (checked: HTTP 200, page title matches the movement).
# Split squats and leg raises are deliberately absent — there is no page here
# that was worth vouching for, and the dashboard shows a missing one in red
# rather than sending the user to a wrong article.
FORM_URLS = {
    "pushups": "https://en.wikipedia.org/wiki/Push-up",
    "squats": "https://en.wikipedia.org/wiki/Squat_(exercise)",
    "diamond-pushups": "https://www.healthline.com/health/fitness-exercise/push-ups-for-triceps",
    "pike-pushups": "https://www.healthline.com/health/fitness/bodyweight-shoulder-exercises",
    "glute-bridge": "https://www.acefitness.org/resources/everyone/exercise-library/49/glute-bridge/",
    "calf-raises": "https://www.acefitness.org/resources/everyone/exercise-library/51/calf-raises",
    "superman": "https://www.acefitness.org/resources/everyone/exercise-library/9/supermans",
    "dead-bug": "https://www.healthline.com/health/exercise-fitness/dead-bug-exercise",
    "mountain-climbers": "https://www.acefitness.org/resources/everyone/exercise-library/258/mountain-climbers",
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS muscles (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  region TEXT NOT NULL,
  sort INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS profile (
  key TEXT PRIMARY KEY,
  value REAL NOT NULL,
  prior REAL NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS muscle_state (
  muscle_slug TEXT PRIMARY KEY REFERENCES muscles(slug),
  wear REAL NOT NULL DEFAULT 0,
  soreness REAL NOT NULL DEFAULT 0,
  stop_at REAL NOT NULL DEFAULT 80,
  resume_at REAL NOT NULL DEFAULT 35,
  rest_until TEXT,
  last_loaded_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exercise_muscles (
  exercise_slug TEXT NOT NULL,
  muscle_slug TEXT NOT NULL REFERENCES muscles(slug),
  role TEXT NOT NULL,
  weight REAL NOT NULL,
  k REAL NOT NULL,
  exposure INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (exercise_slug, muscle_slug)
);

CREATE TABLE IF NOT EXISTS wear_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_key TEXT NOT NULL,
  exercise_slug TEXT NOT NULL,
  muscle_slug TEXT NOT NULL,
  reps INTEGER NOT NULL,
  predicted REAL NOT NULL,
  observed REAL,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  at TEXT NOT NULL,
  local_date TEXT,
  round_key TEXT,
  sleep INTEGER, stress INTEGER, fatigue INTEGER, soreness INTEGER,
  prs INTEGER,
  pain INTEGER NOT NULL DEFAULT 0, pain_where TEXT,
  srpe INTEGER, rir INTEGER, stopper TEXT,
  per_muscle TEXT,
  readiness REAL,
  note TEXT
);

CREATE INDEX IF NOT EXISTS idx_checkins_at ON checkins(at);
CREATE TABLE IF NOT EXISTS profile_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  key TEXT NOT NULL,
  value REAL NOT NULL,
  previous REAL,
  n INTEGER NOT NULL,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_profile_history_at ON profile_history(at);
CREATE INDEX IF NOT EXISTS idx_wear_at ON wear_events(at);
CREATE INDEX IF NOT EXISTS idx_wear_round ON wear_events(round_key);
CREATE INDEX IF NOT EXISTS idx_em_ex ON exercise_muscles(exercise_slug);
"""


# ---------------------------------------------------------------- helpers
def _now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse(value) -> datetime:
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def _norm(text: str) -> str:
    return "".join(ch for ch in str(text).lower() if ch.isalnum())


_LIB_BY_KEY = {_norm(slug): slug for slug in LIBRARY}
_LIB_BY_KEY.update({_norm(name): slug for slug, (name, _) in LIBRARY.items()})


def resolve(slug: str, name: str = "") -> str | None:
    """Map an exercise row onto a library key, by slug or by normalised name."""
    for candidate in (slug, name):
        if not candidate:
            continue
        if candidate in LIBRARY:
            return candidate
        key = _LIB_BY_KEY.get(_norm(candidate))
        if key:
            return key
    return None


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


# ---------------------------------------------------------------- seeding
def seed(db: sqlite3.Connection) -> None:
    """Create the tables, the taxonomy, and attribution for every exercise row."""
    db.executescript(SCHEMA)
    cols = {row["name"] for row in db.execute("PRAGMA table_info(checkins)")}
    if "local_date" not in cols:
        db.execute("ALTER TABLE checkins ADD COLUMN local_date TEXT")
    db.execute("CREATE INDEX IF NOT EXISTS idx_checkins_day ON checkins(local_date)")
    stamp = _iso(_now())
    for slug, name, region, sort in MUSCLES:
        db.execute("INSERT OR IGNORE INTO muscles (slug, name, region, sort) VALUES (?,?,?,?)",
                   (slug, name, region, sort))
        db.execute(
            "INSERT OR IGNORE INTO muscle_state"
            " (muscle_slug, wear, soreness, stop_at, resume_at, updated_at) VALUES (?,0,0,?,?,?)",
            (slug, STOP_DEFAULT, RESUME_DEFAULT, stamp))
    for key, prior in PROFILE_PRIORS.items():
        db.execute("INSERT OR IGNORE INTO profile (key, value, prior, n, updated_at)"
                   " VALUES (?,?,?,0,?)", (key, prior, prior, stamp))
    seed_attribution(db)
    db.commit()


def profile_get(db: sqlite3.Connection, key: str) -> float:
    row = db.execute("SELECT value FROM profile WHERE key=?", (key,)).fetchone()
    return float(row["value"]) if row else float(PROFILE_PRIORS.get(key, 0.0))


def profile_rows(db: sqlite3.Connection) -> list[dict]:
    out = []
    for row in db.execute("SELECT * FROM profile ORDER BY key").fetchall():
        out.append({"key": row["key"], "value": round(row["value"], 2),
                    "prior": round(row["prior"], 2), "n": row["n"],
                    "fitted": row["n"] >= MIN_FIT_OBS,
                    "updated_at": row["updated_at"]})
    return out


def seed_attribution(db: sqlite3.Connection) -> list[str]:
    """Attach library attribution to every exercise that has none yet.

    Returns the names it could not attribute, so the dashboard can show them —
    an exercise without attribution is invisible to the fatigue model, which
    is the one failure mode that would silently break the whole thing.
    """
    stamp = _iso(_now())
    missing: list[str] = []
    has_url = "form_url" in {row["name"] for row in db.execute("PRAGMA table_info(exercises)")}
    rows = db.execute("SELECT slug, name FROM exercises").fetchall()
    for row in rows:
        slug, name = row["slug"], row["name"]
        key = resolve(slug, name)
        if key and has_url and key in FORM_URLS:
            db.execute("UPDATE exercises SET form_url=? WHERE slug=?"
                       " AND (form_url IS NULL OR form_url='')", (FORM_URLS[key], slug))
        have = db.execute("SELECT 1 FROM exercise_muscles WHERE exercise_slug=? LIMIT 1", (slug,)).fetchone()
        if have:
            continue
        if not key:
            missing.append(name)
            continue
        for muscle, role, weight in LIBRARY[key][1]:
            db.execute(
                "INSERT OR IGNORE INTO exercise_muscles"
                " (exercise_slug, muscle_slug, role, weight, k, exposure, updated_at)"
                " VALUES (?,?,?,?,?,0,?)",
                (slug, muscle, role, weight, BASE_K * weight, stamp))
    db.commit()
    return missing


def unattributed(db: sqlite3.Connection) -> list[dict]:
    return [dict(r) for r in db.execute(
        "SELECT e.slug, e.name FROM exercises e WHERE e.active=1 AND NOT EXISTS"
        " (SELECT 1 FROM exercise_muscles m WHERE m.exercise_slug=e.slug)"
        " ORDER BY e.position").fetchall()]


def attribution(db: sqlite3.Connection, exercise_slug: str) -> list[dict]:
    rows = db.execute(
        "SELECT em.*, m.name AS muscle_name FROM exercise_muscles em"
        " JOIN muscles m ON m.slug=em.muscle_slug"
        " WHERE em.exercise_slug=? ORDER BY em.weight DESC, m.sort", (exercise_slug,)).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------- decay
def decay(db: sqlite3.Connection, now: datetime | None = None) -> None:
    """Apply exponential decay to every muscle since it was last touched.

    Lazy: nothing schedules this. Each row remembers when it was written, so a
    read after any silence is as accurate as a continuous simulation. Does not
    commit — callers decide.
    """
    now = now or _now()
    half_life = profile_get(db, "wear_half_life") or WEAR_HALF_LIFE_H
    for row in db.execute("SELECT * FROM muscle_state").fetchall():
        last = _parse(row["updated_at"]) if row["updated_at"] else now
        hours = (now - last).total_seconds() / 3600.0
        if hours < 0.5:
            continue
        wear = row["wear"] * (0.5 ** (hours / half_life))
        sore = row["soreness"] * (0.5 ** (hours / SORENESS_HALF_LIFE_H))
        db.execute("UPDATE muscle_state SET wear=?, soreness=?, updated_at=? WHERE muscle_slug=?",
                   (wear, sore, _iso(now), row["muscle_slug"]))


def snapshot(db: sqlite3.Connection, now: datetime | None = None, do_decay: bool = True) -> list[dict]:
    now = now or _now()
    if do_decay:
        decay(db, now)
    rows = db.execute(
        "SELECT s.*, m.name, m.region, m.sort FROM muscle_state s"
        " JOIN muscles m ON m.slug=s.muscle_slug ORDER BY m.sort").fetchall()
    out = []
    for r in rows:
        rest_until = r["rest_until"]
        out.append({
            "slug": r["muscle_slug"], "name": r["name"], "region": r["region"], "sort": r["sort"],
            "wear": round(r["wear"], 1), "soreness": round(r["soreness"], 1),
            "load": round(max(r["wear"], r["soreness"]), 1),
            "stop_at": round(r["stop_at"], 1), "resume_at": round(r["resume_at"], 1),
            "last_loaded_at": r["last_loaded_at"],
            "resting": bool(rest_until and _parse(rest_until) > now),
            "rest_until": rest_until,
        })
    out.sort(key=lambda m: (-m["load"], m["sort"]))
    return out


# ---------------------------------------------------------------- accrual
def accrue(db: sqlite3.Connection, round_key: str, items: list[dict],
           now: datetime | None = None) -> list[dict]:
    """Debit wear for a round that was actually performed.

    Returns the ledger rows it wrote, so callers can report what moved.
    """
    now = now or _now()
    decay(db, now)
    stamp = _iso(now)
    written = []
    for item in items:
        pairs = attribution(db, item["id"])
        if not pairs:
            continue
        for p in pairs:
            dose = float(item["reps"]) * float(p["k"])
            db.execute(
                "UPDATE muscle_state SET wear=MIN(?, wear + ?), last_loaded_at=?, updated_at=?"
                " WHERE muscle_slug=?", (WEAR_CAP, dose, stamp, stamp, p["muscle_slug"]))
            db.execute(
                "INSERT INTO wear_events (round_key, exercise_slug, muscle_slug, reps, predicted, at)"
                " VALUES (?,?,?,?,?,?)",
                (round_key, item["id"], p["muscle_slug"], int(item["reps"]), dose, stamp))
            db.execute(
                "UPDATE exercise_muscles SET exposure=exposure+1, updated_at=?"
                " WHERE exercise_slug=? AND muscle_slug=?",
                (stamp, item["id"], p["muscle_slug"]))
            written.append({"exercise": item["id"], "muscle": p["muscle_slug"],
                            "reps": int(item["reps"]), "wear": round(dose, 1)})
    return written


def round_muscles(db: sqlite3.Connection, round_key: str) -> list[str]:
    """Muscle slugs a round actually loaded, hottest contribution first."""
    rows = db.execute(
        "SELECT muscle_slug, SUM(predicted) total FROM wear_events WHERE round_key=?"
        " GROUP BY muscle_slug ORDER BY total DESC", (round_key,)).fetchall()
    return [r["muscle_slug"] for r in rows]


def backfill(db: sqlite3.Connection, now: datetime | None = None) -> int:
    """Replay performed rounds that predate the model, chronologically.

    Idempotent — a round that already has wear events is skipped — so this can
    run on every init. Without it the model starts blind on an existing log and
    calls a fresh morning after sixty-five push-ups.
    """
    now = now or _now()
    rows = db.execute(
        "SELECT r.round_key, r.resolved_at FROM rounds r"
        " WHERE r.status IN ('done','late') AND r.resolved_at IS NOT NULL"
        " AND NOT EXISTS (SELECT 1 FROM wear_events w WHERE w.round_key = r.round_key)"
        " ORDER BY r.resolved_at, r.id").fetchall()
    if not rows:
        return 0
    for row in rows:
        at = _parse(row["resolved_at"])
        items = [dict(r) for r in db.execute(
            "SELECT ri.exercise_slug AS id, ri.reps AS reps FROM round_items ri"
            " JOIN rounds r ON r.id = ri.round_id WHERE r.round_key = ? ORDER BY ri.id",
            (row["round_key"],)).fetchall()]
        if items:
            accrue(db, row["round_key"], items, at)
    decay(db, now)
    db.commit()
    return len(rows)


# ---------------------------------------------------------------- readiness
def latest_gate(db: sqlite3.Connection) -> dict | None:
    row = db.execute("SELECT * FROM checkins WHERE kind='gate' ORDER BY id DESC LIMIT 1").fetchone()
    return dict(row) if row else None


def post_window(db: sqlite3.Connection, now: datetime | None = None,
                window_minutes: int = 10) -> dict | None:
    """The one round that is answerable right now, and when that window shuts.

    A post-set answer is a measurement, not a form: it is only valid straight
    after the set it describes, and only once. Both `build_checkin` (what the
    dashboard offers) and `record_checkin` (what the server accepts) go through
    here, so the pop-up and the rule can never disagree.
    """
    now = now or _now()
    row = db.execute(
        "SELECT * FROM rounds WHERE status IN ('done','late') AND resolved_at IS NOT NULL"
        " ORDER BY resolved_at DESC, id DESC LIMIT 1").fetchone()
    if not row:
        return None
    if db.execute("SELECT 1 FROM checkins WHERE kind='post' AND round_key=?",
                  (row["round_key"],)).fetchone():
        return None
    start = _parse(row["resolved_at"])
    end = start + timedelta(minutes=max(1, int(window_minutes)))
    if now < start or now > end:
        return None
    return {"round": dict(row), "opens_at": start, "expires_at": end,
            "seconds_left": max(0, int((end - now).total_seconds()))}


def gate_today(db: sqlite3.Connection, now: datetime | None = None,
               tz=None) -> dict:
    """Today's gate answers, merged per question.

    Each question is answered once a day, so several partial submissions are
    normal; the latest non-empty answer wins for each field.
    """
    now = now or _now()
    day = now.astimezone(tz).date().isoformat() if tz else now.date().isoformat()
    out: dict = {"at": None, "sleep": None, "stress": None, "fatigue": None,
                 "soreness": None, "prs": None, "pain": None, "pain_where": None}
    for row in db.execute("SELECT * FROM checkins WHERE kind='gate'"
                          " ORDER BY id DESC LIMIT 40").fetchall():
        row_day = row["local_date"] or _parse(row["at"]).date().isoformat()
        if row_day != day:
            continue
        out["at"] = out["at"] or row["at"]
        for key in ("sleep", "stress", "fatigue", "soreness", "prs", "pain", "pain_where"):
            if out[key] is None and row[key] is not None:
                out[key] = row[key]
    return out


def _sleep_score(hours) -> float:
    """Hours of sleep on the 1..5 scale the other Hooper items use (1 = best)."""
    try:
        h = float(hours)
    except (TypeError, ValueError):
        return 3.0
    if h >= 8:
        return 1.0
    if h >= 7:
        return 2.0
    if h >= 6:
        return 3.0
    if h >= 5:
        return 4.0
    return 5.0


def readiness(db: sqlite3.Connection, now: datetime | None = None, tz=None) -> dict:
    """0..1 today's capacity, from today's gate answers.

    Half the signal is the four Hooper items (sleep in hours, converted), half
    is Perceived Recovery Status. Answers older than 18 h are treated as stale:
    a readiness score is a statement about now.
    """
    now = now or _now()
    gate = gate_today(db, now, tz)
    out = {"score": 0.7, "prs": None, "at": None, "stale": True, "pain": False,
           "pain_where": None, "hooper": None, "answers": [k for k in
           ("sleep", "stress", "fatigue", "soreness", "prs") if gate.get(k) is not None]}
    if not gate["at"]:
        return out
    age_h = (now - _parse(gate["at"])).total_seconds() / 3600.0
    if age_h > 18:
        out.update({"at": gate["at"], "prs": gate["prs"], "pain": bool(gate["pain"]),
                    "pain_where": gate["pain_where"]})
        return out

    items = []
    if gate["sleep"] is not None:
        items.append(_sleep_score(gate["sleep"]))
    items += [gate[k] for k in ("stress", "fatigue", "soreness") if gate[k] is not None]
    hooper = sum(items) / len(items) if items else 3.0          # 1 best .. 5 worst
    score_hooper = _clamp((5.0 - hooper) / 4.0, 0.0, 1.0)
    score_prs = _clamp((gate["prs"] if gate["prs"] is not None else 6) / 10.0, 0.0, 1.0)
    score = 0.5 * score_hooper + 0.5 * score_prs
    if gate["pain"]:
        score = min(score, 0.35)
    out.update({"score": round(score, 3), "prs": gate["prs"], "at": gate["at"],
                "stale": False, "pain": bool(gate["pain"]), "pain_where": gate["pain_where"],
                "hooper": round(hooper, 2)})
    return out


def effective_stop(stop_at: float, ready: float, influence: float = 20.0) -> float:
    """A bad day lowers the ceiling; a good day never raises it past the model's."""
    return max(30.0, float(stop_at) - (1.0 - _clamp(ready, 0.0, 1.0)) * influence)


# ---------------------------------------------------------------- fitting
def observations(db: sqlite3.Connection) -> list[dict]:
    """Every (muscle, dose, when, reported) pair a post-set check-in produced.

    The raw material for the profile: what the model thought a round cost, when
    it cost it, and what the body said afterwards.
    """
    out = []
    for row in db.execute(
            "SELECT id, at, round_key, rir, per_muscle FROM checkins"
            " WHERE kind='post' AND per_muscle IS NOT NULL ORDER BY id").fetchall():
        try:
            reported = json.loads(row["per_muscle"] or "{}")
        except ValueError:
            continue
        for muscle, level in reported.items():
            dose = db.execute(
                "SELECT SUM(predicted) d, MIN(at) t0 FROM wear_events"
                " WHERE round_key=? AND muscle_slug=?", (row["round_key"], muscle)).fetchone()
            if not dose or not dose["t0"] or float(dose["d"] or 0.0) < 1.0:
                continue
            t0, t1 = _parse(dose["t0"]), _parse(row["at"])
            try:
                level = int(level)
            except (TypeError, ValueError):
                continue
            if level not in SORENESS_TO_WEAR:
                continue
            out.append({"checkin": row["id"], "muscle": muscle, "round": row["round_key"],
                        "dose": float(dose["d"]), "t0": t0, "t1": t1,
                        "hours": (t1 - t0).total_seconds() / 3600.0,
                        "reported": SORENESS_TO_WEAR[level], "level": level,
                        "rir": row["rir"]})
    return out


def _predicted(obs: dict, half_life: float) -> float:
    return obs["dose"] * (0.5 ** (obs["hours"] / half_life))


def _median(values: list[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    mid = len(ordered) // 2
    return ordered[mid] if len(ordered) % 2 else 0.5 * (ordered[mid - 1] + ordered[mid])


def _store(db: sqlite3.Connection, key: str, value: float, n: int, stamp: str,
           reason: str = "") -> None:
    """Write a fitted parameter, and keep a dated record of every real move.

    The log is the point: while the model is being ironed out, the question is
    always "what did it believe last week, and what changed it".
    """
    prev = db.execute("SELECT value, n FROM profile WHERE key=?", (key,)).fetchone()
    db.execute(
        "INSERT INTO profile (key, value, prior, n, updated_at) VALUES (?,?,?,?,?)"
        " ON CONFLICT(key) DO UPDATE SET value=excluded.value, n=excluded.n,"
        " updated_at=excluded.updated_at",
        (key, value, PROFILE_PRIORS[key], n, stamp))
    if prev is None or abs(float(prev["value"]) - float(value)) > 0.009:
        db.execute(
            "INSERT INTO profile_history (at, key, value, previous, n, reason)"
            " VALUES (?,?,?,?,?,?)",
            (stamp, key, value, float(prev["value"]) if prev else None, n,
             reason or ("fitted" if n >= MIN_FIT_OBS else "prior")))


def profile_history(db: sqlite3.Connection, limit: int = 40) -> list[dict]:
    return [{"at": r["at"], "key": r["key"], "value": r["value"],
             "previous": r["previous"], "n": r["n"], "reason": r["reason"]}
            for r in db.execute("SELECT * FROM profile_history ORDER BY id DESC LIMIT ?",
                                (limit,)).fetchall()]


def calibration(db: sqlite3.Connection) -> dict:
    """How far the model's predicted wear sits from what was reported.

    This is the honest scoreboard: it only falls if the coefficients, the
    decay and the soreness reading are together describing this user.
    """
    obs = observations(db)
    if not obs:
        return {"mae": None, "n": 0, "series": []}
    half = profile_get(db, "wear_half_life")
    by_checkin: dict[int, list[float]] = {}
    for o in obs:
        by_checkin.setdefault(o["checkin"], []).append(abs(_predicted(o, half) - o["reported"]))
    errors = [e for group in by_checkin.values() for e in group]
    series = [{"checkin": key, "error": round(sum(v) / len(v), 1)}
              for key, v in sorted(by_checkin.items())]
    return {"mae": round(sum(errors) / len(errors), 1), "n": len(errors), "series": series[-16:]}


def refit(db: sqlite3.Connection, now: datetime | None = None) -> dict:
    """Re-fit the profile to the accumulated check-ins.

    Stateless: everything is recomputed from the ledger every time, so a bad
    fit cannot compound and there is no high-water mark to get wrong. Below
    MIN_FIT_OBS an observation set reverts to its prior rather than pretending.
    """
    now = now or _now()
    stamp = _iso(now)
    obs = observations(db)
    summary: dict[str, dict] = {}

    # 1. recovery half-life — the grid value whose decay curve matches the reports.
    # Fit on the *fraction* of the dose still reported (reported / dose), so a
    # wrong k cannot masquerade as a wrong recovery rate; and refuse to fit at
    # all unless the answers span several "how long after" buckets, because one
    # bucket cannot separate "recovers fast" from "we overcharged the set".
    timed = [o for o in obs if o["hours"] >= 4.0 and o["reported"] > 0]
    buckets = {round(o["hours"] / BUCKET_H) for o in timed}
    prior = PROFILE_PRIORS["wear_half_life"]
    if len(timed) >= MIN_HALF_LIFE_OBS and len(buckets) >= MIN_HALF_LIFE_BUCKETS:
        best = min(HALF_LIFE_GRID, key=lambda h: _median(
            [abs(o["reported"] / o["dose"] - 0.5 ** (o["hours"] / h)) for o in timed]))
        # a prior with eight data points behind it moves; it does not teleport
        best = _clamp(best, prior * 0.5, prior * 2.0)
        _store(db, "wear_half_life", best, len(timed), stamp)
        summary["wear_half_life"] = {"value": best, "n": len(timed), "fitted": True}
    else:
        _store(db, "wear_half_life", prior, 0, stamp)
        summary["wear_half_life"] = {"value": prior, "n": len(timed), "fitted": False}

    half = profile_get(db, "wear_half_life")
    base = profile_get(db, "stop_base")

    # 2. per-muscle ceiling — where this user's work actually starts to crater
    events: dict[str, list[tuple[datetime, float]]] = {}
    for row in db.execute("SELECT muscle_slug, at, predicted FROM wear_events"
                          " ORDER BY at, id LIMIT 4000").fetchall():
        events.setdefault(row["muscle_slug"], []).append((_parse(row["at"]), float(row["predicted"])))

    evidence: dict[str, dict] = {}
    for o in obs:
        if o["rir"] is None or o["level"] < 1:
            continue
        state = sum(p * (0.5 ** (((o["t0"] - at).total_seconds() / 3600.0) / half))
                    for at, p in events.get(o["muscle"], []) if at <= o["t0"])
        slot = evidence.setdefault(o["muscle"], {"easy": 0, "crater": 0, "n": 0})
        slot["n"] += 1
        if o["rir"] <= 1 and o["level"] >= 4 and state >= 40:
            slot["crater"] += 1
        elif o["rir"] >= 2 and o["level"] <= 2 and state >= 30:
            slot["easy"] += 1

    moved = 0
    for muscle, slot in evidence.items():
        if slot["n"] >= 3:
            stop = _clamp(base + 2.0 * slot["easy"] - 4.0 * slot["crater"], 60.0, 90.0)
            moved += 1
        else:
            stop = base
        db.execute("UPDATE muscle_state SET stop_at=? WHERE muscle_slug=?", (stop, muscle))
    summary["stop_base"] = {"value": base, "n": moved, "fitted": moved > 0}

    # 3. readiness influence — does a bad gate actually cost this user anything?
    resisted = affected = 0
    for row in db.execute(
            "SELECT r.round_key, r.resolved_at,"
            " (SELECT c.prs FROM checkins c WHERE c.kind='gate' AND c.at < r.resolved_at"
            "  ORDER BY c.at DESC LIMIT 1) prs,"
            " (SELECT c.rir FROM checkins c WHERE c.kind='post' AND c.round_key=r.round_key"
            "  ORDER BY c.id DESC LIMIT 1) rir"
            " FROM rounds r WHERE r.status IN ('done','late') AND r.resolved_at IS NOT NULL"
            " ORDER BY r.resolved_at DESC LIMIT 200").fetchall():
        if row["prs"] is None or row["prs"] > 4 or row["rir"] is None:
            continue
        if row["rir"] >= 2:
            resisted += 1
        elif row["rir"] == 0:
            affected += 1

    if resisted + affected >= 3:
        influence = _clamp(20.0 + 6.0 * affected - 6.0 * resisted, 0.0, 40.0)
        _store(db, "readiness_influence", influence, resisted + affected, stamp)
        summary["readiness_influence"] = {"value": influence, "n": resisted + affected, "fitted": True}
    else:
        _store(db, "readiness_influence", PROFILE_PRIORS["readiness_influence"], 0, stamp)
        summary["readiness_influence"] = {"value": PROFILE_PRIORS["readiness_influence"],
                                          "n": resisted + affected, "fitted": False}

    db.commit()
    summary["calibration"] = calibration(db)
    summary["observations"] = len(obs)
    return summary


# ---------------------------------------------------------------- selection
def rank(db: sqlite3.Connection, exercises: list[dict], now: datetime | None = None,
         last_done: dict[str, str] | None = None,
         last_muscles: set[str] | None = None, tz=None) -> list[dict]:
    """Score every exercise for this round. Low score wins.

    Three signals, in order of weight:
      load      the hottest muscle the movement would hit (0..100)
      rest      days since it was last performed, capped at 7
      overlap   how much of the previous round's muscle set it repeats
    """
    now = now or _now()
    ready = readiness(db, now, tz)["score"]
    influence = profile_get(db, "readiness_influence")
    snap = {m["slug"]: m for m in snapshot(db, now)}
    last_done = last_done or {}
    last_muscles = last_muscles or set()

    ranked = []
    for pos, ex in enumerate(exercises):
        pairs = attribution(db, ex["id"])
        if not pairs:
            ranked.append({"id": ex["id"], "name": ex["name"], "pos": pos, "score": 60.0,
                           "hot": 0.0, "blocked_by": "no attribution", "why": "no attribution",
                           "muscles": []})
            continue

        hot, blocked_by, resume_ok, muscles = 0.0, None, True, []
        for p in pairs:
            st = snap.get(p["muscle_slug"])
            if not st:
                continue
            muscles.append({"slug": p["muscle_slug"], "name": p["muscle_name"],
                            "role": p["role"], "load": st["load"]})
            hot = max(hot, st["load"])
            if st["resting"]:
                blocked_by = f"{st['name']} resting"
            stop = effective_stop(st["stop_at"], ready, influence)
            if p["role"] == "primary" and st["load"] >= stop:
                blocked_by = st["name"]
            if st["load"] >= 95.0:
                blocked_by = st["name"]
            if p["role"] == "primary" and st["load"] > st["resume_at"]:
                resume_ok = False

        last_iso = last_done.get(ex["id"])
        days = 7.0 if not last_iso else min(7.0, (now - _parse(last_iso)).total_seconds() / 86400.0)
        overlap = len({m["slug"] for m in muscles} & last_muscles)

        score = hot - days * 4.0 - overlap * 8.0 - (12.0 if resume_ok else 0.0)
        ranked.append({
            "id": ex["id"], "name": ex["name"], "pos": pos,
            "score": round(score, 1), "hot": round(hot, 1),
            "blocked_by": blocked_by,
            "why": ("blocked: " + blocked_by) if blocked_by else
                   ("fresh" if hot < 10 else f"{round(hot)}% loaded"),
            "muscles": sorted(muscles, key=lambda m: -m["load"]),
        })

    ranked.sort(key=lambda r: (r["blocked_by"] is not None, r["score"], r["pos"]))
    return ranked


def plan(db: sqlite3.Connection, exercises: list[dict], now: datetime | None = None,
         last_done: dict[str, str] | None = None,
         last_muscles: set[str] | None = None, tz=None) -> tuple[list[dict], dict]:
    """The ordered stack for the next round, plus why.

    Blocked exercises are dropped. If everything is blocked the round becomes a
    deload: the single least-loaded movement at its minimum, so the app never
    goes silent and never breaks the 80% rule hard.
    """
    ranked = rank(db, exercises, now, last_done, last_muscles, tz)
    by_id = {ex["id"]: ex for ex in exercises}
    eligible = [r for r in ranked if not r["blocked_by"]]

    meta = {"deload": False, "blocked": [{"id": r["id"], "name": r["name"],
                                          "why": r["blocked_by"]} for r in ranked if r["blocked_by"]],
            "ranked": ranked}
    if not eligible:
        best = max(ranked, key=lambda r: (r["blocked_by"] is None, -r["score"]))
        meta["deload"] = True
        meta["blocked"] = [{"id": r["id"], "name": r["name"], "why": r["blocked_by"] or "all groups near capacity"}
                           for r in ranked]
        return [by_id[best["id"]]], meta

    return [by_id[r["id"]] for r in eligible], meta


# ---------------------------------------------------------------- check-ins
def _implied(soreness: dict | None) -> dict[str, float]:
    out = {}
    for slug, value in (soreness or {}).items():
        try:
            n = int(value)
        except (TypeError, ValueError):
            continue
        if n in SORENESS_TO_WEAR:
            out[slug] = SORENESS_TO_WEAR[n]
    return out


def record_checkin(db: sqlite3.Connection, payload: dict, now: datetime | None = None,
                   window_minutes: int = 10, tz=None) -> dict:
    """Store a questionnaire and let it move the model.

    gate  — sleep (hours), stress/fatigue/soreness (1..5), prs (0..10), pain flag.
            Sets readiness, pulls each reported muscle's soreness toward the
            answer, and parks an injured muscle for 48 h.
    post  — srpe, rir, stopper, per-muscle soreness for the round just done.
            Compares reported soreness with the wear that was predicted, and
            moves each contributing pair's k. This is the feedback loop.
    """
    now = now or _now()
    kind = str(payload.get("kind") or "").strip()
    if kind not in ("gate", "post"):
        raise ValueError("kind must be 'gate' or 'post'")

    per_muscle = {k: int(v) for k, v in (payload.get("muscle_soreness") or {}).items()
                  if str(k) in MUSCLE_NAME}
    row = {
        "kind": kind, "at": _iso(now), "round_key": payload.get("round_key"),
        "local_date": (now.astimezone(tz).date().isoformat() if tz else now.date().isoformat()),
        "sleep": _num_or_none(payload.get("sleep")), "stress": _int_or_none(payload.get("stress")),
        "fatigue": _int_or_none(payload.get("fatigue")), "soreness": _int_or_none(payload.get("soreness")),
        "prs": _int_or_none(payload.get("prs")),
        "pain": 1 if payload.get("pain") else 0,
        "pain_where": (payload.get("pain_where") or None),
        "srpe": _int_or_none(payload.get("srpe")), "rir": _int_or_none(payload.get("rir")),
        "stopper": (payload.get("stopper") or None),
        "per_muscle": json.dumps(per_muscle) if per_muscle else None,
        "readiness": None, "note": None,
    }

    changes = []
    if kind == "gate":
        changes = _apply_gate(db, row, per_muscle, now)
    else:
        known = db.execute("SELECT 1 FROM rounds WHERE round_key=?",
                           (row["round_key"],)).fetchone()
        if not known:
            raise CheckinRefused(f"unknown round {row['round_key']!r}", 404)
        if db.execute("SELECT 1 FROM checkins WHERE kind='post' AND round_key=?",
                      (row["round_key"],)).fetchone():
            raise CheckinRefused("that set has already been answered", 409)
        window = post_window(db, now, window_minutes)
        if not window or window["round"]["round_key"] != row["round_key"]:
            raise CheckinRefused(
                f"the answer window for that set has closed (it is {window_minutes} minutes "
                "after the set)", 409)
        # the answer may only describe muscles the set actually worked
        loaded = {r["muscle_slug"] for r in db.execute(
            "SELECT DISTINCT muscle_slug FROM wear_events WHERE round_key=?",
            (row["round_key"],)).fetchall()}
        invented = sorted(set(per_muscle) - loaded)
        if invented:
            raise CheckinRefused(
                "that set did not work " + ", ".join(invented), 400)
        changes = _apply_post(db, row, per_muscle, now)

    cur = db.execute(
        "INSERT INTO checkins (kind, at, local_date, round_key, sleep, stress, fatigue, soreness, prs,"
        " pain, pain_where, srpe, rir, stopper, per_muscle, readiness, note)"
        " VALUES (:kind,:at,:local_date,:round_key,:sleep,:stress,:fatigue,:soreness,:prs,"
        " :pain,:pain_where,:srpe,:rir,:stopper,:per_muscle,:readiness,:note)", row)
    if kind == "gate":
        # only now that the row exists can readiness see its own check-in
        row["readiness"] = readiness(db, now)["score"]
        db.execute("UPDATE checkins SET readiness=? WHERE id=?", (row["readiness"], cur.lastrowid))
    db.commit()

    # a post-set answer is new evidence about this body: re-fit the profile.
    # A fit that fails must never cost the user the answer they just gave.
    fitted = None
    if kind == "post":
        try:
            fitted = refit(db, now)
        except Exception as exc:                      # noqa: BLE001
            print(f"refit failed: {exc}", file=sys.stderr)

    return {"ok": True, "kind": kind, "at": row["at"],
            "readiness": row["readiness"],
            "changes": changes,
            "profile": fitted}


def _int_or_none(value):
    if value in (None, "", "null"):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _num_or_none(value):
    if value in (None, "", "null"):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _apply_gate(db, row, per_muscle, now) -> list[dict]:
    changes = []
    stamp = _iso(now)
    implied = _implied(per_muscle)
    for slug, value in implied.items():
        cur = db.execute("SELECT soreness FROM muscle_state WHERE muscle_slug=?", (slug,)).fetchone()
        if not cur:
            continue
        new = max(cur["soreness"], 0.7 * value)
        db.execute("UPDATE muscle_state SET soreness=?, updated_at=? WHERE muscle_slug=?",
                   (new, stamp, slug))
        changes.append({"muscle": slug, "soreness": round(new, 1),
                        "reported": next(k for k, v in SORENESS_TO_WEAR.items() if v == value)})

    if row["pain"] and row["pain_where"] in MUSCLE_NAME:
        until = _iso(now + timedelta(hours=48))
        db.execute("UPDATE muscle_state SET rest_until=?, updated_at=? WHERE muscle_slug=?",
                   (until, stamp, row["pain_where"]))
        changes.append({"muscle": row["pain_where"], "rest_until": until})
    return changes


def _apply_post(db, row, per_muscle, now) -> list[dict]:
    """Compare what we predicted with what the body reported, and move k."""
    changes = []
    round_key = row["round_key"]
    if not round_key:
        return changes
    implied = _implied(per_muscle)
    stamp = _iso(now)

    for slug, value in implied.items():
        dose_row = db.execute(
            "SELECT SUM(predicted) d, COUNT(*) n FROM wear_events WHERE round_key=? AND muscle_slug=?",
            (round_key, slug)).fetchone()
        dose = float(dose_row["d"] or 0.0)
        if dose < 1.0:
            continue
        ratio = _clamp(value / dose, 0.25, 3.0)
        pairs = db.execute(
            "SELECT exercise_slug, k, exposure FROM exercise_muscles WHERE muscle_slug=?"
            " AND exercise_slug IN (SELECT DISTINCT exercise_slug FROM wear_events WHERE round_key=?)",
            (slug, round_key)).fetchall()
        for pair in pairs:
            learn = 0.35 if pair["exposure"] <= 3 else 0.15
            k = _clamp(pair["k"] * (ratio ** learn), K_MIN, K_MAX)
            db.execute("UPDATE exercise_muscles SET k=?, updated_at=? WHERE exercise_slug=? AND muscle_slug=?",
                       (k, stamp, pair["exercise_slug"], slug))
            changes.append({"muscle": slug, "exercise": pair["exercise_slug"],
                            "k": round(k, 2), "predicted": round(dose, 1),
                            "reported_wear": value, "ratio": round(ratio, 2)})
        db.execute("UPDATE wear_events SET observed=? WHERE round_key=? AND muscle_slug=?",
                   (value, round_key, slug))
        cur = db.execute("SELECT soreness FROM muscle_state WHERE muscle_slug=?", (slug,)).fetchone()
        if cur:
            db.execute("UPDATE muscle_state SET soreness=?, updated_at=? WHERE muscle_slug=?",
                       (max(cur["soreness"], 0.7 * value), stamp, slug))

    # Proximity to failure is a direct read on how expensive the reps were.
    if row["rir"] is not None:
        factor = 0.85 if row["rir"] >= 3 else (1.12 if row["rir"] == 0 else 1.0)
        if factor != 1.0:
            for pair in db.execute(
                    "SELECT DISTINCT exercise_slug, muscle_slug, k FROM exercise_muscles"
                    " WHERE exercise_slug IN (SELECT DISTINCT exercise_slug FROM wear_events"
                    " WHERE round_key=?)", (round_key,)).fetchall():
                k = _clamp(pair["k"] * factor, K_MIN, K_MAX)
                db.execute("UPDATE exercise_muscles SET k=?, updated_at=?"
                           " WHERE exercise_slug=? AND muscle_slug=?",
                           (k, stamp, pair["exercise_slug"], pair["muscle_slug"]))
            changes.append({"rir": row["rir"], "k_multiplier": factor})
    return changes


# ---------------------------------------------------------------- reporting
def library_rows(db: sqlite3.Connection) -> list[dict]:
    """What the app knows how to attribute, and how each pair has drifted."""
    out = []
    for row in db.execute(
            "SELECT e.slug, e.name, e.active FROM exercises e ORDER BY e.position").fetchall():
        pairs = db.execute(
            "SELECT em.*, m.name AS muscle_name FROM exercise_muscles em"
            " JOIN muscles m ON m.slug=em.muscle_slug WHERE em.exercise_slug=?"
            " ORDER BY em.weight DESC", (row["slug"],)).fetchall()
        out.append({"slug": row["slug"], "name": row["name"], "active": row["active"],
                    "attributed": bool(pairs),
                    "muscles": [{"slug": p["muscle_slug"], "name": p["muscle_name"],
                                 "role": p["role"], "weight": p["weight"], "k": round(p["k"], 2),
                                 "exposure": p["exposure"]} for p in pairs]})
    return out


def preview_wear(db: sqlite3.Connection, exercise_slug: str, reps: int) -> list[dict]:
    """What N more reps of this exercise would add, per muscle."""
    out = []
    for p in attribution(db, exercise_slug):
        out.append({"muscle": p["muscle_slug"], "name": p["muscle_name"],
                    "role": p["role"], "wear": round(reps * p["k"], 1)})
    return out
