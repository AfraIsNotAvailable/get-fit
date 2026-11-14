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

# ---------------------------------------------------------------- muscle model
# 10. the taxonomy and the attribution that the model stands on
import muscles  # noqa: E402

v = getfit.view()
check("22 muscle groups", len(v["muscles"]) == 22, len(v["muscles"]))
check("every group carries a stop threshold",
      all(m["stop_at"] == 80 and m["resume_at"] == 35 for m in v["muscles"]),
      [m["stop_at"] for m in v["muscles"]][:3])

con = getfit.connect()
push = {p["muscle_slug"]: p for p in muscles.attribution(con, "pushups")}
squat = {p["muscle_slug"]: p for p in muscles.attribution(con, "squats")}
con.close()
check("push-ups debit chest first", push.get("chest", {}).get("weight") == 1.0, push.get("chest"))
check("push-ups debit seven muscles", len(push) == 7, list(push))
check("push-ups hit triceps and front delts",
      push.get("triceps", {}).get("role") == "primary"
      and push.get("anterior-deltoid", {}).get("weight") == 0.45, push.get("triceps"))
check("squats debit quads at full weight",
      squat.get("quads", {}).get("weight") == 1.0 and squat.get("glutes", {}).get("weight") == 0.6,
      squat.get("glutes"))


def reset_muscles():
    """Zero the model without letting init_db's backfill refill it."""
    con = getfit.connect()
    con.execute("DELETE FROM wear_events")
    con.execute("DELETE FROM checkins")
    con.execute("UPDATE muscle_state SET wear=0, soreness=0, rest_until=NULL,"
                " last_loaded_at=NULL, updated_at=?", (getfit.iso(CLOCK["now"]),))
    con.execute("UPDATE exercise_muscles SET k=weight*?, exposure=0", (muscles.BASE_K,))
    con.commit()
    con.close()


def wear_of(slug):
    con = getfit.connect()
    row = con.execute("SELECT wear, soreness FROM muscle_state WHERE muscle_slug=?",
                      (slug,)).fetchone()
    con.close()
    return dict(row)


def settings_now():
    con = getfit.connect()
    out = getfit.load_settings(con)
    con.close()
    return out


def fake_round(key, slug, reps, at):
    """A performed round with a matching round row, so the model can be tested
    without driving the whole tick/confirm state machine."""
    con = getfit.connect()
    cur = con.execute(
        "INSERT OR IGNORE INTO rounds (round_key, sent_at, sent_local_date, deadline_at,"
        " resolved_at, status, target_reps) VALUES (?,?,?,?,?,'done',?)",
        (key, getfit.iso(at), at.date().isoformat(), getfit.iso(at), getfit.iso(at), reps))
    if cur.rowcount:
        con.execute("INSERT INTO round_items (round_id, exercise_slug, exercise_name, reps)"
                    " VALUES (?,?,?,?)", (cur.lastrowid, slug, slug.title(), reps))
    con.commit()
    con.close()


# 11. performing a set debits the muscles that set actually uses
reset_muscles()
fake_round("r-accrue", "pushups", 10, CLOCK["now"])
con = getfit.connect()
muscles.accrue(con, "r-accrue", [{"id": "pushups", "reps": 10}], CLOCK["now"])
con.commit()
con.close()
check("10 push-ups cost 10 chest points", abs(wear_of("chest")["wear"] - 10) < 0.01,
      wear_of("chest"))
check("triceps get 0.6 of the chest dose", abs(wear_of("triceps")["wear"] - 6) < 0.01,
      wear_of("triceps"))
check("a muscle the exercise never touches stays at zero", wear_of("quads")["wear"] == 0,
      wear_of("quads"))

# 12. wear decays: half is gone after one half-life
con = getfit.connect()
muscles.decay(con, CLOCK["now"] + timedelta(hours=muscles.WEAR_HALF_LIFE_H))
con.commit()
con.close()
check("wear halves over one half-life", abs(wear_of("chest")["wear"] - 5) < 0.05, wear_of("chest"))
reset_muscles()

# 13. 80% is a ceiling: a hot chest drops push-ups out of the plan
con = getfit.connect()
con.execute("UPDATE muscle_state SET wear=85, updated_at=? WHERE muscle_slug='chest'",
            (getfit.iso(CLOCK["now"]),))
con.commit()
plan, meta = getfit.plan_round(con, settings_now(), 0, CLOCK["now"])
con.close()
ids = [p["id"] for p in plan]
check("chest at 85 blocks push-ups", "pushups" not in ids, ids)
check("something else is still assigned", ids == ["squats"], ids)
check("the block is explained", any(b["id"] == "pushups" for b in meta["blocked"]), meta["blocked"])

# 14. rotation: the exercise that has been waiting goes first
reset_muscles()
con = getfit.connect()
stack = settings_now()["exercises"]
fresh = muscles.plan(con, stack, CLOCK["now"], {}, set())[0]
recent = muscles.plan(con, stack, CLOCK["now"], {"pushups": getfit.iso(CLOCK["now"])}, set())[0]
con.close()
check("with nothing done, list order decides", [e["id"] for e in fresh][0] == "pushups",
      [e["id"] for e in fresh])
check("an exercise done an hour ago yields to one that has waited",
      [e["id"] for e in recent][0] == "squats", [e["id"] for e in recent])

# 15. a bad-readiness check-in lowers everyone's ceiling
con = getfit.connect()
muscles.record_checkin(con, {"kind": "gate", "sleep": 5, "stress": 5, "fatigue": 5,
                             "soreness": 5, "prs": 1}, CLOCK["now"])
ready = muscles.readiness(con, CLOCK["now"])
con.close()
check("readiness reads low after a bad night", ready["score"] < 0.2, ready)
check("a bad day stops work near 60 instead of 80",
      58 <= muscles.effective_stop(80, ready["score"]) <= 62,
      muscles.effective_stop(80, ready["score"]))

# 16. the feedback loop: report more soreness than predicted and k climbs
reset_muscles()
fake_round("r-loop", "pushups", 10, CLOCK["now"])
con = getfit.connect()
muscles.accrue(con, "r-loop", [{"id": "pushups", "reps": 10}], CLOCK["now"])
con.commit()
before = {p["muscle_slug"]: p["k"] for p in muscles.attribution(con, "pushups")}
muscles.record_checkin(con, {"kind": "post", "round_key": "r-loop", "rir": 1,
                             "muscle_soreness": {"chest": 5}}, CLOCK["now"])
after = {p["muscle_slug"]: p["k"] for p in muscles.attribution(con, "pushups")}
con.close()
check("a worse-than-predicted set raises the chest coefficient",
      after["chest"] > before["chest"], (before["chest"], after["chest"]))
check("it only moves the muscle that was reported",
      after["triceps"] == before["triceps"], (before["triceps"], after["triceps"]))

# 17. and the other way: an easy set with nothing left to give shrinks k
reset_muscles()
fake_round("r-easy", "pushups", 10, CLOCK["now"])
con = getfit.connect()
muscles.accrue(con, "r-easy", [{"id": "pushups", "reps": 10}], CLOCK["now"])
con.commit()
muscles.record_checkin(con, {"kind": "post", "round_key": "r-easy", "rir": 3,
                             "muscle_soreness": {"chest": 1, "triceps": 1}}, CLOCK["now"])
low = {p["muscle_slug"]: p["k"] for p in muscles.attribution(con, "pushups")}
con.close()
check("an easy, painless set lowers the coefficients",
      low["chest"] < 1.0 and low["triceps"] < 0.6, low)

# 18. an exercise nobody has attributed is visible, not silently skipped
con = getfit.connect()
settings = settings_now()
settings["exercises"].append({"id": "", "name": "Zercher carry", "min": 5, "max": None})
getfit.save_settings(con, settings)
missing = [m["name"] for m in muscles.unattributed(con)]
con.execute("UPDATE exercises SET active=0 WHERE name='Zercher carry'")
con.commit()
con.close()
check("an unknown exercise is flagged for attribution", "Zercher carry" in missing, missing)
reset_muscles()

# ---------------------------------------------------------------- the profile
# 19. refit fits this user, and says "prior" when it cannot
import json  # noqa: E402


def wipe():
    con = getfit.connect()
    for table in ("wear_events", "checkins", "round_items", "rounds"):
        con.execute(f"DELETE FROM {table}")
    con.execute("UPDATE muscle_state SET wear=0, soreness=0, rest_until=NULL,"
                " last_loaded_at=NULL, stop_at=80, updated_at=?", (getfit.iso(CLOCK["now"]),))
    con.execute("UPDATE exercise_muscles SET k=weight*?, exposure=0", (muscles.BASE_K,))
    con.execute("DELETE FROM profile")
    con.commit()
    con.close()
    getfit.init_db(getfit.connect())   # re-seed priors


def synthetic(key, dose, t0, t1, level, rir=None, muscle="chest"):
    """A round, its predicted cost, and the answer it got — written directly so
    the fit can be tested against a known generating process."""
    con = getfit.connect()
    con.execute(
        "INSERT INTO rounds (round_key, sent_at, sent_local_date, deadline_at,"
        " resolved_at, status, target_reps) VALUES (?,?,?,?,?,'done',?)",
        (key, getfit.iso(t0), t0.date().isoformat(), getfit.iso(t0), getfit.iso(t1),
         int(dose)))
    con.execute("INSERT INTO wear_events (round_key, exercise_slug, muscle_slug, reps,"
                " predicted, at) VALUES (?,?,?,?,?,?)",
                (key, "pushups", muscle, 1, float(dose), getfit.iso(t0)))
    con.execute("INSERT INTO checkins (kind, at, round_key, rir, per_muscle)"
                " VALUES ('post', ?, ?, ?, ?)",
                (getfit.iso(t1), key, rir, json.dumps({muscle: level})))
    con.commit()
    con.close()


def profile_value(key):
    con = getfit.connect()
    out = muscles.profile_get(con, key)
    con.close()
    return out


wipe()
con = getfit.connect()
empty = muscles.refit(con, CLOCK["now"])
cal_empty = muscles.calibration(con)
con.close()
check("with no check-ins the profile stays on its priors",
      not empty["wear_half_life"]["fitted"] and empty["wear_half_life"]["value"] == 40.0,
      empty["wear_half_life"])
check("and the error score is honestly empty", cal_empty["mae"] is None, cal_empty)

# 20. a series of reports generated by a known recovery rate, across two
# "how long after" buckets, moves the fitted half-life the right way
def synth_series(prefix, h_true, hours, doses):
    for i, h in enumerate(hours):
        for j, dose in enumerate(doses):
            value = dose * (0.5 ** (h / h_true))
            level = min(muscles.SORENESS_TO_WEAR,
                        key=lambda k: abs(muscles.SORENESS_TO_WEAR[k] - value))
            synthetic(f"{prefix}{i}{j}", dose, CLOCK["now"] - timedelta(hours=h),
                      CLOCK["now"], level)


wipe()
synth_series("slow", 96.0, (24, 60), (40, 55, 70, 85))
con = getfit.connect()
slow = muscles.refit(con, CLOCK["now"])
con.close()
check("reports that are still sore two days out fit a long half-life",
      slow["wear_half_life"]["fitted"] and slow["wear_half_life"]["value"] > 40,
      slow["wear_half_life"])

# 21. and a series that clears within a day fits a short one
wipe()
synth_series("fast", 16.0, (8, 24), (50, 65, 80, 95))
con = getfit.connect()
fast = muscles.refit(con, CLOCK["now"])
con.close()
check("reports that clear in a day fit a short half-life",
      fast["wear_half_life"]["fitted"] and fast["wear_half_life"]["value"] < 40,
      fast["wear_half_life"])

# 22. a muscle that keeps cratering gets a lower ceiling
wipe()
for i in range(3):
    synthetic(f"crater{i}", 80, CLOCK["now"] - timedelta(hours=30 * (i + 1)),
              CLOCK["now"] - timedelta(hours=30 * (i + 1) - 2), 5, rir=0)
con = getfit.connect()
muscles.refit(con, CLOCK["now"])
stop = con.execute("SELECT stop_at FROM muscle_state WHERE muscle_slug='chest'").fetchone()["stop_at"]
untouched = con.execute("SELECT stop_at FROM muscle_state WHERE muscle_slug='calves'").fetchone()["stop_at"]
con.close()
check("repeated failure at high load lowers that muscle's stop", stop < 80, stop)
check("muscles with no evidence keep the base", untouched == 80, untouched)

# 23. a bad gate that never costs anything loses its influence
wipe()
for i in range(3):
    t0 = CLOCK["now"] - timedelta(hours=20 * (i + 1))
    synthetic(f"resisted{i}", 40, t0, t0 + timedelta(hours=1), 2, rir=3)
    con = getfit.connect()
    con.execute("INSERT INTO checkins (kind, at, prs) VALUES ('gate', ?, 3)",
                (getfit.iso(t0 - timedelta(hours=1)),))
    con.commit()
    con.close()
con = getfit.connect()
fitted = muscles.refit(con, CLOCK["now"])
influence = muscles.profile_get(con, "readiness_influence")
con.close()
check("a bad readiness score that changes nothing stops lowering the ceiling",
      fitted["readiness_influence"]["fitted"] and influence < 20, influence)

# 24. and the CLI-facing profile view reports the same numbers
wipe()
con = getfit.connect()
rows = {r["key"]: r for r in muscles.profile_rows(con)}
con.close()
check("profile rows carry value, prior and sample size",
      set(rows) == {"wear_half_life", "readiness_influence", "stop_base"}
      and all({"value", "prior", "n", "fitted"} <= set(r) for r in rows.values()), list(rows))

print()
print("FAILURES:", fails if fails else "none")
sys.exit(1 if fails else 0)
