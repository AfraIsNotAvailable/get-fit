# Contract drift: `docs/openapi.yaml` vs what runs

The OpenAPI document was written before the server, as a design. The server then made decisions of
its own. This file records every difference — and, since the naming pass, which ones are settled.

Three gates keep it honest:

```bash
python3 tools/api-sweep.py http://127.0.0.1:8792 <token>   # 42 assertions over every route
python3 tools/spec-check.py                                # 14/14 responses conform, both directions
npx @redocly/cli lint docs/openapi.yaml                    # valid
```

`spec-check.py` validates each live response against the documented schema **and** reports keys the
response carries that the schema never mentions. That second direction is the one that catches a
document quietly rotting.

## Settled: the spec follows the server

The spec was `snake_case` because it mirrored the Python API. The server emits **camelCase** (`stopAt`,
`exerciseSlug`, `roundKey`), like the dashboard and the React client. The spec was rewritten to match
the server — 93 property keys, the `required` lists, the prose that names a field, and the
`?sections=` enum — rather than changing the server and the client to suit the document.

What `spec-check.py` found while doing it, all now fixed in the spec:

| was documented | the server actually sends |
|---|---|
| `Round.roundKey` | `Round.key` (the confirm *receipt* does use `roundKey`) |
| `RecentRound.items` | `RecentRound.exercises` |
| `Exercise.slug` | `Exercise.id`, null for a row being added |
| `Calendar.months` (required) | a sibling of `calendar` on `/dashboard`; `/calendar` merges the two |
| `ProfileParam` without `fitted` | always sends `fitted` — it is what turns "prior" into "fitted" |
| `CheckinKind: [gate, post]` | reads can return `anchor` (a legacy baseline row); writes still take only `gate`/`post`, so there are two enums now |
| `Checkin` without `note` | sends `note` |
| `meta.enums` without `muscles` | sends it |
| `/meta` behind auth | open, deliberately: a client needs the vocabulary before it can pair |
| `GET /rounds` "a bare array" (my earlier note) | the spec always said `RoundPage {items}`; the note was wrong, the server matches |

## Documented, deliberately not implemented

These nine operations stay in the document, marked `deprecated: true`, so the design intent is not
lost. A generated client will flag them.

| op | why not | use instead |
|---|---|---|
| `GET` / `POST /exercises` · `PATCH` / `DELETE /exercises/{slug}` | the stack is edited as a whole, in order, and `PUT /settings` already does that transactionally — per-row CRUD would have to reimplement the reordering and the retire-don't-delete rule | `PUT /settings` |
| `PATCH /muscles/{slug}` | the override (`setwear`, `restUntil`) is a debugging tool; exposing it to a client that also reads `stopAt` invites conflicting stories about why a muscle is parked | the CLI/SQL escape hatch |
| `POST /rounds` | a round is opened by the scheduler; a client that can fire one means two owners of `next_set_at` | the scheduler |
| `POST /auth/token` · `POST /devices` · `DELETE /devices/{id}` | token minting and revocation are admin actions. `GET`/`DELETE /auth/me` covers "who am I" and "unpair this device" | `node apps/server/dist/cli.js token …` |

## Implemented late, straight from the spec

`GET /checkins` (with `kind`, `from`, `to`, `limit`), `GET /library`, `GET /muscles/{slug}`,
`GET /profile/history`, `POST /profile/refit` were documented from the start and missing from the
server until this pass. The client needs the check-in trail and the learned coefficients (`k`,
`exposure`) to say anything honest about the model.

## Still open: status codes vs the Python app

`POST /checkins` answers `201`; a validation failure is `422` with `errors[].path` where the Python
app answered `400` with a single message. Clients must read the `problem+json` `code`, not the prose.
Deliberate — the new surface is stricter — but a breaking difference for anything built against
`:8777`.

## The rule that came out of this

A route is not done until both harnesses cover it. Parity (`tools/parity.py`) proves the *numbers*
match the Python app; the sweep and `spec-check.py` prove the *surface* exists, answers the right
codes, and describes itself accurately. The parity harness alone could not see a missing route, a
wrong status code, or a field the spec had renamed.
