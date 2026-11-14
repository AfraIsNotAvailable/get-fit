#!/usr/bin/env python3
"""Diff the TypeScript dashboard against the Python /api/state.

Temporary harness, deleted at cutover. It copies the live database twice, asks
`getfit.view()` and `/api/v1/dashboard` the same questions, and exits non-zero on
any disagreement. Run it after touching the engine or the db layer:

    python3 tools/parity.py                      # live copy from the Pi
    python3 tools/parity.py /path/to/getfit.db   # any copy

Nothing here writes to the real database or the Pi.
"""
from __future__ import annotations

import json
import os
import tempfile
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCRATCH = Path(tempfile.mkdtemp(prefix="getfit-parity-"))
PORT = 8799
BASE = f"http://127.0.0.1:{PORT}"

# usage: tools/parity.py [getfit.db]
# With no argument it copies the live database off the Pi (read-only, over ssh).
if len(sys.argv) > 1:
    shutil.copy(sys.argv[1], SCRATCH / "py.db")
else:
    subprocess.run(["scp", "-q", "rpi4:/home/afra/get-fit/getfit.db", str(SCRATCH / "py.db")], check=True)
shutil.copy(SCRATCH / "py.db", SCRATCH / "ts.db")

# ---------------------------------------------------------------- python side
sys.path.insert(0, str(REPO))
import getfit  # noqa: E402

getfit.DB_PATH = SCRATCH / "py.db"
v = getfit.view()


def py_muscle(m):
    return {"slug": m["slug"], "wear": m["wear"], "soreness": m["soreness"], "load": m["load"]}


py = {
    "totals": {t["id"]: t["reps"] for t in v["totals"] if t["id"] != "_summary"},
    "total_sum": sum(t["reps"] for t in v["totals"] if t["id"] != "_summary"),
    "sets_done": v["tally"]["sets_done"],
    "sets_missed": v["tally"]["sets_missed"],
    "current": None if not v["current"] else {
        "key": v["current"]["id"],
        "status": v["current"]["status"],
        "target_reps": sum(e["reps"] for e in v["current"]["exercises"]),
    },
    "next_set_local": None if not v["next_set"] else v["next_set"]["local"],
    "next_set_deferred": None if not v["next_set"] else v["next_set"]["deferred"],
    "preview": [{"id": p["id"], "reps": p["reps"]} for p in v["preview"]],
    "readiness": round(v["readiness"]["score"], 3),
    "muscle_count": len(v["muscles"]),
    "hottest": [py_muscle(m) for m in v["muscles"][:3]],
    "calendar_today": v["calendar"]["days"].get(v["calendar"]["today"]),
    "month": {"month": v["months"]["current"]["month"], "reps": v["months"]["current"]["reps"],
              "target": v["months"]["current"]["target"]},
    "round_open": v["round_open"],
    "selection_deload": v["selection"]["deload"],
    "blocked": sorted(b["name"] for b in v["selection"]["blocked"]),
}

# ---------------------------------------------------------------- ts side
env = dict(os.environ, GETFIT_DB=str(SCRATCH / "ts.db"), GETFIT_PORT=str(PORT),
           GETFIT_HOST="127.0.0.1", SCHEDULER="off")
server = subprocess.Popen(
    [str(REPO / "apps/server/node_modules/.bin/tsx"), "src/main.ts"],
    cwd=REPO / "apps/server", env=env,
    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
)
try:
    for _ in range(60):
        try:
            urllib.request.urlopen(f"{BASE}/api/v1/health", timeout=1).read()
            break
        except Exception:
            time.sleep(0.25)
    else:
        print("server never came up"); print(server.stderr.read().decode()); raise SystemExit(1)

    dash = json.loads(urllib.request.urlopen(f"{BASE}/api/v1/dashboard", timeout=10).read())

    def ts_muscle(m):
        return {"slug": m["slug"], "wear": m["wear"], "soreness": m["soreness"], "load": m["load"]}

    today = dash["calendar"]["days"].get(dash["calendar"]["today"])
    ts = {
        "totals": {t["id"]: t["reps"] for t in dash["lifetime"]["exercises"]},
        "total_sum": dash["lifetime"]["totalReps"],
        "sets_done": dash["lifetime"]["setsDone"],
        "sets_missed": dash["lifetime"]["setsMissed"],
        "current": None if not dash["currentRound"] else {
            "key": dash["currentRound"]["key"],
            "status": dash["currentRound"]["status"],
            "target_reps": sum(i["reps"] for i in dash["currentRound"]["items"]),
        },
        "next_set_local": None if not dash["nextSet"] else dash["nextSet"]["local"],
        "next_set_deferred": None if not dash["nextSet"] else dash["nextSet"]["deferred"],
        "preview": [{"id": p["id"], "reps": p["reps"]} for p in dash["nextAssignment"]],
        "readiness": round(dash["readiness"]["score"], 3),
        "muscle_count": len(dash["muscles"]),
        "hottest": [ts_muscle(m) for m in dash["muscles"][:3]],
        "calendar_today": None if not today else {"rounds": today["rounds"], "done": today["done"],
                                                  "reps": today["reps"], "by_ex": today["byEx"],
                                                  "ratio": today["ratio"]},
        "month": {"month": dash["months"]["current"]["month"],
                  "reps": dash["months"]["current"]["reps"],
                  "target": dash["months"]["current"]["target"]},
        "round_open": dash["roundOpen"],
        "selection_deload": dash["selection"]["deload"],
        "blocked": sorted(b["name"] for b in dash["selection"]["blocked"]),
    }
finally:
    server.terminate()
    try:
        server.wait(timeout=5)
    except subprocess.TimeoutExpired:
        server.kill()

# ---------------------------------------------------------------- diff
diffs: list[str] = []
for key in sorted(set(py) | set(ts)):
    a, b = py.get(key), ts.get(key)
    if key == "totals":
        for k in sorted(set(a) | set(b)):
            if a.get(k) != b.get(k):
                diffs.append(f"totals[{k}]: {a.get(k)} vs {b.get(k)}")
        continue
    if key == "hottest":
        if [x["slug"] for x in a] != [x["slug"] for x in b]:
            diffs.append(f"hottest order: {[x['slug'] for x in a]} vs {[x['slug'] for x in b]}")
        for i, (x, y) in enumerate(zip(a, b)):
            for field in ("wear", "soreness", "load"):
                if abs(float(x[field]) - float(y[field])) > 0.11:
                    diffs.append(f"hottest[{i}].{field}: {x[field]} vs {y[field]}")
        continue
    if a != b:
        diffs.append(f"{key}:\n      py={a}\n      ts={b}")

print("================ parity: live database copy ================")
for key in sorted(py):
    print(f"{key:18} {json.dumps(py[key], default=str)[:110]}")
print()
print("DIFFS:", len(diffs))
for d in diffs:
    print("  -", d)
raise SystemExit(1 if diffs else 0)
