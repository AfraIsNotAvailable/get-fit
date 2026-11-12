#!/usr/bin/env python3
"""get-fit — escalating workout stack engine (SQLite store).

Entities
  settings      one row: timezone, interval, response window, quiet hours
  exercises     the stack, ordered by position; removed ones stay with active=0
  rounds        one row per set that was sent (sent/deadline/status/resolved)
  round_items   what each round asked for, per exercise (reps + name snapshot)

Derived
  tally         opening balances (imported legacy totals) + reps of done/late rounds
  calendar      per local day: rounds sent, rounds done, reps, per-exercise split

CLI
  getfit.py tick [--dry-run] [--force]   send a set if one is due (cron calls this)
  getfit.py confirm [--source X]         log the current round as done (hook calls this)
  getfit.py status | state | report      inspect
  getfit.py reset [--keep-tally]         wipe rounds
  getfit.py migrate                      import legacy settings/state/tally json
"""
from __future__ import annotations

import json
import re
import sqlite3
import sys
import uuid
import calendar as calmod
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

BASE = Path(__file__).resolve().parent
DB_PATH = BASE / "getfit.db"
LEGACY_SETTINGS = BASE / "settings.json"
LEGACY_STATE = BASE / "state.json"
LEGACY_TALLY = BASE / "tally.json"

DEFAULT_SETTINGS = {
    "timezone": "Europe/Bucharest",
    "interval_minutes": 90,
    "response_minutes": 10,
    "quiet_start": "00:00",
    "quiet_end": "07:00",
    "exercises": [
        {"id": "pushups", "name": "Push-ups", "min": 10, "max": 20},
        {"id": "squats", "name": "Squats", "min": 5, "max": None},
    ],
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  timezone TEXT NOT NULL,
  interval_minutes INTEGER NOT NULL,
  response_minutes INTEGER NOT NULL,
  quiet_start TEXT NOT NULL,
  quiet_end TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exercises (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  min_reps INTEGER NOT NULL,
  max_reps INTEGER,
  position INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  retired_at TEXT
);

CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_key TEXT NOT NULL UNIQUE,
  sent_at TEXT NOT NULL,
  sent_local_date TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  resolved_at TEXT,
  status TEXT NOT NULL,
  bonus_applied INTEGER NOT NULL DEFAULT 0,
  target_reps INTEGER NOT NULL DEFAULT 0,
  source TEXT
);

CREATE TABLE IF NOT EXISTS round_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  exercise_slug TEXT NOT NULL,
  exercise_name TEXT NOT NULL,
  reps INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS opening_balance (
  exercise_slug TEXT PRIMARY KEY,
  exercise_name TEXT NOT NULL,
  reps INTEGER NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  bonus INTEGER NOT NULL DEFAULT 0,
  next_set_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rounds_date ON rounds(sent_local_date);
CREATE INDEX IF NOT EXISTS idx_items_round ON round_items(round_id);
"""


# ---------------------------------------------------------------- io
def connect() -> sqlite3.Connection:
    db = sqlite3.connect(DB_PATH, timeout=15)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    return db


def init_db(db: sqlite3.Connection) -> None:
    db.executescript(SCHEMA)
    if not db.execute("SELECT 1 FROM settings WHERE id=1").fetchone():
        s = DEFAULT_SETTINGS
        db.execute(
            "INSERT INTO settings (id, timezone, interval_minutes, response_minutes, quiet_start, quiet_end)"
            " VALUES (1, ?, ?, ?, ?, ?)",
            (s["timezone"], s["interval_minutes"], s["response_minutes"], s["quiet_start"], s["quiet_end"]),
        )
        stamp = iso(now_utc())
        for pos, ex in enumerate(s["exercises"]):
            db.execute(
                "INSERT INTO exercises (slug, name, min_reps, max_reps, position, active, created_at)"
                " VALUES (?, ?, ?, ?, ?, 1, ?)",
                (ex["id"], ex["name"], ex["min"], ex["max"], pos, stamp),
            )
    if not db.execute("SELECT 1 FROM app_state WHERE id=1").fetchone():
        db.execute("INSERT INTO app_state (id, bonus, next_set_at, created_at) VALUES (1, 0, ?, ?)",
                   (iso(now_utc()), iso(now_utc())))
    db.commit()


def now_utc() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse(value) -> datetime:
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


# ---------------------------------------------------------------- settings
def load_settings(db: sqlite3.Connection) -> dict:
    row = db.execute("SELECT * FROM settings WHERE id=1").fetchone()
    rows = db.execute("SELECT * FROM exercises WHERE active=1 ORDER BY position, id").fetchall()
    return {
        "timezone": row["timezone"],
        "interval_minutes": row["interval_minutes"],
        "response_minutes": row["response_minutes"],
        "quiet_start": row["quiet_start"],
        "quiet_end": row["quiet_end"],
        "exercises": [
            {"id": e["slug"], "name": e["name"], "min": e["min_reps"],
             "max": None if pos == len(rows) - 1 else e["max_reps"]}
            for pos, e in enumerate(rows)
        ],
    }


def slugify(name: str, db: sqlite3.Connection) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "exercise"
    slug, i = base, 2
    while db.execute("SELECT 1 FROM exercises WHERE slug=?", (slug,)).fetchone():
        slug = f"{base}-{i}"
        i += 1
    return slug


def save_settings(db: sqlite3.Connection, cfg: dict) -> dict:
    stamp = iso(now_utc())
    db.execute(
        "UPDATE settings SET timezone=?, interval_minutes=?, response_minutes=?, quiet_start=?, quiet_end=? WHERE id=1",
        (cfg["timezone"], cfg["interval_minutes"], cfg["response_minutes"],
         cfg["quiet_start"], cfg["quiet_end"]),
    )
    keep: set[str] = set()
    for pos, ex in enumerate(cfg["exercises"]):
        slug = (ex.get("id") or "").strip()
        row = db.execute("SELECT id FROM exercises WHERE slug=?", (slug,)).fetchone() if slug else None
        if row:
            db.execute(
                "UPDATE exercises SET name=?, min_reps=?, max_reps=?, position=?, active=1, retired_at=NULL WHERE id=?",
                (ex["name"], ex["min"], ex["max"], pos, row["id"]),
            )
            keep.add(slug)
        else:
            slug = slugify(ex["name"], db)
            db.execute(
                "INSERT INTO exercises (slug, name, min_reps, max_reps, position, active, created_at)"
                " VALUES (?, ?, ?, ?, ?, 1, ?)",
                (slug, ex["name"], ex["min"], ex["max"], pos, stamp),
            )
            keep.add(slug)
    for row in db.execute("SELECT slug FROM exercises WHERE active=1").fetchall():
        if row["slug"] not in keep:
            db.execute("UPDATE exercises SET active=0, retired_at=? WHERE slug=?", (stamp, row["slug"]))
    db.commit()
    return load_settings(db)


# ---------------------------------------------------------------- state
def load_state(db: sqlite3.Connection) -> dict:
    row = db.execute("SELECT * FROM app_state WHERE id=1").fetchone()
    return {"bonus": row["bonus"], "next_set_at": row["next_set_at"], "created_at": row["created_at"]}


def save_state(db: sqlite3.Connection, state: dict) -> None:
    db.execute("UPDATE app_state SET bonus=?, next_set_at=? WHERE id=1",
               (state["bonus"], state["next_set_at"]))


def last_round(db: sqlite3.Connection) -> dict | None:
    row = db.execute("SELECT * FROM rounds ORDER BY id DESC LIMIT 1").fetchone()
    if not row:
        return None
    items = db.execute("SELECT * FROM round_items WHERE round_id=? ORDER BY id", (row["id"],)).fetchall()
    return {
        "id": row["round_key"],
        "db_id": row["id"],
        "sent_at": row["sent_at"],
        "deadline": row["deadline_at"],
        "status": row["status"],
        "confirmed_at": row["resolved_at"],
        "bonus_applied": row["bonus_applied"],
        "exercises": [{"id": i["exercise_slug"], "name": i["exercise_name"], "reps": i["reps"]}
                      for i in items],
    }


# ---------------------------------------------------------------- schedule
def tz_of(settings: dict) -> ZoneInfo:
    try:
        return ZoneInfo(settings.get("timezone") or "UTC")
    except Exception:
        return ZoneInfo("UTC")


def _hm_seconds(value: str) -> int:
    hh, mm = (value or "00:00").split(":")[:2]
    return int(hh) * 3600 + int(mm) * 60


def in_active_window(dt: datetime, settings: dict) -> bool:
    local = dt.astimezone(tz_of(settings))
    secs = local.hour * 3600 + local.minute * 60 + local.second
    qs = _hm_seconds(settings.get("quiet_start", "00:00"))
    qe = _hm_seconds(settings.get("quiet_end", "07:00"))
    if qs == qe:
        return True
    if qs < qe:
        return not (qs <= secs < qe)
    return not (secs >= qs or secs < qe)


def clamp_to_active(dt: datetime, settings: dict) -> datetime:
    if in_active_window(dt, settings):
        return dt
    tz = tz_of(settings)
    local = dt.astimezone(tz)
    qs = _hm_seconds(settings.get("quiet_start", "00:00"))
    qe = _hm_seconds(settings.get("quiet_end", "07:00"))
    candidate = local.replace(hour=qe // 3600, minute=(qe // 60) % 60, second=0, microsecond=0)
    if qs < qe:
        if local.hour * 3600 + local.minute * 60 >= qe:
            candidate += timedelta(days=1)
    else:
        if local.hour * 3600 + local.minute * 60 >= qs:
            candidate += timedelta(days=1)
    return candidate.astimezone(timezone.utc)


# ---------------------------------------------------------------- stack math
def compose(settings: dict, bonus: int) -> list[dict]:
    """Turn (minimums, bonus) into the concrete set for right now."""
    exercises = settings["exercises"]
    out: list[dict] = []
    carry = max(0, int(bonus))
    prev_capped = False
    for idx, ex in enumerate(exercises):
        last = idx == len(exercises) - 1
        cap = None if last else ex.get("max")
        base = int(ex.get("min") or 0)
        if idx > 0 and not prev_capped and carry <= 0:
            break
        asked = base + carry
        reps = asked if cap is None else min(asked, int(cap))
        carry = max(0, asked - reps)
        prev_capped = cap is not None and reps >= int(cap)
        if reps > 0:
            out.append({"id": ex["id"], "name": ex["name"], "reps": reps})
    return out


def format_set(rows: list[dict]) -> str:
    return "\n".join(["Time to lock in:"] + [f"{r['name']} {r['reps']}" for r in rows])


# ---------------------------------------------------------------- actions
def open_round(db: sqlite3.Connection, settings: dict, state: dict, now: datetime) -> dict:
    rows = compose(settings, state["bonus"])
    resp = int(settings.get("response_minutes", 10))
    tz = tz_of(settings)
    cur = db.execute(
        "INSERT INTO rounds (round_key, sent_at, sent_local_date, deadline_at, status, bonus_applied, target_reps)"
        " VALUES (?, ?, ?, ?, 'pending', ?, ?)",
        (uuid.uuid4().hex[:12], iso(now), now.astimezone(tz).date().isoformat(),
         iso(now + timedelta(minutes=resp)), state["bonus"], sum(r["reps"] for r in rows)),
    )
    for r in rows:
        db.execute("INSERT INTO round_items (round_id, exercise_slug, exercise_name, reps) VALUES (?, ?, ?, ?)",
                   (cur.lastrowid, r["id"], r["name"], r["reps"]))
    state["next_set_at"] = None   # the interval clock only runs between rounds
    save_state(db, state)
    return last_round(db)


def close_round(db: sqlite3.Connection, settings: dict, state: dict, now: datetime) -> None:
    interval = int(settings.get("interval_minutes", 90))
    state["next_set_at"] = iso(clamp_to_active(now + timedelta(minutes=interval), settings))
    save_state(db, state)


def cmd_tick(dry_run: bool = False, force: bool = False) -> int:
    db = connect()
    init_db(db)
    settings = load_settings(db)
    state = load_state(db)
    now = now_utc()
    message = None

    cur = last_round(db)
    round_open = bool(cur and cur["status"] == "pending")
    if round_open and now >= parse(cur["deadline"]):
        if not dry_run:
            db.execute("UPDATE rounds SET status='missed', resolved_at=? WHERE id=?",
                       (iso(now), cur["db_id"]))
            state["bonus"] = int(state["bonus"]) + 1
            close_round(db, settings, state, now)
            db.commit()
        round_open = False

    next_at = state["next_set_at"]
    due = (not round_open) and next_at is not None and now >= parse(next_at)
    if due and (force or in_active_window(now, settings)):
        message = format_set(compose(settings, state["bonus"]))
        if not dry_run:
            open_round(db, settings, state, now)
            db.commit()

    db.close()
    if message:
        print(message)
    return 0


def cmd_confirm(source: str = "") -> int:
    db = connect()
    init_db(db)
    settings = load_settings(db)
    state = load_state(db)
    cur = last_round(db)
    if not cur or cur["status"] not in ("pending", "missed"):
        db.close()
        return 3

    now = now_utc()
    late = cur["status"] == "missed" or now > parse(cur["deadline"])
    db.execute("UPDATE rounds SET status=?, resolved_at=?, source=? WHERE id=?",
               ("late" if late else "done", iso(now), source, cur["db_id"]))
    state["bonus"] = 2 if late else 0
    close_round(db, settings, state, now)
    db.commit()

    receipt = _receipt(cur, late, state, settings)
    db.close()
    print(receipt)
    return 0


def _receipt(cur: dict, late: bool, state: dict, settings: dict) -> str:
    rows = ", ".join(f"{r['reps']} {r['name'].lower()}" for r in cur["exercises"])
    if late:
        out = f"Late, but logged: {rows}.\nReset — next set is +2 push-ups."
    else:
        out = f"Logged: {rows}. Back to base next set."
    if state.get("next_set_at"):
        local = parse(state["next_set_at"]).astimezone(tz_of(settings))
        out += f" Next set {local.strftime('%H:%M')}."
    return out


def cmd_reset(keep_tally: bool) -> int:
    db = connect()
    init_db(db)
    db.execute("DELETE FROM round_items")
    db.execute("DELETE FROM rounds")
    db.execute("UPDATE app_state SET bonus=0, next_set_at=? WHERE id=1", (iso(now_utc()),))
    if not keep_tally:
        db.execute("DELETE FROM opening_balance")
    db.commit()
    db.close()
    print("state reset" + (" (tally kept)" if keep_tally else " (tally cleared)"))
    return 0


# ---------------------------------------------------------------- reporting
def totals(db: sqlite3.Connection) -> list[dict]:
    """Lifetime reps per exercise slug, including removed exercises and legacy balances."""
    acc: dict[str, dict] = {}
    for row in db.execute("SELECT * FROM opening_balance").fetchall():
        acc[row["exercise_slug"]] = {"id": row["exercise_slug"], "name": row["exercise_name"],
                                     "reps": int(row["reps"]), "order": -50, "active": False}
    for row in db.execute(
        "SELECT ri.exercise_slug slug, ri.exercise_name name, ri.reps reps"
        " FROM round_items ri JOIN rounds r ON r.id = ri.round_id"
        " WHERE r.status IN ('done','late') ORDER BY r.id"
    ).fetchall():
        slot = acc.setdefault(row["slug"], {"id": row["slug"], "name": row["name"],
                                            "reps": 0, "order": 900, "active": False})
        slot["reps"] += int(row["reps"])
        slot["name"] = row["name"]

    for pos, row in enumerate(db.execute("SELECT * FROM exercises WHERE active=1 ORDER BY position").fetchall()):
        slot = acc.setdefault(row["slug"], {"id": row["slug"], "name": row["name"],
                                            "reps": 0, "order": pos, "active": False})
        slot.update({"name": row["name"], "order": pos, "active": True})
    return sorted(acc.values(), key=lambda s: (s["order"], s["name"]))


def build_calendar(db: sqlite3.Connection, settings: dict, now: datetime) -> dict:
    tz = tz_of(settings)
    days: dict[str, dict] = {}
    for row in db.execute(
        "SELECT sent_local_date d, COUNT(*) rounds,"
        " SUM(CASE WHEN status IN ('done','late') THEN 1 ELSE 0 END) done,"
        " SUM(CASE WHEN status IN ('done','late') THEN target_reps ELSE 0 END) reps"
        " FROM rounds GROUP BY sent_local_date"
    ).fetchall():
        days[row["d"]] = {"rounds": row["rounds"], "done": row["done"] or 0,
                          "reps": row["reps"] or 0, "by_ex": {}}
    for row in db.execute(
        "SELECT r.sent_local_date d, ri.exercise_slug slug, SUM(ri.reps) reps"
        " FROM round_items ri JOIN rounds r ON r.id = ri.round_id"
        " WHERE r.status IN ('done','late') GROUP BY d, slug"
    ).fetchall():
        slot = days.setdefault(row["d"], {"rounds": 0, "done": 0, "reps": 0, "by_ex": {}})
        slot["by_ex"][row["slug"]] = int(row["reps"])
    for slot in days.values():
        slot["ratio"] = (slot["done"] / slot["rounds"]) if slot["rounds"] else 0.0
    today = now.astimezone(tz).date()
    return {"days": days,
            "today": today.isoformat(),
            "start": (today - timedelta(days=364)).isoformat(),
            "max_reps": max([s["reps"] for s in days.values()], default=0)}


def build_months(db: sqlite3.Connection, settings: dict, now: datetime) -> dict:
    """Monthly reps against the ceiling a month allows: days × rounds per day × base stack."""
    tz = tz_of(settings)
    today = now.astimezone(tz).date()

    qs = _hm_seconds(settings.get("quiet_start", "00:00")) // 60
    qe = _hm_seconds(settings.get("quiet_end", "07:00")) // 60
    quiet_minutes = 0 if qs == qe else ((qe - qs) % 1440 or 1440)
    active_minutes = max(int(settings.get("interval_minutes", 90)), 1440 - quiet_minutes)
    rounds_per_day = max(1, active_minutes // int(settings.get("interval_minutes", 90)))
    base_reps = sum(r["reps"] for r in compose(settings, 0)) or 1

    done = {row["m"]: int(row["reps"] or 0) for row in db.execute(
        "SELECT substr(sent_local_date,1,7) m, SUM(target_reps) reps FROM rounds"
        " WHERE status IN ('done','late') GROUP BY m").fetchall()}

    months = []
    first = today.replace(day=1)
    for back in range(11, -1, -1):
        y, m = first.year, first.month - back
        while m <= 0:
            m += 12
            y -= 1
        key = f"{y:04d}-{m:02d}"
        days = calmod.monthrange(y, m)[1]
        target = days * rounds_per_day * base_reps
        reps = done.get(key, 0)
        months.append({"month": key,
                       "label": first.replace(year=y, month=m, day=1).strftime("%b"),
                       "year": y, "days": days, "target": target, "reps": reps,
                       "ratio": (reps / target) if target else 0.0,
                       "current": key == today.strftime("%Y-%m")})
    return {"rounds_per_day": rounds_per_day, "base_reps": base_reps,
            "current": months[-1], "history": months[-6:]}


def view() -> dict:
    db = connect()
    init_db(db)
    settings = load_settings(db)
    state = load_state(db)
    now = now_utc()
    tz = tz_of(settings)

    total_rows = totals(db)
    summary = sum(t["reps"] for t in total_rows)
    sets_done = db.execute("SELECT COUNT(*) c FROM rounds WHERE status IN ('done','late')").fetchone()["c"]
    sets_missed = db.execute("SELECT COUNT(*) c FROM rounds WHERE status='missed'").fetchone()["c"]
    first = db.execute("SELECT MIN(resolved_at) t FROM rounds WHERE status IN ('done','late')").fetchone()["t"]

    cur = last_round(db)
    current = None
    if cur:
        current = dict(cur)
        current["seconds_left"] = max(0, int((parse(cur["deadline"]) - now).total_seconds()))
        current["local_sent"] = parse(cur["sent_at"]).astimezone(tz).strftime("%H:%M")

    recent = []
    rows = db.execute(
        "SELECT r.*, GROUP_CONCAT(ri.reps || '×' || ri.exercise_name, '|') AS items"
        " FROM rounds r LEFT JOIN round_items ri ON ri.round_id = r.id"
        " GROUP BY r.id ORDER BY r.sent_at DESC, r.id DESC LIMIT 12"
    ).fetchall()
    for row in rows:
        items = []
        if row["items"]:
            for chunk in row["items"].split("|"):
                reps, _, name = chunk.partition("×")
                items.append({"name": name, "reps": int(reps)})
        sent = parse(row["sent_at"]).astimezone(tz)
        recent.append({"set": row["round_key"], "status": row["status"],
                       "at": row["resolved_at"] or row["sent_at"],
                       "local": sent.strftime("%H:%M"), "day": sent.strftime("%d %b"),
                       "exercises": items})

    next_set = None
    if state["next_set_at"]:
        when = parse(state["next_set_at"])
        eff = clamp_to_active(when, settings)
        next_set = {"at": iso(eff), "local": eff.astimezone(tz).strftime("%H:%M"),
                    "deferred": eff != when, "scheduled": iso(when),
                    "seconds_left": max(0, int((eff - now).total_seconds()))}

    out = {
        "now": iso(now),
        "now_local": now.astimezone(tz).strftime("%H:%M:%S"),
        "timezone": settings.get("timezone"),
        "settings": settings,
        "state": {"bonus": state["bonus"], "next_set_at": state["next_set_at"],
                  "created_at": state["created_at"]},
        "recent": recent,
        "tally": {"started_at": first, "sets_done": sets_done, "sets_missed": sets_missed,
                  "totals": {t["id"]: {"name": t["name"], "reps": t["reps"]} for t in total_rows}},
        "totals": [{"id": "_summary", "name": "Total reps", "reps": summary}] + total_rows,
        "current": current,
        "round_open": bool(cur and cur["status"] == "pending"),
        "next_set": next_set,
        "preview": compose(settings, state["bonus"]),
        "quiet_now": not in_active_window(now, settings),
        "calendar": build_calendar(db, settings, now),
        "months": build_months(db, settings, now),
    }
    db.close()
    return out


def cmd_status() -> int:
    v = view()
    print(f"local now      {v['now_local']} ({v['timezone']})")
    print(f"bonus          +{v['state']['bonus']}")
    print(f"next set       {v['next_set']['local'] if v['next_set'] else '-'}")
    print(f"current        {(v['current'] or {}).get('status', 'none')}"
          f" {v['current']['seconds_left'] if v['current'] else ''}")
    print("preview        " + (", ".join(f"{r['name']} {r['reps']}" for r in v["preview"]) or "-"))
    print("totals         " + ", ".join(f"{t['name']}: {t['reps']}" for t in v["totals"][1:]))
    return 0


def cmd_report() -> int:
    for day, slot in sorted(view()["calendar"]["days"].items()):
        parts = ", ".join(f"{k} {n}" for k, n in slot["by_ex"].items())
        print(f"{day}  {slot['done']}/{slot['rounds']} rounds  {slot['reps']} reps  {parts}")
    return 0


# ---------------------------------------------------------------- migration
def cmd_migrate() -> int:
    db = connect()
    init_db(db)
    if db.execute("SELECT COUNT(*) c FROM rounds").fetchone()["c"]:
        print("already migrated (rounds exist)")
        db.close()
        return 0

    settings = json.loads(LEGACY_SETTINGS.read_text()) if LEGACY_SETTINGS.exists() else DEFAULT_SETTINGS
    state = json.loads(LEGACY_STATE.read_text()) if LEGACY_STATE.exists() else {}
    tally = json.loads(LEGACY_TALLY.read_text()) if LEGACY_TALLY.exists() else {}
    save_settings(db, settings)

    if state.get("bonus"):
        db.execute("UPDATE app_state SET bonus=?, next_set_at=? WHERE id=1",
                   (int(state["bonus"]), state.get("next_set_at")))
        db.commit()
    elif state.get("next_set_at"):
        db.execute("UPDATE app_state SET next_set_at=? WHERE id=1", (state["next_set_at"],))
        db.commit()

    tz = tz_of(settings)
    # the legacy history can list the same set twice (missed, then confirmed late);
    # the later entry wins
    merged: dict[str, dict] = {}
    for h in list(state.get("history", [])) + ([state["current"]] if state.get("current") else []):
        if not (h.get("exercises") or []):
            continue
        merged[h.get("set") or h.get("id") or uuid.uuid4().hex[:12]] = h

    imported = 0
    for key, h in merged.items():
        if db.execute("SELECT 1 FROM rounds WHERE round_key=?", (key,)).fetchone():
            continue
        rows = h["exercises"]
        at = h.get("at") or h.get("sent_at") or iso(now_utc())
        sent = parse(at)
        cur = db.execute(
            "INSERT INTO rounds (round_key, sent_at, sent_local_date, deadline_at, resolved_at,"
            " status, target_reps) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (key, iso(sent), sent.astimezone(tz).date().isoformat(),
             iso(sent + timedelta(minutes=10)), at, h.get("status", "missed"),
             sum(int(r["reps"]) for r in rows)))
        for r in rows:
            db.execute("INSERT INTO round_items (round_id, exercise_slug, exercise_name, reps)"
                       " VALUES (?, ?, ?, ?)", (cur.lastrowid, r["id"], r["name"], r["reps"]))
        imported += 1

    done_reps: dict[str, int] = {}
    for row in db.execute(
            "SELECT ri.exercise_slug slug, SUM(ri.reps) reps FROM round_items ri"
            " JOIN rounds r ON r.id = ri.round_id WHERE r.status IN ('done','late')"
            " GROUP BY ri.exercise_slug").fetchall():
        done_reps[row["slug"]] = int(row["reps"])
    for slug, slot in (tally.get("totals") or {}).items():
        gap = int(slot.get("reps", 0)) - done_reps.get(slug, 0)
        if gap > 0:
            db.execute("INSERT OR REPLACE INTO opening_balance (exercise_slug, exercise_name, reps, recorded_at)"
                       " VALUES (?, ?, ?, ?)", (slug, slot.get("name", slug), gap, iso(now_utc())))

    db.commit()
    db.close()
    print(f"migrated {imported} rounds; opening balances from legacy tally")
    return 0


def main(argv: list[str]) -> int:
    cmd = argv[1] if len(argv) > 1 else "status"
    args = argv[2:]
    if cmd == "tick":
        return cmd_tick(dry_run="--dry-run" in args, force="--force" in args)
    if cmd == "confirm":
        return cmd_confirm(args[args.index("--source") + 1] if "--source" in args else "")
    if cmd == "reset":
        return cmd_reset(keep_tally="--keep-tally" in args)
    if cmd == "state":
        print(json.dumps(view(), indent=2, ensure_ascii=False))
        return 0
    if cmd == "status":
        return cmd_status()
    if cmd == "report":
        return cmd_report()
    if cmd == "migrate":
        return cmd_migrate()
    if cmd == "compose":
        bonus = int(args[args.index("--bonus") + 1]) if "--bonus" in args else 0
        db = connect()
        init_db(db)
        print(format_set(compose(load_settings(db), bonus)))
        db.close()
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
