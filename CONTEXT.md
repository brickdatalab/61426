# 61426 — Project Context (for V5)

BTC/ETH **Polymarket up/down** live dashboards + the signal logic behind them.
This file is the current-state brief for anyone (human or agent) picking up the project,
especially for **V5** work.

## Autopsy log auto-sync (2026-07-06)

Completed session logs (any version) are now auto-committed to `AUTOPSY/logs/` on `main`.
A standalone reconciler on VM `pm` (`tools/autopsy-sync/autopsy_sync.py`, cron `*/5` under
`flock`, clone at `/home/vincent/autopsy-sync/repo` via a repo deploy key) reads the live
log dir **read-only** (never touches `ourwebsocket`/`v5logd`), and for each bar closed
≥5 min: verifies the settle against Polymarket Gamma, rewrites `settled` in place if it
disagrees (Polymarket is ground truth), then commits+pushes the log. Idempotent (already-
synced bars skip without a network call). See `tools/autopsy-sync/README.md`. **Consequence:**
the VM pushes log commits to `main`, so your local `main` drifts behind — `git pull --rebase`
to catch up (log commits are new files, never conflict with code). Disable by commenting the
crontab line on the VM. Note: settle-vs-Binance-spot divergences are **not** only on flat bars
(e.g. `1783348800` moved +$9.97 on spot but Polymarket resolved DOWN).

## Current state 2026-07-08 — v8 (per-tick stream replaced; v7s early call inherited)

**v8 shipped.** The per-tick UP/DOWN/MIXED stream is now `decideV8`: **call the cushion side
when `|cushion| ≥ max($10, 0.5·vol_1m)`, else MIXED** — the walk-forward frontier winner from
the v8 research program (823 24/7 bars / 48,557 ticks / 40 features: taker split, side-split
whale flow, perp-spot basis, book bid/ask pulls, poly dynamics, VWAP, trajectory transforms —
**all measured ≈no lift beyond price location**; permutation importance `cush_norm` 0.380 vs
0.022 next; hysteresis variants worse OOS). The v7s early-call channel is inherited
byte-identical (gate: 0 latch mismatches on 1,008 bars). Gate 5/5 (1,008 pooled bars):
acc 82.5% vs v6 73.1%, wrong 12.6% vs 16.0%, **missed fire-worthy 0.00% vs 20.9%**, LOBO all
days. The 30 measured "MIXED-while-evidence-screams" pain bars are all called correctly; two
are permanent fixtures in `v8/test/`. No VM change (rule uses tape fields already present).
Logs `<slug>_v8.json`. Records: `v8/analysis/2026-07-08-frontier.md`, `v8/README.md`.
New do-not-re-litigate: per-tick microstructure (aggression split, whale split, basis, book
pulls, poly dynamics, VWAP) adds no directional accuracy beyond cushion at 1s–60s windows.

## Previous state 2026-07-07 — v7 generation (v7s frozen, v7c parked)

**v7s + v7c shipped** (PR #1 `f2079f3`, then PR #2 `0ba38e7`). Both are full sibling forks of
v6; lean stream **byte-identical** to v6 (tie-gate: 0 differing ticks in 74,305 over 253 bars,
PASS). The change: v6's always-call EARLY CALL is replaced with a **selective** one — one
immutable latch per BTC 5m bar in the **45–90s window**, requiring `poly_mid` in-band +
cushion-agree + dwell 3, **abstaining otherwise** (hard deadline 90s: measured edge decays
45–90s +10.5pp → 90–120s +2.3pp → 120–180s +0.9pp). New engine input `inp.polyMid`, plumbed
additively through `runner/engine-adapter.mjs` and the dashboards (v6 and earlier ignore it).

| engine | band | pooled 990-bar (281 live + 709 BQ 24/7) | status |
|---|---|---|---|
| **v7s** standard | [0.82, 0.93] | **85.8% @ 23.4% cov, median fire 68s** (BQ-24/7 alone 81.7%; ex-cascade-day 89.5%) | **live** — `/v7s/updown-liquidity-overlap.html`, logs `_v7s.json` |
| **v7c** conviction | [0.90, 0.96] | **91.5% @ 7.2% cov, fire 72s** (BQ-24/7 90.4%; ex-cascade 94.0%) | **PARKED** for UMA/automation plans — do not deploy, wire, or modify |

**The load-bearing v7 finding (add to the do-not-re-litigate list below):** the in-sample
result (95.6% / +10.5pp edge on live-session logs) **collapsed out-of-sample** to 81.7% /
−2.8pp on 709 continuous 24/7 BQ bars. Diagnosed causes: bar-selection luck (live sessions ran
in cleaner stretches); misses are invisible at fire time (hits/misses statistically identical
on every available feature — no veto exists in these inputs); and **Polymarket is calibrated
at 45–90s — trading edge from public tape/poly features ≈ 0**. Plus ~8% of bars are near-flat
oracle coin-flips, capping any predictor ~96%. Consequences: judge every candidate on the 24/7
BQ distribution, never on live-session samples; any v8 edge claim must beat the calibrated
market on that distribution. Full record: `v7/analysis/2026-07-07-v7-basis.md` + `v7/README.md`;
evidence base `v7/analysis/bq_eval.jsonl` (709 bars, 59.2h, Jul 5–7).

**Dashboard (PR #2):** the v7s 1s tick loop runs in a **dedicated Web Worker** — Chrome
throttles main-thread timers (~1 tick/min after ~5 min backgrounded; this corrupted the old
v5.4 A/B) but not worker timers, so minimized/occluded tabs keep ticking at 1/s (gap >2.5s
logs a console warning; falls back to `setInterval` if Worker creation fails). System sleep is
separate: long continuous runs need **`caffeinate -dis`** on the Mac. Local serving: any port
works (`:5173` convention; a standing worker-managed server on `:7724` is also in use).

**Queued next (v8 research):** (1) order-book *dynamics* from `bin.book_imb_1s`/`trades_1s`
(the hunt for edge beyond `poly_mid`), (2) cross-market lead-lag (perp→spot, ETH→BTC),
(3) v7c + UMA automation requirements. Open infra: the VM runner (`61426-runner`/`61426-tls`)
is deployed but disabled, `stunnel4` (dead SSH experiment) still holds VM :443 which the
runner's TLS front needs, and Binance perp 429 pressure persists on the shared VM IP.

## Previous state 2026-07-05 — v6 (frozen predecessor)

**v6 shipped.** Fork of v5.4. Lean stream (`decideDebounced`/`momentumOf`/`flipRisk`) is
**byte-identical** to v5.4 — replay gate over the pooled 145 live + 135 BQ = 280-bar evidence
base: correct 34793→34793 (100.0%), 0 bars hurt, GATE PASS. New: an **early-call channel**
(`earlyCallOf`) — one immutable, always-call directional call latched per bar at the first
tick with `rem<=210` (90s into a 5m bar). Tier ladder: **strong** (`sig` on cushion side,
`|cushion|>=3x` vol floor), **qualified** (`2x<=ratio<3x`), **lean** (fallback — `sig` even
off-cushion, else cushion sign, else smoothed order-book imbalance sign). Coverage **280/280
(100%)** on the evidence base — no no-call bars. Logs `<slug>_v6.json`. Full record:
`v6/analysis/2026-07-05-v6-basis.md`.

**Tier table** (from the basis doc's `early-call-verify.mjs` run, 280 bars; tier rows count
only `late:false` calls — calls latched `late:true` because the session joined mid-bar are
tagged and reported separately in the `late` row, nothing silently dropped):

| Set | strong (n, acc) | qualified (n, acc) | lean (n, acc) | late (n, acc) |
|---|---|---|---|---|
| LIVE (145) | 26, 96.2% | 13, 84.6% | 100, 62.0% | 6, 83.3% |
| BQ (135) | 20, 75.0% | 17, 76.5% | 98, 57.1% | 0, — |
| POOLED (280) | 46, 87.0% | 30, 80.0% | 198, 59.6% (118/198) | 6, 83.3% |

**Honest caveat (OOS degradation, not resolved):** strong/qualified score noticeably lower on
BQ (75.0%/76.5%) than LIVE (96.2%/84.6%). Candidate explanations, flagged not smoothed over:
(a) the BQ capture window sits in a measurably heavier regime — spot turnover ~$5.4K/s vs perp
~$194K/s, with a liquidation-cascade stretch (2026-07-05 ~11:09–11:12 UTC) driving
`perp_spot_div` to ~$107M vs ~$4.65M on the one comparable live sample; (b) the BQ window is
one contiguous ~11.3h stretch, not a diverse sample of sessions; (c) `bin.book_imb_1s`
replicates `feeds.py DepthFeed._imbalance` verbatim but runs as an independent service
instance on the same VM — formula-identical, process-parity unverified (open question).

**Data layer:** `bin` dataset on VM `pm`, 3 BigQuery tables at 1s cadence — `trades_1s`
(spot+perp), `book_imb_1s`, `poly_5m_1s`. Exporter `v6/analysis/bq-export-bars.mjs`: klines
settle fidelity 135/135 bars matched a kline + 135/135 settle directions matched (100%),
median `|our_open − kline_open|` = $0.00 (p75 $0.01, max $18.18). Observed pull: 135 bars over
an ~11.3h (40,549s) window → **~284/day** at the observed 135/137 attempted-slot success rate
(**~288/day** theoretical-max-adjusted). *(An earlier "~264/day" figure could not be traced to
any committed artifact per the basis doc's own self-review — the ~284–288/day figures above are
the traceable ones.)* Evidence base now **145 live + 135 BQ = 280 bars**.

**P2/P3 (ENGINE_PROBLEMS 2 & 3) measured, NOT shipped** — both gate FAIL:
- Candidate B (`P2_NO_WHALE`, drop whale-print corroboration): pooled correct-tick retention
  98.42% < 99% required; 27 bars lose >10% of their correct ticks (6 wiped to zero). NO-SHIP.
- Candidate C (`P3_FAT_HOLD`, keep a fat cushion-aligned `sig` alive instead of decaying to
  MIXED): coverage gain is real (fat-cushion subset non-MIXED coverage 58.0%→80.9%), but
  exactly 1 per-bar-hurt violation (BQ `1783241700`, 3→0 correct ticks) against the
  zero-tolerance gate, plus pooled wrong ticks increase (14254→15658). NO-SHIP — but **the
  strongest v6.1 revisit candidate** once the one hurt bar is examined at BQ scale.
- B+C combined: still 23 bars lose >10% of correct ticks. NO-SHIP.

**v6.1 roadmap:** earlier-mark sweep — test `EARLY_MARK_REM` at `rem` 240/225 (60s/75s into
the bar) instead of the current 210 (90s), once ~1–2k BQ bars accumulate (currently 135).
`FINDINGS-first-fire.md` already shows 60s measurably worse (85.3% vs 92.1% at ≥2x) on the
smaller 145-bar set — needs re-test at pooled scale before any change. Same dominance-gate
pattern (`v6/analysis/replay-compare.mjs`).

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

### Dashboard fixes (2026-07-03, v5.3 + v5.4, commit `dd83717`) — display/plumbing only, engines untouched
- Tick loop can no longer stack (was 3 rows/sec after continuous-runs rollovers → duplicate log rows; now guarded, measured 1.00/s). Chart-swap blank fixed (empty `setData([])` on the hidden 2nd series breaks LWC 4.2.3 pane rendering — whitespace point instead; swap history deduped/ascending). Polymarket book fetch capped 900ms. Pressure bar pinned (`.sigcol` fixed 430px). Binance/Polymarket/Combined tile row removed.
- **Grading caveat:** pre-fix session logs that crossed rollovers contain duplicated rows — dedupe before analysis.

### V5.4 (2026-07-02) — CURRENT TUNED VERSION
- **V5.4** = fork of v5.3 + one gate-validated rule: **BAFO** (book-against flow override — a fat cushion `>= max($30, 3x vol_1m)` with agreeing d60+cvd_3m flow overrides an opposing book EWMA). From the 52-bar full-ledger audit (`v5.4/analysis/2026-07-02-lhf-52bars.md`): correct fires +482 (+8.8%), wrong -9, missed -473, 0/52 bars lose a correct tick, LOBO 52/52. All other rules identical to v5.3. Conviction-lock now also requires a real price lead (thin locks were 58% vs fat 91%).
- **Run V5.4:** `http://localhost:5173/v5.4/updown-liquidity-overlap.html`. Logs `<slug>_v54.json` via legacy `/log`. v5.3 -> frozen predecessor.

### V5.3 (2026-07-02) — TUNED SIGNAL VERSION (frozen predecessor)
- **V5.3** = fork of **v5.1** (not v5.2) with the first tuned signal logic — three measured rules in `decideDebounced` (`v5.3/src/signals.mjs`): cushion-aligned entry (`ALIGNED_ENTER 0.14`), counter-cushion confirmation (counter entries need momentum or whale-print backing), hold-release (`HOLD_RELEASE 15` — uncorroborated counter-cushion holds decay to MIXED). Everything else identical to v5.1.
- **Measured (replay, Polymarket-verified bars):** tuning set (20 bars) acc 70.8%→80.1%, wrongEp 26→17; out-of-sample (8 bars) acc 50.2%→**80.8%**, wrongEp 9→5. Gate tool: `v5.3/analysis/replay-compare.mjs` (GATE PASS). Design: `docs/superpowers/specs/2026-07-02-v5.3-max-accuracy-design.md`.
- **Run V5.3:** `http://localhost:5173/v5.3/updown-liquidity-overlap.html`. Logs `<slug>_v53.json` via the legacy open `/log` (no secret machinery — v5.1-style).

### V5.1 → V5.2 (2026-07-02)
- **V5.1** = the forward-looking flip-detection variation (pure `v5.1/src/signals.mjs`: clean flow, debounced decision, stabilized momentum, P(flip) score). **Frozen as the 20-bar deep-dive baseline** — see `v5.1/FINDINGS.md` + `v5.1/analysis/2026-07-02-deepdive-20bars.md`. Logs tagged `_v51`, all 20 Polymarket-resolution-verified.
- **V5.2** = the current **runnable** version: v5.1 signal logic **byte-identical** (no signal change yet — those are discuss-first) + hardening (localStorage prune to 50 sessions, `_v52` log namespace, authed `POST /v51/log` with `X-V5-Secret`, VM disk cap). **Run V5.2:** `http://localhost:5173/v5.2/updown-liquidity-overlap.html`. Logs land as `<slug>_v52.json`.
- **VM `/log` hardening deployed:** `_disk_guard` (500MB / 5000-file cap) on both routes; authed `/v51/log` route (secret **unset → open** for now, dormant auth; set `OWS_LOG_SECRET` on the VM + a `v5.2/secret.js` with `window.V52_SECRET` to enable). Legacy open `/log` preserved so frozen v5/v5.1 keep working. Backups on VM: `server.py.bak-pre-harden`, `config.py.bak-pre-harden`.

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
From the v7 program (2026-07-07, 709-bar 24/7 BQ evidence base — see the v7 section above):
- **Polymarket is calibrated at 45–90s** — its price ≈ its accuracy in every bucket; trading
  edge from public tape/poly features ≈ 0 there. `poly_mid` is the dominant early predictor;
  AND-ing in flow/book/whale signals slightly hurts.
- **Live-session samples are selection-flattered** (95.6% in-sample → 81.7% 24/7 OOS). Judge
  every candidate on the 24/7 BQ distribution.
- **~8% of bars are near-flat oracle coin-flips** — no predictor clears ~96% overall.

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
