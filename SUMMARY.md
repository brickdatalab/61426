# SUMMARY.md — Full Project State (updated 2026-07-04; original 2026-07-02)

**Purpose:** complete handoff so a compacted/future session knows exactly where we left off. Read this + `CLAUDE.md` + `CONTEXT.md` first. When the user says "v1/v2/v3/v4" in conversation they usually mean **v5.1/v5.2/v5.3/v5.4** (the historical `v4/` multi-venue experiment is dead — never resurrect, never name anything v4).

## WHERE WE ARE RIGHT NOW (2026-07-04)

- **Dashboard fixes SHIPPED to v5.3 + v5.4** (2026-07-03, commit `dd83717`, both live-verified in browser):
  1. **Tick-loop stacking killed** — async ticks + continuous-runs rollover used to leak 1s intervals (3 rows/sec, duplicate VM log rows, duplicate session POSTs). Now: interval cleared in `start()`, settle re-entry guard, ticks never overlap. Measured 1.00 ticks/s.
  2. **Chart-swap blank fixed** — root cause: hiding the 2nd line with `setData([])` — a truly EMPTY series breaks the Lightweight Charts 4.2.3 pane render loop (`Value is null` every frame = blank panel). Fix: whitespace point `[{time:parsed.ts}]` instead. Plus: swap history deduped-on-push (strictly ascending times), null-free ascending `setData`, try/catch so no chart error can kill a tick, swap works while stopped.
  3. **Polymarket book fetch capped at 900ms** (`jgetT`) — slow Polymarket costs poly fields for a tick, never cadence.
  4. **Pressure bar pinned** — `.sigcol` fixed 430px flex-basis; long siginfo text ellipsizes; bar pixel-stable.
  5. **Binance IMB / Polymarket IMB / Combined tile row removed** (markup + setters).
  - **DATA CAVEAT:** session logs recorded BEFORE this fix that crossed continuous-runs rollovers contain duplicated rows (up to 3/sec). Dedupe or exclude when grading older `_v53` logs.
- **BigQuery collector (World 2) built and PAUSED at the IAM grant** — full state + resume commands in `rawddataset.md`. Tables `strange-mason-474823-e0:raw_d.ticks/bars` exist; collector deployed to VM `/home/vincent/collector/` (NOT started); blocked only on the user running the dataset-ACL grant for the VM service account.
- **VM cleanup (2026-07-02):** `dboard-listener` (unrelated copy-trading process, wedged since Jun 29, 1.4 cores + 3.6GB) stopped AND disabled at user's order. VM now ~15% CPU / ~2.4GB used; remaining consumers: `payload_v6` (~0.6 core) + `ourwebsocket` (~3.5%).
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

1. **Resume the BigQuery collector** when the user runs the IAM grant (exact command in `rawddataset.md`): smoke insert → single-stream soak → 4 streams under systemd → docs. Its dual-engine columns then answer the v5.4 trust question as a free byproduct.
2. Collect clean v5.4 bars (focused tab / solo) → grade live vs the gate prediction → user decides trust.
3. At ~100 bars: rerun the LHF pipeline; retest the near-miss rescue stacks, the lp-corroborator problem, and the tick-vs-time hardening (queue in memory: `v54-state-and-retest-queue`). Dedupe pre-2026-07-03 logs that crossed rollovers before grading.
4. The FINDINGS §10 re-measurement list (alerts by |cushion|, p_flip calibration, late-bar tag gating).

---

# HANDOFF ADDENDUM — 2026-07-05 (read this after the sections above; nothing above is removed, some of it is superseded by what's here)

## Where we are RIGHT NOW (top priority context)

- **The user runs v5.3 live.** v5.4 exists, is gate-validated, but is NOT yet trusted for live use.
- **The next engine version is v6, and its tuning targets are already documented**: `ENGINE_PROBLEMS.md` (repo root) ends with "THE THREE MAJOR ENGINE PROBLEMS — v6 TUNING TARGETS": full dossiers with per-instance evidence tables for `thin-aligned-vs-flow` (21 instances/13 bars/1,047 wrong ticks), `inverted-whale-corroborator` (9/7/415), `late-deadzone-release` (7/7/645 silent ticks). Every row regenerated from the deterministic extractor and re-verified against a fresh run before commit. **v6 work is discussion-first per standing rule — the dossiers are documentation, no fixes were designed.**
- **42 full bar autopsies live in `AUTOPSY/`** (one .md per slug, standard format). All 168 `_v53` session logs are staged locally at `AUTOPSY/logs/` (gitignored).

## What was built since the last summary section

1. **140:140 mirror comparison** (2026-07-04): all v5.3 logs replayed through the real v5.4 engine → `_v54m.json` mirrors on the VM `mirrors/`; generator `v5.4/analysis/mirror-v54.mjs`. Pooled result on 111 settled bars: v5.4 +1,026 correct / −77 wrong / −1,016 missed / 0 bars hurt / GATE PASS — strongest v5.4 evidence yet, still counterfactual. The 5 real `_v54.json` test logs were DELETED at user's order (clean comparison).
2. **Settle ground truth re-verified**: all 140 mirror-set logs checked against Polymarket Gamma resolutions — 140/140 match (lifetime 192/192). Gamma requires a browser User-Agent header (bare urllib gets Cloudflare 403).
3. **Behavior-correlation program** (results in `ENGINE_PROBLEMS.md`): hard direction flips (52 v5.3 / 50 v5.4; switched-to direction 56%/60%; final-60s flips 30%/40% — worse than nothing); first signal vs settle 66% both versions (identical first calls on all 120 shared bars — the 41 misses are the SAME bars, BAFO can't act that early); second signal 77%/78%; HIGH CONVICTION first-flash 2×2 (78–80% both cards; flash fires in 75% of bars; accuracy lives at cushion ≥2× floor: 94–98%; **v5.4's 1× magnitude gate is set too low — 1×→2× is a documented display-layer candidate**).
4. **The `autopsy` pipeline** — the tooling that produced the 42 case files:
   - Skill: `~/.claude/skills/autopsy/` — `scripts/autopsy_data.py` (deterministic fact extractor: episodes, entry attribution, failure flags, truth-tellers, v5.4 mirror diff; finds logs in `AUTOPSY/logs/` else fetches from VM), `references/patterns.md` (failure-pattern encyclopedia + interpretation rules), `assets/template.md` (report skeleton), SKILL.md (hard rules: every number from the script, one output file, no engine changes, errors stop).
   - Subagent: `.claude/agents/autopsy.md` (Sonnet model, tools locked to Skill/Bash/Read/Write) — registers after a session restart; until then dispatch general-purpose+sonnet with the same brief. Proven pattern: ~40 parallel agents completed the sweep; transient API rate-limit errors just need relaunching (agents that died wrote nothing — check `AUTOPSY/*.md` existence to find casualties).
5. **Dashboard fixes earlier (2026-07-03, `dd83717`)** still stand: single tick loop (1.00/s measured), chart-swap fixed (empty `setData([])` breaks LWC 4.2.3 pane rendering — whitespace point instead), 900ms Polymarket fetch cap, pinned pressure bar, imb tile row removed.

## What's working / what's not (updated)

**Working:** the measurement pipeline end-to-end (extractor → autopsy agents → verified dossiers); mirrors + gate comparator; settle verification (192/192 lifetime); dashboards post-fix; VM healthy (~15% CPU after killing the unrelated dboard-listener on 2026-07-02 — stopped AND disabled).

**Not working / open, in priority order:**
1. **The three v6 engine problems** (see ENGINE_PROBLEMS.md dossiers) — the whole point of the current program.
2. **Conviction gate too low** (1× → 2× candidate, display-layer, measured on 140 bars).
3. **v5.4 trust** — still no clean live-fire evidence; the paused BigQuery collector solves this as a byproduct.
4. **BigQuery collector paused at ONE user-run IAM command** — full resume state in `rawddataset.md`. Tables exist (`strange-mason-474823-e0:raw_d`), collector deployed to VM `/home/vincent/collector/` (never started).
5. Unclassified wrong episodes (converged-then-reversed; split-flow d3m-vs-since_open disagreements — engine has no tie-break) — documented per-bar in AUTOPSY/, not yet measured as classes.

## Standing rules (unchanged, absolute)

Version isolation (new work = new version dir; v6 will be a fork, never edits to v5.x). Signal-logic changes discussion-first, shipped only through the dominance-gate pattern. Never trust static per-tick predictions — dynamic replay only. Mirrors (`_v53m`/`_v54m`) are never live sessions. Dedupe pre-2026-07-03 rollover-crossing logs before per-tick grading. The dead historical `v4/` is never referenced as a target ("v3/v4" in user speech = v5.3/v5.4).

## Next steps in order

1. v6 design discussion off the three dossiers (user drives; measure candidate rules with the LHF pipeline pattern — ledger → dynamic replay → dominance filter + LOBO — before any fork).
2. Conviction-gate 1×→2× decision (display-layer).
3. Resume the collector when the user runs the IAM grant (`rawddataset.md` has the exact command).
4. Keep collecting `_v53` logs; restage `AUTOPSY/logs/` when doing new autopsies (scp from VM).

---

# HANDOFF ADDENDUM — 2026-07-05 (v6 SHIPPED) — appended verbatim per user instruction

v6 is built, verified, and the final whole-branch review verdict is READY TO MERGE. 11 commits on branch v5.1 (ddc37aa..72c6efb), every v5.x file untouched — swap the URL and nothing else changes: http://localhost:5173/v6/updown-liquidity-overlap.html.

About your server log: it's healthy. The 404s are all favicon.ico / apple-touch-icon.png — files browsers request automatically that no version of this dashboard has ever had; same noise appears on your v5.3/v5.4 loads going back days. Your log also shows v6 loading clean at 14:28:38 (HTML 200 + signals.mjs 200) — that was my boot check, which ran through your already-running server: V6 tag renders, engine module loads, zero JS errors.

What v6 is

- Lean stream: byte-identical to v5.4, proven — the gate replayed both engines over all 280 bars: 34,793→34,793 correct ticks, 0 bars hurt, GATE PASS. Problems 2 and 3 from ENGINE_PROBLEMS were prototyped and measured first: both failed the dominance gate (B: 98.42% retention, 27 hurt bars; C: 1 hurt bar + wrong ticks up; B+C: 23 hurt) so neither shipped — same fate as P1. C is the documented first revisit candidate at BQ scale.
- The EARLY CALL channel — one latched call per bar at the first tick past the 90-second mark, every bar gets a call (280/280 coverage, your mandate), tiered by what the data earned:

┌────────────────────┬───────────────┬────────────────────────┬───────────────────────────────┐
│        Tier        │  live (145)   │ BQ out-of-sample (135) │ pooled — what the badge shows │
├────────────────────┼───────────────┼────────────────────────┼───────────────────────────────┤
│ strong (≥3× floor) │ 96.2% (n=26)  │ 75.0% (n=20)           │ 87%                           │
├────────────────────┼───────────────┼────────────────────────┼───────────────────────────────┤
│ qualified (2–3×)   │ 84.6% (n=13)  │ 76.5% (n=17)           │ 80%                           │
├────────────────────┼───────────────┼────────────────────────┼───────────────────────────────┤
│ lean (fallback)    │ 62.0% (n=100) │ 57.1% (n=98)           │ 60%                           │
└────────────────────┴───────────────┴────────────────────────┴───────────────────────────────┘

- Data pipeline: bq-export-bars.mjs turns your bin tables into replayable bars (135 exported, settle verified 135/135 against klines, median open delta $0.00). The evidence base now grows ~284/day without a browser tab.

What you need to hear straight

The out-of-sample day degraded the tiers — strong fell from 96% to 75% on the BQ bars. Candidate explanations are documented (single heavy-perp-regime day, book-imbalance process-parity open question), but until more BQ days accumulate, treat 87% pooled as the honest strong-tier number, not 96%. The final review caught the badge showing the inflated 92/96% figures and it was fixed before ship — badge, basis doc, and root docs now agree to the decimal. Mid-bar connects (which can't have full pre-mark history) are tagged late and show no percentage rather than borrowing one; 6 such bars were split out of the evidence itself.

The review process also caught and fixed: a silent data-corruption bug in the exporter (null − barOpen cushion), a fail-open acceptance gate, and two doc mischaracterizations. Full record: v6/analysis/2026-07-05-v6-basis.md.

Next: let the bin tables run. At ~1–2k bars (a few days), the v6.1 earlier-mark sweep (60s/75s marks, dwell-qualified variant) runs through the same gate — that's the path to earlier calls that the current 145+135 bars can't statistically support. Branch is not merged to main, same as your v5.x precedent — your call when.

✻ Crunched for 1h 56m 0s

❯ I want you to tell me now when I turn on V6 and I'm watching it and I see a fire, will the new features be accounted for in its firing? Yes or no? I want you to tell me also too, will these new features that are in the big four table that we're pulling be tracked and locked? Just respond back yes or no for that too. So I expect a yes or no for the first one and a yes or no for the second one.

Q1 — Yes. When you turn on v6 and see the EARLY CALL fire, that fire is the new machinery: it only latches from the 90-second mark, it's qualified by cushion-side + vol-floor ratio (the ≥3×/≥2× tiers), it carries its measured accuracy on the badge, and if you connected mid-bar it says "late — unmeasured" instead of borrowing a number. One precision so the yes is honest: the plain UP/DOWN/MIXED signal tag is deliberately unchanged v5.4 behavior — the new fire is the EARLY CALL badge.

Q2 — Yes. The three BigQuery tables keep recording 24/7 regardless of whether any dashboard is open (they're systemd services on the VM, append-only, hourly-partitioned), and every v6 fire is locked: the call latches once per bar in the engine (immutable for the rest of the bar), and it's written into the session log rows (early_call / early_tier) that POST back to the VM — so every fire is permanently graded against how the bar actually settled. One precision here too: the live engine doesn't read BigQuery in real time — the tables are the permanent record and tuning fuel, while live firing runs off the ourWebSocket feed as always.
