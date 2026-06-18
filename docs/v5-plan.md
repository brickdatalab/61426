# V5 — Official Plan

**Foundation:** V5 = the `v5/` copy of v3, edited freely. **v3 frozen** (sha-verified each milestone). V4 dead. Data sources **unchanged** this build (Binance fstream WS diff-book + `@trade` CVD; Polymarket REST) — we change *logic + display*, not feeds. `ourWebSocket` 6-metric integration is a later phase; the ✦ since-open metric below is computed locally from the existing stream (same formula as `ourWebSocket`'s `tape.cvd_candle_usd`).

## Phase 1 — Logic & numbers (TDD; no UI)
- **P1.1 Rolling buffers**: CVD history ≥60s, price history ≥15s, imb history with per-sample `rem`.
- **P1.2 ✦ CVD-since-bar-open** (`cvd_candle_usd` equivalent): running accumulator of each trade's signed USD from bar open; reset on new bar; seeded on mid-bar connect via one `aggTrades` pull from `bar_start`.
- **P1.3 Deltas**: `cvd_d5/d10/d60` = `CVD30s(t) − CVD30s(t−window)`; `cush_d10` = `cushion(t) − cushion(t−10s)`.
- **P1.4 Forward CVD flow-momentum**: adaptive 5s slope z-scored vs recent slope volatility → **continuation** conviction (steep **and** price-aligned). Refuted signals excluded (no rollover→reversal, no simple divergence as primary). Regime-adaptive, honest confidence.
- **P1.5 Fold CVD into the call**: tie-break (books MIXED) / confirm (aligned) / conflict (flow vs book → stand down).
- **P1.6 TDD**: replay `testdata/v3-logs/`; assert deltas + momentum-fires-on-validated-pattern + signal integration. ✦ synthetic unit tests + trend-compare vs CSV `tape_cvd_candle_usd` (spot vs perp caveat).

Pure logic lives in `v5/src/signals.mjs` (browser-importable ES module, no Node APIs); tests in `v5/test/signals.test.mjs` (node:test + fixtures).

## Phase 2 — Display restructure
- **Cards row**: `[Cushion + Δ10s] [✦ CVD since open] [CVD Δ5s] [CVD Δ10s] [CVD Δ60s] [Signal]`.
- **Remaining → top-right** header.
- **BTCmid + Polyprob → subtle actionable read**: slim live sub-header (`BTC $65,316 · Poly 0.62`).
- **Replace the depth graph** with a **CVD graph**: main line `CVD30s` + overlaid `Δ5/10/60s` + rate line; ✦ optional secondary = CVD-since-open. Fluid/eased. (Book-stats calc stays internal; only the ladder render is removed.)
- **Imbalance graph hover tooltip** = elapsed time into the bar (`2m 14s in`, 24h).
- **Flowing pressure bar** replaces the snapping PRIMED label (continuous eased left(DOWN)↔right(UP); discrete call as secondary smoothed tag).
- **Table**: untouched (Signal column reflects new logic).

## Phase 3 — Threads & logging
- **Sidebar**: delete the explanatory text; keep `Feeds · WS live` dots; separator beneath.
- **Chat-history thread list**: one thread per market session (auto-created on start, even mid-run). Title = `BTC · 5m · HH:MM ET` (24h, Eastern, from slug Unix ts).
- **Click thread → basic progression view** (price vs prediction + end result).
- **VM log endpoint (build now)**: standalone log-receiver on the VM (`v5/logd/`, **not** touching `ourWebSocket`) — `POST /log` writes `<slug>.json` to `v5/logs/`; systemd + firewall. V5 POSTs each run with extended schema (existing rows + `cvd_d5/d10/d60`, `cush_d10`, ✦ `cvd_since_open`, momentum, conviction, final `{settled,open,close}`). ⚠️ Needs TLS once on Vercel (HTTPS→VM POST is mixed content).

## Cross-cutting
- **Accuracy**: every number/signal TDD-validated; honest confidence, no over-tuning.
- **Never-break**: v3 untouched (sha-verified each milestone).
- **`ourWebSocket`** out of scope this build — ✦ proves we replicate its key bar-level metric locally without consuming it.

## Execution order
Phase 1 (logic/TDD, incl. ✦) → Phase 2 (display) → Phase 3 (threads + log endpoint). Checkpoint after each.
