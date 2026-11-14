# Per-muscle wear model — research brief

Working notes for the muscle-group state / dynamic-exercise-assignment system. Written
2026-11-14. Nothing here is implemented yet; this is the evidence base and the design
decisions it implies.

---

## 1. Frameworks that already exist

Three bodies of work cover most of the spec. None of them is a paper you can copy; two are
established enough to be treated as settled practice.

### 1.1 Per-muscle recovery percentage (commercial prior art)

Fitbod ships exactly this model. Vendor documentation (`fitbod.me/blog/fitbod-algorithm`,
`fitbod.me/blog/muscle-recovery`):

- every muscle group carries a **recovery percentage 0–100%**, estimated from logged sets,
  reps and load, decaying back toward 100% over roughly 7 days;
- every exercise in the library is **scored** by how recovered the muscles it needs are, and
  selection is driven by that score;
- the Recovery tab is a per-muscle **heat map**; the user can **manually override** a
  percentage the model got wrong;
- the vendor itself says "don't get too hung up on the exact percentages — there is no
  magic number that dictates whether you should exercise a specific muscle."

Two takeaways. First, the architecture the user described is sound enough that a funded
product runs it. Second, the manual override *is* the negative feedback loop — the vendor
treats the model as a prior and the human as the correction signal, which is the right
relationship.

### 1.2 Volume landmarks: MV / MEV / MAV / MRV

Renaissance Periodization's framework (Israetel; `renaissanceperiodization.com` per-muscle
guides) gives each muscle four thresholds in weekly hard sets:

| landmark | meaning | typical range |
|---|---|---|
| MV | maintenance volume | 4–8 sets/wk |
| MEV | minimum effective volume | 8–12 |
| MAV | maximum adaptive volume | 12–20 |
| MRV | maximum recoverable volume | 16–26+ |

This is the same idea as "stop assigning at 80% wear, resume at 30–40%", expressed in a
different unit: **80% ≈ MRV, 30–40% ≈ MEV**. The literature behind the numbers:

- Schoenfeld, Ogborn & Krieger 2017 (*J Sports Sci* 35:1073–1082): graded dose–response;
  each extra weekly set ≈ +0.37% muscle gain, with the jump at ≥10 sets/muscle/wk.
- Baz-Valle et al. 2022 (*J Human Kinetics* 81:199–210): 12–20 weekly sets/muscle is the
  practical optimum for trained men; no advantage to >20 for quads or biceps.
- ACSM 2026 Position Stand, overview of 137 reviews (≥30,000 participants, *MSSE*
  58(4):851–872): hypertrophy is enhanced by **≥10 sets/wk** and eccentric overload; and
  notably **training to momentary failure did not consistently change outcomes**, nor did
  set structure or time under tension.

That last point matters for this system: weekly hard-set volume per muscle is a much better
currency than rep-level precision.

### 1.3 Fitness–fatigue impulse response (the decay math)

Banister's model: a training dose produces two antagonistic responses that both decay
exponentially, with a long time constant for fitness and a short one for fatigue
(Morton, Fitz-Clarke & Banister 1990, *J Appl Physiol* 69:1171–1177). Performance is the
difference. This is precisely the shape of a "wear" accumulator: dose in, exponential decay
out, gate on the difference.

Caveat worth knowing before copying it: the two components are **not statistically
identifiable** from training and performance data alone, and adding the fatigue term
improves fit without improving out-of-sample prediction (Marchal et al. 2025,
*Sci Rep* 15:3706). Conclusion for us: use the *shape* (per-muscle accumulator with
exponential decay) but do not attempt to fit a full FFM.

Do **not** use the acute:chronic workload ratio. Impellizzeri et al. 2020 (*Sports Med*,
"What role do chronic workloads play in the ACWR? Time to dismiss ACWR and its underlying
theory") show the ratio is a rescaling artefact with no predictive value. A per-muscle
accumulator is the better shape anyway.

---

## 2. What the evidence says the spec should change

**2.1 Wear decays with a time constant, and there are two of them.**
DOMS appears 12–24 h after unaccustomed work, peaks 24–72 h, resolves in 5–7 days
(Cheung, Hume & Maxwell 2003, *Sports Med* 33:145–164). Force loss recovers faster than
soreness. One number per muscle cannot carry both. Minimum viable: `wear` (acute, τ≈2 days)
and `soreness` (perceptual, τ≈5 days), both per muscle.

**2.2 Soreness is a bad measure of damage, and a bad gate.**
110 men, 12 / 24 / 60 maximal eccentric elbow-flexor actions: soreness on palpation did not
correlate with any marker of damage; flexed/extended soreness correlated weakly (r<0.32)
(Nosaka, Newton & Sacco 2002, *Scand J Med Sci Sports* 12:337–346). Soreness is a signal
that the tissue is unaccustomed, not that it is unrecovered. So: gate on **readiness**, use
soreness as a per-muscle modifier.

**2.3 A new exercise reads as more wear than the same exercise repeated.**
The repeated-bout effect: a second bout of the same eccentric work produces markedly less
damage, soreness and strength loss than the first (McHugh 2003; Hyldahl et al. 2017,
*ESSR* 45:24–33; meta-analysis of 35 studies, *Front Physiol* 2026, largest protective
effect at 72 h, protection persisting weeks to months). Consequence for a system that
rotates exercises: **every first exposure will look expensive**, the loop will learn
"new exercise = high wear", and rotation will stall. Fix: track exposure count per
(exercise, muscle) and apply a novelty discount — 0.5× wear on the first exposure, 0.8× on
the second, 1.0× from the third.

**2.4 Rotating exercises costs nothing in gains and helps adherence.**
21 trained men, 8 weeks, fixed vs session-randomised exercise selection: no difference in
bench/squat 1RM or quadriceps muscle thickness; the varied group showed a significant
moderate improvement in intrinsic motivation (Baz-Valle et al. 2019, *PLOS One*
14(12):e0226989). So the rotation is justified — as distribution of per-muscle volume and
as adherence, not as "muscle confusion".

**2.5 Count hard sets, or weight reps by proximity to failure.**
A flat "% wear per rep" treats a rep at 8 reps-in-reserve the same as a rep at failure.
Volume evidence is built on *hard sets* (ACSM 2026; Schoenfeld 2017). Two options:
(i) record sets, not reps, as the dose — one hard set of push-ups ≈ one unit;
(ii) keep reps but scale by effort: `wear_rep = k × (1 − RIR/10)`.

**2.6 RIR answers are only trustworthy near failure.**
Trained men squatting to failure at 70% 1RM mis-called their reserve by 5.15±2.92 reps at
"5 RIR", 3.65±2.46 at "3 RIR" and 2.05±1.73 at "1 RIR" (Zourdos et al. 2021,
*JSCR* 35(2S):S158–S165). Ask for RIR as a coarse bucket (0 / 1 / 2 / 3+) and weight the
answer by how close to failure the set was. Do not regress on a free-typed RIR number.

**2.7 The thresholds are per-muscle and personal.**
MRV varies hugely between muscles and lifters (calves MRV ≈ 20 sets, quads ≈ 18–24, chest
16–26 in RP's tables, all "serious intermediate" estimates). A global 80% is a placeholder.
The feedback loop's job is to move each muscle's 80% independently.

**2.8 The questionnaire is a noisy sensor, not an equation.**
Use it to nudge coefficients (exponential moving average of observed/expected per
exercise–muscle pair, learning rate shrinking with n), not to solve for the coefficients.
And log the prediction next to the observation so drift is visible — otherwise the loop has
no memory of what it believed.

---

## 3. Muscle attribution

### 3.1 Use a fixed taxonomy, not free text

Two open datasets already encode this, both usable as-is:

- **yuhonas/free-exercise-db** — 800+ exercises, public domain, one JSON per exercise with
  `primaryMuscles` / `secondaryMuscles` over a 17-value enum:
  `abdominals, abductors, adductors, biceps, calves, chest, forearms, glutes, hamstrings,
  lats, lower back, middle back, neck, quadriceps, shoulders, traps, triceps`.
- **kinetic-place/exercises-db** — 899 exercises, 17 muscle groups, adds a `tertiary` tier
  and referential IDs, i.e. a ready `exercise_muscles(exercise_id, muscle_group_id, type)`
  join table.

What they already say, verbatim, for the two exercises in the current stack:

```
Pushups           primary: chest          secondary: shoulders, triceps
Bodyweight Squat  primary: quadriceps     secondary: glutes, hamstrings
Barbell Squat     primary: quadriceps     secondary: calves, glutes, hamstrings, lower back
```

The user's own push-up description ("chest, front delts, triceps; secondarily serratus,
abs/obliques, forearms") is more granular than the 17-group enum — `serratus anterior` has
no slot, and `shoulders` cannot distinguish anterior/lateral/posterior deltoid. Options:
keep the 17 and lose the nuance, or extend to ~22 groups by splitting deltoids into
three and adding serratus anterior, adductors (already present), and rotator cuff later.
Recommendation: **extend to 22**. The anterior/lateral/posterior split is the whole reason
to have a per-muscle model — a lateral raise and an overhead press must not debited the
same account.

### 3.2 Contribution weights

`primary = 1.00`, `secondary = 0.40`, `stabiliser = 0.15`, applied to the dose. Proposed
starting tables (to be calibrated by the loop, not literature values):

**Push-up (bodyweight, full ROM, hands ~shoulder width)**

| muscle | role | weight |
|---|---|---|
| pectoralis major | primary | 1.00 |
| triceps brachii | primary | 0.60 |
| anterior deltoid | primary | 0.45 |
| serratus anterior | stabiliser→secondary | 0.35 |
| rectus abdominis | stabiliser | 0.25 |
| obliques | stabiliser | 0.20 |
| forearm flexors | stabiliser | 0.10 |

**Squat (bodyweight, full depth)**

| muscle | role | weight |
|---|---|---|
| quadriceps | primary | 1.00 |
| gluteus maximus | primary | 0.60 |
| adductor magnus | secondary | 0.35 |
| erector spinae | stabiliser | 0.30 |
| hamstrings | secondary | 0.25 |
| rectus abdominis | stabiliser | 0.20 |
| calves | stabiliser | 0.15 |

Barbell back squat: raise erectors to ~0.50 and hamstrings to ~0.35, add upper back/traps
~0.25. Front squat shifts weight from glutes/hamstrings toward quads and upper back.

### 3.3 The missing piece: the attribution rule

The user's requirement — "every new exercise gets this research done and attributed" — is a
process rule, not code. It needs to live in three places or it will be skipped:
1. `exercise_muscles` table, NOT NULL on every exercise row (schema enforces it);
2. a line in `README.md` under "adding an exercise";
3. a line in the `getfit-challenge` skill, so a future session inherits the rule.

---

## 4. The questionnaire

Their draft asks: soreness per muscle (1–5), willingness to do more (y/n), rep at which
fatigue started, reps in reserve, soreness for each primary and secondary muscle.

Keep soreness, willingness and RIR. Drop or reword "at which rep did you start feeling
tired" — recall of an inflection point inside a set is unreliable, and it duplicates RIR.
Add the four items that the monitoring literature actually validates, and split the
questionnaire into two moments, because they answer different questions.

### Before the next set (gate — decides what to assign)

| # | question | instrument |
|---|---|---|
| 1 | Sleep quality last night (1–5) | Hooper index item |
| 2 | Stress right now (1–5) | Hooper index item |
| 3 | General fatigue (1–5) | Hooper index item |
| 4 | Overall muscle soreness (1–5) | Hooper index item |
| 5 | How recovered do you feel today? (0–10) | Perceived Recovery Status (PRS) |
| 6 | Any sharp joint pain? (none / which) | safety flag, hard stop |

Hooper index = sleep, stress, fatigue, DOMS, each on a 1–7 anchored Likert, summed
(Hooper & Mackinnon 1995; item structure confirmed in *Sports Med Open* 2022 review
PMC9367927 and used daily in Para/AFL cohorts). The user's 1–5 is fine — what matters is
that the anchors are explicit and identical every time ("1 = very, very good / 5 = very,
very bad" for sleep; "1 = very, very low / 5 = very, very high" for the other three).

PRS (Laurent et al. 2011, *JSCR* 25:620–628) is a 0–10 single item: 0–2 poorly recovered,
4–6 moderately, 8–10 well recovered. Validated specifically after resistance work —
after 8×10 back squats at 70% 1RM it tracked countermovement jump (r=.84) and mean bar
velocity (r=.80) across 72 h (*IJSPP* 17(6):886). This is the single best-value question on
the list, and it is exactly what "would you be willing to do more of the same type today"
is trying to measure.

### After the set (calibration — decides how expensive the dose was)

| # | question | instrument |
|---|---|---|
| 7 | How hard was that? (0–10) | session RPE (Foster 2001, *JSCR* 15:109–115) |
| 8 | Reps in reserve at the end: 0 / 1 / 2 / 3+ | RIR-based RPE (Zourdos 2016, *JSCR* 30:267–275) |
| 9 | What stopped you? muscle failure / breathing / joints / boredom | disambiguates the fatigue source |
| 10 | Soreness now, per primary muscle (1–5) | the user's original item |

sRPE × duration gives load in arbitrary units — the standard currency for comparing
sessions of different modes, validated across 36 studies (*Front Neurosci* 2017;11:612).
For this app the duration is short and fixed, so sRPE alone carries most of the signal.

Keep the per-muscle soreness question to the **primary muscles plus at most two
secondaries**. Asking eight soreness questions after a set of push-ups is where users stop
answering.

### Comparison rule

`observed = f(soreness after, RIR, sRPE)`; `expected = model's predicted wear`.
Update `coefficient[exercise, muscle] *= exp(λ × log(observed/expected))` with λ ≈ 0.2 and
shrinking as observations accumulate. Store both numbers on every row, always.

---

## 5. The user's numbers, computed

Current engine state (read from `getfit.db`, 2026-11-14 11:52):

- stack: `pushups` 10–15 reps, `squats` 5+; squats have **never** been performed — every
  `round_item` ever recorded is a push-up.
- confirmed push-ups (status done/late): **65 reps in 5 sets**, 11–18 reps each, spread
  over 2026-11-12 → 2026-11-14.
- since yesterday 00:00 local: **41 reps** (10 + 13 + 18).
- 15 rounds in that window were missed; the log is much sparser than the clock suggests.

The user reports push muscles at **65–70% wear** after a day of push-ups. Two readings:

| basis | reps | wear/rep | +10 push-ups |
|---|---|---|---|
| all confirmed reps, 70% | 65 | 1.08% | 70% → **80.8%** |
| all confirmed reps, 65% | 65 | 1.00% | 65% → **75%** |
| since yesterday only, 70% | 41 | 1.71% | 70% → **87%** |

Recommended starting coefficient: **1% of chest wear per push-up**, from the 65-rep
reading, which is suspiciously round and therefore a good prior. Under it, the app should
answer the user's question — "if I'm assigned another 10 push-ups, what's the expected
wear?" — with **+10.8 points, i.e. 76–81%, at or over the 80% stop**. That is the system
agreeing with the user's own instinct that another block of push-ups is not the right
choice today.

Sanity check on that coefficient: 70% wear from 65 reps implies ~93 reps/day at 100%,
i.e. ~7 sets of 13 — consistent with sets taken near failure. If the sets are actually at
3+ RIR, the coefficient should be roughly halved (0.4–0.5%/rep). The first questionnaire
answers should settle which.

Per-muscle, from the weight table and 1% chest coefficient:

| muscle | weight | wear/rep | after 65 reps |
|---|---|---|---|
| pectoralis major | 1.00 | 1.00% | 65% |
| triceps brachii | 0.60 | 0.60% | 39% |
| anterior deltoid | 0.45 | 0.45% | 29% |
| serratus anterior | 0.35 | 0.35% | 23% |
| rectus abdominis | 0.25 | 0.25% | 16% |
| obliques | 0.20 | 0.20% | 13% |
| forearm flexors | 0.10 | 0.10% | 6.5% |

Which is the desired outcome: chest is exhausted (stop), triceps/ant-delts are loaded but
trainable, everything else is fresh. Note that this makes a **push-up + squat** day legal
today — chest at 65% blocks more pressing, legs at 0% do not — and that a pull/row or a
lateral-raise movement would be the natural third slot.

---

## 7. What was built (2026-11-14)

Decisions taken with the user: 22-group taxonomy, a separate `muscle_state` table, and the
check-in living on the dashboard behind `POST /api/checkin`.

| research finding | what the code does |
|---|---|
| Banister impulse response decays exponentially; a full FFM is not identifiable (§1.3) | per-muscle exponential decay, half-life 40 h (wear) / 96 h (soreness). No parameter fitting. |
| DOMS peaks 24–72 h and clears in 5–7 d (§2.1) | two separate state variables, so soreness can outlive the force cost. |
| soreness is a poor proxy for damage (§2.2) | gating uses `max(wear, soreness)`; the post-set report moves the coefficient rather than setting the state. |
| repeated-bout effect (§2.3) | *not* a hardcoded discount — the learning rate is 0.35 for a pair's first 3 exposures and 0.15 after, so the model converges on the second and third exposure by itself instead of being told. |
| rotation costs nothing, helps adherence (§2.4) | selection scores on load, days since performed, and overlap with the previous round's muscles. |
| hard sets, not reps, are the currency (§2.5) | the coefficient `k` is per rep but scaled by what the check-in says about proximity to failure: RIR ≥ 3 multiplies it by 0.85, RIR = 0 by 1.12. |
| RIR is only trustworthy near failure (§2.6) | RIR is a 0/1/2/3+ bucket, never a free number, and only the extremes move anything. |
| landmarks are per-muscle and personal (§2.7) | `stop_at` / `resume_at` are per-muscle columns, not constants. |
| the questionnaire is a noisy sensor (§2.8) | EMA on `k`, clamped to [0.10, 4.00], with every prediction stored in `wear_events` next to the observation. |
| 22 groups with three deltoid heads (§3.1) | `muscles.MUSCLES`, plus a 29-movement `LIBRARY` of weights. |
| attribution must be mandatory (§3.3) | `save_settings` attributes on add; unknown names surface as `unattributed` on the dashboard. |
| validated instruments (§4) | Hooper ×4 + PRS on the gate; sRPE + RIR + stopper + per-muscle soreness after the set. |

Calibration anchor: the user reported chest 65–70% after 65 confirmed push-ups, which implied
≈1% wear per rep. `getfit.py setwear` pinned chest at 68 and the other push-up muscles at their
weight-scaled share; the replay alone had predicted 43.7 (65 points accumulated over 2 days, then
decayed), so the first post-set check-in will move `k` upward — which is the loop doing its job.

Known soft spots: the soreness→wear mapping (0/25/50/75/100) is a stub for a per-user curve; the
gate's 18 h staleness window is a guess; and the multiplier on RIR extremes (0.85 / 1.12) is
uncalibrated until there are enough rounds to fit it.

### Update — what the profile fits now

The three coefficients the model could actually fit, and the guard on each:

| parameter | fitted from | guard |
|---|---|---|
| `wear_half_life` | the *fraction* of the dose still reported (`reported / dose`) against `0.5^(Δt/h)`, grid-searched over 16–96 h | ≥8 observations across ≥2 "how long after" buckets; result clamped to 0.5–2× the prior. Fitting on the fraction keeps a wrong `k` from masquerading as a fast recovery |
| per-muscle `stop_at` | rounds where the answer says it cratered (RIR ≤ 1, soreness ≥ 4 at load ≥ 40) vs. came back easy | needs 3 observations; `80 + 2·easy − 4·crater`, clamped 60–90 |
| `readiness_influence` | rounds that followed a bad gate (PRS ≤ 4) and were still easy (RIR ≥ 2) | needs 3 such rounds; `20 + 6·affected − 6·resisted`, clamped 0–40 |

Refit is stateless — recomputed from the ledger every time, so a bad fit cannot compound. Every real
move is appended to `profile_history` with the previous value and the observation count
(`getfit.py history`), which is the audit trail for ironing the model out.

Readiness reads today's gate answers merged per question (`gate_today`), and sleep is stored in
**hours** and converted to the 1–5 Hooper scale only at scoring time. Questions are answered once
per local day; the dashboard hides the answered ones and they all return after midnight.

---

## 8. Sources

- ACSM. Progression Models in Resistance Training for Healthy Adults. *MSSE* 41(3):687–708, 2009. doi:10.1249/MSS.0b013e3181915670
- ACSM. Resistance Training Prescription for Muscle Function, Hypertrophy, and Physical Performance in Healthy Adults: An Overview of Reviews. *MSSE* 58(4):851–872, 2026. doi:10.1249/MSS.0000000000003897
- Baz-Valle E, Schoenfeld BJ, et al. The effects of exercise variation in muscle thickness, maximal strength and motivation in resistance trained men. *PLOS One* 14(12):e0226989, 2019.
- Baz-Valle E, et al. A Systematic Review of the Effects of Different Resistance Training Volumes on Muscle Hypertrophy. *J Hum Kinet* 81:199–210, 2022.
- Cheung K, Hume PA, Maxwell L. Delayed onset muscle soreness: treatment strategies and performance factors. *Sports Med* 33:145–164, 2003.
- Foster C, et al. A new approach to monitoring exercise training. *JSCR* 15(1):109–115, 2001.
- Hooper SL, Mackinnon LT. Monitoring overtraining in athletes. *Sports Med* 20:321–327, 1995. (item structure per PMC9367927)
- Hyldahl RD, et al. Mechanisms and Mediators of the Skeletal Muscle Repeated Bout Effect. *ESSR* 45(1):24–33, 2017.
- Impellizzeri FM, et al. What Role Do Chronic Workloads Play in the Acute to Chronic Workload Ratio? Time to Dismiss ACWR and Its Underlying Theory. *Sports Med*, 2020. doi:10.1007/s40279-020-01280-1
- Laurent CM, et al. A practical approach to monitoring recovery: development of a perceived recovery status scale. *JSCR* 25(3):620–628, 2011.
- Laurent CM, et al. The validity of Perceived Recovery Status as a marker of daily recovery following a high-volume back-squat protocol. *IJSPP* 17(6):886, 2022.
- Marchal A, et al. Statistical flaws of the fitness-fatigue sports performance prediction model. *Sci Rep* 15:3706, 2025.
- McHugh MP. Recent advances in the understanding of the repeated bout effect. *Scand J Med Sci Sports* 13:88–97, 2003.
- Morton RH, Fitz-Clarke JR, Banister EW. Modeling human performance in running. *J Appl Physiol* 69(3):1171–1177, 1990.
- Nosaka K, Newton M, Sacco P. Delayed-onset muscle soreness does not reflect the magnitude of eccentric exercise-induced muscle damage. *Scand J Med Sci Sports* 12(6):337–346, 2002.
- Schoenfeld BJ, Ogborn D, Krieger JW. Dose-response relationship between weekly resistance training volume and increases in muscle mass. *J Sports Sci* 35(11):1073–1082, 2017.
- Zourdos MC, et al. Novel resistance training-specific RPE scale measuring repetitions in reserve. *JSCR* 30(1):267–275, 2016.
- Zourdos MC, et al. Proximity to failure and total repetitions performed in a set influences accuracy of intraset RIR-based RPE. *JSCR* 35(2S):S158–S165, 2021.
- Datasets: github.com/yuhonas/free-exercise-db (public domain, 800+ exercises); github.com/kinetic-place/exercises-db (899 exercises, 17 muscle groups, primary/secondary/tertiary).
- Prior art: fitbod.me/blog/fitbod-algorithm, fitbod.me/blog/muscle-recovery, help.fitbod.me (per-muscle recovery %, exercise scoring, manual override).
