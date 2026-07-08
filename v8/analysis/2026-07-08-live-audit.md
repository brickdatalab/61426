# v8 live audit — 72 clean live bars (2026-07-08)

Grades the shipped v8 engine against its own live logs the way it was built: value
scoring, split-half + walk-forward discipline, dynamic replay as judge. Regenerate:
`60_live_audit.py` (ledger/taxonomy/vetoes on live logs) + the BQ-scale candidate tests
below. Determinism verified first: 3 live logs replayed through `v8/src/signals.mjs`
matched the logged signal 295/295, 295/295, 295/295 (100%) — the logs ARE the engine.

## A. Ledger (72 bars, 21,304 ticks)

correct 13,816 · wrong 2,147 · missed **1** · ok-MIXED 5,340 →
**accuracy 86.6% @ 74.9% coverage, value +7.06/bar.**

| band (rem) | live acc | live cov | predicted (823-bar backtest) | diff |
|---|---|---|---|---|
| 300–240 | 72.9% | 54.9% | 67.4% | +5.5pp |
| 240–180 | 82.4% | 72.0% | 72.8% | +9.6pp |
| 180–120 | 87.0% | 76.9% | 78.8% | +8.2pp |
| 120–60 | 90.0% | 81.0% | 85.9% | +4.1pp |
| 60–0 | 94.2% | 88.1% | 92.3% | +1.9pp |

**Calibration verdict: OK — live beats prediction in every band, all within the 10pp
flag.** The uniform positive skew is the known live-hours selection flattering (calmer
regimes than 24/7); the monotonic shape matches the model exactly. The engine is
behaving precisely as designed. The single "missed" tick (1 in 21,304,
`1783517100` — |cushion| a rounding-width above floor while the logged tag was MIXED)
is a float-boundary artifact, not a logic hole.

## B. Where the wrong ticks actually come from (all 2,147 attributed)

| class | wrong ticks | share | bars | fixable? |
|---|---|---|---|---|
| **true-flip** (lead ≥2× floor, then reversed) | 1,906 | **88.8%** | 25 | not from these inputs — the measured wall |
| boundary (persistent 1.0–2.0× floor, wrong side) | 209 | 9.7% | 6 | only by predicting reversals (same wall) |
| chatter (thin, brief, flap-back) | 32 | 1.5% | 4 | negligible mass |

Worst bars are all true-flips (e.g. `1783500000`: price −$139 below open, settled UP —
200 wrong ticks that no cushion-family rule can avoid). Chatter — the one class a
hysteresis tweak could touch — is 1.5% of errors. **The error budget is ~99% "price
genuinely led the wrong way," which is the designed, disclosed failure mode.**

## C. Candidates tested — all three measured, all three NO-SHIP

1. **Lower floor (VOLMULT 0.4/0.45 ⇔ enter at 0.8/0.9× floor)** — motivated by 679
   near-miss MIXED ticks at 0.8–1.0× floor. Walk-forward on 823 BQ bars (train d1–2,
   test d3–4): monotonic — 0.8× → −1.51 vpb / 81.3%, 0.9× → −1.25 / 82.1%,
   **1.0× (shipped) → −1.02 / 82.9%**. The near-misses don't pay for the wrong ticks
   they bring. NO-SHIP.
2. **flipRisk veto (tag→MIXED when p_flip > thr)** — the only new-logic candidate.
   Live split-half: +65.4 value on half 1 → **+5.4 on half 2** (12× collapse). BQ scale
   (832-bar replay, per-day): held-out last-2-days **−3.16 vpb vs plain −2.86**, accuracy
   +0.02pp. The half-1 gain was a few lucky flip bars — exactly the v7-mirage shape the
   honesty rails exist to catch. NO-SHIP.
3. **imb_ewma-against veto (book EWMA >0.2 opposing the tag)** — live counterfactual:
   kills correct ticks ~20:1 vs wrong (h1 −880c/−45w, value −314; h2 −661c/−43w, −203).
   The book echo remains anti-signal, consistent with the frontier. NO-SHIP.

## D. Verdict

**The engine stands unchanged.** Live performance is at or above the backtest in every
band; 0 missed fire-worthy leads in practice (1 rounding tick); errors are 99%
concentrated in the one class this engine, by disclosed design, does not claim to
predict — genuine reversals. All three improvement candidates were measured under the
standing discipline and rejected on held-out data; the record of each rejection (with
killing numbers) is above, so they are not re-litigated later.

What would actually move the needle on the remaining 13% wrong ticks is reversal
prediction — and the v8 frontier already measured that no public tape/book/poly feature
carries that information at fire time. That remains the honest wall. The engine's
per-tick contract — never miss a developing lead, never echo noise, honest per-minute
accuracy 73→94% — is being met live.
