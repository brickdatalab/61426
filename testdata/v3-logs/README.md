# V3 run logs — V5 TDD fixtures

One JSON file per Polymarket BTC "up-down" bar session captured live from the V3
dashboard. These are the **empirical fixtures for V5's test-driven signal logic**:
each bar is a replayable tick sequence we can run candidate signals against.

## Schema

```jsonc
{
  "slug": "btc-updown-5m-<epoch>",     // bar id; asset + interval + bar-start epoch
  "rows": [
    // one entry per ~1-second tick while the bar was live:
    { "t": "HH:MM:SS", "rem": 240,            // clock + seconds remaining
      "btc_imb": 0.53, "poly_imb": -0.07,     // Binance perp / Polymarket book imbalance, [-1,1]
      "comb": 0.23,                            // average of the two imbalances
      "cushion": -165.0,                       // BTC price − bar open, USD  (+ = above open / UP)
      "cvd": -106786,                          // 30s Cumulative Volume Delta, USD signed (+ = net buy)
      "signal": "DOWN" },                      // dashboard call: UP / DOWN / MIXED (imbalance-driven)
    // ...
    { "t": "..", "settled": "DOWN", "open": 65419.3, "close": 65154.1 }  // real outcome (final row)
  ]
}
```

Field notes:
- `cushion` **is the live price direction** (signed distance from the bar open).
- `cvd` is the trailing 30s net signed aggressor flow. `signal` is computed from the
  **imbalances only** (both books > +0.12 → UP, both < −0.12 → DOWN, else MIXED);
  CVD is displayed, not used in the call.
- `settled` is ground truth: did BTC close above (`UP`) or below (`DOWN`) the open.

## Source / transport note
- The 16 logs originally in `logs/` plus `btc-updown-5m-1781723100` were captured by
  V3. Most use the **REST `aggTrades?limit=1000`** CVD (truncates the 30s window to
  ~22s under heavy volume). `1781723100` is the first **WebSocket `@trade`** CVD run
  (true 30s window, ~2× larger magnitudes — the accurate number).
- `1781724300` is the **canonical "90% UP → flipped DOWN" bar**: price was +$205
  with ~2 min left, then crashed to settle −$165.

## How V5 uses these (TDD)
Candidate forward-looking signals (CVD momentum/slope, CVD-vs-price divergence,
imbalance agreement, …) are written **test-first**: a test replays a fixture's tick
stream and asserts whether the signal should fire (and when). The flip bar
(`1781724300`) and the WS run (`1781723100`) are the primary regression cases.

## Honest caveat (do NOT over-fit)
This is a **small (n=18), noisy sample** of 5-minute bars. Validation across these
logs showed CVD and order-book imbalance are **weak** predictors of 5m BTC flips:
- Late-bar CVD *sign* matched the outcome ~65%.
- Per-tick CVD slope and simple CVD/price divergence did **not** generalize
  (the divergence that looked perfect on the flip bar was followed by *up* moves on
  average across the rest).

Treat these fixtures as **regression seeds and sanity checks**, not a tuning oracle.
Real predictive edge is expected to come from the additional data sources V5 adds.
