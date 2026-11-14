# Server module split

The rewrite has three layers with one rule: **dependencies point inward.** `engine` knows nothing about
HTTP or SQL; `http` may not contain rules; `db` may not contain decisions. Anything that would break
that rule is a smell worth fixing before merge.

```
        ┌──────────────────────────────────────────────┐
        │ apps/server/http    routes, auth, errors, ETag│
        ├──────────────────────────────────────────────┤
        │ apps/server/services  use cases, transactions │
        ├──────────────────────┬───────────────────────┤
        │ apps/server/scheduler│ apps/server/notify    │
        ├──────────────────────┴───────────────────────┤
        │ packages/db           SQL, repositories       │
        ├──────────────────────────────────────────────┤
        │ packages/engine       pure rules, no I/O      │
        └──────────────────────────────────────────────┘
                     ▲
        packages/contracts (zod): imported by server AND web, never imports either
```

`contracts` sits outside the arrow: it is data shape only (zod schemas + path metadata). If a schema
module ever needs `db` or `engine`, the schema is wrong.

---

## 1. What each package owns

### `packages/engine` — the rules, pure

No `fs`, no `fetch`, no `Date.now()`, no `process.env`. Time and data arrive as arguments. This is what
makes the 60 assertions portable and the Android client's "predicted set" a client-side computation if
you ever want it.

| module | owns | ported from |
|---|---|---|
| `schedule.ts` | active window math, `clampToActive`, `compose()` bonus overflow, interval bookkeeping helpers | `getfit.py: compose, in_active_window, clamp_to_active, _hm_seconds` |
| `selection.ts` | score, block, deload, `planRound(snapshot)` → `{rows, meta}` | `getfit.py: plan_round`; `muscles.py: rank, plan` |
| `wear.ts` | decay, accrue, implied soreness, `k` update, readiness, refit, calibration, `effectiveStop` | `muscles.py: decay, accrue, readiness, refit, calibration, effective_stop, _implied` |
| `calendar.ts` | per-day cells, month ceiling, hue inputs | `getfit.py: build_calendar, build_months` |
| `receipt.ts` | the confirmation sentence (a presenter; text is data here, not policy) | `getfit.py: _receipt, format_set` |
| `types.ts` | `Snapshot`, `Plan`, `Checkin`, `Settings`, `MuscleState` | the sqlite rows, typed |

The one structural change from Python: **`decay()` stops writing.** Today `muscles.decay(db, now)`
mutates `muscle_state` and `snapshot(db, do_decay=True)` hides that write inside a read. In the rewrite:

```ts
const decayed = decay(snapshot, now, profile)      // pure, returns a new snapshot
const plan    = planRound({ ...decayed, settings, bonus }, now)  // pure
await repo.persistDecayed(decayed)                 // only if a round closes
```

That is why the snapshot is an explicit argument: ranking needs decayed numbers, and today the only way
to get them is a write.

### `packages/db` — the only SQL

| file | owns |
|---|---|
| `schema.sql` | current tables verbatim + `api_tokens`, `devices`, `notification_log`, `schema_migrations` |
| `migrate.ts` | forward-only numbered migrations, run at boot under `BEGIN IMMEDIATE`, idempotent |
| `repositories/settings.ts` | load/save settings + exercises (the diff semantics: new list, retired rows stay `active=0`) |
| `repositories/rounds.ts` | open/close/last/pending, `round_items`, recent + paginated reads |
| `repositories/muscles.ts` | `muscle_state`, `exercise_muscles`, `wear_events`, `profile`, `profile_history` |
| `repositories/checkins.ts` | gate/post rows, `gate_today`, `post_window`, per-day merge |
| `repositories/tokens.ts` | API tokens (hashed), device push tokens |
| `repositories/tx.ts` | `withImmediateTransaction(fn)` — the only place `BEGIN IMMEDIATE` appears |

Repositories return **plain structs**, never ORM entities and never `undefined`-heavy rows. Mapping
between rows and the engine's `Snapshot` happens in `apps/server/services/mappers.ts` — one file, so a
column rename is one edit.

**Concurrency:** SQLite, one process, `better-sqlite3` (synchronous) inside `BEGIN IMMEDIATE` for every
mutating use case. The tick and a `POST /rounds/:key/confirm` can then never interleave: the second one
sees the first's result. The Python version gets this from a per-connection `timeout=15` and luck; make
it explicit.

### `apps/server/services` — use cases, transactions, no HTTP types

| service | use case | touches |
|---|---|---|
| `dashboard.ts` | build the composite view (all 16 sections, see `api.md` §5) | everything, read-only |
| `rounds.ts` | `tick()`, `fireNow()`, `confirm(key, source)`, `resolveExpired()` | engine plan + rounds repo + notifier |
| `checkins.ts` | `gate()`, `post()`, `todo()` | engine readiness/calibration + checkins repo |
| `settings.ts` | `update(patch)` — validates, retires removed exercises, reseeds attribution | settings repo + engine seed |
| `exercises.ts` | add/retire/rename + attribution seeding | library + repo |
| `muscles.ts` | `setWear`, `setStop`, `restUntil` (admin overrides) | muscles repo |
| `auth.ts` | pair / exchange / revoke (see `api.md` §4) | tokens repo |

Service inputs are DTOs from `contracts`, outputs are DTOs or `Result`-style errors — never `Request`,
never `Response`. That is what makes them callable from the scheduler, the tests, and a future CLI.

### `apps/server/http` — thin

```
http/
├─ app.ts               express() factory — mounts routes, middleware, static; no listen
├─ routes/
│  ├─ dashboard.ts      GET /api/v1/dashboard
│  ├─ rounds.ts         GET/POST /rounds, POST /rounds/:key/confirm
│  ├─ checkins.ts       GET /checkins/todo, POST /checkins
│  ├─ settings.ts       GET/PUT /settings
│  ├─ exercises.ts      CRUD
│  ├─ muscles.ts        GET /muscles, PATCH /muscles/:slug
│  ├─ library.ts profile.ts calendar.ts meta.ts health.ts
│  └─ auth.ts           /auth/pair, /auth/token, /auth/me
├─ middleware/
│  ├─ auth.ts           bearer token → ctx.user; CF Access JWT fallback for the UI
│  ├─ validate.ts       zod parse of params/query/body → 422 problem+json
│  ├─ idempotency.ts    Idempotency-Key → replay stored response
│  ├─ etag.ts           dashboard ETag + 304
│  ├─ errors.ts         domain error → RFC 9457 status mapping
│  └─ requestId.ts      x-request-id, into every log line
└─ openapi.ts           serves /openapi.yaml and /docs (scalar UI) in dev only
```

A route file is allowed to do exactly four things: parse (via `contracts`), call one service, choose a
status code, set headers. If it needs a second service or an `if` about the domain, the use case is
missing.

### `apps/server/scheduler`

```
scheduler/
├─ tick.ts       5 s timer → resolveExpired() → maybeOpenRound(); aligned, drift-corrected
├─ events.ts     tiny typed emitter: RoundOpened, RoundResolved, CheckinDue
└─ jobs.ts       optional daily job: prune notification_log, sqlite .backup
```

- **In-process, not cron.** The clock only has meaning next to the data it reads. Starting the server
  restores the schedule from `app_state.next_set_at` — no catch-up table, no missed-minute ambiguity.
- **5 s tick, 1 min resolution.** The current cron fires once a minute and is observably late (the log
  shows a ~2 min cadence under load). A 5 s timer costs nothing and makes `seconds_left` honest.
- **Idempotent.** `resolveExpired()` re-derives from `rounds.status` and the deadline, so a double tick
  is harmless; `maybeOpenRound()` is guarded by `BEGIN IMMEDIATE` + `next_set_at IS NULL` check.
- **Failure isolation.** A notifier throwing must not stop the tick: the round is committed first, then
  delivery is attempted and logged to `notification_log` (retry later, never roll back the round).

### `apps/server/notify` — adapters, one interface

```ts
interface Notifier { id: string; send(ev: DomainEvent): Promise<DeliveryResult> }
```

- `telegram.ts` — Bot API sendMessage to the configured chat. Replaces the Hermes cron's stdout path.
- `fcm.ts` — Firebase HTTP v1, per-device, with dead-token pruning.
- `webpush.ts` — optional, only if you keep a PWA-ish browser notification path.
- `log.ts` — default in dev.

`notification_log(id, kind, event, target, status, attempts, at)` is the only state they share, and it is
what makes "did the 14:30 set actually get delivered?" answerable — today that question is answered by
reading a cron execution database belonging to a different application.

---

## 2. Mapping the existing code, file by file

| today | becomes | note |
|---|---|---|
| `getfit.py: SCHEMA` | `packages/db/schema.sql` | verbatim, plus new tables |
| `getfit.py: init_db, _ensure_columns` | `db/migrate.ts` | numbered migrations replace ad-hoc ALTERs |
| `getfit.py: load/save_settings, slugify` | `db/repositories/settings.ts` + `services/settings.ts` | validation moves to `contracts` |
| `getfit.py: load_state, save_state` | `db/repositories/rounds.ts` (state row) | `app_state` is round-related, not global |
| `getfit.py: in_active_window, clamp_to_active, compose` | `engine/schedule.ts` | pure already — straight port |
| `getfit.py: plan_round, last_done_map, last_circle` | `engine/selection.ts` + repo reads | the reads become the snapshot |
| `getfit.py: open_round, close_round, cmd_tick` | `services/rounds.ts: tick/open/close` | `cmd_tick`'s print becomes an event |
| `getfit.py: confirm, _receipt` | `services/rounds.ts: confirm` + `engine/receipt.ts` | receipt text becomes a presenter |
| `getfit.py: totals, build_calendar, build_months` | `engine/calendar.ts` + `services/dashboard.ts` | |
| `getfit.py: view` | `services/dashboard.ts` | split into sections; see `api.md` §5 |
| `getfit.py: build_checkin` | `services/checkins.ts: todo` | |
| `getfit.py: cmd_reset, cmd_setwear, cmd_migrate` | admin routes or a small `cli.ts` | keep the CLI, it is useful for triage |
| `muscles.py: MUSCLES, MUSCLE_NAME, LIBRARY` | `packages/db/seeds/*.ts` (data, not code) | plain data files, diffable |
| `muscles.py: resolve, _norm` | `engine/library.ts` | slug/name matching |
| `muscles.py: seed, seed_attribution, unattributed, attribution` | `db/repositories/muscles.ts` + `services/exercises.ts` | |
| `muscles.py: decay, snapshot` | `engine/wear.ts` (pure) + repo persist | the split described in §1 |
| `muscles.py: accrue, backfill` | `engine/wear.ts` + `services/rounds.ts` | backfill becomes a migration |
| `muscles.py: rank, plan` | `engine/selection.ts` | |
| `muscles.py: readiness, gate_today, post_window, _sleep_score` | `engine/wear.ts` + `services/checkins.ts` | |
| `muscles.py: refit, calibration, profile_rows, profile_history, observations` | `engine/wear.ts` + repo | |
| `muscles.py: record_checkin` | `services/checkins.ts` | throws typed `CheckinRefused` → 409 |
| `server.py: validate, validate_checkin` | `packages/contracts` zod schemas | same limits, same messages |
| `server.py: Handler.do_GET/do_POST` | `http/routes/*` | |
| `index.html` (vanilla JS, ~1 000 lines) | `apps/web` features | see `client.md` |
| `settings.html` | `apps/web/features/settings` | |
| `scripts/getfit-tick.sh` | deleted | the scheduler is in-process |
| Hermes cron job `get-fit` | deleted (or kept as a 1-line "call the API" job during cutover) | |
| Hermes hook `getfit-confirm` | `POST /api/v1/rounds/:key/confirm` | see `api.md` §7 |

---

## 3. Config

One `env.ts` in `apps/server`, parsed by zod, no `process.env` anywhere else:

```
GETFIT_DB=/home/afra/get-fit/data/getfit.db
GETFIT_PORT=8787
GETFIT_HOST=127.0.0.1            # cloudflared dials locally; no need for 0.0.0.0
GETFIT_BASE_URL=https://fit.afrasinei.dev
SCHEDULER=on|off                 # off for the read-only shadow during migration
TZ_DEFAULT=Europe/Bucharest      # only a default; the real timezone lives in settings
TELEGRAM_BOT_TOKEN=...           # optional; adapter disabled when absent
TELEGRAM_CHAT_ID=...
FCM_CREDENTIALS_FILE=...         # optional
LOG_LEVEL=info
```

Secrets stay in `/etc/getfit/api.env` (root:afra, 0640), referenced by the unit's `EnvironmentFile=`,
never in the repo and never in the web bundle.

---

## 4. Testing, per layer

| layer | kind | what it proves |
|---|---|---|
| `engine` | unit + property | the 60 ported assertions, plus property tests: decay is monotonic, compose never exceeds `max`, plan is deterministic for a snapshot |
| `db` | integration on `:memory:` | migrations apply from empty and from the *current* production schema; backfill produces the same `wear_events` as Python |
| `services` | integration | tick → open → confirm → next set, on a temp DB; late/missed/quiet-window paths |
| `http` | supertest | status codes, problem+json bodies, ETag 304, 401/409/422, idempotency replay |
| `contracts` | build-time | emitted `openapi.yaml` has no dangling `$ref`, every route validates against its schema |
| parity (temporary) | differential | TS `/dashboard` vs Python `/api/state` on live data, field by field, until cutover |

The parity harness is the one piece of throwaway code worth writing carefully: it is what turns "looks
right" into "is equal", and it is deleted the day Python goes.

---

## 5. What is deliberately *not* in the split

- No generic repository base class, no unit-of-work framework, no DI container. Six repositories and a
  `withImmediateTransaction` helper are enough; `createServices(deps)` with a plain object is the whole
  container.
- No separate worker process. The scheduler is a timer in the API process because there is exactly one
  writer by design; splitting it would reintroduce the two-process problem this rewrite is meant to end.
- No auth provider library. Eight lines of HMAC/argon2 and an `api_tokens` table beat a SaaS dependency
  for a single-user app behind Cloudflare.
- No GraphQL, no tRPC, no websockets. Polling a 16-section dashboard every 30 s over a tunnel is fine;
  the Android client benefits from the same boring behaviour.
