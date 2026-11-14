# Running get-fit somewhere else

Everything the service needs is in this repository except two things that belong to the machine:
a scheduler and (optionally) a messaging hook. This file is the checklist for moving the runtime.

## What the service actually is

| piece | process | lives in |
|---|---|---|
| **the tick** | `getfit.py tick`, once a minute. Decides whether a set is due, opens a round, prints the message | `scripts/getfit-tick.sh` (scheduler calls it) |
| **the dashboard** | `server.py`, long-lived, port 8777 (TLS on 8443 when `certs/` exists) | `server.py`, `index.html`, `settings.html`, `art/` |
| **the state** | `getfit.db` (SQLite, tracked in git) | repo root |
| **confirm by chat** | a Hermes gateway hook + a model-routing plugin | *not in this repo — machine-specific* |

Only the last one is optional: the dashboard's **Mark done** button posts to `/api/confirm` and runs
the same `getfit.confirm()` the hook does, so a machine without Telegram is still fully usable.

## Moving it to another machine

1. **Clone** `git@github.com:AfraIsNotAvailable/get-fit.git` and `cd` into it.
2. **Check python**: 3.11+ (uses `zoneinfo`). Nothing to `pip install` — stdlib only.
3. **Config**: `settings` lives in `getfit.db`, not in a file. A fresh clone carries the current
   settings, stack and history because the DB is tracked. Edit them at `/settings`.
4. **Run the dashboard**: `python3 server.py --port 8777`. For browser notifications you need a
   secure context — either `localhost` or the TLS listener: put `getfit.crt`/`getfit.key` in
   `certs/` (gitignored) and open `https://<host>:8443`.
5. **Run the tick**: schedule `scripts/getfit-tick.sh` every minute. It resolves the checkout from
   its own location, keeps the dashboard alive, and runs the tick under a 180 s timeout.

   ```
   * * * * * /path/to/get-fit/scripts/getfit-tick.sh >> /path/to/get-fit/tick.log 2>&1
   ```

   On macOS cron needs Full Disk Access, or use a `launchd` `StartInterval=60` job instead. Either
   way the script is the only thing the scheduler knows about.
6. **Verify**: `python3 getfit.py status` shows the clock; `python3 getfit.py tick --dry-run` shows
   what the next tick would send; `python3 tests.py` should pass (60 assertions).

## One writer only

`getfit.db` being tracked is what makes the history portable, but it also means **two machines
running the service will diverge**: each writes rounds, wear events and check-ins to its own copy,
and merging two SQLite files by hand is not a thing you want to do. Pick one host to run the tick
and the dashboard. Moving the runtime is `git pull` on the new host *while the old one is stopped*,
then start it there.

If you develop on one machine and deploy on another, keep the DB out of the way of development:
`getfit.py reset --keep-tally` clears rounds without losing the lifetime totals.

## What this Pi does today

- Cron job `get-fit` (Hermes, `every 1m`, `no_agent`) runs `/opt/data/scripts/getfit-tick.sh`, which
  is the Pi-local copy of `scripts/getfit-tick.sh` with `APP` and `PY` hard-coded.
- The gateway hook `/opt/data/hooks/getfit-confirm/` turns a Telegram "done" into
  `getfit.py confirm` and posts the receipt; the plugin `/opt/data/plugins/getfit-confirm-cheap/`
  keeps the follow-up agent turn cheap and silent.
- TLS material in `certs/` (gitignored) with SANs for this box's IPs.

When you move development off this box, none of that has to change until you decide to deploy a
newer version here: `git pull` + restart `server.py` is the whole upgrade.

## Where the thinking lives

- `docs/fatigue-model-research.md` — the research brief: frameworks that already exist, what the
  evidence says the model should do, the sources, and a section recording which of the model's
  constants are research-backed and which are priors waiting for calibration. Update that section
  whenever a coefficient changes, so the reasoning does not drift away from the code.
- `art/CREDITS.md` — the licence record for the muscle atlas. Required by CC BY 4.0; keep it
  accurate if the artwork is ever replaced.
