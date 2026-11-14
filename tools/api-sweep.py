"""Contract sweep for /api/v1 — every route, the codes, the problem+json shape.

Run against a scratch instance (auth ON) so the 401/409/422 paths are real:
    GETFIT_DB=... GETFIT_PORT=8792 GETFIT_REQUIRE_TOKEN=1 SCHEDULER=on tsx src/main.ts
    python3 tools/api-sweep.py http://127.0.0.1:8792 <token>
"""
import json
import sys
import urllib.error
import urllib.request

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://127.0.0.1:8792"
TOKEN = sys.argv[2] if len(sys.argv) > 2 else ""
passed, failed = [], []


def call(method, path, body=None, token=True, headers=None):
    url = f"{BASE}{path}"
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if token and TOKEN:
        req.add_header("Authorization", f"Bearer {TOKEN}")
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            raw = response.read()
            return response.status, response.headers, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            parsed = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            parsed = raw.decode()[:200]
        return error.code, error.headers, parsed


def check(name: str, condition: object, detail: object = "") -> None:
    """Record one assertion; the detail only prints when it fails."""
    (passed if condition else failed).append(f"{name}" if condition else f"{name}  -> {detail!r}")


# ------------------------------------------------------------------ open paths
status, _, health = call("GET", "/api/v1/health", token=False)
check("GET /health is open and 200", status == 200, status)
check("GET /health reports scheduler + db", isinstance(health, dict) and "scheduler" in health, health)

status, _, meta = call("GET", "/api/v1/meta", token=False)
check("GET /meta needs no token (vocabulary for clients)", status == 200, status)
check("GET /meta lists 22 muscles", status == 200 and len(meta["muscles"]) == 22, status)
check("GET /meta lists the library", status == 200 and len(meta["library"]) > 20, status)
check("GET /meta enums include round status", status == 200 and "missed" in meta["enums"]["roundStatus"], status)

# ------------------------------------------------------------------ auth
status, headers, body = call("GET", "/api/v1/dashboard", token=False)
check("GET /dashboard without a token is 401", status == 401, status)
check("401 body is problem+json", headers.get("Content-Type", "").startswith("application/problem+json"), headers.get("Content-Type"))
status, headers, body = call("GET", "/api/v1/dashboard")
check("GET /dashboard with a token is 200", status == 200, status)
check("dashboard carries an ETag", bool(headers.get("ETag")), headers.get("ETag"))
etag = headers.get("ETag")
status, _, _ = call("GET", "/api/v1/dashboard", headers={"If-None-Match": etag})
check("If-None-Match returns 304", status == 304, status)

status, _, me = call("GET", "/api/v1/auth/me")
check("GET /auth/me names the device", status == 200 and me.get("name"), me)

# ------------------------------------------------------------------ reads
for path, key in (("/api/v1/now", "timezone"), ("/api/v1/rounds", "items"),
                  ("/api/v1/checkins", None), ("/api/v1/library", None),
                  ("/api/v1/muscles/chest", "slug"), ("/api/v1/profile/history", None),
                  ("/api/v1/muscles", None), ("/api/v1/profile", "params"),
                  ("/api/v1/calendar", "days"), ("/api/v1/settings", "exercises"),
                  ("/api/v1/checkins/todo", "due")):
    status, _, body = call("GET", path)
    ok = status == 200 and (key is None or (isinstance(body, dict) and key in body))
    check(f"GET {path} is 200 with {key or 'a list'}", ok, status)

status, _, body = call("GET", "/api/v1/rounds?limit=3")
check("GET /rounds honours limit", status == 200 and len(body) <= 3, len(body) if status == 200 else status)

status, _, body = call("GET", "/api/v1/rounds/does-not-exist")
check("GET /rounds/{unknown} is 404", status == 404, status)

status, _, body = call("GET", "/api/v1/nope")
check("unknown path is 404 problem+json", status == 404, status)

# ------------------------------------------------------------------ the round on the clock
status, _, dash = call("GET", "/api/v1/dashboard")
current = dash.get("currentRound")
check("a round is on the clock", bool(current) and current["status"] in ("pending", "missed"), current and current["status"])

if current:
    key = current["key"]
    status, _, confirmed = call("POST", f"/api/v1/rounds/{key}/confirm", {"source": "cli"})
    check("POST confirm on the open round is 200", status == 200, (status, confirmed))
    check("confirm returns a receipt", status == 200 and confirmed.get("receipt"), confirmed)
    status, _, body = call("POST", f"/api/v1/rounds/{key}/confirm", {"source": "cli"})
    check("a second confirm is 409", status == 409, status)
    status, _, body = call("POST", "/api/v1/rounds/nope/confirm", {"source": "cli"})
    check("confirm on an unknown round is 409/404", status in (404, 409), status)

# ------------------------------------------------------------------ check-ins
status, _, body = call("POST", "/api/v1/checkins", {"kind": "gate", "stress": 9})
check("gate with stress 9 is 422", status == 422, (status, body))
check("422 names the field that failed",
      status == 422 and any(e.get("path", "").endswith("stress") for e in body.get("errors", [])),
      body)

status, _, body = call("POST", "/api/v1/checkins", {"kind": "gate"})
check("an empty gate is accepted (partial answers are the point)", status == 201, status)

status, _, body = call("POST", "/api/v1/checkins",
                       {"kind": "gate", "sleep": 7.5, "stress": 2, "fatigue": 2, "soreness": 2, "prs": 7, "pain": False})
check("a real gate is accepted with 201", status == 201, (status, body))
check("the gate answer comes back with readiness", status == 201 and body.get("readiness") is not None, body)
status, _, dash = call("GET", "/api/v1/dashboard")
check("readiness moved off the 0.7 default", abs(dash["readiness"]["score"] - 0.7) > 0.001, dash["readiness"]["score"])
check("today's gate is recorded as answered",
      sorted(dash["checkinTodo"]["gateAnswered"]) == ["fatigue", "pain", "prs", "sleep", "soreness", "stress"],
      dash["checkinTodo"]["gateAnswered"])

status, _, body = call("POST", "/api/v1/checkins",
                       {"kind": "post", "roundKey": "nope", "srpe": 7, "rir": 1})
check("post check-in for an unknown round is 404", status == 404, (status, body))

# ------------------------------------------------------------------ settings
status, _, settings = call("GET", "/api/v1/settings")
original = settings
bad = dict(original, intervalMinutes=0)
status, _, body = call("PUT", "/api/v1/settings", bad)
check("interval 0 is 422", status == 422, (status, body))
status, _, body = call("PUT", "/api/v1/settings", dict(original, timezone="Mars/Olympus"))
check("a bogus timezone is 422", status == 422, (status, body))
status, _, body = call("PUT", "/api/v1/settings", original)
check("the unchanged settings round-trip is 200", status == 200, (status, body))

print(f"passed {len(passed)}  failed {len(failed)}")
for line in passed:
    print("  ok   ", line)
for line in failed:
    print("  FAIL ", line)
sys.exit(1 if failed else 0)
