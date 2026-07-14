# V8 Project Summary

This project is a live decision dashboard for BTC and ETH Polymarket UP/DOWN markets. It is used primarily on 5-minute markets, with 15-minute markets supported. During a market, it continuously emits an `UP`, `DOWN`, or `MIXED` read based on live price position and supporting market context; it does not place trades.

## Data flow

The live tape is collected on the VM from Binance spot trades, Binance perpetual-trade data, and Binance order-book depth. `feeds.py` maintains those feeds and their rolling histories. `compute.py` turns them into a snapshot containing current price, bar open, cumulative-volume-delta (CVD) measures, realized one-minute volatility, Binance book imbalance, large-print flow, efficiency, and perpetual-versus-spot CVD divergence. `server.py` streams those snapshots to the browser over WebSocket and accepts completed session logs. `config.py` contains the service configuration.

The browser separately reads the Polymarket CLOB order book to calculate the Polymarket midpoint and order-book imbalance.

## Dashboard and signal engine

`updown-liquidity-overlap-demo.html` is the operator dashboard. It receives the VM tape, reads the Polymarket book, updates once per second, and renders:

- the current `UP` / `DOWN` / `MIXED` signal;
- price cushion, CVD and flow, volatility, Binance and Polymarket imbalance, and Polymarket midpoint;
- flip-risk, early-call, and conviction context;
- live charts, the current bar countdown, session history, and the final settled direction.

`signals.mjs` is the pure V8 signal engine. Its emitted per-tick signal uses the current price cushion:

```text
cushion = price - bar_open

UP or DOWN when |cushion| >= max($10, 0.5 × one-minute realized volatility)
MIXED otherwise
```

The sign of cushion determines `UP` versus `DOWN`. The additional tape and Polymarket fields remain visible on the dashboard and support its contextual displays, but the emitted V8 per-tick direction is this volatility-gated cushion rule.

## Session logs

Each dashboard run builds a session log in browser storage as it runs. It appends one tick row per update, then appends a settlement row when the market closes and posts the completed log to the VM.

Each log is JSON with this shape:

```text
{
  "slug": "market identifier",
  "rows": [
    "tick rows...",
    "final settlement row"
  ]
}
```

Tick rows include the timestamp and seconds remaining; signal and cushion; price/CVD/flow/volatility fields from the VM; Binance and Polymarket book fields; flip-risk and conviction context; and early-call context. The final row contains `settled`, `open`, and `close`. Processed logs also include `signal_up_sum`, `signal_down_sum`, and `signal_mixed_sum` on that final row.

## Add log examples here

<!-- Add representative V8 log examples and your vector-store note here. -->

## Analysis

The analysis we’ve done so far is that walk-forward testing and live evaluation identify the simple volatility-gated cushion rule as the strongest shipped per-tick signal. Its directional accuracy improves as settlement approaches. Its main remaining failure case is a genuine reversal after price has already led in the opposite direction; V8 reports the current developing lead and does not claim to predict that reversal.

For the evidence, methodology, and detailed results, read `2026-07-08-frontier.md` and `2026-07-08-live-audit.md`.

## Files to provide with this summary

- `UPDATED_PROJECT_SUMMARY.md`
- `updown-liquidity-overlap-demo.html`
- `signals.mjs`
- `server.py`
- `feeds.py`
- `compute.py`
- `config.py`
- `2026-07-08-frontier.md`
- `2026-07-08-live-audit.md`
- representative V8 session-log JSON files
