#!/usr/bin/env bash
# get-fit — one scheduler tick. Run this every minute from cron / launchd /
# systemd-timer. Prints the set when one is due; empty stdout = a silent tick.
#
# Portable copy: point it at the checkout with GETFIT_HOME (defaults to the
# parent of this script) and at an interpreter with GETFIT_PY (defaults to
# python3 on PATH).
#
#   * * * * * /path/to/get-fit/scripts/getfit-tick.sh >> /path/to/get-fit/tick.log 2>&1
#
# Hard rules learned the hard way:
#  - the dashboard keepalive must be detached (setsid --fork where available,
#    nohup otherwise) and fully unlinked from this script's stdio. A plain
#    `( ... & )` can leave the spawned server as a child of this shell; a cron
#    runner that waits on the process tree then kills the job with
#    "script timed out" even though the tick itself was fine.
#  - the tick itself is wrapped in `timeout` so no hang can eat an hour.
set -u

APP="${GETFIT_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PY="${GETFIT_PY:-$(command -v python3)}"
PORT="${GETFIT_PORT:-8777}"

[ -x "$PY" ] || { echo "getfit-tick: no python3 (set GETFIT_PY)" >&2; exit 1; }

# keep the dashboard server alive (best effort — never breaks the tick)
if ! curl -sf -m 2 -o /dev/null "http://127.0.0.1:${PORT}/api/state" 2>/dev/null; then
  (
    cd "$APP" || exit 0
    if setsid --fork true 2>/dev/null; then
      setsid --fork "$PY" server.py --port "$PORT" </dev/null >>server.log 2>&1
    else
      nohup "$PY" server.py --port "$PORT" </dev/null >>server.log 2>&1 &
    fi
  ) >/dev/null 2>&1
fi

exec timeout 180 "$PY" "$APP/getfit.py" tick
