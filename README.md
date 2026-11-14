# get-fit

Escalating workout stack, driven by Hermes cron + a Telegram confirmation, stored in SQLite.

## How it works

- `getfit.py tick` runs **every minute** from a Hermes no-LLM cron job. It is silent unless a
  set is due, so the only thing that ever reaches Telegram is the set itself.
- A set is due every `interval_minutes` (90) while outside the quiet window. Sending a set opens a
  **round** with a `response_minutes` (10) clock. The 90 minute clock does not run during an open
  round — it starts when the round closes, either because you confirmed or because the window
  expired.
- Confirm on Telegram ("done", "did it", ...) → the round is logged, the stack resets to the
  minimums, and the next 90 minute clock starts. The gateway hook
  `~/.hermes/hooks/getfit-confirm/` does this the moment the message arrives.
- No reply inside the window → `+1` rep on the next set. The bonus is applied to the first
  exercise up to its max, then overflows to the next exercise in list order (which joins at its
  own minimum), and so on. The last exercise has no overflow target and absorbs everything.
- Replied, but after the window → the round is logged and the stack resets to **minimum + 2** on
  the first exercise.
- Penalties survive the quiet window: whatever was stacked at night is still there at 07:00.

## Data model

`getfit.db` (SQLite, next to the code):

| table | holds |
|---|---|
| `settings` | timezone, interval, response window, quiet hours (one row) |
| `exercises` | the ordered stack; removing one sets `active=0` and keeps the row. `form_url` is the
  how-to article the dashboard links to |
| `rounds` | every set that was sent: `sent_at`, `deadline_at`, `resolved_at`, `status`, `target_reps` |
| `round_items` | per round, per exercise: reps asked for + a name snapshot |
| `opening_balance` | lifetime reps imported from the pre-database tally |
| `app_state` | the bonus and the next set time (one row) |
| `muscles` | the 22-group taxonomy (slug, name, region, sort) |
| `muscle_state` | per muscle: `wear`, `soreness`, `stop_at`, `resume_at`, `rest_until` |
| `exercise_muscles` | attribution: which muscles an exercise loads, at what `weight`, learned coefficient `k` |
| `wear_events` | the ledger: one row per round × exercise × muscle, `predicted` vs `observed` |
| `checkins` | the questionnaires: gate items, PRS, sRPE, RIR, per-muscle soreness |

Lifetime totals = `round_items` of done/late rounds + `opening_balance`. The activity calendar is
`rounds` grouped by `sent_local_date`.

## The muscle model

Every muscle carries two numbers in 0..100 wear points: `wear` (mechanical cost, half-life 40 h)
and `soreness` (perceptual residue, half-life 96 h, pulled toward whatever you report). Whatever
gates an exercise is `max(wear, soreness)`.

- A set that is **performed** debits each muscle it uses: `reps × k`, where `k` is that
  (exercise, muscle) pair's own coefficient. A missed set debits nothing — it was not done.
- A muscle **stops** receiving work at `stop_at` (80, less on a bad-readiness day) and becomes
  the preferred target again at `resume_at` (35).
- Selection scores every exercise: the hottest muscle it would hit, minus days since it was last
  performed, minus how much of the previous round's muscle set it repeats. Lowest score wins, so
  the stack rotates by itself. If everything is blocked the round becomes a **deload** — the
  least-loaded movement at its minimum — rather than silence.
- Two check-ins feed the loop. The **gate** (before the set) sets readiness from four Hooper
  items plus Perceived Recovery Status, and lowers everyone's ceiling when you slept badly. The
  **post** one (after the set) compares the soreness you report against the wear that was
  predicted, and moves `k` for the muscles concerned. That is the negative feedback loop: the
  model learns what each exercise actually costs *this* body.

Attribution is loaded from a library in `muscles.py` (29 movements). **When you add an exercise,
it is attributed automatically if the name matches the library** — otherwise the dashboard flags it
as unattributed and it is invisible to the model. Never leave one unattributed.

## The dashboard

The band shows the **assignment** — the set that is on the clock, or the one the engine will send
next — with every exercise linked to its form article. An exercise with no `form_url` is red, and a
hover says so; fix it in Settings rather than guessing a link. A wrong article is worse than none.

The Muscles block lists all 22 groups with load bars, and hovering one paints that muscle on the
body to its right. The artwork is vendored in `art/` (Ryan Graves, CC BY 4.0, via
`kit-g/flutter-body-atlas`); the attribution is rendered under the figure. Serratus anterior, lower
back and hip flexors have **no artwork** in that atlas and stay marked pending — do not draw
substitutes by hand.

The check-in block is the **gate**, asked before a set. Sleep is entered in **hours** (converted to
the 1–5 Hooper scale when the score is computed); fatigue, soreness and recovered carry a hover
explanation of what they measure and what they move. **Each question is answered once a day:** on
save the answered rows disappear, the rest stay until answered, and everything reopens the next
local day (`checkins.local_date`). The after-set questionnaire is a modal that opens only inside the
`response_minutes` window that follows a confirmed set, and only if that set has not been answered
yet: `muscles.post_window` is the single rule behind both the pop-up and the server, which refuses a
late, repeated or fabricated answer.

The Profile block shows the fitted parameters, how many observations back each one, and the
calibration error per check-in. Every real change is appended to `profile_history` — `getfit.py
history` lists it, which is how you audit what the model believed and what moved it.

Background and sources: `docs/fatigue-model-research.md`.

## Files

| file | role |
|---|---|
| `getfit.py` | engine + state machine (`tick`, `confirm`, `status`, `report`, `reset`, `migrate`) |
| `muscles.py` | taxonomy, attribution library, decay, selection, calibration, check-ins |
| `server.py` | tiny HTTP server for the two pages: `:8777` plain, `:8443` TLS when `certs/` exists |
| `index.html` | dashboard: lifetime total, assignment, check-in, muscle state + atlas, calendar, gauge |
| `art/` | muscle-atlas SVG (Ryan Graves, CC BY 4.0) + the licence record |
| `settings.html` | schedule + exercise stack, writes through `POST /api/settings` |
| `tests.py` | state-machine + muscle-model tests (`python3 tests.py`) |
| `scripts/getfit-tick.sh` | the once-a-minute scheduler entry point (portable; see `docs/DEPLOY.md`) |
| `docs/` | the research brief and the deployment checklist |
| `legacy/` | the pre-database JSON files (gitignored, kept for reference) |

## Running it elsewhere

`docs/DEPLOY.md` is the checklist: what the service is, how to schedule the tick on another host,
why only one machine may write to `getfit.db`, and what this box currently runs.

Pushing to `main` deploys here automatically once the self-hosted runner is registered —
`.github/workflows/deploy.yml` calls `scripts/deploy.sh`, which is also safe to run by hand.

## Common commands

```bash
python3 getfit.py status          # where the stack is right now
python3 getfit.py tick --dry-run  # what the next tick would send
python3 getfit.py confirm         # log the current round by hand
python3 getfit.py muscles         # per-muscle load, wear, soreness, and the stop line
python3 getfit.py library         # attribution and learned k per exercise
python3 getfit.py checkin --kind gate --prs 6 --sleep 4 --stress 2 --fatigue 3 --soreness 3
python3 getfit.py checkin --kind post --round_key <key> --srpe 7 --rir 2 --muscle chest=4
python3 getfit.py setwear chest=68 triceps=41   # pin a muscle by hand (manual override)
python3 getfit.py report          # per-day rounds/reps, ready for later reports
python3 getfit.py reset           # back to zero (--keep-tally to keep the totals)
python3 tests.py                  # 60 assertions on the engine and the model
```
