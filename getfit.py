#!/usr/bin/env python3
"""get-fit — escalating workout stack engine.

Files next to this script:
  settings.json  what the web UI writes (exercises, minimums, caps, windows)
  state.json     runtime state the engine keeps (current set, deadline, bonus)
  tally.json     lifetime reps per exercise id (survives exercise removal)

CLI:
  getfit.py tick [--dry-run] [--force]   send a set if one is due (cron calls this)
  getfit.py confirm [--source X]         log the current set as done (hook calls this)
  getfit.py status                       human summary
  getfit.py state                        raw JSON for the web UI
  getfit.py reset [--keep-tally]         wipe runtime state
"""
from __future__ import annotations

import fcntl
import json
import os
import sys
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

BASE = Path(__file__).resolve().parent
SETTINGS_PATH = BASE / "settings.json"
STATE_PATH = BASE / "state.json"
TALLY_PATH = BASE / "tally.json"
LOCK_PATH = BASE / ".lock"

DEFAULT_SETTINGS = {
    "timezone": "Europe/Bucharest",
    "interval_minutes": 90,
    "response_minutes": 10,
    "quiet_start": "00:00",
    "quiet_end": "07:00",
    "exercises": [
        {"id": "pushups", "name": "Push-ups", "min": 10, "max": 20},
        {"id": "squats", "name": "Squats", "min": 5, "max": 30},
    ],
}

DEFAULT_TALLY = {"started_at": None, "totals": {}, "sets_done": 0, "sets_missed": 0}


# ---------------------------------------------------------------- io helpers
def load_json(path: Path, default):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError):
        return json.loads(json.dumps(default))


def save_json(path: Path, obj) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    os.replace(tmp, path)


@contextmanager
def lock():
    fh = open(LOCK_PATH, "a+")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(fh, fcntl.LOCK_UN)
        fh.close()


def now_utc() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse(value) -> datetime:
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def load_settings() -> dict:
    st = load_json(SETTINGS_PATH, DEFAULT_SETTINGS)
    merged = json.loads(json.dumps(DEFAULT_SETTINGS))
    merged.update({k: v for k, v in st.items() if k != "exercises"})
    if st.get("exercises"):
        merged["exercises"] = st["exercises"]
    return merged


def load_state() -> dict:
    s = load_json(STATE_PATH, {})
    s.setdefault("bonus", 0)
    s.setdefault("history", [])
    s.setdefault("current", None)
    s.setdefault("created_at", iso(now_utc()))
    return s


def load_tally() -> dict:
    t = load_json(TALLY_PATH, DEFAULT_TALLY)
    t.setdefault("totals", {})
    t.setdefault("sets_done", 0)
    t.setdefault("sets_missed", 0)
    return t


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
    """Push dt forward to the end of the quiet window if it lands inside it."""
    if in_active_window(dt, settings):
        return dt
    tz = tz_of(settings)
    local = dt.astimezone(tz)
    qs = _hm_seconds(settings.get("quiet_start", "00:00"))
    qe = _hm_seconds(settings.get("quiet_end", "07:00"))
    target_secs = qe
    candidate = local.replace(hour=target_secs // 3600, minute=(target_secs // 60) % 60,
                              second=0, microsecond=0)
    if qs < qe:
        if local.hour * 3600 + local.minute * 60 >= qe:
            candidate += timedelta(days=1)
        else:
            # inside the window: later today
            pass
    else:  # window wraps midnight (e.g. 22:00 -> 07:00)
        if local.hour * 3600 + local.minute * 60 >= qs:
            candidate += timedelta(days=1)
    return candidate.astimezone(timezone.utc)


# ---------------------------------------------------------------- stack math
def compose(settings: dict, bonus: int) -> list[dict]:
    """Turn (minimums, bonus) into the concrete set for right now.

    Exercise 0 always runs and absorbs the bonus up to its cap. When it is at
    its cap the next exercise joins at its own minimum, absorbing whatever is
    left over. The last exercise has no overflow target, so it is uncapped.
    """
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
    lines = ["Time to lock in:"]
    for row in rows:
        lines.append(f"{row['name']} {row['reps']}")
    return "\n".join(lines)


# ---------------------------------------------------------------- actions
def _start_set(settings: dict, state: dict, now: datetime) -> dict:
    rows = compose(settings, state.get("bonus", 0))
    resp = int(settings.get("response_minutes", 10))
    current = {
        "id": uuid.uuid4().hex[:12],
        "sent_at": iso(now),
        "deadline": iso(now + timedelta(minutes=resp)),
        "exercises": rows,
        "status": "pending",
        "bonus_applied": state.get("bonus", 0),
    }
    state["current"] = current
    # the interval clock does not run while a round is open; it starts when the
    # round is answered or abandoned (see _close_round)
    state["next_set_at"] = None
    return current


def _close_round(state: dict, settings: dict, now: datetime) -> None:
    """Start the interval clock that leads to the next set."""
    interval = int(settings.get("interval_minutes", 90))
    state["next_set_at"] = iso(clamp_to_active(now + timedelta(minutes=interval), settings))


def cmd_tick(dry_run: bool = False, force: bool = False) -> int:
    settings = load_settings()
    with lock():
        state = load_state()
        now = now_utc()
        dirty = False

        cur = state.get("current")
        open_round = bool(cur and cur.get("status") == "pending")
        if open_round and now >= parse(cur["deadline"]):
            cur["status"] = "missed"
            cur["missed_at"] = iso(now)
            state["bonus"] = int(state.get("bonus", 0)) + 1
            state["history"].append({"set": cur["id"], "status": "missed",
                                     "at": iso(now), "exercises": cur["exercises"]})
            tally = load_tally()
            tally["sets_missed"] = int(tally.get("sets_missed", 0)) + 1
            if not dry_run:
                save_json(TALLY_PATH, tally)
            _close_round(state, settings, now)
            open_round = False
            dirty = True

        message = None
        next_at = state.get("next_set_at")
        due = (not open_round) and next_at is not None and now >= parse(next_at)
        if due and (force or in_active_window(now, settings)):
            current = _start_set(settings, state, now)
            dirty = True
            message = format_set(current["exercises"])

        if dirty and not dry_run:
            save_json(STATE_PATH, state)
        if message:
            print(message)
    return 0


def cmd_confirm(source: str = "") -> int:
    settings = load_settings()
    with lock():
        state = load_state()
        cur = state.get("current")
        if not cur or cur.get("status") not in ("pending", "missed"):
            return 3
        now = now_utc()
        late = now > parse(cur["deadline"]) or cur.get("status") == "missed"

        tally = load_tally()
        if not tally.get("started_at"):
            tally["started_at"] = iso(now)
        for row in cur["exercises"]:
            slot = tally["totals"].setdefault(row["id"], {"name": row["name"], "reps": 0})
            slot["name"] = row["name"]
            slot["reps"] = int(slot.get("reps", 0)) + int(row["reps"])
        tally["sets_done"] = int(tally.get("sets_done", 0)) + 1

        state["bonus"] = 2 if late else 0
        cur["status"] = "late" if late else "done"
        cur["confirmed_at"] = iso(now)
        cur["source"] = source
        state["history"].append({"set": cur["id"], "status": cur["status"],
                                 "at": iso(now), "exercises": cur["exercises"]})
        _close_round(state, settings, now)
        save_json(TALLY_PATH, tally)
        save_json(STATE_PATH, state)

    rows = ", ".join(f"{r['reps']} {r['name'].lower()}" for r in cur["exercises"])
    if late:
        receipt = (f"Late, but logged: {rows}.\n"
                   f"Reset — next set is +2 push-ups.")
    else:
        receipt = f"Logged: {rows}. Back to base next set."
    nxt = state.get("next_set_at")
    if nxt:
        local = parse(nxt).astimezone(tz_of(settings))
        receipt += f" Next set {local.strftime('%H:%M')}."
    print(receipt)
    return 0


def cmd_reset(keep_tally: bool) -> int:
    with lock():
        state = {"bonus": 0, "current": None, "history": [],
                 "created_at": iso(now_utc()), "next_set_at": iso(now_utc())}
        save_json(STATE_PATH, state)
        if not keep_tally:
            save_json(TALLY_PATH, DEFAULT_TALLY)
    print("state reset" + (" (tally kept)" if keep_tally else " (tally cleared)"))
    return 0


# ---------------------------------------------------------------- view model
def view() -> dict:
    settings = load_settings()
    state = load_state()
    tally = load_tally()
    now = now_utc()
    tz = tz_of(settings)

    totals = []
    totals.append({"id": "_summary", "name": "Total reps", "reps":
                   sum(int(v.get("reps", 0)) for v in tally["totals"].values())})
    seen = set()
    for ex in settings["exercises"]:
        slot = tally["totals"].get(ex["id"], {})
        totals.append({"id": ex["id"], "name": ex.get("name", ex["id"]),
                       "reps": int(slot.get("reps", 0)), "active": True})
        seen.add(ex["id"])
    # exercises removed from the config but already on the board stay in the tally
    for ex_id, slot in tally["totals"].items():
        if ex_id in seen:
            continue
        totals.append({"id": ex_id, "name": slot.get("name", ex_id),
                       "reps": int(slot.get("reps", 0)), "active": False})

    cur = state.get("current")
    round_open = bool(cur and cur.get("status") == "pending")
    current = None
    if cur:
        current = dict(cur)
        current["seconds_left"] = max(0, int((parse(cur["deadline"]) - now).total_seconds()))
        current["local_sent"] = parse(cur["sent_at"]).astimezone(tz).strftime("%H:%M")

    nxt = state.get("next_set_at")
    next_set = None
    if nxt:
        when = parse(nxt)
        eff = clamp_to_active(when, settings)
        next_set = {"at": iso(eff),
                    "local": eff.astimezone(tz).strftime("%H:%M"),
                    "deferred": eff != when,
                    "scheduled": iso(when),
                    "seconds_left": max(0, int((eff - now).total_seconds()))}

    recent = []
    for h in state.get("history", [])[-12:]:
        item = dict(h)
        try:
            item["local"] = parse(h["at"]).astimezone(tz).strftime("%H:%M")
        except Exception:
            item["local"] = ""
        recent.append(item)

    preview = compose(settings, int(state.get("bonus", 0)))
    return {
        "now": iso(now),
        "now_local": now.astimezone(tz).strftime("%H:%M:%S"),
        "timezone": settings.get("timezone"),
        "settings": settings,
        "state": {k: v for k, v in state.items() if k != "history"},
        "recent": recent,
        "tally": tally,
        "totals": totals,
        "current": current,
        "round_open": round_open,
        "next_set": next_set,
        "preview": preview,
        "quiet_now": not in_active_window(now, settings),
    }


def cmd_status() -> int:
    v = view()
    print(f"local now      {v['now_local']} ({v['timezone']})")
    print(f"bonus          +{v['state'].get('bonus', 0)}")
    print(f"next set       {v['next_set']['local'] if v['next_set'] else '-'}")
    print(f"current        {(v['current'] or {}).get('status', 'none')}"
          f" {v['current']['seconds_left'] if v['current'] else ''}")
    print("preview        " + (", ".join(f"{r['name']} {r['reps']}" for r in v["preview"]) or "-"))
    print("totals         " + ", ".join(f"{t['name']}: {t['reps']}" for t in v["totals"][1:]))
    return 0


def main(argv: list[str]) -> int:
    cmd = argv[1] if len(argv) > 1 else "status"
    args = argv[2:]
    if cmd == "tick":
        return cmd_tick(dry_run="--dry-run" in args, force="--force" in args)
    if cmd == "confirm":
        source = ""
        if "--source" in args:
            source = args[args.index("--source") + 1]
        return cmd_confirm(source)
    if cmd == "reset":
        return cmd_reset(keep_tally="--keep-tally" in args)
    if cmd == "state":
        print(json.dumps(view(), indent=2, ensure_ascii=False))
        return 0
    if cmd == "status":
        return cmd_status()
    if cmd == "compose":  # debug helper: compose --bonus 11
        bonus = 0
        if "--bonus" in args:
            bonus = int(args[args.index("--bonus") + 1])
        print(format_set(compose(load_settings(), bonus)))
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
