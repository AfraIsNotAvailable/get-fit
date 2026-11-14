#!/usr/bin/env bash
# get-fit — deploy the main branch onto this host and restart the dashboard.
#
# Pull, don't merge. getfit.db is tracked, and the running service writes to it
# on every tick, so a plain `git pull` refuses to move whenever a round has been
# logged. The code comes from origin; the state stays on the host: the database
# is parked for the duration of the reset and put straight back.
#
# Idempotent — with HEAD already at origin/main it only health-checks. Safe to
# run by hand, from cron, or from a GitHub Actions self-hosted runner.
#
#   GETFIT_HOME  checkout to deploy          (default: parent of this script)
#   GETFIT_PORT  dashboard port              (default 8777)
#   GETFIT_BRANCH branch to deploy           (default main)
set -euo pipefail

APP="${GETFIT_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PORT="${GETFIT_PORT:-8777}"
BRANCH="${GETFIT_BRANCH:-main}"
PY="${GETFIT_PY:-$(command -v python3)}"
cd "$APP"

say() { printf '[deploy] %s\n' "$*"; }

[ -d .git ] || { say "$APP is not a git checkout"; exit 1; }

server_pid() {
  ps -eo pid,cmd | awk -v p="--port" -v port="$PORT" \
    '$3=="server.py" && $4=="--port" && $5==port {print $1; exit}'
}

restart_server() {
  local pid
  pid=$(server_pid || true)
  if [ -n "${pid:-}" ]; then
    say "stopping dashboard (pid $pid)"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    # If something supervises the dashboard (systemd Restart=always on the Pi,
    # s6 elsewhere), the kill *is* the restart: wait for it to come back before
    # spawning a second copy that would only race it for the port.
    for _ in $(seq 1 16); do
      if healthy; then say "a supervisor restarted the dashboard"; return 0; fi
      sleep 0.5
    done
  fi
  # double-fork: the cron keepalive does the same, and a server parented to this
  # shell would keep a CI job waiting on the process tree
  if setsid --fork true 2>/dev/null; then
    setsid --fork "$PY" server.py --port "$PORT" </dev/null >>server.log 2>&1
  else
    nohup "$PY" server.py --port "$PORT" </dev/null >>server.log 2>&1 &
  fi
}

healthy() {
  curl -sf -m 2 -o /dev/null "http://127.0.0.1:$PORT/api/state"
}

wait_healthy() {
  for _ in $(seq 1 40); do
    healthy && return 0
    sleep 0.5
  done
  return 1
}

PREV=$(git rev-parse HEAD)
say "at $(git rev-parse --short HEAD) ($BRANCH)"

git fetch --quiet origin "$BRANCH"
TARGET=$(git rev-parse "origin/$BRANCH")
say "origin/$BRANCH is $(git rev-parse --short "$TARGET")"

if [ "$PREV" = "$TARGET" ]; then
  if healthy; then
    say "nothing to deploy; dashboard healthy on :$PORT"
    exit 0
  fi
  say "nothing to deploy but the dashboard is down — restarting"
  restart_server
  wait_healthy && { say "healthy on :$PORT"; exit 0; }
  say "dashboard did not come back up"
  exit 1
fi

# Park the database: `git reset --hard` would otherwise overwrite it with the
# repository's copy and undo every round logged since the last commit. The
# window is two moves wide; a tick landing inside it loses that one write.
PARK=$(mktemp -u "${TMPDIR:-/tmp}/getfit-db.XXXXXX")
mv getfit.db "$PARK"
restore_db() { [ -f "$PARK" ] && mv "$PARK" getfit.db; }
trap 'restore_db' EXIT

say "checking out $(git rev-parse --short "$TARGET")"
git reset --hard --quiet "$TARGET"
restore_db
trap - EXIT

say "tests"
if ! "$PY" tests.py >"${TMPDIR:-/tmp}/getfit-tests.log" 2>&1; then
  tail -25 "${TMPDIR:-/tmp}/getfit-tests.log" >&2
  say "tests failed — code back to $(git rev-parse --short "$PREV"), service untouched"
  git reset --hard --quiet "$PREV"
  exit 1
fi

restart_server
if wait_healthy; then
  say "deployed $(git rev-parse --short "$TARGET"), healthy on :$PORT"
  exit 0
fi

say "health check failed — rolling code back to $(git rev-parse --short "$PREV")"
git reset --hard --quiet "$PREV"
restart_server
say "rolled back; investigate server.log"
exit 1
