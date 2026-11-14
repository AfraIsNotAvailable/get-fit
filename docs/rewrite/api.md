# The API

Target: `/api/v1`, REST, JSON, documented by `docs/openapi.yaml` (draft) and generated from
`packages/contracts` once the rewrite starts. The audience is two clients that do not share a browser
session: the React app and a native Android app.

Everything below is a *design*; the current server still exposes `/api/state`, `/api/settings`,
`/api/confirm`, `/api/checkin` and nothing else.

---

## 1. Conventions (the rules the Android client will assume)

| topic | rule |
|---|---|
| base path | `/api/v1`. Breaking changes go to `/api/v2`; additive fields never bump. |
| ids | slash-safe slugs (`split-squats`) for exercises and muscles, 12-char opaque keys for rounds (`9f3a1c07be42`). |
| time | all instants RFC 3339 UTC with `Z` (`2026-11-14T13:35:20Z`). Local renderings are *derived* server-side and returned next to them (`local: "15:35"`), never as the only form. The client never guesses the timezone: `settings.timezone` + `meta.server_time` are always present. |
| durations | integer seconds (`seconds_left`), integer minutes in settings. |
| numbers | reps are integers; wear/soreness/readiness are floats 0..100 / 0..1, rounded to 1 dp at the edge. |
| nullability | explicit `null`, never omitted and never `""`. `max: null` means uncapped. |
| enums | lowercase strings, exactly as the engine stores them (`pending`, `done`, `late`, `missed`). |
| errors | RFC 9457 `application/problem+json`; see §6. |
| idempotency | every mutating POST accepts `Idempotency-Key`; replays return the stored response with `Idempotent-Replay: true`. |
| concurrency | mutations take `If-Match`-style `expected_status` where it matters (confirm). Mismatch → `409`. |
| pagination | cursor-based on `GET /rounds` only (`?limit=&cursor=`), because it is the only unbounded list. |
| caching | `GET /dashboard` and `GET /meta` return `ETag`; clients send `If-None-Match` and get `304`. Everything else is `no-store`. |
| CORS | not needed for the web app (same origin) and irrelevant for Android; the rewrite should not enable `*`. |

---

## 2. Why the old surface is not enough

| today | problem for a native client |
|---|---|
| `GET /api/state` | 23 flat keys / 16 renderable sections in one 15 KB blob; no ETag, no way to fetch only the check-in state, no schema, no version. |
| `POST /api/confirm` | operates on **"the last round"** — implicit target. Two devices, or a retry after a timeout, cannot know what they confirmed. |
| `POST /api/settings` | replaces the world, including retiring exercises, with no diff and no `PUT` semantics. |
| `POST /api/checkin` | one endpoint, two questionnaires (`gate`/`post`), distinguished by a body field; `post` needs a `round_key` that arrives inside another payload. |
| errors | `{ok:false, error:"..."}` with 400/409 and no machine-readable code, so a client can only show strings. |
| auth | none. Fine behind Cloudflare Access for a browser, impossible for a phone. |
| `server.py` static | pages and API share one origin and one port — workable, but the API has no separate contract. |

---

## 3. Resources

```
now ─── settings ─── exercises
 │        │             │
 └── rounds ─── round_items ─── wear_events ─── muscles ─── exercise_muscles
 │                                                              │
 └── checkins (gate | post) ────────────────────────────── profile, profile_history
```

| method | path | purpose | who |
|---|---|---|---|
| GET | `/health` | liveness + version + db check | infra |
| GET | `/meta` | taxonomy (22 muscles), library (29 movements), enum values, server time, feature flags | all clients, cached |
| GET | `/now` | server time, local time, quiet-window state, `seconds_left` to next event | Android (cheap poll) |
| GET | `/dashboard` | the composite home view; `?sections=` to narrow; ETag | web + Android |
| GET | `/settings` | timezone, interval, response window, quiet hours, exercise stack | web + Android |
| PUT | `/settings` | full replacement (same validation as today) | web |
| GET | `/exercises` | stack with `active`, `position`, `min`, `max`, `form_url` | web + Android |
| POST | `/exercises` | add one (seeds attribution, refuses unknown movements) | web |
| PATCH | `/exercises/{slug}` | rename / reps / form_url / position | web |
| DELETE | `/exercises/{slug}` | retires (`active=0`), never deletes history | web |
| GET | `/rounds` | list, newest first, cursor | both |
| GET | `/rounds/{key}` | one round with items and resolution | both |
| POST | `/rounds` | fire a set now, ignoring the clock (test / manual) | web (dev) |
| POST | `/rounds/{key}/confirm` | log it; `source` = `web` / `android` / `telegram` / `cli` | both |
| GET | `/checkins/todo` | what is due right now: `gate` or `post` + the target round + expiring seconds | both |
| POST | `/checkins` | answer a gate or a post questionnaire | both |
| GET | `/checkins` | history (`?kind=&from=&to=`) | web |
| GET | `/muscles` | 22 rows: wear, soreness, load, stop/resume, rest_until, last_loaded | both |
| GET | `/muscles/{slug}` | one muscle + its attribution + 30-day spark | web |
| PATCH | `/muscles/{slug}` | manual override: `wear`, `stop_at`, `resume_at`, `rest_until` | web |
| GET | `/library` | movement → muscle attribution with learned `k` and `exposure` | web |
| GET | `/profile` | fitted parameters, sample sizes, calibration error | web |
| GET | `/profile/history` | the audit trail (`profile_history`) | web |
| POST | `/profile/refit` | recompute from `wear_events` | web |
| GET | `/calendar?month=YYYY-MM` | day cells + month summary + ceiling | both |
| POST | `/devices` | register an FCM token for push | Android |
| DELETE | `/devices/{id}` | unregister | Android |
| POST | `/auth/pair` · `/auth/token` · `/auth/me` | device pairing and tokens | Android |

Two structural cleanups worth calling out:

- **`/dashboard` is a composition, not a resource.** It exists because the home screen needs 16 sections
  in one round-trip on a phone network. Each section is a sub-schema in `contracts`, and every one of
  them is also reachable through its own endpoint — the composite must never be the *only* way to get a
  fact, or the API becomes a screen-scraper.
- **Confirm gets its target in the URL.** `POST /rounds/{key}/confirm` with `expected_status:
  "pending"|"missed"` is safe to retry, safe from two devices, and returns the same receipt shape the
  hook posts today. `409` when the round is already resolved, with the current state in the problem body
  so the client can reconcile instead of showing a red toast.

---

## 4. Auth

Cloudflare Access is a *browser* gate: it answers with a redirect to the one-time-PIN page, which no
native client can complete. So:

**Web (`fit.afrasinei.dev`)** — unchanged: Cloudflare Access in front, session cookie handled by CF.
The API additionally accepts a CF Access JWT (`cf-access-jwt-assertion`) header, which Cloudflare adds
after login, so the API can tell the web app apart from a stranger.

**Android (`fit.afrasinei.dev/api/**`)** — bearer tokens issued by our server:

1. `POST /auth/pair` with a short-lived code you read off the web app (`Settings → Devices → Add
   device`), body `{code, device_name, device_model}` → `{device_id, token, expires_at}`.
2. The phone stores the token in `EncryptedSharedPreferences` (Keystore-backed).
3. Every request: `Authorization: Bearer <token>`.
4. `POST /auth/token` rotates it (old token valid for 5 minutes, so a lost response is retryable).
5. `DELETE /auth/me` (or the web app's device list) revokes.

Storage: `api_tokens(id, name, token_hash, created_at, last_used_at, expires_at, revoked_at)`, hash with
argon2id, **never** store the raw token. Tokens are per-device, so revoking a lost phone is one row.

**Cloudflare configuration this implies** (worth doing in phase 2, not now): the Access application gets a
`bypass` policy for `fit.afrasinei.dev/api/*` so the phone is not bounced to a login page, while the rest
of the hostname stays gated. The bearer token is then the only thing protecting the API — which is why
§9 matters.

**Decided:** one origin, `fit.afrasinei.dev`, for pages and API. No `api-fit.` hostname.

---

## 5. The dashboard payload

`GET /api/v1/dashboard` returns a flat object whose properties are the sections, plus `etag` — today's
`view()` keys, regrouped and renamed:

| today | v1 |
|---|---|
| `now`, `now_local`, `timezone` | `server_time` (single object: `utc`, `local`, `timezone`) |
| `settings` | `settings` |
| `state` | `clock` (`bonus`, `next_set_at`) |
| `next_set` | `next_set` |
| `current`, `round_open` | `current_round` (with `open: true` folded in) |
| `preview` | `next_assignment` |
| `tally`, `totals` | `lifetime` (`sets_done`, `sets_missed`, `total_reps`, per exercise) |
| `recent` | `recent_rounds` (12, newest first) |
| `calendar`, `months` | `calendar`, `months` |
| `muscles` | `muscles` |
| `readiness`, `checkin` | `readiness`, `checkin_todo` |
| `profile`, `calibration`, `history` | `profile` (`params`, `calibration`, `history`) |
| `selection` | `selection` (`deload`, `blocked`, `ranked`) |
| `unattributed` | `unattributed` |
| `quiet_now` | folded into `server_time.quiet_now` |

Renaming is the point: `state.state`, `totals` containing a fake `_summary` row, and `now_local` as a
bare string are the things a typed client trips over. Every field keeps its current meaning and value;
only the shape moves.

`sections=` and ETag: the web app asks for everything; the Android home asks for
`current_round,next_set,checkin_todo,readiness,muscles` and pays ~2 KB; both send `If-None-Match` and get
`304` while nothing moved. Today's `Cache-Control: no-store` on everything is what makes the current
dashboard poll a 15 KB payload forever.

---

## 6. Errors

RFC 9457, one shape for everything:

```json
{
  "type": "https://fit.afrasinei.dev/problems/round-already-resolved",
  "title": "Round already resolved",
  "status": 409,
  "code": "round_already_resolved",
  "detail": "round 9f3a1c07be42 was confirmed at 2026-11-14T13:35:20Z",
  "instance": "/api/v1/rounds/9f3a1c07be42/confirm",
  "current": { "status": "done", "resolved_at": "2026-11-14T13:35:20Z" }
}
```

| status | when | current behaviour |
|---|---|---|
| 400 | malformed JSON / missing body | same, but with a code |
| 401 | no/invalid bearer token | *new* |
| 403 | valid token, wrong scope (e.g. revoke someone else's device) | *new* |
| 404 | unknown round/exercise/muscle | *new* (today: silent fallback) |
| 409 | `round_already_resolved`, `checkin_refused_*`, `expected_status_mismatch` | today 409 with a bare string |
| 422 | schema validation failures, field-level `errors[]` | today 400 with a sentence |
| 429 | rate limited | *new* |
| 503 | db locked / not ready | *new* |

The engine's `CheckinRefused` keeps its four reasons as `code` values (`late`, `repeat`, `unknown_round`,
`muscle_not_worked`) — the Android client shows a different message for each, and today it cannot.

---

## 7. Notifications and Telegram

The tick produces domain events, not text:

```
RoundOpened   {round_key, items[], deadline, local_deadline}
RoundResolved {round_key, status, receipt}
CheckinDue    {kind:"post", round_key, expires_at}
```

- Telegram: `telegram.ts` sends `engine/receipt.formatSet(items)` — the same sentence the cron prints
  today. **It is temporary**: the bot stays until the native app ships, then the hook, the Hermes cron
  job and this adapter are deleted in one go (decision 2, `README.md` §8). **One consumer only.** If the Android app and the web app also confirm, the round can be
  resolved by any of them; the hook must not also post a receipt, or you get two.
- The Hermes confirm hook becomes one line: `POST /api/v1/rounds/{last_open}/confirm` with a token,
  instead of shelling out to `getfit.py confirm`. Or it is deleted, if Telegram confirmation moves to
  the bot owner (`apps/server/notify/telegram-inbound.ts`, long-poll `getUpdates`) — decide in §8, not
  in code.
- FCM: `RoundOpened` → `fcm.ts` → devices. Payload is data-only (`{type:"round_opened", round_key}`), so
  the app renders its own notification and can act on it offline.

---

## 8. TLS, ports, and the browser-notification problem

Today `server.py` also listens on `:8443` with a self-signed cert purely so browsers grant
`Notification.requestPermission()` on the LAN. In the rewrite:

- Public: `https://fit.afrasinei.dev` → cloudflared → `127.0.0.1:8787` (plain HTTP). Secure context,
  notifications work, no certificate to rotate.
- LAN: keep `GETFIT_TLS_PORT=8443` as an **optional** listener with the existing `certs/`, exactly as
  now, for when the tunnel is down. Two lines in `main.ts`; not a v1 requirement.
- `GETFIT_HOST=127.0.0.1` by default: nothing should be reachable on the LAN except through the tunnel
  or the TLS listener.

---

## 9. Limits, abuse, and the fact that this is the public internet

- 60 req/min per token, 10 req/min for mutations; `429` with `Retry-After`. The dashboard polls every
  30 s, so the honest clients are far under it.
- Request body cap 64 KB (the biggest legitimate body is a settings PUT).
- `Idempotency-Key` kept 24 h in `idempotency_keys(key, token_id, route, response, at)`.
- No user enumeration: `/auth/pair` answers the same for a bad code and a consumed one (with a different
  `code` in the body only after successful pairing).
- Pairing codes: 8 digits, 5 minutes, single use, rate-limited to 5 attempts.

---

## 10. OpenAPI pipeline

1. `packages/contracts` defines zod schemas + a `paths` table (method, path, params, request, response,
   errors, auth).
2. `pnpm openapi` emits `openapi/openapi.yaml` (3.1). Committed, so every contract change is a reviewable
   diff.
3. CI fails if the emitted file differs from the committed one (drift), or if `redocly lint` reports an
   error.
4. `pnpm gen:ts` → `openapi/openapi-typescript` types consumed by `openapi-fetch` in the web app.
5. `pnpm gen:kotlin` → `openapi-generator` (kotlin + okhttp + kotlinx.serialization) into
   `openapi/clients/kotlin`, consumed by the Android module as a source set. Generated code is never
   hand-edited; the generator version is pinned in CI.
6. The server's runtime validation *is* the same zod schema, so "documented" and "enforced" cannot drift
   apart.

The draft in `docs/openapi.yaml` is what step 2 should converge on: it is written by hand today so you can
read the shape and so the Kotlin generator has something real to lard the Android work against.

## 11. Development-only surface (`/dev/*`)

Developing against the live database is useful enough to deserve a route, and dangerous enough to
deserve being off by default. So:

- Mounted **only** when `GETFIT_DEV=1`; otherwise the paths do not exist (404, not 403).
- Additionally bound to loopback: the dev surface is served on `127.0.0.1:8788` by a second listener,
  never on the public port. Cloudflare cannot reach it; `ssh -L 8788:127.0.0.1:8788 rpi4` can.
- `GET /dev/schema` — tables, columns, indexes, row counts, `PRAGMA integrity_check`.
- `POST /dev/query` — `{ sql, params }`, **statements must start with `select`/`with`/`pragma`** and are
  checked against a deny list (`insert|update|delete|drop|alter|attach|vacuum|reindex`). Runs inside a
  read-only transaction with a 2 s busy timeout and a 200-row cap, results as JSON.
- `GET /dev/state` — the raw `Snapshot` the engine was handed, before the view model reshaped it. This
  is the one that pays for itself: when a number looks wrong, the question is always "what did the
  engine actually see".
- No writes. The dev surface is for reading, and the whole point of one writer stays intact. A
  `sqlite3` shell over ssh is still the right tool for an emergency edit; nothing here pretends to be
  a database console.
