# Engine Logic

## Source of truth

The current source of truth is `v8/src/signals.mjs`. It is a pure ES module: no DOM, network, or runtime feed access. That makes the same logic importable by a browser dashboard, Node tests, the VM runner, and replay scripts.

## Per-bar state

`newSession()` creates short histories for since-open CVD and price, EWMA moments for flow and price movement, legacy imbalance state, the v8 signal state, conviction reversal counters, flip alert state, and early-call latch state (`v8/src/signals.mjs:81-92`). Histories are pruned to 65 seconds, slightly longer than the largest 60-second derivative window.

## Canonical tick sequence

`tick()` is the only normal evaluation path (`v8/src/signals.mjs:319-350`):

1. Rejects the tick until both `sinceOpen` and `price` exist.
2. Records the current CVD accumulator and price.
3. Computes exact 5s, 10s, and 60s flow deltas plus a 10s cushion delta.
4. Computes momentum from 5s flow and 6s price movement.
5. Runs the legacy debounced book/flow decision.
6. Runs the v8 cushion-lead decision.
7. Grades directional v8 output with conviction metadata.
8. Runs the early-call latch and flip-risk display channel.
9. Returns the combined output object.

The returned `decision.sig` is v8. The old stream is preserved separately as `decision.legacySig` for pressure-bar/state parity and comparison.

## Current emitted stream: `decideV8`

At `v8/src/signals.mjs:200-208`:

```text
floor = max($10, 0.5 × vol_1m)
if cushion is missing: carry the previous v8 tag
if |cushion| >= floor: UP when cushion > 0, otherwise DOWN
else: MIXED
```

The rule is intentionally stateless apart from carrying the last tag across a null-cushion tick. It does not use book imbalance, whale flow, momentum, Polymarket price, or hysteresis to gate the emitted signal. Those features were tested offline and retained only in other channels.

If live `vol_1m` is absent, `volFromHist()` falls back to realized 1-second price-difference standard deviation times `sqrt(60)`, with a conservative `$30` default for short history (`v8/src/signals.mjs:244-251`).

## Conviction metadata

`convictionOf()` runs after the v8 tag and returns `null` for MIXED. For directional ticks it awards up to five points:

- cushion ratio at least 1.5× the floor;
- cushion ratio at least 2.5× the floor;
- flip probability at or below 0.5;
- Polymarket probability agrees by at least 0.02;
- no directional reversals yet in the bar.

Five points is tier 3, zero or one is tier 1, otherwise tier 2 (`v8/src/signals.mjs:214-233`). This is display/logging only and cannot change the emitted side.

## Legacy stream

`decideDebounced()` combines Binance and Polymarket imbalance, smooths it with an EWMA, applies entry/exit hysteresis and seven-tick dwell, then applies v5.3/v5.4 rules:

- lower aligned entry threshold when the book agrees with cushion;
- BAFO override when a large cushion is opposed by book but supported by 60s flow and 3m CVD;
- momentum can lead, confirm, or conflict with the book;
- counter-cushion entries require momentum or large-print support;
- counter-cushion holds decay after 15 uncorroborated ticks.

The exact implementation is `v8/src/signals.mjs:133-193`. This stream remains operationally important for display and parity but is no longer the primary `decision.sig`.

## Early-call channel

`earlyCallOf()` is independent of the per-tick stream and latches at most one call per bar (`v8/src/signals.mjs:261-289`):

- ignores the first 45 seconds (`remS > 255`);
- operates only from 45 to 90 seconds in (`remS` 255 through 210);
- requires sane `polyMid`, favorite probability in `[0.82, 0.93]`, and cushion agreement;
- requires three consecutive qualifying ticks;
- becomes a permanent abstention after the 90-second deadline if it has not fired;
- remains immutable after firing.

This channel is inherited from `v7s`, not derived from `decideV8`.

## Flip-risk display channel

`flipRisk()` estimates a baseline driftless-walk probability from cushion, expected move, and remaining time, then adjusts it with normalized opposing 60s flow, large prints, perp/spot divergence, and an absorption boost when efficiency is low (`v8/src/signals.mjs:291-317`). It produces an explanatory risk/readout and alert state; it does not gate the v8 signal.

