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
echoing noise*, not beating the market's price. Known designed failure mode: on genuine
flip bars, pre-flip directional ticks are wrong until the flip happens (v8 reports where
price leads *now* — it does not claim reversal prediction). First live read (2026-07-08,
4 bars): 90.9% of directional ticks on the settle side; the one weak bar was exactly this
flip class; early channel 2/2 fires correct + 2 correct abstentions.

## Implementation notes (what changed in the signal logic, exactly)

**Files:** `v8/src/signals.mjs` (engine), `v8/test/signals.test.mjs` (15 tests),
`v8/test/fixtures/*.json` (2 real pain bars), `v8/updown-liquidity-overlap.html`
(dashboard fork), `v8/analysis/replay-compare.mjs` (gate), `v8/analysis/` (the full
research pipeline that produced the rule).

**New CFG values (the only tuned numbers in v8, both measured not chosen):**
- `V8_FLOOR_ABS: 10` — $ absolute floor. Same floor family the early-call and BAFO
  channels already use (`max($10, 0.5·vol_1m)` is the project's standing vol floor).
- `V8_FLOOR_VOLMULT: 0.5` — vol multiple. Together: `floor = max(10, 0.5 * vol_1m)`.
  Basis: this exact static pair was the walk-forward winner; the swept alternatives
  (enter 1.0/1.1/1.25 × exit 0.7/0.8/0.9 × dwell 1/2/3 hysteresis grid, `50_distill.py`)
  all scored WORSE on held-out days. No other constant was added or altered.

**New function `decideV8(s, inp)`** — the emitted per-tick stream:
- Consumes only `inp.cushion` and `inp.vol1m` (falls back to `volFromHist(s.priceHist)`
  when the tape's vol field is absent — same fallback `flipRisk` already used).
- Returns `{ sig, floor, note }`; `note` is `'cushion-lead'` on directional calls.
- Stateless by design (the static rule beat hysteresis OOS); the single state field
  added to `newSession()` is `sig8`, used ONLY to carry the last tag through a
  null-cushion tick — it never fabricates a call.

**Changed `tick()` return contract (additive):** `decision` is now
`{ sig, imbEwma, note, floor, legacySig }` where `sig` = decideV8's call and
`legacySig` = the old v6/v7s lean tag. The legacy pipeline (`decideDebounced` +
`momentumOf` + `flipRisk`, byte-identical to v6/v5.4) still executes every tick — it
feeds the pressure bar (`imbEwma`), the flip readout, and the HIGH-CONVICTION card, and
keeps engine state identical to predecessors. Displays reading `decision.sig` get v8;
everything else is untouched plumbing.

**Explicitly NOT changed:** `earlyCallOf` (byte-identical to v7s — gate-proven, 0 latch
mismatches over 1,008 bars), all early-call CFG values, `decideDebounced` and every
v5.3/v5.4 rule inside it (aligned-enter, counter-confirmation, hold-release, BAFO),
`momentumOf`, `flipRisk`, `newSession` shape (one additive field), all exports (the
engine stays drop-in for the dashboard and `runner/engine-adapter.mjs`). The dashboard
fork changed only version identity (title/badge/log suffix `_v8`/localStorage keys) —
the Web Worker ticker and all display mechanics are inherited from v7s.

**Why the corroborators were removed from the emitted tag:** every candidate input
(book EWMA, whale prints, flow deltas, momentum, poly, VWAP, basis, book pulls) was
auditioned offline against the settle on 823 24/7 bars and added ≈ nothing beyond price
location (`2026-07-08-frontier.md` §1). The old stream's corroboration logic is what
produced the two documented failures — 20.9% missed fire-worthy ticks (MIXED while
evidence screamed) and the ~60% book-echo first call. v8 removes the failure by removing
the unearned inputs from the *emitted* call while keeping them visible elsewhere on the
page (pressure bar, flip risk), where they carry display value without gating the tag.
