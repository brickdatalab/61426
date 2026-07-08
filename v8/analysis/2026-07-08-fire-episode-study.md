# Fire-episode study — which fire do you trust? (2026-07-08)

Episode-level audit of the v8 per-tick stream: every directional run ("fire") from
**967 BQ 24/7 bars + 92 live bars**, replayed through the real engine (determinism
100%; two independent episode counters agree exactly: 267 live K=5). Unit = a fire
triggered at the K-th consecutive same-direction tick (headline K=5: **2,405 BQ +
267 live episodes**). All bet-time fields computed at trigger (anti-hindsight
asserted in code and verified by an independent reviewer; `won` is the label only —
it feeds no rule and no model input). Walk-forward: TRAIN = first 2 BQ days,
HELDOUT = later BQ days, LIVE = second distribution. Pipeline: `70_extract_episodes.mjs`,
`71_build_episodes.py`, `72_sequence_map.py`, `73_hypotheses.py`, `74_decision_card.py`
(all reviewed by three independent code-review agents; two robustness fixes applied,
zero result changes).

## 1. "It fires one direction, then another, then back — which is right?"

**The most recent fire. Always, and by a wide margin.**

| pattern (BQ, K=5) | n | verdict |
|---|---|---|
| A→B (2nd fire opposes 1st) | 249 | **B right 68.3%, A right 31.7%** — trust the newer fire >2:1 |
| A→B→A (returns to first direction) | 62 | the return fire is right **71.0%** |
| A→B→B (re-confirms the reversal) | 80 | right 71.2% |
| first fire vs last fire of the bar | 957 bars | first 64.5% · **last 90.1%** |

Accuracy by fire index: #1 64.5% → #2 66.1% → #3 66.8% → #4+ 76.3%. Later fires are
better — but the market reprices them (avg cost 0.65 → 0.75), so **ROI stays ≈ 0 at
every index**. The information ladder is real; the discount is already charged.

## 2. Fire types — where your manual instinct is measurably right

| type (BQ) | n | acc | avg price | ROI/bet |
|---|---|---|---|---|
| reversal (opposes previous fire) | 549 | **72.3%** | 0.719 | **0.00, positive in 4/5 time bands** |
| first fire of bar | 957 | 64.5% | 0.65 | 0.00 |
| **re-affirmation (same dir as previous)** | 899 | 67.2% | 0.70 | **−0.05 — the money loser** |

Reversal fires are the strongest class; **re-affirmation fires — the "it switched
back" moments you distrust — are the only consistently negative-ROI class.** Your
instinct has a measured basis. Direction→MIXED→opposite ("decay" reversals) is
essentially the *only* reversal shape that exists (545 of 549; the stream almost
never snaps through the floor without a MIXED beat), so H2 was unmeasurable.

## 3. When it's wrong — concentrated or everywhere? Does it negate wins?

- **Not concentrated:** top-10 worst bars carry only 7% of all lost fires; losses
  spread evenly across all four days. There is no removable "bad regime."
- **The drain is the choppy bar:** bars producing BOTH a winning and a losing fire
  netted **−$359** (flat $1 each fire) while single-direction bars netted **+$317**.
  All profit lives in bars that fire clean; the whipsaw bar is where money dies.
  Practical form: *once a bar has already reversed twice, stand down.*

## 4. Is it predictive — before it's priced in? Yes, measurably — and priced anyway

After a fire that turns out CORRECT, the fired side's market price rises **+3.3¢ in
30s, +5.7¢ in 60s**; after a WRONG fire it falls −8.1¢/−13.1¢ (live: +3.1/+4.7 vs
−11.7/−16.2). **The engine's correct calls lead the market — the market follows.**
But because you can't (yet) tell correct fires from wrong ones better than the price
already does, the average edge nets to zero: all-fires ROI −0.007/bet on held-out BQ,
+0.046 on live (CI crosses zero; live-hours flattered). The infamous "disagreement"
slice — engine fires while the market prices the other side (<0.50) — is decisively
NOT the edge: n=22, **27.3% accuracy, −0.38 ROI**. When the whole market disagrees
with a 5-tick run, the market is right. Cheap fires are cheap for a reason.

## 5. Pre-registered hypotheses — survivors and casualties (train → heldout → live)

**SURVIVED (same-sign lift in every measurable split):**
- **H9 — p_flip ≤ 0.5 at trigger:** +0.019 → +0.064 → **+0.65 live**. The engine's
  own flip-risk channel stratifies fire quality. Strongest, most portable survivor
  (computable live today).
- **H8 — opposing-side liquidity pulled (book pull_skew):** +0.020 → +0.052. The
  classic leading tell, finally showing up — at the episode level, not the tick level.
- **H6 — aggression-aligned (taker split):** +0.016 → +0.010. Real but small.

**FAILED:** H1 reversal>reaffirm (held on both BQ splits +0.045/+0.060, flipped on
live n=66 — strict rule kills it; likely real but unproven), H2 (unmeasurable),
**H3 disagreement (decisively negative)**, H4 VWAP, H5 whales, H7 basis, H10/H11
time-band forms, H12 grind-shape.

## 6. The decision card — honest verdict: NOT SHIPPABLE YET

Best pre-declared rule (selected on TRAIN only): **bet reversal fires in minutes 2–4
when opposing-side liquidity is being pulled (H8)** —
train **78.9% acc, +0.114 ROI/bet (n=76)** · heldout **74.7%, +0.037 (n=87,
90% CI [−0.073, +0.146])** · live: unmeasurable (book columns are BQ-only).
Positive in both splits, **but the CI does not clear zero at n=87** — betting it now
would be faith, not measurement. The reference models confirm no better cut exists
in the feature set (a depth-2 tree collapses onto price itself — the calibration
wall). Required to power this test: ~3–4× the held-out sample ≈ **2–3 more weeks of
collector data**, zero re-tuning (the rule is frozen as pre-registered).

## 7. What you can use TODAY (no code change, no bet-sizing faith)

1. **Trust the newest fire.** Whatever fired last is the best available call — 2:1
   over the older fire when they conflict.
2. **Respect reversals, distrust re-affirmations.** A fresh opposite-direction fire
   is the strongest signal class; a "switch-back-to-the-same-side" fire is the only
   class that reliably loses money at market prices.
3. **Two reversals = done betting that bar.** Choppy bars carry the entire loss pool.
4. **Check the flip-risk readout at fire time** (it's on the dashboard): fires with
   p_flip ≤ 0.5 are measurably better in every split — live lift was the largest
   measured anywhere in this study.
5. **Never take the cheap "market disagrees" bait** — 27% accuracy.

## 8. Queued (needs your call, separately)

- **Re-test at ~2,500 held-out bars (~2–3 weeks):** the frozen reversal+H8 rule and
  H1 — automatic, no tuning; ships through the standing gate only if the CI clears.
- **Optional display-only conviction chip** on the v8 dashboard: fire type +
  p_flip flag at each new fire (surfaces §7 automatically while you trade manually).
  Engine untouched; discussion-first.
- Post-hoc observations (NOT tested, next-batch candidates only): fire-index 4+
  accuracy jump; live reaffirm-after-reversal asymmetry.
