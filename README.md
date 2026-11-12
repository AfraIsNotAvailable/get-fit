# get-fit

Escalating workout stack, driven by Hermes cron + a Telegram confirmation.

## How it works

- `getfit.py tick` runs **every minute** from a Hermes no-LLM cron job. It is silent unless a
  set is due, so the only thing that ever reaches Telegram is the set itself.
- A set is due every `interval_minutes` (90) while outside the quiet window (00:00–07:00 local).
  Sending a set starts the `response_minutes` (10) clock.
- Confirm on Telegram ("done", "did it", ...) → the set is logged in `tally.json` and the stack
  resets to the minimums. The gateway hook `~/.hermes/hooks/getfit-confirm/` does this the moment
  the message arrives.
- No reply inside the window → `+1` rep on the next set. The bonus is applied to the first
  exercise up to its max, then overflows to the next exercise in list order (which joins at its
  own minimum), and so on. The last exercise has no overflow target and just absorbs everything.
- Replied, but after the window → the set is logged and the stack resets to **minimum + 2** on the
  first exercise.
- Penalties survive the quiet window: whatever was stacked at night is still there at 07:00.

## Files

| file | role |
|---|---|
| `getfit.py` | engine + state machine (`tick`, `confirm`, `status`, `reset`, `state`) |
| `server.py` | tiny HTTP server for the dashboard, port 8777 |
| `index.html` | tally, countdowns, config page |
| `settings.json` | written by the config page, read by every tick |
| `state.json` | current set, deadline, bonus |
| `tally.json` | lifetime reps per exercise id (survives removal from the config) |
| `tests.py` | state-machine tests (`python3 tests.py`) |

## Common commands

```bash
python3 getfit.py status          # where the stack is right now
python3 getfit.py tick --dry-run  # what the next tick would send
python3 getfit.py confirm         # log the current set by hand
python3 getfit.py reset           # back to zero (--keep-tally to keep the totals)
python3 tests.py                  # 16 assertions on the state machine
```
