# The two questionnaires

Two different measurements, two different cadences. Merging them loses whichever one is dropped.

| | after the set | the next morning |
|---|---|---|
| when | inside the `responseMinutes` window (10 min) after the set closes | once a day, in the gate |
| asks | `srpe`, `rir`, stopper, plus "how much did that set cost" per muscle | `sleep`, `stress`, `fatigue`, `soreness`, `prs`, pain, plus "how sore is it now" per muscle |
| measures | **cost** — did the model charge the right amount for that set | **recovery** — how fast the charge fades |
| moves | `k`, per (exercise, muscle) | `wear_half_life`, the per-muscle ceiling, `readiness_influence` |

## Why the after-set sheet cannot fit a decay rate

`wear_events` are stamped when the round is confirmed, and the sheet has to be answered within ten
minutes of that, so every observation it produces has `hours ≈ 0`. The half-life fit needs
observations at **≥ 4 hours** across at least two six-hour buckets (`MIN_HALF_LIFE_OBS = 8`,
`MIN_HALF_LIFE_BUCKETS = 2`). With post-set answers alone the fit is unreachable and
`wear_half_life` sits at its 40 h prior forever — which is exactly what the dashboard showed on the
live database.

The morning gate is answered 12–24 h after the load. That is the range that can tell "recovers
fast" from "the model overcharges this movement", and it is why the daily per-muscle rows exist.

## How it is wired

- `checkinTodo.askMuscles` — up to **six** muscles, most loaded first, only those that took load in
  the last 48 h and have not been reported today. The client renders one row per muscle and must not
  invent its own list: the API owns the choice, so the phone and the web page always ask the same.
- `POST /checkins` with `kind: "gate"` and `muscleSoreness: { chest: 3 }` — 1–5, stored on the gate
  row. A gate answer that carries per-muscle soreness refits immediately; a gate without it does not,
  because nothing changed.
- `observations()` in the engine tags each one `source: "post" | "gate"`. Gate observations carry
  `rir: null`, so the ceiling-fitting loop (which needs RIR) ignores them; the half-life loop takes
  any observation with `hours ≥ 4`, which in practice means only gate ones.
- A gate report is attributed to the **most recent** load for that muscle within 48 h. Older than
  that and the answer describes nothing identifiable.

## Trap: the timestamp is the whole feature

If `accrue()` ever stamps wear at *send* time instead of confirm time, post-set observations start
carrying the confirmation latency as their gap. That looks like a fix and is not: the latency is
minutes on a good day, and the mix of "0 h cost" and "20 min decay" observations pulls the fit in
two directions at once. Cost and decay need different questions, not a smarter timestamp.

Python (`v1`) does not have the daily rows, so its `wear_half_life` stays at the prior. Parity is
unaffected while no gate row carries `muscleSoreness` — the live database has none yet. Once the Pi
is cut over, the two implementations are expected to diverge on this parameter, and that divergence
is the feature.
