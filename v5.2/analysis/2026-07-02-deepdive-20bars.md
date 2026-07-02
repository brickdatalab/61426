# V5.1 Deep Dive — 20 Bars, Counterfactual Replay Analysis

**Date:** 2026-07-02 · **Dataset:** 20 settled BTC 5m bars (`btc-updown-5m-1782969600` … `1782976200`), all Polymarket-resolution-verified (20/20 match, Chainlink source). **No production code was changed** — all counterfactuals ran in a scratchpad harness importing the real `v5.1/src/signals.mjs` read-only.

**User constraints honored:** transitions stay within the current envelope (avg ≤6 / max ≤9 per bar); variants that improve accuracy by going MIXED more (stealth gating) rejected — fire-worthy coverage must be ≥ baseline; momentum layer fully in scope.

---

## 1. Method + fidelity gate

Harness: `replay.mjs` (scratchpad) reconstructs the dashboard's exact tick inputs from the logs (`sinceOpen=cvd_since_open`, `price=open+cushion`, raw `bimb/pimb`, all VM metrics) and replays them through the real engine, with CFG overrides or harness-side decision-rule variants (a port of `decideDebounced` proven tick-identical to the module: 5799/5799).

**Fidelity vs the live sessions:** signal tag reproduced on **99.88%** of 5,799 ticks (19/20 bars 100%; the 7 divergent ticks on bar …3800 trace to one knife-edge live momentum tick — z 2.04 logged vs 2.26 replayed at a 5s-window boundary, a millisecond-jitter artifact). Decision state near-exact (`imb_ewma` max Δ 0.0008). Numeric medians: mom_z Δ 0.002, p_flip Δ 0.0002; sparse tails from window-edge sampling under ms jitter. **All variant comparisons use the replayed stock run as baseline (same clock), so jitter cancels. Gate: PASS.**

## 2. Baseline (replayed stock, 20 bars)

| metric | value |
|---|---|
| per-tick accuracy (non-MIXED vs settle) | **70.8%** |
| fire-worthy coverage¹ | **50.6%** |
| transitions avg / max | 5.85 / 9 |
| wrong episodes | 26 |
| first-fire accuracy | 70% |
| alerts (episodes: correct/total) | 1/3 |

¹ *Fire-worthy tick* = cushion is on the eventual settle side AND |cushion| ≥ max($10, 0.5·vol_1m) — a real settle-direction lead exists. Coverage = share of those ticks where the tag called it.

Bar mix: 11 clean-trend, 5 reversal/chop, 4 late-flip. Worst bars: …5900 (0/71 correct ticks), …3500 (11/139), …1400 (67/164, coverage 0%).

## 3. Autopsy — why it's wrong when wrong, why silent when it should fire

**Wrong episodes (26): 18 are counter-cushion** — the book leans against the current price lead and the tag follows the book (33% accuracy class from FINDINGS §3, now fully enumerated). The other 8 are early with-cushion calls on a lead that later reversed (honest losses).

**Fire-worthy ticks not correctly called (1,869), by blocking gate:**

| gate | ticks | meaning |
|---|---|---|
| hold_zone | 608 | EWMA agrees with settle side but sits in the 0.08–0.20 band → never enters |
| wrong_side_held | 601 | tag actively on the wrong side (the counter-cushion disease) |
| dead_zone | 508 | book genuinely neutral (|EWMA|<0.08) while price leads — only a non-book input can catch these |
| dwell_pending | 150 | in transit through the 7-tick dwell |
| flow_conflict | 2 | momentum veto — effectively never happens |

## 4. Counterfactual sweeps (~250 variants × 20 bars)

**4a Decision grid** (ENTER×EXIT×DWELL×ALPHA_IMB, 132 variants): best constrained = `ENTER 0.20 / EXIT 0.05 / DWELL 10 / ALPHA 0.04` → acc 75.5%, cov 56.7%, trans 3.10, wrongEp 17. Slower EWMA + stickier exit + longer dwell = fewer, better episodes. EXIT 0.05 consistently beats 0.08.

**4b Momentum grid** (36 variants): re-parameterizing momentum (Z_FIRE 1.2–2.0, gate 0.5–1.0, warmup 30–60s) moves tag accuracy ≤0.1pt. Momentum fires more (up to 411 ticks at the loosest) with 73–77% direction accuracy, but the fold almost never binds. **Verdict: momentum is a decent confirmer, not the missing catcher. Don't chase it with parameters.**

**4c Rule variants** (the winners):

| variant | acc | cov | trans | wrongEp |
|---|---|---|---|---|
| stock | 70.8% | 50.6% | 5.85 | 26 |
| counter-cushion confirm alone | **79.4%** | 52.6% | 4.65 | **15** |
| cc + aligned-entry 0.14 | **80.1%** | 57.1% | 5.10 | 17 |
| cc + aligned 0.12 + W_BIN 0.9 | 79.0% | **79.5%** | 4.70 | 22 |

- *Counter-cushion confirmation*: an entry AGAINST the cushion requires corroboration (momentum agrees OR large_prints sign agrees); otherwise hold. Directly kills the dominant failure class — and LOWERS transitions.
- *Cushion-aligned asymmetric entry*: ENTER drops 0.20→0.12–0.14 when the candidate direction agrees with the cushion → recovers the 608 hold_zone ticks (fires earlier on true moves).
- *Binance-weighted book* (comb = 0.75–0.9·bimb): down-weights the noisy Polymarket book leg.

**Combos (4a × 4c):**

| variant | acc | cov | trans avg/max | wrongEp | first-fire acc |
|---|---|---|---|---|---|
| **A0.04/D10/X0.05 + cc + aligned0.12 + W_BIN0.75** | **77.5%** | **82.3%** | **2.40 / 7** | **13** | 55% |
| A0.06/D7/X0.05 + cc + aligned0.12 + W_BIN0.9 | 76.0% | 87.4% | 3.00 / 6 | 20 | 55% |
| stock params + cc + aligned0.14 | 80.1% | 57.1% | 5.10 / 8 | 17 | 65% |

**The trade-off to own:** every high-coverage combo drops first-fire accuracy 70%→55% — firing earlier means the opening call is riskier. Accuracy-per-tick and coverage rise because correct calls run much longer; the first minutes get noisier.

**LOBO stability (top 3 combos):** leave-one-bar-out accuracy ranges ±2pts (e.g. flagship 77.5% → [74.5%, 78.8%] eq.); wins are broad-based, not concentrated. Consistent worst bars are the late-flips (…1400: 0%) — no tag variant fixes those; that's the flip-score's job.

**4d Flip/alert sweep:** only 4 genuine flip bars — too few events to tune. Directional observations: a min-|cushion| alert gate does what was hoped (at ALERT_P 0.55/TICKS 5: false alerts 9→2 going from no gate to $15 gate, keeping 2 true positives); stricter ALERT_P 0.7 produces zero alerts ever. **Recommendation: collect more flip bars before touching alert params.**

## 5. Flip-bar forensics (4 bars)

| bar | decisive cross | stock caught? | pre-cross tells (60s) |
|---|---|---|---|
| …2300 (DOWN) | rem=118 | YES, 0s delay | imb_ewma 60/60 settle-side, perp 60/60 |
| …2600 (DOWN) | rem=131 | YES, 0s delay | imb 28/60, d60 27/60 |
| …1400 (UP) | rem=122 | never | weak/mixed tells (d60 36/60; d3m, whale, perp all wrong side); p_flip peaked 0.35 |
| …5000 (UP) | **rem=3** | never | **d60 50/60, cvd_3m 52/60, large_prints 13/13 settle-side** — flow screamed UP for a full minute while price sat below open |

**Structural finding (…5000, the canonical "should have caught it"):** the flip-score prior `Φ(−|cushion|/vol·√t)` collapses toward 0 as time runs out, so no amount of opposing flow can push p_flip over the alert bar late in a bar — exactly when a flow-led snap-back flip happens. The flow term needs to be weighed against *whether remaining flow can plausibly move price by |cushion|*, not just added in logit space. This is a design gap, not a parameter gap; it needs more late-flip examples before building the replacement.

## 6. Ranked change candidates (all: validate forward before adopting — n=20)

1. **Counter-cushion confirmation** (decide-layer rule). Measured: acc +8.6pts, wrong episodes 26→15, transitions DOWN. Attacks the dominant failure class directly. Lowest risk: it only suppresses entries that were 33%-accurate. *Cost: none measured.*
2. **Cushion-aligned asymmetric ENTER (0.20 → ~0.12 when aligned)**. Measured (with #1): coverage 57→80%+, recovers the hold_zone bucket. *Cost: first-fire accuracy 70→55%.*
3. **Binance-weighted comb (W_BIN 0.75–0.9)**. Measured: small consistent gains stacked with #1–2; poly book leg is the noise source. *Cost: poly book no longer vetoes; keep some weight.*
4. **Slower/stickier decision params (ALPHA 0.04, DWELL 10, EXIT 0.05)**. Measured flagship combo: acc 77.5% / cov 82.3% / trans 2.40 / wrongEp 13. *Cost: adds latency to genuine reversals (dwell 10 ≈ 10s); combined first-fire accuracy 55%.*
5. **Alert min-|cushion| gate ($5–15)**. Directionally validated (kills coin-flip-zone false alerts); tune only after more flip bars.
6. **(Design work, needs data): late-bar flow-vs-cushion flip term** — the …5000 gap. Do not attempt from n=4 flip bars.

**Explicitly NOT recommended from this data:** momentum re-parameterization (4b — no tag effect); d10 tie-break in the dead zone (tested, worse); touching W_FLOW/scales (no discriminating events yet).

## 7. Reproduction

Everything lives in the session scratchpad (`deepdive/`): `replay.mjs` (fidelity/dump/sweep/baseline modes), `grid_*.json`, `res_*.json`, per-bar `dumps/`. Fixture logs are the 20 `*_v51.json` from the VM. To re-run at 50+ bars: re-pull logs, re-run `node replay.mjs fidelity` then the grids.
