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
| `exercises` | the ordered stack; removing one sets `active=0` and keeps the row |
| `rounds` | every set that was sent: `sent_at`, `deadline_at`, `resolved_at`, `status`, `target_reps` |
| `round_items` | per round, per exercise: reps asked for + a name snapshot |
| `opening_balance` | lifetime reps imported from the pre-database tally |
| `app_state` | the bonus and the next set time (one row) |

Lifetime totals = `round_items` of done/late rounds + `opening_balance`. The activity calendar is
`rounds` grouped by `sent_local_date`.

## Files

| file | role |
|---|---|
| `getfit.py` | engine + state machine (`tick`, `confirm`, `status`, `report`, `reset`, `migrate`) |
| `server.py` | tiny HTTP server for the two pages, port 8777 |
| `index.html` | dashboard: clocks, dither calendar, lifetime tally, recent rounds |
| `settings.html` | schedule + exercise stack, writes through `POST /api/settings` |
| `tests.py` | state-machine tests (`python3 tests.py`) |
| `legacy/` | the pre-database JSON files (gitignored, kept for reference) |

## Common commands

```bash
python3 getfit.py status          # where the stack is right now
python3 getfit.py tick --dry-run  # what the next tick would send
python3 getfit.py confirm         # log the current round by hand
python3 getfit.py report          # per-day rounds/reps, ready for later reports
python3 getfit.py reset           # back to zero (--keep-tally to keep the totals)
python3 tests.py                  # 28 assertions on the state machine
```
