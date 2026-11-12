#!/usr/bin/env python3
"""State-machine tests for getfit (runs against a throwaway copy of the store)."""
import io
import json
import sys
import tempfile
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import getfit

tmp = Path(tempfile.mkdtemp(prefix="getfit-test-"))
getfit.SETTINGS_PATH = tmp / "settings.json"
getfit.STATE_PATH = tmp / "state.json"
getfit.TALLY_PATH = tmp / "tally.json"
getfit.LOCK_PATH = tmp / ".lock"

getfit.save_json(getfit.SETTINGS_PATH, getfit.DEFAULT_SETTINGS)
getfit.save_json(getfit.TALLY_PATH, getfit.DEFAULT_TALLY)

CLOCK = {"now": datetime(2026, 11, 12, 5, 0, tzinfo=timezone.utc)}  # 07:00 Bucharest
getfit.now_utc = lambda: CLOCK["now"]
getfit.save_json(getfit.STATE_PATH, {"bonus": 0, "current": None, "history": [],
                                     "next_set_at": getfit.iso(CLOCK["now"])})


def run(fn, *a, **kw):
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = fn(*a, **kw)
    return rc, buf.getvalue().strip()


def state():
    return json.loads(getfit.STATE_PATH.read_text())


def tally():
    return json.loads(getfit.TALLY_PATH.read_text())


def advance(minutes):
    CLOCK["now"] = CLOCK["now"] + timedelta(minutes=minutes)


fails = []


def check(name, cond, detail=""):
    print(("PASS  " if cond else "FAIL  ") + name + ("" if cond else f"  -> {detail}"))
    if not cond:
        fails.append(name)


# 1. first tick fires a base set and starts no interval clock
rc, out = run(getfit.cmd_tick)
check("tick fires base set", out == "Time to lock in:\nPush-ups 10", repr(out))
check("set is pending", state()["current"]["status"] == "pending")
check("no interval clock while the round is open", state()["next_set_at"] is None,
      state()["next_set_at"])

# 1b. a tick during an open round must not fire another set
advance(5)
rc, out = run(getfit.cmd_tick)
check("no second set while a round is open", out == "", repr(out))

# 2. confirming on time logs 10 push-ups, resets bonus, starts the 90 minute clock
advance(1)
rc, out = run(getfit.cmd_confirm, "test")
check("confirm rc=0", rc == 0, rc)
check("tally +10 push-ups", tally()["totals"]["pushups"]["reps"] == 10, tally())
check("bonus reset", state()["bonus"] == 0, state()["bonus"])
check("interval clock starts at confirmation",
      getfit.parse(state()["next_set_at"]) == CLOCK["now"] + timedelta(minutes=90),
      state()["next_set_at"])

# 3. silent rounds: nine misses, then the tenth adds squats at 5
for i in range(9):
    CLOCK["now"] = getfit.parse(state()["next_set_at"])   # exactly when the set is due
    run(getfit.cmd_tick)                                   # fire
    CLOCK["now"] = CLOCK["now"] + timedelta(minutes=11)    # blow past the 10 min window
    run(getfit.cmd_tick)                                   # expire -> +1
s = state()
check("bonus 9 after nine misses", s["bonus"] == 9, s["bonus"])
check("expiry starts the next interval", s["next_set_at"] is not None, s["next_set_at"])
CLOCK["now"] = getfit.parse(state()["next_set_at"])
rc, out = run(getfit.cmd_tick)
check("set at bonus 9 is 19 push-ups", out.endswith("Push-ups 19"), repr(out))
CLOCK["now"] = CLOCK["now"] + timedelta(minutes=11)
run(getfit.cmd_tick)
check("bonus 10 after ten misses", state()["bonus"] == 10)
CLOCK["now"] = getfit.parse(state()["next_set_at"])
rc, out = run(getfit.cmd_tick)
check("bonus 10 -> 20 push-ups + 5 squats",
      out == "Time to lock in:\nPush-ups 20\nSquats 5", repr(out))

# 4. late confirmation: logs the set, next set +2 push-ups, clock restarts from now
advance(15)   # past the 10 minute window
rc, out = run(getfit.cmd_confirm, "test")
check("late confirm logs", rc == 0 and "Late" in out, out)
check("late penalty is +2", state()["bonus"] == 2, state()["bonus"])
check("tally added 20 push-ups and 5 squats",
      tally()["totals"]["pushups"]["reps"] == 30 and tally()["totals"]["squats"]["reps"] == 5, tally())
check("late confirmation restarts the interval clock",
      getfit.parse(state()["next_set_at"]) == CLOCK["now"] + timedelta(minutes=90),
      state()["next_set_at"])

# 5. quiet hours: nothing fires between 00:00 and 07:00 local
CLOCK["now"] = datetime(2026, 11, 13, 1, 30, tzinfo=timezone.utc)   # 03:30 Bucharest
st = state()
st["next_set_at"] = getfit.iso(CLOCK["now"])
st["current"] = None
getfit.save_json(getfit.STATE_PATH, st)
rc, out = run(getfit.cmd_tick)
check("quiet hours stay silent", out == "", repr(out))

# 6. a round that dies at 23:30 local schedules the next set for 07:00
CLOCK["now"] = datetime(2026, 11, 13, 21, 30, tzinfo=timezone.utc)  # 23:30 local
st = state()
st["next_set_at"] = getfit.iso(CLOCK["now"])
st["current"] = None
st["bonus"] = 0
getfit.save_json(getfit.STATE_PATH, st)
rc, out = run(getfit.cmd_tick)
check("23:30 set fires", out.startswith("Time to lock in"), repr(out))
CLOCK["now"] = CLOCK["now"] + timedelta(minutes=11)
run(getfit.cmd_tick)   # expire -> interval clock, clamped out of quiet hours
nxt = getfit.parse(state()["next_set_at"]).astimezone(getfit.tz_of(getfit.load_settings()))
check("next set held until 07:00", nxt.strftime("%H:%M") == "07:00", nxt.isoformat())

# 7. removed exercise keeps its lifetime reps
getfit.save_json(getfit.TALLY_PATH, {"started_at": None, "sets_done": 2, "sets_missed": 11,
                                     "totals": {"pushups": {"name": "Push-ups", "reps": 30},
                                                "oldjacks": {"name": "Jumping jacks", "reps": 12}}})
v = getfit.view()
names = {t["name"]: t["reps"] for t in v["totals"]}
check("removed exercise still counted", names.get("Jumping jacks") == 12, names)
check("summary sums everything", names.get("Total reps") == 42, names)

# 8. the view model marks an open round and hides the next-set countdown
CLOCK["now"] = datetime(2026, 11, 14, 8, 0, tzinfo=timezone.utc)
st = state()
st["next_set_at"] = getfit.iso(CLOCK["now"])
st["current"] = None
getfit.save_json(getfit.STATE_PATH, st)
run(getfit.cmd_tick)
v = getfit.view()
check("view reports an open round", v["round_open"] is True, v["round_open"])
check("no next set while a round is open", v["next_set"] is None, v["next_set"])

print()
print("FAILURES:", fails if fails else "none")
sys.exit(1 if fails else 0)
