# V5 — Official Plan + Changelog

> ## STATUS (as of 2026-06-27) — PRODUCTION on `main`
> **V5 is the working dashboard. VM is the single Binance data source.**
>
> **Architecture:** Browser → `ws://34.89.159.108:8802` (VM ourWebSocket: CVD, price, bar_open, imbalance, efficiency, large_prints, perp-spot divergence) + Polymarket REST. No direct Binance from the browser.
>
> **4 Lightweight Charts** (locked view, no scroll/zoom, white zero baseline):
> 1. CVD 1m — net flow (purple)
> 2. CVD 10s — delta flow (yellow)
> 3. Bar flow — CVD since open (green)
> 4. **Dropdown swap chart** — Binance imb vs Poly imb (default) / CVD 5s delta / CVD 60s delta / Cushion
>
> **Cards:** Cushion(+Δ10s) · CVD since open · CVD Δ5/10/60s · Signal
> **Pressure bar:** flowing (eased), driven by book imbalance + CVD momentum
> **Threads:** session-history sidebar + click-to-view progression modal
> **Continuous runs:** auto-advance N markets on settle
> **Settle accuracy:** spot klines (`api.binance.com`, CORS-open)
>
> **VM changes deployed:**
> - `compute.py`: added `price`, `bar_open`, `binance_imb` to the payload
> - `feeds.py`: added `DepthTape` + `DepthFeed` (Binance spot `@depth20@100ms`, imbalance formula)
> - `server.py`: wired DepthFeed + heartbeat 30s→90s
> - Firewall `allow-ourwebsocket-8802` created (permanent)
>
> **Run V5:** `cd /Users/vitolo/Desktop/61426 && python3 -m http.server 5173 & sleep 1 && open "http://localhost:5173/v5/updown-liquidity-overlap.html"`
> **v3 frozen** (sha `5978…d849`). V4 dead.

---

## Changelog (reverse chronological)

### 2026-06-27 — `697a4fa` on `main` (merged from `ws-reliability`)
- **WS reliability fix:** watchdog (every 3s, reconnect if stale >5s), 500ms fixed reconnect (was exponential 1-8s), `visibilitychange` handler (reconnect on tab focus), `owsReconnecting` flag (prevents double-reconnect). VM heartbeat 30s→90s.
- **Chart swap flicker fix:** removed `applyOptions()` from swap — `swapImbChart()` now only calls `setData()` on existing lines. No destroy/recreate, no option changes, no flicker.
- **Chart swap feature:** dropdown on 4th chart to switch between Binance imb vs Poly imb / CVD 5s delta / CVD 60s delta / Cushion. Full history loads on swap (mid-market, all data from bar start).

### 2026-06-27 — `d57f97b` on `main` (merged from `chart-swap`)
- **Chart swap (initial):** dropdown replacing the 4th chart heading. `destroyChart()` + `ensureChart()` approach (later replaced by `swapImbChart()` data-only approach).

### 2026-06-27 — `4ff7fca` on `main` (merged from `continuous-runs`)
- **Continuous runs:** auto-advance N markets on settle. Module-level `runsLeft` counter (set on user click, decremented per settle). 2.5s pause to read SETTLED banner.
- **Settle accuracy fix:** `fapi.binance.com` (perp, CORS-blocked) → `api.binance.com` (spot, CORS-open). SETTLED UP/DOWN now uses authoritative spot open+close.

### 2026-06-27 — `225c8ec` on `main` (merged from `vm-single-connector`)
- **VM single-connector:** ALL Binance data from the VM. Dashboard `tick()` reads `bimb=st.owsImb`, `bmid=st.last`. Removed the entire fstream book computation (bookStale check, REST depth fallback, diff-stream book, bookStats). Killed per-tick CORS spam.
- **VM deploy:** `compute.py` + `feeds.py` (DepthFeed) + `server.py` (heartbeat wiring) updated on the VM.
- **White zero baseline:** `#3a4150` → `#ffffff` on all 4 charts.

### 2026-06-27 — `9561845` on `main` (merged from `charts-v2`)
- **ourWebSocket CVD wiring:** CVD source swapped from browser-computed perp 30s → VM spot 1m. `openOWS()`/`closeOWS()` added. Removed CORS-blocked aggTrades watchdog. `@trade` fstream kept for price only.
- **4-chart redesign:** 2×2 grid, Lightweight Charts (CVD 1m, CVD 10s delta, bar flow since open, Binance imb vs Poly imb). Locked view (`handleScroll/handleScale` disabled). Full bar timeline (`setVisibleRange`). TradingView logo hidden via CSS. Integer y-axis on CVD charts.

### 2026-06-18 — Phases 1–3 (`fcd6c4a`, `82a12f3`, `be0145a`)
- **Phase 1:** Pure signal logic (`v5/src/signals.mjs`) + TDD (`v5/test/signals.test.mjs`, 13/13). `cvdSinceOpen`, deltas, flow-momentum, `decide()`.
- **Phase 2:** Display restructure — flowing pressure bar, CVD graph, restructured cards, remaining→top-right, subtle price/prob, trimmed sidebar.
- **Phase 3:** Session threads + VM log endpoint (`v5/logd/`, port 8803, systemd).

---

## Honest assessment (unchanged)
- CVD-since-open and Cushion: **10/10** accuracy.
- CVD 1m net flow: **9/10**.
- Binance imb: **3/10** (proven 1s noise).
- CVD as a flip predictor: **weak** (validated across 18 fixtures). V5 is a lens, not an actionable edge, until new metrics are validated (Phase 4, pending).
- The dashboard's UP/DOWN signal matched outcome only ~29% historically; CVD sign ~65%.
