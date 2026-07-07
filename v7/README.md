# v7 family — shared research data for the v7s / v7c engines

This directory holds the SHARED evidence base and tooling behind the two v7-generation
engines (each a full sibling version dir, per the repo's version-isolation rule):

- **`v7s/`** — the STANDARD model. Selective early call, band **[0.82, 0.93]**.
  Measured (2026-07-07, pooled 990-bar replay: 281 live + 709 BQ 24/7):
  **85.8% @ 23.4% coverage, median fire 68s in** (BQ-24/7 alone 81.7%; ex-cascade-day 89.5%;
  live-hours sample 95.6% — selection-flattered, trust the 24/7 numbers).
- **`v7c/`** — the CONVICTION model. Same channel, band **[0.90, 0.96]**.
  Measured: **91.5% @ 7.2% coverage, median fire 72s in** (BQ-24/7 90.4%; ex-cascade 94.0%).
  Reserved for high-conviction / automation (UMA) plans — parked, not deployed.

Both engines: v6 lean stream BYTE-IDENTICAL (gate: 0/74,305 differing ticks over 253 bars,
PASS); the only change is the replaced `earlyCallOf` — one immutable latched call per 5m bar,
fire window 45–90s in, dwell 3, poly-sanity + cushion-agree, **ABSTAINS otherwise** (the
measured edge dies after ~90s: late fires ran ~88%/no-edge, hence the hard deadline).
New engine input: `inp.polyMid` (plumbed additively through `runner/engine-adapter.mjs`
and each version's dashboard; v6 and earlier ignore it).

Files here:
- `bq_eval.jsonl` — compact OOS evidence base: 709 BQ-reconstructed 5m bars (Jul 5–7,
  59.2h continuous, 24/7 — no session-selection bias), first-2-min rows + settle.
- `compact-bq-eval.mjs` — regenerates it from `v6/analysis/bqbars/` (gitignored raws).
- Validation: `node v7s/analysis/validate.mjs AUTOPSY/logs v7/analysis/bq_eval.jsonl`
  (same for v7c). Gate: `node v7s/analysis/replay-compare.mjs AUTOPSY/logs`.

Honest caveats that travel with the numbers: a cascade day (2026-07-05) pulls v7s to ~72%
for that day; ~8% of bars are near-flat oracle coin-flips capping any predictor ~96%;
measured trading edge vs Polymarket prices ≈ 0 (the market is calibrated at 45–90s) — these
engines optimize DIRECTIONAL ACCURACY of the early call, not priced edge.
