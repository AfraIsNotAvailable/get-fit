# get-fit → Vite + React + Express: the shape

**Status: plan + phase 1.** The plan below is the agreement; the engine port it describes is already in
the repo (`packages/engine`, green). The Pi still runs the Python app — nothing in this directory is
deployed.

Related: `server-modules.md` (how the server is split), `api.md` (the contract and how it is versioned),
`client.md` (web + Android), and `docs/openapi.yaml` (the draft spec, lintable as-is).

---

## 1. What the rewrite is actually for

The Python app is about 2 500 lines of engine and server (`getfit.py` 1 020, `muscles.py` 1 157,
`server.py` 287) plus 474 of tests, and it fits in your head: a state machine, a physiology model, a
stdlib HTTP server and two hand-written pages (`index.html`, `settings.html`). It works. The reasons to
move it are not "Python bad", they are:

1. **A native Android client is coming.** That needs a documented, versioned, stable HTTP contract —
   which is exactly what four ad-hoc endpoints with an implicit "the last round" target are not.
2. **One language across web and server.** The dashboard's ~1 000 lines of HTML, CSS and vanilla JS in
   `index.html` are the part of the codebase that is hardest to change safely; React + TS buys types and
   a component boundary the muscle atlas, calendar and check-in sheet can each live behind.
3. **The scheduler belongs to the service.** Today the tick is an external Hermes cron job that prints
   to stdout and lets a chat gateway deliver it. That indirection is why the runner, the keepalive and
   the hook are all load-bearing. In the rewrite the server owns the clock and publishes events.

Constraints that do **not** change:

- **One writer, one database.** `getfit.db` stays SQLite, opened by exactly one process.
- **The model is the product.** 22 muscles, 29-movement library, wear/soreness decay, `k` calibration,
  selection ranking, quiet window, bonus overflow. A rewrite that changes any of these numbers is a
  failed rewrite, regardless of how nice the code is.
- **It must never be down** while you use it. The cutover happens on the same box, behind the same
  hostname, with the old unit still installed and disabled only after parity.

---

## 2. Decisions

| decision | choice | why | rejected |
|---|---|---|---|
| runtime | Node 24 LTS, TypeScript strict | matches Vite toolchain, one language for web+server | Bun (young for systemd/sqlite), Deno (npm edge cases) |
| HTTP | **Express 5** | asked for; 5 has async error propagation, so route handlers stay flat | Fastify (better perf, but the ask is express), Hono (no need) |
| DB driver | **`node:sqlite` (`DatabaseSync`)** | ships with Node 24, no native build on arm64, synchronous like the Python code — changed from `better-sqlite3` while implementing | `better-sqlite3` (prebuilt-binary risk on the Pi), an ORM (later, if ever) |
| validation | **zod** in `packages/contracts` | one source of truth → OpenAPI → generated TS and Kotlin clients | hand-written YAML as source (drifts), class-validator (web-unfriendly) |
| Web | **Vite + React 19 + TS**, no component library | the house style is bespoke editorial CSS; a UI kit would fight it | Next.js (no SSR need, adds a server), Tailwind preset (the CSS already exists) |
| data layer | TanStack Query + generated `openapi-fetch` | polling, cache, retry and background refetch are the whole app | Redux (overkill), SWR (fine, Query is better for mutations) |
| scheduler | in-process timer in the API server | one writer, one clock, events fire where the code is | external cron (keeps the split we are removing) |
| notifications | adapter interface: `Telegram`, `Fcm`, `WebPush` | Telegram today, FCM for Android next, without touching the engine | hard-coding Telegram in the tick |
| API style | REST, `/api/v1`, resource-oriented, RFC 9457 errors | Android clients want boring HTTP | GraphQL (no need), RPC (no need) |
| repo | pnpm workspace monorepo | contracts are shared by server, web and the generated Kotlin client | two repos (spec drift) |

---

## 3. Target repository layout

```
get-fit/
├─ pnpm-workspace.yaml
├─ package.json                      # scripts: dev, build, test, openapi, lint
├─ tsconfig.base.json
├─ openapi/
│  ├─ openapi.yaml                   # GENERATED from packages/contracts, committed, CI-diffed
│  └─ clients/                       # generated: ts (web), kotlin (android), never edited
├─ packages/
│  ├─ contracts/                     # zod schemas + route metadata = the API's single source
│  │  ├─ src/resources/*.ts          # Round, Exercise, MuscleState, Checkin, Settings, Dashboard…
│  │  ├─ src/paths.ts                # path + method + request/response schema table
│  │  └─ src/openapi.ts              # zod → OpenAPI 3.1 emitter (build step)
│  ├─ engine/                        # PURE domain. no express, no sqlite, no fetch, no Date.now()
│  │  ├─ src/types.ts                # Snapshot / Round / Checkin structs
│  │  ├─ src/data.ts                 # 22 muscles, 29-movement library, priors, form links
│  │  ├─ src/time.ts                 # iso/parse, tz conversion, pyRound (half-to-even)
│  │  ├─ src/schedule.ts             # active window, clamp, compose/bonus, formatAssignment
│  │  ├─ src/wear.ts                 # decay, accrue, readiness, calibration, refit
│  │  ├─ src/selection.ts            # rank, plan, planRound
│  │  ├─ src/rounds.ts               # tick, confirm, receipt (the state machine)
│  │  ├─ src/checkins.ts             # gate/post questionnaires, CheckinRefused
│  │  ├─ src/calendar.ts             # totals, day cells, monthly ceiling
│  │  └─ src/view.ts                 # the dashboard view model
│  └─ db/                            # the only place SQL lives
│     ├─ src/schema.sql              # current schema, verbatim, plus new tables
│     ├─ src/migrate.ts              # numbered, forward-only, runs at boot
│     └─ src/repositories/*.ts       # rounds.ts, settings.ts, muscles.ts, checkins.ts, tokens.ts
├─ apps/
│  ├─ server/                        # Express 5
│  │  ├─ src/app.ts                  # express app factory (testable, no listen)
│  │  ├─ src/main.ts                 # config, migrate, listen, start scheduler, graceful stop
│  │  ├─ src/http/                   # routes/, middleware/ (auth, errors, etag, requestId), openapi.ts
│  │  ├─ src/services/               # application layer: dashboard, rounds, checkins, settings
│  │  ├─ src/scheduler/              # tick loop + event bus
│  │  ├─ src/notify/                 # telegram.ts, fcm.ts, webpush.ts
│  │  └─ test/                       # integration tests against an in-memory db
│  └─ web/                           # Vite + React + TS
│     ├─ src/api/client.ts           # openapi-fetch with the generated types
│     ├─ src/features/{dashboard,checkin,muscles,calendar,settings,profile}/
│     ├─ src/components/             # band, gauge, atlas, modal, table primitives
│     └─ src/styles/                 # the existing editorial CSS, split into tokens + components
├─ apps/android/                     # (phase 5) Kotlin + Compose, or its own repo pointing at openapi/
├─ getfit.db                         # the live db, still at the root while it is git-tracked (see §7)
├─ archive/python/                   # the frozen Python checkout, kept until cutover, then deleted
└─ docs/                             # this plan, DEPLOY.md, fatigue-model-research.md
```

**Why `packages/engine` is separate from `apps/server`:** it makes the rule enforceable. `engine` may
not import `db`, `express`, `node:fs`, or call `Date.now()` — a lint rule enforces it. Every rule that
matters (decay, ranking, bonus overflow, readiness) becomes a pure function over a snapshot, and the
60-assertion suite from `tests.py` ports one-to-one against it. The current split can't do this because
`muscles.py` both *computes* decay and *writes* it (`decay(db)`, `snapshot(db, do_decay=True)`).

---

## 4. Runtime shape on the rpi4 (after cutover)

```
cloudflared (root)  ──►  http://localhost:8787   getfit-api.service (systemd, User=afra)
                             ├── /api/v1/*        JSON, bearer token or CF Access
                             ├── /*               static files from apps/web/dist
                             ├── scheduler        5 s timer → due? → open round → emit RoundOpened
                             └── node:sqlite      /home/afra/get-fit/getfit.db
```

- One systemd unit (`getfit-api.service`), `Restart=always`, enabled at boot. No container, no cron,
  no keepalive, and the runner's PID-namespace problem disappears because the unit *is* the service.
- `deploy.sh` keeps its job (park the DB, reset --hard, tests, restart) but the "restart" becomes
  `touch .restart-request` → `getfit-restart.path` → `systemctl restart getfit-api` — the mechanism
  already proven today, minus the two-process dance.
- The web build is served by Express; no nginx, no second port, no TLS listener (Cloudflare terminates,
  and the LAN can keep `:8443` only if you still want browser notifications without the tunnel — see
  `api.md` §8).
- `getfit-api.service` replaces `getfit.service`. Both exist during cutover, one disabled.

---

## 5. Phases and their gates

Each phase ends with something verifiable; nothing is "done" because it compiles.

**Phase 0 — freeze and harness (no user-visible change).**
Copy `getfit.db` and the Python checkout into `archive/python/` (note: the existing `legacy/` is the
older thing — the pre-database JSON export — and stays where it is). Write
`scripts/capture-golden.sh` that records `/api/state` (and `getfit.py muscles|library|report|history`)
from the live DB into `packages/engine/test/fixtures/`. Port `tests.py` to Vitest **as-is** (same
assertions, same names) so the port has a pass/fail scoreboard from day one.
*Gate:* `vitest` runs the ported assertions against the Python engine's behaviour encoded as expected
values.

**Phase 1 — engine port (pure).**
`schedule`, `selection`, `wear`, `calendar` as pure functions over a `Snapshot` (muscle states, exercise
attribution, last-done map, settings, `now`). Differential test: for N random snapshots, the TS planner
must return the same exercise order and reps as `getfit.py`'s `plan_round` on the same input.
*Gate:* unit suite green + 1 000-case differential run with zero mismatches.

**Phase 2 — API v1 + auth, shadow mode.**
Express app serves `/api/v1` against a **read-only copy** of the DB. `/api/v1/dashboard` must be
section-by-section equal to `/api/state` (a JSON-diff script, field by field, on the live data).
Generate `openapi.yaml`; lint it in CI; generate the TS client.
*Gate:* dashboard diff is empty for three consecutive days of real state; OpenAPI lints clean; auth
rejects unauthenticated calls.

**Phase 3 — web rewrite.**
Vite app on a second port (`8788`) reading the same API. Side-by-side review at 1440 px, 820 px and
390 px. Feature checklist from `index.html`/`settings.html` (band, gauge, atlas hover, check-in sheet,
calendar canvas, months, profile table, settings form, notifications) ticked one by one.
*Gate:* every item on that checklist works on the new app; the old page still works.

**Phase 4 — cutover on the Pi.**
Install `getfit-api.service`, point cloudflared at `:8787`, disable `getfit.service` (Python), keep it
installed for a week. The DB file is not migrated — same schema, additive tables only.
*Gate:* a full day of ticks, one confirmed set, one missed set, one gate and one post check-in, all
landing in the same tables the Python CLI reads.

**Phase 5 — Android + push.**
Kotlin client from the checked-in OpenAPI; FCM device registration; the Telegram bot is removed
(decision 2).

---

## 6. What has to be true for "the same numbers"

The rewrite is only acceptable if these survive bit-for-bit. They are the parity contract; each has a
named test in `packages/engine/test/parity.test.ts`.

| rule | value |
|---|---|
| interval clock | runs **only between rounds**; `next_set_at` is `null` while a round is open |
| response window | `response_minutes` (default 10) from `sent_at`; expiry → `missed`, `bonus += 1` |
| confirm in window | `done`, `bonus = 0`, next set = `now + interval` clamped into the active window |
| confirm late | `late`, `bonus = 2` |
| quiet window | no sends; a due set defers to `quiet_end`; penalties persist overnight |
| bonus overflow | fills exercise 1 to `max`, then the next at its own `min`; `max_reps IS NULL` = sink |
| wear | `reps × k`, half-life 40 h; soreness 96 h; gate = `max(wear, soreness)` |
| stop/resume | 80 / 35, `stop_effective` lowered by readiness with influence 20 |
| selection score | hottest muscle loaded − 4 × days since performed − 8 × overlap with previous round |
| `k` update | `k *= ratio ** 0.35` (`0.15` once exposures > 3); RIR ≥ 3 → ×0.85, RIR 0 → ×1.12 |
| do-nothing | a missed round accrues no wear; only `done`/`late` rounds debit |
| lifetime | `round_items` of done/late + `opening_balance`; retired exercises keep their rows |
| monthly ceiling | `days × ((1440 − quiet) // interval) × compose(settings, 0)` |

---

## 7. Data, deployment, and the one-writer rule

- **Same database file.** Add tables, never rewrite existing ones: `api_tokens`, `devices`,
  `notification_log`, `schema_migrations`. SQLite `ALTER TABLE` is only ever additive, and indexes on
  retrofitted columns are created *after* the ALTER (the `checkins.local_date` lesson).
- **`getfit.db` in git**: keep it until cutover + 30 days so rollback is `git checkout` + restart
  Python, then stop tracking it and move it to `data/` with `sqlite3 .backup` on a timer (decision 3).
  Tracking a file the service writes on every tick is why `deploy.sh` has to park it.
- **Direct access while developing** is a first-class want: the server exposes a loopback-only,
  read-only `/dev/*` surface when `GETFIT_DEV=1` (schema, SQL, the raw snapshot) — `api.md` §11.
- **During phases 2–4 only one process may write.** The shadow server opens the DB `?mode=ro`; the
  scheduler in it is *disabled by config* (`SCHEDULER=off`), not by comment.
- **Rollback** at any point before phase 4 is `systemctl disable --now getfit-api` — the Python unit
  was never removed.

---

## 8. Decisions (2026-11-14)

1. **One origin.** `fit.afrasinei.dev` serves both the web app and `/api/v1`. Cloudflare Access stays
   in front of the pages, with a path-scoped bypass for `/api/*` (see `api.md` §4). No second hostname.
2. **Telegram is temporary.** The bot keeps working as-is until the native app ships; at phase 5 the
   confirmation channel is the app and the Hermes hook, the cron job and the bot integration are
   deleted together.
3. **The database stays where it is** (`getfit.db`, tracked) until cutover, then moves to `data/` and
   stops being tracked. Direct access while developing is wanted, so the server grows a
   **development-only surface** (`/dev/*`, only mounted with `GETFIT_DEV=1` and bound to localhost) with
   read-only SQL and schema introspection — `api.md` §11.
4. **The v1 client is online-only.** No offline mutation queue: if the phone cannot reach the server it
   shows a logged-out / offline state. Offline confirmation is a later project, and when it lands it has
   to answer "the server moved while you were away" explicitly rather than merge silently.

---

## 9. Status

- **Phase 0/1 — engine ported, green.** `packages/engine` implements the schedule, the wear model,
  selection, check-ins, the calendar and the round state machine as pure functions. The 60 assertions of
  `tests.py` are ported into 26 Vitest cases (`pnpm --filter @getfit/engine test`), all passing, with
  `tsc --noEmit` clean.
- **Phase 2 — shadow-capable, partly done.** `packages/db` opens the Python schema unchanged (plus the
  additive tables), migrates an old database in place, and loads the engine's `Snapshot`;
  `apps/server` serves `/api/v1` with `/health`, `/now`, `/meta`, `/dashboard` (ETag/304, `?sections=`),
  `/rounds`, `/rounds/{key}`, `/rounds/{key}/confirm`, `/checkins`, `/checkins/todo`, `/muscles`,
  `/profile`, `/calendar`, `/settings` (GET/PUT), and problem+json errors. 41 tests green (engine 26,
  db 4, server 11).
- **Parity proven on the live database.** `python3 tools/parity.py` copies the Pi's `getfit.db` twice
  and diffs `getfit.view()` against `/api/v1/dashboard`: **0 diffs** across totals, sets, current round,
  next set, preview, readiness, the 22 muscles and the three hottest, the calendar day and the month
  ceiling.
- **The harness already paid for itself twice**, both caught on the first real run: JavaScript's `%`
  keeps the sign where Python's wraps, so a quiet window crossing midnight inflated the monthly ceiling
  from 3000 to 7800; and with decay now pure, `view()` has to decay for itself instead of trusting a
  previous read to have persisted it.
- **Cutover blocks closed** (all local, all tested): `packages/contracts` validates every mutating body
  with zod and returns 422 with field paths; device tokens are real (8-digit pairing codes, SHA-256
  stored, revocable, 401 without one); the scheduler publishes `RoundOpened` through a notifier adapter
  (Telegram or console) and logs every delivery to `notification_log`; and the deploy path learned a
  second mode keyed on `.use-api`, with `deploy/getfit-api.*` units, `scripts/install-node.sh`,
  `scripts/ci.sh` and `scripts/cutover.sh shadow|live|rollback`.
- **60 tests green** (engine 26, contracts 7, db 4, server 23).
- **Still open before `live`:** a Node 24 runtime on the Pi host (Debian ships 20 — `install-node.sh`
  handles it), the Cloudflare Access bypass for `/api/*`, and a few days of shadow running. Then the web
  app; `/dev/*` and the generated OpenAPI/clients come with it.

A note on the plan that changed while implementing: `better-sqlite3` is replaced by **`node:sqlite`**
(`DatabaseSync`), which ships with Node 24 — no native build, no prebuilt-binary risk on arm64, and the
same synchronous style.
