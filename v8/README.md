# v8 — calibrated cushion-lead per-tick stream + inherited v7s early call

The v8 per-tick signal (`decideV8`) replaces the v6/v7s lean stream's emitted tag:

> **sig = sign(cushion) when |cushion| ≥ max($10, 0.5·vol_1m), else MIXED.**

One sentence, zero corroborators — because every candidate corroborator was auditioned
offline and measured to add ≈ nothing beyond price location. Full record:
`v8/analysis/2026-07-08-frontier.md` (walk-forward, 823 24/7 bars, 48,557 ticks, 40
features across taker-split aggression, side-split whale flow, perp-spot basis, book
bid/ask pull rates, poly dynamics, VWAP, trajectory transforms; permutation importance:
`cush_norm` 0.380, next best 0.022). Hysteresis/dwell variants measured WORSE
out-of-sample (`50_distill.py`) — the static rule ships.

Gate (2026-07-08, `node v8/analysis/replay-compare.mjs v6/analysis/bqbars AUTOPSY/logs`,
1,008 pooled bars = 832 BQ 24/7 + 176 live): **GATE PASS 5/5** —
value dominance vs v6 (−5.30 vs −33.57 value/bar), accuracy **82.5% vs 73.1%**, wrong-rate
12.6% vs 16.0%, **missed fire-worthy ticks 0.00% vs 20.9%**, LOBO passes every day, and the
early-call channel is a **0-mismatch tie with v7s across all 1,008 bars** (inherited
byte-identical; `EARLY CALL` badge numbers unchanged: 85.8% @ 23.4% pooled).

What changed for the operator:
- The big UP/DOWN/MIXED tag now answers one question: *has price actually led, beyond
  noise?* The 30 documented pain bars (|cushion| ≥ $150 + ≥ $1M same-side CVD, old stream
  MIXED) are all called on the evidence side — two are permanent test fixtures.
- No more first-call folklore: there is no ~60% book-echo opening call; the first call
  exists only once a vol-scaled lead exists (measured by minute: 67% → 73% → 79% → 86% → 92%).
- The legacy stream still runs inside the engine (pressure bar `imbEwma`, flip readout,
  and `decision.legacySig` for comparison) — display plumbing unchanged.
- No VM/compute.py change needed: the rule consumes only fields already on the tape.

Run: serve repo root (`python3 -m http.server 5173` or the standing :7724 server) →
`/v8/updown-liquidity-overlap.html`. Logs settle as `<slug>_v8.json` into the same
autopsy pipeline. Tests: `node --test v8/test/signals.test.mjs` (15). Engine is
plug-and-play: same exports as v7s/v6; the runner loads it by version path unchanged.

Honest limits (unchanged physics, see frontier report): the market is calibrated at
45–90s — early unpriced certainty is not available from public data; ~8% of bars are
near-flat oracle coin-flips. v8's win is *never missing the developing move and never
echoing noise*, not beating the market's price.
