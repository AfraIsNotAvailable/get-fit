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

## Deploying on push

`.github/workflows/deploy.yml` deploys `main` to this host on every push. It runs on a
**self-hosted runner**, because a GitHub-hosted runner cannot reach a machine behind a home router and
opening a port to pull code is a bad trade. The runner dials out to GitHub; GitHub hands it the job;
the job calls `scripts/deploy.sh`, the same script you can run by hand.

**Registering the runner** (done on this box on 2026-11-14 — `/home/afra/.hermes/actions-runner` on the
host, i.e. `/opt/data/actions-runner` inside the Hermes container; name `raspberrypi`, labels
`self-hosted, getfit`, work dir `_work`):

1. GitHub → the repo → *Settings → Actions → Runners → New self-hosted runner* (Linux/ARM64 here).
2. Download per the shown commands, verify the sha256, extract.
3. `./config.sh --url https://github.com/AfraIsNotAvailable/get-fit --token <TOKEN> --name <name>
   --labels getfit --work _work --unattended --replace`
4. Start it.

**Three things about this host that make the stock instructions not apply**, all handled by
`start.sh`:

- **No systemd** (pid 1 is s6), so `svc.sh install` cannot work. The runner is started detached and
  kept alive by the tick script (`/opt/data/scripts/getfit-tick.sh`), which resurrects it within a
  minute of it dying — the same pattern that keeps the dashboard up.
- **No root and no apt lists**, so `libicu` — which the bundled .NET wants — cannot be installed,
  and `config.sh` refuses to run without it. A copy of Debian's `libicu76` is extracted under
  `libicu/` and `start.sh` puts it on `LD_LIBRARY_PATH`.
- `run.sh` and `start.sh` need `chmod +x` after extraction.

The `getfit` label is what `runs-on: [self-hosted, getfit]` matches — without it the job queues
forever. `self-hosted` is applied automatically, so `runs-on: self-hosted` also works.

Optional: set the repo variable `GETFIT_HOME` if the checkout is not `/home/afra/get-fit`; the port
defaults to 8777. The workflow's own default is that path, so a variable is only needed to override
it.

**What the deploy does**, in order: fetch → if HEAD already matches `origin/main`, health-check and
stop (a push that touches nothing runtime-safe must not bounce the service) → park `getfit.db` →
`git reset --hard origin/main` → put the database back → run `tests.py` → restart the dashboard →
poll `/api/state`. Tests failing or the health check failing rolls the **code** back to the previous
commit; the database is never rolled back, because the state is not the deploy's to rewrite.

Consequences worth knowing:

- The host is a **deploy target**, not a working copy. `reset --hard` discards local edits here by
  design. Develop elsewhere; push; let the runner pull.
- `getfit.db` is parked and restored across the reset, so rounds logged during development survive
  the deploy. The park window is two `mv`s wide — a tick landing inside it loses that one write.
- The minute cron keepalive also restarts the dashboard if it is down, so a failed health check is
  not the end of the world; the rollback just makes sure the *code* is the last known good one.

**No runner?** The script is idempotent, so polling works instead: put
`*/5 * * * * /opt/data/home/dev/web/get-fit/scripts/deploy.sh >> /opt/data/logs/getfit-deploy.log 2>&1`
in cron and it deploys within five minutes of a push, doing nothing when there is nothing to do.

## One writer only

`getfit.db` being tracked is what makes the history portable, but it also means **two machines
running the service will diverge**: each writes rounds, wear events and check-ins to its own copy,
and merging two SQLite files by hand is not a thing you want to do. Pick one host to run the tick
and the dashboard. Moving the runtime is `git pull` on the new host *while the old one is stopped*,
then start it there.

If you develop on one machine and deploy on another, keep the DB out of the way of development:
`getfit.py reset --keep-tally` clears rounds without losing the lifetime totals.

## What this Pi does today

The checkout is `/home/afra/get-fit` on the host, next to the other services in `~`. The Hermes
container mounts it at the same path (`- /home/afra/get-fit:/home/afra/get-fit` in
`/home/afra/hermes/docker-compose.yml`), so the scheduler, the confirm hook and the runner all use
identical paths. The app itself still runs inside that container (`network_mode: host`, uid 1000) and
the host reaches the dashboard on `127.0.0.1:8777`.

- Public URL `https://fit.afrasinei.dev` — one ingress rule in `/etc/cloudflared/config.yml` (root on
  the host) pointing at `http://localhost:8777`, with a Cloudflare Access application (`Get fit`,
  one-time PIN, allow `afrasinei.serban@gmail.com`) in front of it. On the LAN: `:8777`, and `:8443`
  when `certs/` exists.
- Cron job `get-fit` (Hermes, `every 1m`, `no_agent`) runs `~/.hermes/scripts/getfit-tick.sh`
  (`/opt/data/scripts/getfit-tick.sh` in the container), the Pi-local copy of
  `scripts/getfit-tick.sh` with `APP` and `PY` hard-coded to the checkout and the venv python.
- The gateway hook `~/.hermes/hooks/getfit-confirm/` turns a Telegram "done" into
  `getfit.py confirm` and posts the receipt; the plugin `~/.hermes/plugins/getfit-confirm-cheap/`
  keeps the follow-up agent turn cheap and silent. Both carry the checkout path: after moving the
  repo, update `APP` in the hook or confirmations stop landing without an error.
- TLS material in `certs/` (gitignored) with SANs for this box's IPs.

Upgrading is `git push` from the development machine: the runner pulls, tests, restarts and
health-checks, and the minute keepalive puts the dashboard back if anything dies in between.

## Where the thinking lives

- `docs/fatigue-model-research.md` — the research brief: frameworks that already exist, what the
  evidence says the model should do, the sources, and a section recording which of the model's
  constants are research-backed and which are priors waiting for calibration. Update that section
  whenever a coefficient changes, so the reasoning does not drift away from the code.
- `art/CREDITS.md` — the licence record for the muscle atlas. Required by CC BY 4.0; keep it
  accurate if the artwork is ever replaced.
