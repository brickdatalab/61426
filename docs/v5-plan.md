# V5 — Official Plan

> ## STATUS (as of 2026-06-18)
> **Built & live — Phases 1–3, on V3 data** (commits `fcd6c4a`, `82a12f3`, `be0145a`):
> - **Logic** (`v5/src/signals.mjs`, pure/browser-importable) + **TDD** (`v5/test/signals.test.mjs`, 13/13 green): `cvdSinceOpen`, `cvd_d5/d10/d60`, `cush_d10`, flow-momentum (adaptive 5s z-slope, continuation-only), `decide()` (tie-break/confirm/conflict).
> - **Display**: flowing pressure bar (replaces snapping PRIMED), CVD graph (main CVD30s + Δ5/10/60s + rate), cards row (Cushion+Δ10s · CVD-since-open · Δ5/10/60s · Signal), Remaining→top-right, subtle BTC/Poly readout, imbalance-graph hover (elapsed time), trimmed sidebar.
> - **Threads/logging**: session-history sidebar (one thread per market, ET titles) + click-to-view progression modal; extended log schema (`cvd_since_open`, deltas, momentum).
> - **VM log endpoint** `v5/logd/` (standalone aiohttp, port 8803, systemd `v5logd`) — built & running on `pm`; **firewalled externally** (needs `gcloud compute firewall-rules create v5-logd-ingress --allow tcp:8803 --source-ranges 0.0.0.0/0 --network default --project lithe-hallway-493420-r4`). localStorage logging works regardless.
>
> **NOT done (the actual V5 goal — pending):**
> - ❌ **Phase 4** — validate the 6 `ourWebSocket` metrics against CSV outcomes (`5m.csv`/`15mTOOL_rows.csv` have all 6 + `outcome`): truth gate before wiring.
> - ❌ **Phase 5** — wire `ourWebSocket` (decision: **hybrid** — keep V3 Binance + add the 6 metrics).
> - ❌ **Phase 6/7** — TLS/Vercel deploy (decision: **local-first**; `ws://` from `http://localhost` works, no mixed content).
>
> **Decisions locked:** hybrid data (keep V3 Binance + add ourWebSocket) · validate-first · local-first.
>
> **Honest state:** the *understand-what's-happening* layer (lean/pressure/CVD-flow/threads) works; the signal driving it is the **weak V3 CVD** (validated non-edge). It's a lens, not an actionable edge, until Phase 4→5.
>
> **Run V5:** `cd /Users/vitolo/Desktop/61426 && python3 -m http.server 5173 & sleep 1 && open "http://localhost:5173/v5/updown-liquidity-overlap.html"`  · **Run V3:** same but `/v3/…`  · v3 frozen (sha `5978…d849`).

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
