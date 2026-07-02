# 61426 — Project Context (for V5)

BTC/ETH **Polymarket up/down** live dashboards + the signal logic behind them.
This file is the current-state brief for anyone (human or agent) picking up the project,
especially for **V5** work.

## Versions (single-file HTML dashboards, no build; each in its own subdir)
- **v1** `v1/updown-playground.html` — cushion dashboard. Untouched lineage.
- **v2** `v2/updown-playground-CVDprob.html` — CVD→P(up). Untouched lineage.
- **v3** `v3/updown-liquidity-overlap.html` — **the current working dashboard.** Binance perp
  order-book imbalance + Polymarket book, overlaid; PRIMED UP/DOWN signal. **Committed & live.**
- **v4** (multi-venue blend experiment) + its `engine/` — **DEAD / debt, removed from the tree**
  (retained in git history). Do not resurrect.

### How v3 gets its data (and why)
v3 reads **Binance perp** over **one WebSocket** (`@depth@100ms` diff-stream maintained as a
full local book via snapshot+diffs, + `@trade` for CVD), with **REST fallbacks** that fire only
when Binance mutes a WS stream (intermittent from some IPs). Polymarket book is REST 1s.
**Why WS, not REST:** the original v3 polled Binance REST 3×/sec → triggered a `-1003` IP ban
(HTTP 418) that also killed the running dashboard. One persistent WS socket = near-zero request
weight = no ban. The CVD is the **true 30s** net signed flow (the old REST `aggTrades?limit=1000`
silently truncated the window to ~22s under heavy volume).

### Hard rule (do not violate)
**A new version must never affect a previous working version.** v1/v2/v3 are never edited by v4/v5
work. New work = new file.

## V5 — the actual goal
**Forward-looking flip detection** on Polymarket BTC/ETH up-down bars: signal that a bar is about
to flip (e.g., "90% UP with 2 min left → will flip DOWN") *before* it happens.

### Current state (as of 2026-07-02) — PRODUCTION
V5 is the working dashboard on `main`. The VM (`ourWebSocket` on port **80**) is the
single Binance data source — CVD, price, bar_open, order-book imbalance, efficiency,
large prints, perp-spot divergence all delivered via one WebSocket. No direct browser →
Binance connection. 4 locked Lightweight Charts (2×2 grid), dropdown swap on the 4th,
flowing pressure bar, continuous runs, session threads, accurate settle (spot klines).
VM changes deployed (`compute.py`/`feeds.py`/`server.py` with DepthFeed + heartbeat 90s).
GCP tag `http-server` added to the VM (`default-allow-http` rule, permanent). **Run V5:** `python3 -m http.server 5173`
→ `http://localhost:5173/v5/updown-liquidity-overlap.html`

### Data source: `ourWebSocket` (runs on this VM)
- URL: `ws://34.89.159.108/ws/v5/tape?symbol=BTCUSDT&bar=5m` (also `ETHUSDT`, `bar=15m`).
  No auth, no rate limit, on-change ~10/sec.
- Single source of truth: `/home/vincent/ourWebSocket/CONNECT.md`.
- Emits **6 metrics** (sign: `+` = net aggressive buy):
  - `tape.cvd_candle_usd` — net spot CVD since bar open.
  - `tape.cvd_delta_1m` / `tape.cvd_delta_3m` — net spot CVD over 1m / 3m.
  - `tape.large_print_net_3m_usd` — net signed USD of spot prints **≥$100k** over 3m (**whale flow**).
  - `tape.efficiency_3m` — |Δprice 3m| / |net BTC 3m| (**absorption efficiency**).
  - `perp_spot_divergence.perp_cvd_minus_spot_cvd_5m_usd` — perp CVD Δ5m − spot CVD Δ5m.
- Scope (decided): **single-venue Binance**, spot-CVD primary + the perp/spot divergence field.
- **CORS:** open (`Access-Control-Allow-Origin: *` on `/log`).

### What the validation already proved (do NOT re-litigate, but don't over-trust either)
Backtested across 18 captured bars (`testdata/v3-logs/`):
- **CVD-30s alone is a WEAK predictor** of 5m flips. Per-tick slope and simple CVD/price
  divergence did **not** generalize (the divergence that looked perfect on the flip bar was
  followed by *up* moves on average across the rest). Late-bar CVD *sign* matched outcome ~65%.
- The order-book **imbalance is noise** at 1s cadence (whipsaws ±0.9 constantly).
- **Promising (unvalidated) signals** that directly target flips: `large_print_net_3m_usd`
  (institutional distribution into a rally), `efficiency_3m` (exhaustion/absorption), and
  `perp_cvd_minus_spot_cvd_5m_usd` (perp leads spot). These are why V5 uses ourWebSocket, not v3's CVD.

### How V5 must be built (discipline)
- **TDD**, fixtures = `testdata/v3-logs/` (18 bars; canonical flip case =
  `btc-updown-5m-1781724300` — was +$205 / ~90% UP with 2 min left, settled DOWN −$165).
  Write the test (replay a fixture, assert whether the signal fires + when) before the code.
- **Do not over-gate / over-fit.** n=18 is a small, noisy sample. Use regime-adaptive measures
  (z-scores, relative slopes), report honest confidence, and treat edge as directional until
  confirmed by the new data — not a tuned oracle.
- Keep it **forward-looking**: the value is lead time on a flip, not confirming a move that already happened.

## Where things live
- **Local repo** (source of truth, git @ `brickdatalab/61426`): `/Users/vitolo/Desktop/61426/`
- **VM (`pm`, project `lithe-hallway-493420-r4`)**: `/home/vincent/projects/61426/` — **partial mirror** (v3 baseline copy, `testdata/`, `CONTEXT.md`, CSVs, and `v5/logd/`). The V5 dashboard/src/tests are **not** mirrored — V5 runs locally; the VM hosts `ourWebSocket` (port **80**, with `/log` endpoint for session logging).
- **ourWebSocket service**: `/home/vincent/ourWebSocket/` (systemd `ourwebsocket`, port **80**, `AmbientCapabilities=CAP_NET_BIND_SERVICE`)
- **V5 log receiver**: handled by ourWebSocket's `POST /log` route (port 80). The old standalone `v5logd` (port 8803) is retired — same atomic-write logic now runs inside ourWebSocket.
- **Older history/detail**: `issues.md` (V3 handoff). The removed `v4.md` and `engine/` live in git history only.

## Run (local)
- **V5:** `python3 -m http.server 5173` → `http://localhost:5173/v5/updown-liquidity-overlap.html`
- **V3:** `http://localhost:5173/v3/updown-liquidity-overlap.html` (v3 frozen, sha `5978…d849`)
- HTTP is required (V5 loads `signals.mjs` as a module). One dashboard per port.
