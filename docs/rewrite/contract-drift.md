# Contract drift: `docs/openapi.yaml` vs what runs

The OpenAPI document was written before the server, as a design. The server then made a few
decisions on its own. This file records every difference, so the Android client is built against
reality rather than against the diagram — and so nobody "fixes" the spec by making it smaller
without noticing a feature.

Verified by diffing every `path`+`method` in the spec against the routes registered in
`apps/server/src/app.ts`, and by sweeping the running API (`tools/api-sweep.py`, 42 assertions).

## Documented, deliberately not implemented

| op | why not | use instead |
|---|---|---|
| `GET /exercises` · `POST /exercises` · `PATCH /exercises/{slug}` · `DELETE /exercises/{slug}` | the stack is edited as a whole, in order, and `PUT /settings` already does that transactionally — a per-row CRUD would have to reimplement the reordering and the retire-don't-delete rule | `PUT /settings` |
| `PATCH /muscles/{slug}` | the override (`setwear`, `rest_until`) is a debugging tool. Exposing it to a client that also reads `stop_at` invites conflicting stories about why a muscle is parked | not exposed; the CLI/SQL escape hatch stays |
| `POST /rounds` | a round is opened by the scheduler, not by a client. Allowing `POST /rounds` means two clocks owning `next_set_at` | the scheduler |
| `POST /auth/token` · `POST /devices` · `DELETE /devices/{id}` | token minting and revocation are an admin action, not a self-service one. `GET/DELETE /auth/me` covers "who am I" and "unpair this device" | `node apps/server/dist/cli.js token …` |

## Documented and now implemented

`GET /checkins` (with `kind`, `from`, `to`, `limit`), `GET /library`, `GET /muscles/{slug}`,
`GET /profile/history`, `POST /profile/refit`. They were in the spec from the start and missing from
the server until this pass; the client needs the check-in trail and the learned coefficients
(`k`, `exposure`) to render anything honest about the model.

## Shape mismatches to fix before the Android client

1. **Field naming.** The spec's schemas are `snake_case` (`stop_at`, `stop_effective`,
   `exercise_slug`) because the Python API it mirrored was. The server emits **camelCase**
   (`stopAt`, `stopEffective`, `exerciseSlug`), like the dashboard and the React client. One of the
   two has to move; the server is what runs, so the spec should follow it — but that is a mechanical
   rewrite of ~1,600 lines and needs a decision, not a silent edit.
2. **`GET /rounds` returns `{ "items": [...] }`**, the spec says a bare array. Same for the
   pagination fields it does not yet send.
3. **`POST /checkins` answers `201`** (spec agrees), while a *validation* failure is `422` with
   `errors[].path` — the Python app used `400` with a single message. Clients should read
   `problem+json` `code`, not the prose.
4. **`/meta` is open** (no token) because a client needs the vocabulary before it can pair; the spec
   marks it authenticated. `/health` is open on both.

## Rules that came out of this pass

- A route is not done until `tools/api-sweep.py` covers it: an endpoint nobody calls is an endpoint
  that silently 401s or 404s for a month.
- Re-run `python3 tools/parity.py` (read path, 0 diffs) **and** `tools/api-sweep.py` (write and error
  paths) after touching the engine, the service or the routes. The parity harness alone cannot see a
  missing route or a wrong status code.
