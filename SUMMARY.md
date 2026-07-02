# SUMMARY.md — Full Project State (written 2026-07-02, end of the v5.1→v5.4 session)

**Purpose:** complete handoff so a compacted/future session knows exactly where we left off. Read this + `CLAUDE.md` + `CONTEXT.md` first. When the user says "v1/v2/v3/v4" in conversation they usually mean **v5.1/v5.2/v5.3/v5.4** (the historical `v4/` multi-venue experiment is dead — never resurrect, never name anything v4).

## WHERE WE ARE RIGHT NOW

- **The user is running v5.3 live** (`http://localhost:5173/v5.3/updown-liquidity-overlap.html`). They do **not yet trust v5.4** — its only live A/B (bar `1783004400`) was invalidated by Chrome background-tab throttling (2.24s/tick vs 1.13s, half the ticks), which distorted v5.4's inputs and produced a wrong 70-tick UP via the known-bad lp-corroborator door (NOT via the new BAFO rule, which never fired). Building trust in v5.4 = the next piece of work: collect clean `_v54` logs (focused tab or solo run) and grade live firing vs the gate prediction at 30–50 fair bars.
- Serve everything with `python3 -m http.server 5173` from the repo root. One dashboard per port; each version is its own subdir.

## VERSION LADDER (each = full fork; predecessors frozen; isolation is ABSOLUTE)

| version | engine | status | log suffix |
|---|---|---|---|
| `v5/` | original (rolling-window CVD bug, flappy signal: 64–89 transitions/bar) | frozen legacy | `<slug>.json` |
| `v5.1/` | rebuilt pure engine: clean flow from `cvd_candle_usd`, debounced decision (EWMA 0.06 / enter 0.20 / exit 0.08 / dwell 7), stabilized momentum (60s warmup, z≥2, price gate — almost never fires), P(flip) score + persistence alert | frozen baseline; home of `FINDINGS.md` | `_v51` |
| `v5.2/` | = v5.1 logic byte-identical + hardening (localStorage prune 50 sessions, authed `/v51/log` POST w/ `X-V5-Secret`, v52 namespace) | frozen | `_v52` |
| `v5.3/` | first tuned engine: + `ALIGNED_ENTER 0.14` (aligned entries), counter-cushion confirmation (counter entries need momentum OR whale-print backing), `HOLD_RELEASE 15` (uncorroborated counter-holds decay). Gate: tuning 20 bars 70.8→80.1% acc; OOS 8 bars 50.2→80.8% | **user's current live version** | `_v53` |
| `v5.4/` | = v5.3 + **BAFO** (book-against flow override: `|cushion| ≥ max($30, 3×vol_1m)` + d60 & cvd_3m agreeing with cushion overrides an opposing book EWMA) + conviction-lock magnitude gate. 52-bar gate: +482 correct / −9 wrong / −473 missed / 0 bars hurt / LOBO 52/52 | built & gate-validated; **awaiting clean live evidence / user trust** | `_v54` |

Signal card UI (v5.3+): run counter `×N ticks`, conviction charge bar to 31 ticks, flashing yellow HIGH CONVICTION lock when run≥31 + price-side agreement (+ in v5.4: + real-lead magnitude), `fighting price` caution state.

## WHERE EVERY SCRIPT LIVES AND WHAT IT DOES

**Per version `vX.Y/`:**
- `updown-liquidity-overlap.html` — single-file dashboard (no build). 1s tick loop: Polymarket REST book + VM WS data → `tick()` → 4 charts, tiles, pressure bar, conviction card, log row; POSTs the session log to the VM at settle.
- `src/signals.mjs` — the pure engine (browser+node). Exports `newSession, tick, CFG, momentumOf, decideDebounced, flipRisk, phi, volFromHist, valAt, deltaAt`. ALL signal logic lives here. v5.4's `decideDebounced(s, inp, momentum, flow)` takes the flow arg (BAFO needs d60).
- `test/signals.test.mjs` + `test/replay.test.mjs` + `test/fixtures/` — node:test. Run: `node --test v5.4/test/signals.test.mjs v5.4/test/replay.test.mjs` (33 tests on v5.4; file paths, never the dir). Fixtures include a DOWN-settling bar and the flip-bar TRUE-POSITIVE alert test (`btc-updown-5m-1782970800_v51.json`) — the assertion that an alert MUST fire; never weaken it.
- `analysis/replay-compare.mjs` — acceptance gate: replays new-vs-old engine over a logs dir, binary GATE PASS/FAIL. v5.3's compares to v5.1; v5.4's compares to v5.3 and enforces the dominance criteria (≥99% correct retained, no bar hurt >10%, wrong not increased, transitions ≤ baseline).
- `v5.3/analysis/mirror-v53.mjs` — batch counterfactual generator: replays `*_v51/_v52` logs through v5.3 → `<slug>_v53m.json` mirrors (28 exist in VM `logs/mirrors/`). Mirrors carry a provenance block; NEVER treat as live sessions.
- `ourWebSocket/` in each version — local copy of the VM service (see below).

**Reports:** `v5.1/FINDINGS.md` (running findings home, §0–10c), `v5.1/analysis/2026-07-02-deepdive-20bars.md`, `v5.4/analysis/2026-07-02-lhf-52bars.md` (latest: the 52-bar audit, winner + all rejections with killing numbers). Design specs in `docs/superpowers/specs/`. Plans in `docs/superpowers/plans/`.

**Scratchpad (session-temporary, regenerable — may be gone after compaction):** `deepdive/replay.mjs` (the counterfactual harness: `decideVariant` with ~15 parameterized rule flags, modes fidelity/dump/sweep/baseline; equivalence-gated vs the real modules), `lhf/ledger.mjs` (per-tick ledger generator), `lhf/ledger.jsonl` + `episodes.json` + agent findings + sweep results. If lost, everything regenerates from the VM logs + these scripts' patterns (documented in the analysis reports).

## THE VM (GCP `pm`, project `lithe-hallway-493420-r4`)

- `34.89.159.108`, ssh: `ssh -i ~/.ssh/pm vincent@34.89.159.108`. Service: `/home/vincent/ourWebSocket/` (server.py, feeds.py, compute.py, config.py), systemd `ourwebsocket`, port 80, `CAP_NET_BIND_SERVICE`.
- WS feed: `ws://34.89.159.108/ws/v5/tape?symbol=BTCUSDT&bar=5m` — emits tape.{cvd_candle_usd, cvd_delta_1m, cvd_delta_3m, large_print_net_3m_usd, efficiency_3m, price, bar_open, binance_imb, vol_1m_usd} + perp_spot_divergence. `vol_1m_usd` was added this session (additive; backup `compute.py.bak-pre-v51`).
- Log ingest: legacy open `POST /log` (v5/v5.1/v5.3/v5.4 use it) + authed `POST /v51/log` w/ `X-V5-Secret` (v5.2 uses it; secret currently UNSET → open). Both disk-capped (`_disk_guard`: 500MB/5000 files). Backups: `server.py.bak-pre-harden`, `config.py.bak-pre-harden`.
- Session logs: `/home/vincent/projects/61426/v5/logs/` (`mirrors/` subdir = counterfactuals).

## WHAT WE DID THIS SESSION (chronological, with the numbers that matter)

1. **Diagnosed v5's flip-flopping** from 2 logs: rolling-1m-window CVD contaminating all derivatives; raw 1s book threshold ±0.12 crossed 55–81×/bar; z-score explosions; 4 rich VM metrics received but unused.
2. **Built v5.1** (10-task subagent-driven plan): pure engine + tests; transitions 64–89 → 1–9. Live-verified; logs to VM.
3. **Verified ground truth**: every settle checked against Polymarket's Chainlink resolution via prediction-skills (`resolve.py`) — ultimately **52/52 match**. Polymarket resolves ~15–20s after bar end (a just-ended bar can read "still live").
4. **20-bar deep dive** (fidelity-gated counterfactual replay, ~250 variants): late-bar tag collapse (89% mid-bar → 43% final-60s; flip score right 5/5 when they disagreed); persistence composite (run≥31 + cushion agreement = 96%); chose max-accuracy profile → **v5.3** (3 rules). OOS gate 50.2→80.8%.
5. **v5.2** built earlier as hardening-only (localStorage prune, authed log route + CORS-header bug found live and fixed, disk cap deployed).
6. **UI**: run counter + conviction visualization (charge bar, flashing lock, fighting-price state).
7. **Bar `1782998700` autopsy** → thin-cushion locks are weak (58% vs 91% fat on 52 bars) → conviction magnitude gate (shipped in v5.4).
8. **Mirrors**: 28 `_v53m` counterfactual logs generated + published.
9. **52-bar low-hanging-fruit audit** (the big one): per-tick ledger (14,618 ticks: 5,480 correct / 1,926 wrong / 3,966 missed under v5.3) → 4 parallel evidence agents → 33 dynamic counterfactual variants → strict dominance filter + LOBO. **One winner: BAFO** → **v5.4**. Decisive rejections: dwell-shortening (statically 7.5:1, dynamically −2.6% correct + 20 bars hurt — static agent predictions routinely invert under dynamic replay!); lp-corroborator removal (aggregate inversion REAL — lp-"confirmed" counter fires run 9–14% — but removal erases all correct ticks on 3 late-flip bars); rescue stacks (fail LOBO by 1–3 wrong ticks — retest at ~100 bars).
10. **v5.3 vs v5.4 live A/B failed methodologically** (tab throttling — see WHERE WE ARE). Rule recorded: valid A/B = one live + mirror replay of the other, or two visible windows.

## WHAT'S WORKING / WHAT'S NOT

**Working:** flap-free signal (1–9 transitions/bar); verified settle pipeline (52/52); the measurement machinery (ledger → agents → dynamic replay → dominance gate) — the single most valuable asset; v5.3 live behavior matching its gate numbers; the conviction card; VM feed + logging (zero WS gaps in logs); test safety net incl. the TP-alert fixture.

**Not working / open (in priority order):**
1. **v5.4 trust** — gate-validated but no clean live evidence; user runs v5.3 meanwhile. Next task: fair `_v54` collection + live-vs-gate grading.
2. **Inverted whale-print corroborator** — lp-"confirmed" counter-cushion fires are 9–14% accurate in aggregate (misfired again on the throttled bar), but blunt removal kills flip-catching. Needs a discriminating rule. In the retest queue.
3. **Tick-vs-time semantics** — all constants are per-tick (alpha, dwell 7, hold-release 15, run counts); any cadence disruption (tab throttling) silently stretches wall-clock behavior. Candidate hardening: time-based constants.
4. **Missed fires** still large (3,966 baseline; v5.4 removes 473): counter-blocked (1,364) and dead-zone (1,280) are the biggest untapped pools; the near-miss rescue stacks target them.
5. Alert layer barely tested (few flip bars); p_flip flat above 0.2; late-bar collapse of the flip-prior (`Φ→0` as t→0) — design gap from bar `…985000`, needs more late-flip examples.
6. No edge demonstrated vs Polymarket's own prices yet (5/11 at max divergence) — the money question stays open.

## STANDING RULES (non-negotiable, also in memory + CLAUDE.md)

- **Version isolation:** new work = new version dir; never modify v1…v5.3 (v5.4 is current-editable until superseded).
- **No auto-changes from log review:** analyze → present measured findings → explicit user approval → ship as a new fork through the dominance gate.
- **Never trust static per-tick predictions** — always dynamic replay with the equivalence-gated harness.
- Mirrors (`_v53m`) are never live data. Exclude <100-tick stub logs and the throttled `1783004400_v54` log from grading.
- Findings are stated as measured counts with binary verdicts; future-regime performance is the one explicitly directional claim.

## NEXT STEPS (agreed direction)

1. Collect clean v5.4 bars (focused tab / solo) → grade live vs the gate prediction → user decides trust.
2. At ~100 bars: rerun the LHF pipeline; retest the near-miss rescue stacks, the lp-corroborator problem, and the tick-vs-time hardening (queue in memory: `v54-state-and-retest-queue`).
3. The FINDINGS §10 re-measurement list (alerts by |cushion|, p_flip calibration, late-bar tag gating).
