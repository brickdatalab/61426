# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read first

`CONTEXT.md` at the repo root is the current-state brief (architecture, data source, validation findings, VM layout). `docs/v5-plan.md` is the V5 plan + changelog. Read CONTEXT.md before making changes — it is kept current and overrides anything stale here.

## Hard rule — version isolation

**A new version must never affect a previous working version.** `v1/`, `v2/`, `v3/` are frozen lineage and are never edited by v4/v5 work. New work = new files. v4 is dead (removed from tree, git history only) — do not resurrect it.

## Version ladder (as of 2026-07-08)

`v8/` is the **current live version** (with `v7c/` still parked); each version is a full fork of its predecessor and predecessors are frozen:
- **v8** — current, live. v7s early-call channel byte-inherited (gate: 0 latch mismatches over 1,008 bars) + a **replaced per-tick stream** (`decideV8`): `sig = sign(cushion)` when `|cushion| ≥ max($10, 0.5·vol_1m)`, else MIXED — the walk-forward frontier winner (823 24/7 bars; 40 auditioned microstructure features added ≈nothing beyond price location; hysteresis variants measured worse OOS). Gate 5/5 on 1,008 pooled bars: acc **82.5% vs v6's 73.1%**, wrong 12.6% vs 16.0%, **missed fire-worthy 0.00% vs 20.9%**, LOBO all days, value dominance. Legacy stream still runs internally (pressure bar, `decision.legacySig`). Logs `<slug>_v8.json`. Full record: `v8/analysis/2026-07-08-frontier.md` + `v8/README.md`.
- **v7s** — frozen predecessor to v8. v6 lean stream byte-identical (tie-gate: 0 differing ticks in 74,305 over 253 bars, PASS) + a **selective** EARLY CALL replacing v6's always-call channel: one immutable latch per bar in the 45–90s window when `poly_mid ∈ [0.82, 0.93]` + cushion-agree + dwell 3, **abstains otherwise** (hard deadline 90s — measured edge dies after that). Pooled 990-bar record (281 live + 709 BQ 24/7): **85.8% @ 23.4% coverage, median fire 68s** (24/7-only 81.7%; live-hours 95.6% is selection-flattered — trust the 24/7 number). Dashboard has the background-proof Web Worker tick loop (long runs also need `caffeinate -dis`). New engine input `inp.polyMid` (plumbed additively; v6 and earlier ignore it). Logs `<slug>_v7s.json`. Full record: `v7/analysis/2026-07-07-v7-basis.md` + `v7/README.md`.
- **v7c** — v7s's conviction sibling, band [0.90, 0.96]: **91.5% @ 7.2% coverage, fire 72s** (pooled 990). **PARKED for UMA/automated-trading plans — do not deploy, wire, or modify.**
- **v6** — frozen predecessor to v7s/v7c. v5.4 lean stream byte-identical (replay gate: correct 34793→34793, 0 bars hurt, GATE PASS over the pooled 145 live + 135 BQ = 280-bar evidence base; candidates P2/P3 measured and rejected — dominance gate FAIL) + the tiered always-call EARLY CALL channel: one latched call per bar at the first tick with `rem<=210` (90s into a 5m bar). Tiers: strong (cushion-side ratio ≥3x vol floor) 96.2% live (n=26) / 75.0% BQ-OOS (n=20); qualified (2x≤ratio<3x) 84.6% live (n=13) / 76.5% BQ-OOS (n=17); lean (always-call fallback) 59.6% pooled (118/198); late-latch calls (session joined mid-bar) are tagged `late:true` and reported separately (n=6, live only, 83.3%). Coverage 280/280 (100%). Full record: `v6/analysis/2026-07-05-v6-basis.md`. Logs `<slug>_v6.json`.
- **v5.4** — frozen predecessor to v6. v5.3 + the BAFO rule (book-against flow override; gate-validated on 52 Polymarket-verified bars: +482 correct/−9 wrong/0 bars hurt) + conviction-lock magnitude gate. Logs `<slug>_v54.json`.
- **v5.3** — first tuned engine (aligned entry 0.14, counter-cushion confirmation, hold-release 15). Frozen. Logs `_v53`.
- **v5.1 / v5.2** — untuned baseline engine (v5.2 = v5.1 + hardening). Frozen. Logs `_v51`/`_v52`.
- Session logs live on the VM at `/home/vincent/projects/61426/v5/logs/`; `mirrors/` there holds `_v53m` **counterfactual replays** (never treat as live sessions). BQ-derived bars live in `v6/analysis/bqbars/` (`_bq.json`, reconstructions from the `bin` dataset on VM `pm` — never live sessions; same provenance rule as mirrors). Analysis reports: `v5.1/FINDINGS.md` (running findings home), `v5.1/analysis/`, `v5.4/analysis/2026-07-02-lhf-52bars.md`, `v6/analysis/2026-07-05-v6-basis.md` (incl. rejected candidates + v6.1 retest queue), `v7/analysis/2026-07-07-v7-basis.md` (latest — the OOS-collapse findings, v7s/v7c design, v8 research queue). The v7 OOS evidence base is `v7/analysis/bq_eval.jsonl` (709 BQ bars, 24/7).
- **Log hygiene (2026-07-08, NOT an engine change):** `AUTOPSY/logs/` is completeness-cleaned. After every pull run `python3 tools/log-clean/clean-logs.py --pull --execute` — it HARD-deletes (repo + origin + VM source, else the sync cron resurrects) logs with gap-runs >10s, early-ends (last rem >10), >30-tick late starts, or <80% span density; ≤30-tick late starts are kept. Scattered 1–2s holes never count. Rules/rationale/manifest: `tools/log-clean/` (first purge 2026-07-08: 64 files). Consequence for analysis: surviving live logs meet a uniform completeness floor — no per-script row filters needed.
- **Signal-logic changes are discussion-first**: analyze logs, present measured findings, get explicit approval, then ship as a NEW version fork with the dominance-gate pattern (`v6/analysis/replay-compare.mjs`).

## Commands

There is no build step, package.json, or linter. Dashboards are single-file HTML (no framework); signal logic is a pure ES module; the VM service is Python.

- **Run current dashboard:** `python3 -m http.server 5173` from the repo root, then open `http://localhost:5173/v8/updown-liquidity-overlap.html` (v7s at `/v7s/...`, v6 at `/v6/...`, etc.). HTTP is required (ES-module import — `file://` won't work). One dashboard per port. For long continuous runs also run `caffeinate -dis` (system sleep kills any browser-side run).
- **Run tests (current version):** `node --test v8/test/signals.test.mjs` (node:test, no deps; v7s: `node --test v7s/test/signals.test.mjs`; v6: `node --test v6/test/signals.test.mjs v6/test/replay.test.mjs`). Pass file paths — the directory form fails.
- **Acceptance gate (v8):** `node v8/analysis/replay-compare.mjs <bq-bars-dir> <live-logs-dir>` (value dominance + early-channel tie vs v7s + LOBO; binary GATE PASS/FAIL). Prior gates: `node v7s/analysis/replay-compare.mjs <live-logs-dir>`, `node v6/analysis/replay-compare.mjs <live-logs-dir> [bq-bars-dir]`. v7 validator: `node v7s/analysis/validate.mjs AUTOPSY/logs v7/analysis/bq_eval.jsonl`.
- **VM service tests:** `cd <version>/ourWebSocket && python3 -m unittest test_compute test_server -v`.

## Architecture

BTC/ETH Polymarket up/down live dashboards + the signal logic behind them. V5 (the production dashboard) does **forward-looking flip detection**: signal that a bar about to settle one way will flip, before it happens.

Data flow (V5): Browser → `ws://34.89.159.108/ws/v5/tape?symbol=BTCUSDT&bar=5m` (the VM's `ourWebSocket` service on port 80) + Polymarket REST. The VM is the **single Binance data source** — CVD, price, bar_open, order-book imbalance, efficiency, large prints, perp-spot divergence all arrive on that one socket. The browser never talks to Binance directly except for settle accuracy (spot klines from `api.binance.com`). This exists because polling Binance REST from the browser earned an IP ban (HTTP 418).

Key pieces:
- `v5/updown-liquidity-overlap.html` — the production dashboard. Single file: 4 locked Lightweight Charts (2×2), dropdown swap on the 4th, pressure bar, session threads, continuous runs.
- `v5/src/signals.mjs` — pure signal math (no DOM, no network) so it is both browser-importable and node-testable. All V5 signal logic goes here, not in the HTML.
- `v5/test/signals.test.mjs` — node:test suite for signals.mjs.
- `v5/ourWebSocket/` — local copy of the VM service (`server.py`, `feeds.py`, `compute.py`, `config.py`). Deployed at `/home/vincent/ourWebSocket/` on the GCP VM `pm` (project `lithe-hallway-493420-r4`), systemd unit `ourwebsocket`, port 80. Its `CONNECT.md` on the VM is the source of truth for the wire protocol. `POST /log` on the same port receives dashboard session logs (the old `v5/logd/` standalone service is retired).
- `testdata/v3-logs/` — 18 captured bars used as TDD fixtures. Canonical flip case: `btc-updown-5m-1781724300`.
- `v1/`, `v2/`, `v3/` — frozen predecessor dashboards (see hard rule).

## Working discipline (from CONTEXT.md)

- **TDD:** replay a fixture from `testdata/v3-logs/`, assert whether/when the signal fires, before writing signal code.
- **Don't over-fit:** n=18 fixtures is small and noisy. Use regime-adaptive measures (z-scores, relative slopes) and honest confidence; treat edge as directional until confirmed on new data.
- Signals must stay **forward-looking** — the value is lead time on a flip, not confirming a move that already happened.
- Validation findings not to re-litigate: CVD-30s alone is weak (~65% late-bar sign match); 1s order-book imbalance is noise; the promising unvalidated signals are `large_print_net_3m_usd`, `efficiency_3m`, and perp−spot CVD divergence.
