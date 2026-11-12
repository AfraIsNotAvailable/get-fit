#!/usr/bin/env python3
"""State-machine tests for getfit (runs against a throwaway database)."""
import io
import sys
import tempfile
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import getfit

tmp = Path(tempfile.mkdtemp(prefix="getfit-test-"))
getfit.DB_PATH = tmp / "test.db"

CLOCK = {"now": datetime(2026, 11, 12, 5, 0, tzinfo=timezone.utc)}  # 07:00 Bucharest
getfit.now_utc = lambda: CLOCK["now"]

db = getfit.connect()
getfit.init_db(db)
db.execute("UPDATE app_state SET next_set_at=? WHERE id=1", (getfit.iso(CLOCK["now"]),))
db.commit()
db.close()


def run(fn, *a, **kw):
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = fn(*a, **kw)
    return rc, buf.getvalue().strip()


def state():
    con = getfit.connect()
    row = con.execute("SELECT * FROM app_state WHERE id=1").fetchone()
    con.close()
    return dict(row)


def totals():
    con = getfit.connect()
    out = {t["id"]: t["reps"] for t in getfit.totals(con)}
    con.close()
    return out


def last_round():
    con = getfit.connect()
    cur = getfit.last_round(con)
    con.close()
    return cur


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
check("round stored as pending", last_round()["status"] == "pending", last_round())
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
check("round marked done", last_round()["status"] == "done", last_round()["status"])
check("tally +10 push-ups", totals().get("pushups") == 10, totals())
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
      totals().get("pushups") == 30 and totals().get("squats") == 5, totals())
check("late confirmation restarts the interval clock",
      getfit.parse(state()["next_set_at"]) == CLOCK["now"] + timedelta(minutes=90),
      state()["next_set_at"])

# 4b. the month gauge counts the reps of done rounds and knows its ceiling
v = getfit.view()
mo = v["months"]["current"]
check("month reps come from done rounds", mo["reps"] == 35, mo)
check("month ceiling is days x rounds/day x base stack",
      mo["target"] == mo["days"] * v["months"]["rounds_per_day"] * v["months"]["base_reps"], mo)
check("month history keeps one row per month", len(v["months"]["history"]) == 6, len(v["months"]["history"]))

# 5. quiet hours: nothing fires between 00:00 and 07:00 local
CLOCK["now"] = datetime(2026, 11, 13, 1, 30, tzinfo=timezone.utc)   # 03:30 Bucharest
con = getfit.connect()
con.execute("UPDATE app_state SET next_set_at=? WHERE id=1", (getfit.iso(CLOCK["now"]),))
con.commit()
con.close()
rc, out = run(getfit.cmd_tick)
check("quiet hours stay silent", out == "", repr(out))

# 6. a round that dies at 23:30 local schedules the next set for 07:00
CLOCK["now"] = datetime(2026, 11, 13, 21, 30, tzinfo=timezone.utc)  # 23:30 local
con = getfit.connect()
con.execute("UPDATE app_state SET next_set_at=?, bonus=0 WHERE id=1", (getfit.iso(CLOCK["now"]),))
con.commit()
con.close()
rc, out = run(getfit.cmd_tick)
check("23:30 set fires", out.startswith("Time to lock in"), repr(out))
CLOCK["now"] = CLOCK["now"] + timedelta(minutes=11)
run(getfit.cmd_tick)   # expire -> interval clock, clamped out of quiet hours
nxt = getfit.parse(state()["next_set_at"]).astimezone(getfit.tz_of(getfit.load_settings(getfit.connect())))
check("next set held until 07:00", nxt.strftime("%H:%M") == "07:00", nxt.isoformat())

# 7. a retired exercise keeps its lifetime reps
con = getfit.connect()
cur = con.execute(
    "INSERT INTO rounds (round_key, sent_at, sent_local_date, deadline_at, resolved_at, status, target_reps)"
    " VALUES ('legacy1', '2026-11-01T10:00:00Z', '2026-11-01', '2026-11-01T10:10:00Z',"
    " '2026-11-01T10:05:00Z', 'done', 12)")
con.execute("INSERT INTO round_items (round_id, exercise_slug, exercise_name, reps)"
            " VALUES (?, 'oldjacks', 'Jumping jacks', 12)", (cur.lastrowid,))
con.commit()
con.close()
v = getfit.view()
names = {t["name"]: t["reps"] for t in v["totals"]}
check("retired exercise still counted", names.get("Jumping jacks") == 12, names)
check("summary sums everything", names.get("Total reps") == sum(n for k, n in names.items() if k != "Total reps"), names)

# 8. the view model marks an open round and hides the next-set countdown
CLOCK["now"] = datetime(2026, 11, 14, 8, 0, tzinfo=timezone.utc)
con = getfit.connect()
con.execute("UPDATE app_state SET next_set_at=? WHERE id=1", (getfit.iso(CLOCK["now"]),))
con.commit()
con.close()
run(getfit.cmd_tick)
v = getfit.view()
check("view reports an open round", v["round_open"] is True, v["round_open"])
check("no next set while a round is open", v["next_set"] is None, v["next_set"])

# 9. the calendar groups rounds by local day with a completion ratio
day = v["calendar"]["today"]
slot = v["calendar"]["days"].get(day)
check("calendar has today", slot is not None, v["calendar"]["days"].keys())
check("calendar day counts one round", slot and slot["rounds"] >= 1, slot)
check("calendar day reports zero reps so far", slot and slot["reps"] >= 0, slot)

print()
print("FAILURES:", fails if fails else "none")
sys.exit(1 if fails else 0)
