# Whipsaw-veto study — can we predict the choppy bar at its first fire? (2026-07-08)

The eureka hunt, run at full fleet strength and reported at full honesty. Question:
at the FIRST K=5 fire of a bar, predict whether the bar will later fire the opposite
direction (the "whipsaw" class that carries the entire betting loss pool: −$359 vs
+$317 on clean bars). Answer: **not predictable from this data at this sample size.**
Documented null, one directional lean recorded for the next data batch.

## Design (all pre-registered, all reviewed)

- Label: bar fires both directions at K=5 (= exactly the mixed-bar loss pool). 967
  bars, 41.8% whipsaw among bars-with-fires (957 first-fire rows).
- **Persistence check first:** P(whipsaw | prev bar whipsaw) = 41.9% vs 41.4% base,
  crossings autocorr r=0.14 → **zero bar-to-bar chop memory.** The cross-bar regime
  thesis died before modeling, as the harness was designed to reveal.
- 60 features, 8 families, causality-tiered (T0 = strictly pre-open via a continuous
  30-min window; T1 = ≤ first-fire trigger): path geometry, pre-bar context, tape
  battle, book regime (incl. absolute depth), poly regime, vol structure, ETH
  cross-asset (new BQ pull), and **10 novel predictors pre-registered by two
  independent ideation agents** (flow deceleration, liquidity vacuum, away-side
  contra-build, run commitment, poly reprice-per-shock, whale chase/conflict,
  ETH beta residual, imb freshness, multi-timescale disagreement).
- **Red-team audit before any result was read: zero causality/label leaks confirmed**
  (every slice verified bounded; pre-window strictly pre-open; labels never in X).
- Walk-forward: train = first 2 BQ days, held-out = later days; τ selected on train
  only; the ship metric is held-out Δdollars with bootstrap 90% CI.

## Results

| check | train | held-out |
|---|---|---|
| HGB AUC | 0.947 | **0.521** |
| logistic AUC | 0.715 | **0.531** |
| persistence baseline AUC | — | 0.495 |

The model memorizes and generalizes nothing. The money metric says the same in
dollars: the HGB veto turned train from −32.9 to **+79.0** (a textbook in-sample
mirage) and moved held-out by **−5.0** (CI [−42, +35]). The logistic veto: +3.4
(CI [−30, +44]). All ten novel predictors landed at single-feature held-out AUC
0.47–0.53 — mechanically plausible, empirically noise. The two failure modes their
own authors flagged (thin per-second aggregation hiding print-level structure;
±0.12%-band depth staleness) are the likely reasons.

**The one survivor-shaped signal:** `poly_hug` — the bar's own Polymarket price
sitting near 0.50 at your first fire — is the best single predictor at held-out
AUC **0.570**, and `price_side` confirms it from the other side (expensive first
fires → clean bars, AUC 0.593 in the protective direction). Mechanism: the crowd's
uncertainty IS the chop forecast. But the simple money test fails: a poly_hug-veto
selected on train moved held-out by −6.5 (first-fire policy) / +5.8 (all-fires)
with CIs spanning ±$30–50. Real lean, unproven dollars.

## What this means for betting (unchanged from the fire-episode study, now proven twice)

The anti-chop rules that actually hold are **reactive, not predictive**:
1. You cannot see the whipsaw coming at the first fire — nobody can, from this data.
2. You CAN see it the moment it declares itself: **after a bar's second reversal,
   stand down** (that rule needs no forecast — it is the definition arriving).
3. Distrust re-affirmation fires; respect fresh reversals; trust the newest fire.
4. Mild lean, use as tiebreak only: a first fire while poly still hugs 0.50 is
   ~6–8pp more whipsaw-prone than one the market has already priced.

## Next-batch queue (frozen, no re-tuning)

- Re-test at ~2,500 held-out bars (~2–3 weeks of collector accumulation):
  the poly_hug veto (θ=0.55, all-fires policy), the reversal+H8 bet rule from the
  fire-episode study, and H1 (reversal>reaffirm).
- If print-level data ever becomes collectable (trade counts / clip sizes), the
  ideation batch's iceberg/clip-regularity family (B2/A10) becomes computable —
  it was the most mechanism-credible idea we could NOT test with 1s aggregates.

Pipeline (all committed, regenerable): `80_whipsaw_labels.py`, `wfeat/w1–w8`,
`81_whipsaw_features.py`, `82_whipsaw_eval.py`. Fleet: 8 GLM-5.2 feature workers,
2 Sonnet ideation agents, 1 Sonnet red-team, all logged in this study.
