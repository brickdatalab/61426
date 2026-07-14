# Live Relay, Runner, and Persistence

## Market-data service

The Python `ourWebSocket` service in the versioned `v5.x/ourWebSocket/` directories is an aiohttp service. It starts BTCUSDT and ETHUSDT hubs, each with spot, perpetual, and depth feeds. Spot is Binance WebSocket aggTrade; perpetual data is continuously paged from Binance REST; startup backfills seed recent history. The service broadcasts snapshots on change, with a 0.1-second polling cadence and no consumer authentication (`v5.4/ourWebSocket/server.py:1-7`, `:219-229`).

The main consumer route is:

```text
GET /ws/v5/tape?symbol=BTCUSDT|ETHUSDT&bar=5m|15m
```

The snapshot contains tape fields such as `cvd_candle_usd`, `price`, `bar_open`, Binance imbalance, 1m/3m CVD deltas, large-print net, efficiency, volume, and perp/spot divergence. Depth data contributes Binance order-book imbalance. The service also exposes `/health` and legacy log endpoints (`v5.4/ourWebSocket/server.py:87-125`, `:160-187`).

## Runner feed adapters

`runner/feeds/ows.mjs` connects to the tape WebSocket, parses snapshots, tracks latest data and age, and reconnects with capped backoff. `runner/feeds/poly.mjs` resolves the market token through Gamma, polls the CLOB book, computes Polymarket midpoint and imbalance, and also reconnects/backoffs on failures. These are intentionally independent feeds so the session can distinguish tape staleness from book staleness.

## Input assembly

`runner/engine-adapter.mjs:16-33` is the critical relay seam. It maps feed names into the engine’s exact input contract:

```text
tape.cvd_candle_usd                       → sinceOpen
tape.price                                → price
tape.binance_imb                          → bimb
book.pimb                                 → pimb
tape.large_print_net_3m_usd               → largePrints
tape.efficiency_3m                       → efficiency
tape.perp_cvd_minus_spot_cvd_5m_usd       → perpSpotDiv
tape.cvd_delta_3m                         → cvd3m
price - barOpen                           → cushion
tape.vol_1m_usd                           → vol1m
book.poly_mid                             → polyMid
```

`polyMid` is additive for v7/v8 early-call and conviction logic; older engines ignore it.

## Session lifecycle

`runner/session.mjs` owns one `{version, slug}` run. Every live second it reads the latest OWS and Polymarket values, captures `bar_open` once, builds the input, invokes `mod.tick()`, writes a state row, and atomically persists the complete in-bar state (`runner/session.mjs:181-216`, `:218-249`).

The state file includes the engine Git hash. On restart, the runner loads the same version and refuses to resume if the hash differs unless explicitly overridden (`runner/session.mjs:139-178`). It reconstructs state by replaying the persisted rows using each row’s original `now_ms`, preserving warmup, momentum, dwell, and latch behavior.

At bar end it uses the raw last price for settlement, writes `<slug>_<version>.json` idempotently, and can advance a continuous run to the next slug with a fresh engine session (`runner/session.mjs:251-297`).

## Orchestration and control API

`runner/orchestrator.mjs` manages multiple sessions, persists an atomic active manifest, resumes active sessions on boot, routes A/B logs to a separate directory, and exposes run/list/rows/log operations (`runner/orchestrator.mjs:25-119`).

`runner/control-api.mjs` is a small authenticated Node HTTP API:

- `POST /runs`
- `DELETE /runs/:id`
- `GET /runs`
- `GET /runs/:id/rows?since=N`
- `GET /logs`
- `GET /logs/:name`

Every route requires `Authorization: Bearer <secret>`, with length-safe constant-time comparison (`runner/control-api.mjs:12-23`, `:25-50`).

