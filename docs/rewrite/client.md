# Clients: web and Android

Two clients, one contract. Both read `docs/openapi.yaml`; neither hand-writes a type that the other
could drift from.

---

## 1. Web (`apps/web`)

### Structure

```
src/
├─ api/
│  ├─ client.ts        openapi-fetch instance (baseUrl, bearer/CF cookie, problem+json → ApiError)
│  ├─ queries.ts       queryKeys + queryOptions (dashboard, settings, library, profile, calendar)
│  └─ mutations.ts     confirm, checkin, saveSettings, exercise CRUD, muscle patch
├─ app/
│  ├─ main.tsx         QueryClient, router, error boundary
│  └─ routes.tsx       "/" dashboard, "/settings", "/profile", "/table"
├─ features/
│  ├─ dashboard/       Band, Clock, Lifetime, RecentRounds
│  ├─ checkin/         GateSheet, PostSheet, useCheckinTodo
│  ├─ muscles/         MuscleList, BodyAtlas, MuscleDetail
│  ├─ calendar/        YearCanvas, MonthBars
│  ├─ profile/         ParamsTable, CalibrationSeries, History
│  └─ settings/        ScheduleForm, ExerciseStackEditor, DeviceList
├─ components/         Button, Field, Rule, Stamp, Modal, Callout  (own, ~200 lines total)
├─ lib/                format (numbers, times, plural), useCountdown, notifications
└─ styles/             tokens.css, base.css, components/*.css
```

Nothing else. No state library: the server owns the state, TanStack Query caches it, and the only
local UI state is "which sheet is open".

### Data flow

- `useDashboard()` → `GET /dashboard` with `If-None-Match` from the last ETag, `refetchInterval: 30_000`,
  `refetchIntervalInBackground: false`, `staleTime: 15_000`. A `304` is not a failure: `openapi-fetch`
  exposes the response, so the query keeps the previous data and updates `dataUpdatedAt`.
- **Countdowns are local.** `seconds_left` from the server plus `performance.now()` since the response;
  re-sync on every refetch and on `visibilitychange`. Never trust the device clock — keep
  `serverTimeOffset = server_time.utc - Date.now()` from the last response and render from that.
- **Mutations invalidate by key**, not by refetching the world: `confirm` → invalidate `dashboard`,
  `rounds`, `checkins/todo`; `checkin` → invalidate `dashboard`, `muscles`, `profile`.
- **A `409` is normal**, not a crash: the round was already confirmed (another device, a retry, the
  Telegram hook). The page reconciles from the problem body's `current` and shows the receipt it
  already got, or a quiet "already logged" state.
- **Offline**: `networkMode: "offlineFirst"` and a banner. No offline mutations in the web app — the
  phone is the offline story.

### The six pieces worth thinking about

| piece | today | target |
|---|---|---|
| **band** | flex row, inline `onclick` handlers, HTML strings | `Band.tsx` + `AssignmentItem`, `<a href={form_url}>`, missing article → red with `title` warning (never invent a URL) |
| **gauge / lifetime** | `animateTotal()` mutating `textContent` | `<Lifetime total={…} />` with a `useSpringNumber` hook; the animation is a CSS transition on a text node's value, not a DOM rewrite |
| **body atlas** | 3 stacked SVGs, hover via CSS class on `body`, `showMuscle()` fetches `/art/<slug>.svg` | `<BodyAtlas active={slug} />`: the three planes preloaded once (`?import` them so Vite hashes them), a `<g data-muscle>` class toggle, no fetch-per-hover. Missing groups (serratus, lower back, hip flexors) stay marked pending — same rule as today |
| **calendar** | `<canvas>` with `paint()` per cell, manual DPR handling | keep canvas: 364 cells is too many nodes. `YearCanvas.tsx` with a `useEffect` that redraws on resize and on data change, DPR from `window.devicePixelRatio`, tooltip from a hit-test on `mousemove` |
| **check-in sheet** | modal built by concatenating HTML, `tickSheet()` countdown, `sendCheckin()` | `PostSheet`/`GateSheet` in a `<dialog>`; one form per question group; submit disabled while `seconds_left <= 0`; the server's `409` codes map to specific messages (`late` → "the window closed at 14:20") |
| **profile table** | string-built rows | `ParamsTable` from `Profile.params`, `CalibrationSeries` as a small SVG sparkline |

### Styling

The house style is already decided and is not up for renegotiation (`SKILL.md`): paper/ink, hairline
rules, square corners, tabular figures, no gradients, no rounded cards, no emoji headers, and **no copy
that explains the encoding**. The rewrite keeps the CSS almost verbatim:

- `styles/tokens.css` — the current custom properties (`--ink`, `--paper`, `--rule`, sizes, the accent
  used for "next set"). This file is also the source for the Android theme (see §3).
- `styles/components/*.css` — one file per component folder, plain CSS with a `.gf-` prefix. No
  Tailwind, no CSS-in-JS: the existing sheet is 900 lines of hand-tuned editorial layout and porting it
  is cheaper than re-expressing it in a utility system.
- Fonts: the current stack, loaded from the same place, `font-display: swap`.

### Build and serving

`vite build` → `apps/web/dist`, served by Express (`express.static`) with `index.html` fallback for
`/settings` and `/profile`. Hashed assets get `Cache-Control: immutable`; `index.html` gets `no-cache`.
Source maps are shipped privately (`build.sourcemap: true`) — this is your own box.

### Tests

- `vitest` + `@testing-library/react` for the pure pieces: `compose` display, band rendering from a
  fixture, sheet state machine, formatters.
- One Playwright smoke test against a seeded server: dashboard renders, confirm flow works, gate saves,
  settings saves. That is the whole E2E budget; the dashboard is not a place to grow a test pyramid.

---

## 2. Android (`apps/android`, phase 5)

Kotlin 2.x, Compose, minSdk 26, `kotlinx.serialization`, OkHttp, Ktor *or* the generated Retrofit
client — pick whichever the generator emits, do not hand-roll HTTP.

```
app/
├─ data/
│  ├─ api/            generated client (openapi/clients/kotlin), never edited
│  ├─ auth/           TokenStore (EncryptedSharedPreferences + Keystore), pairing flow
│  ├─ repo/           DashboardRepository, RoundRepository, CheckinRepository (cache + api)
│  └─ db/             Room: last dashboard snapshot, pending confirmations queue
├─ domain/            thin mappers to UI models; NO physiology rules (the server decides)
├─ ui/
│  ├─ home/           Band, NextSet, Lifetime, CheckinCard  ← GET /dashboard?sections=…
│  ├─ muscles/        list + atlas + detail
│  ├─ history/        rounds list, month bars
│  ├─ checkin/        gate + post sheets (same question order as web)
│  └─ settings/       schedule, stack, devices, pairing
└─ work/              PollWorker (15 min floor), ConfirmRetryWorker
```

**What the phone must not do:** compute wear, decide the next exercise, or guess the readiness. Those
are server decisions; the client renders them. The only client-side arithmetic is countdowns and
formatting.

**Auth**: `POST /auth/pair` once (code from the web's device list) → token in `TokenStore` → OkHttp
interceptor adds `Authorization: Bearer`. On `401`, drop the token and show the pairing screen; never
retry in a loop.

**Confirmations offline: not in v1.** The client is online-only (decision 4). No request succeeds
offline, no queue is kept, and an unreachable server drops the app to the pairing screen rather than
pretending it logged something. That is a deliberate simplification: an offline queue has to answer
"the server advanced while you were away" (the round expired, the bonus moved, another device
confirmed) and that reconciliation is its own project. `Idempotency-Key` is still sent on every
mutation, so the endpoint is ready for it when the time comes.

**Push**: FCM data-only message `{type:"round_opened", round_key}` → local notification with a "Done"
action that fires the same confirm call. Registration via `POST /devices` on login and on token refresh.
The 15-minute WorkManager poll is the floor, not the mechanism — a 90-minute interval with a 10-minute
window is not something to leave to Doze.

**Atlas on Android**: the vendored SVGs are fine but Compose cannot read `<g>` layers for hit-testing.
Recommended: `coil-svg` to render, and an invisible `Path` set (converted once, committed as
Drawable paths) for the tap targets. The three missing muscles stay missing — that is a content
decision, not a rendering one.

---

## 3. Shared design tokens

`apps/web/src/styles/tokens.css` is the source. A tiny generator (`pnpm tokens:android`) emits
`apps/android/.../theme/Tokens.kt` with the same colours, sizes and type scale. Two rules:

1. The tokens file is the only place a colour is written; both apps import the generated artifact.
2. If a token is needed on one platform and not the other, it still goes in the shared file with a
   comment — otherwise the two apps drift within a month.

---

## 4. Client checklist before phase 3/5 is "done"

- [ ] every section of `index.html` renders from `GET /dashboard` with no hard-coded copy
- [ ] confirm works from web and phone; the second one gets a reconciled `409`, not an error toast
- [ ] the after-set modal appears only inside the window and disappears at zero
- [ ] gate questions answered today stay hidden until local midnight
- [ ] an unattributed exercise is visible and red on both clients
- [ ] the atlas hover/tap paints the same muscle on both
- [ ] `settings` round-trips: change interval → the next set moves; retire an exercise → still in history
- [ ] one FCM notification arrives with the app killed
- [ ] going offline logs the client out cleanly (v1 policy) and re-pairing works
- [ ] dark mode? — currently only paper/ink; decide before building the Android theme

---

## 5. Parity pitfalls, learned the hard way

The first React pass rendered every section and still looked wrong: 760px wide instead of 980, the
calendar with no month labels, hovering a muscle painted nothing. None of it was missing components —
it was the port, not the markup. Check these before believing a layout difference is a design choice.

**Two stylesheets, one global scope.** `index.html` and `settings.html` were separate documents with
overlapping class names, which is fine until both are imported into one app:

- `.wrap` was declared in both — 980px on the dashboard, 760px on settings. Imported second,
  settings won, and the whole dashboard rendered narrow. Keep the chrome (tokens, `body`, `.wrap`,
  masthead, `h1`, `.label`, `.block`) in one file and scope the settings page with `.wrap.settings`.
- the settings `:root` was an older copy without `--cal-empty` and `--scrim`, so importing it second
  silently dropped those tokens and the calendar's empty cells lost their colour.
- `.ex` meant "exercise row" on settings and "form-article link" on the dashboard. The link inherited
  `display:grid` and a border, so assignments stacked as full-width blocks. Renamed to `.exrow`.

**The atlas maps slugs to shape ids.** The SVG ids are anatomical (`pectoralis_major_l`), the API
speaks slugs (`chest`). Matching by name paints nothing; the `MUSCLE_ART` table is the only correct
source. The figure also swaps front/back per muscle, and injecting that markup wipes the highlight —
re-apply it after the swap or every second hover goes dark.

**The calendar scale is theoretical.** `dayScale` is rounds-per-day × the base stack, not the best day
ever logged, and weeks start Monday with spacers for days that have not happened yet. Getting either
wrong makes the year look sparse or dense rather than wrong.

**Compare pixels, not memories.** Both pages at 1440px: 2368 vs 2369px tall, settings 2021 vs 2021,
`.body` 148×326, `.mrow2` 239×31, 12px type, the same horizontal overflow (the hero strip scrolls).
Those numbers settle an argument faster than a screenshot at an arbitrary window size.
