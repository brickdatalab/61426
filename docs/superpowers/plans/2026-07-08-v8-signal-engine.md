# v8 Signal Engine — Research + Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A rebuilt per-tick signal stream (v8) that calls the settle direction while the move is developing — before the market prices it — learned outcome-backwards from every tick we own, shipped as an isolated interchangeable version fork.

**Architecture:** Two phases with a hard human checkpoint between them. Phase A (Tasks 0–7) builds the evidence base, feature matrix, anti-echo scoring harness, four baselines, and the ML ceiling/frontier — pure research, no engine code. Phase B (Tasks 8–12, contingent on the user approving the frontier) distills readable rules into a `v8/` sibling fork of v7s, validates through dynamic replay + dominance gate + LOBO, and ships. GLM-5.2 workers (parallel `chat_completion` calls via the OpenRouter MCP) draft bulk code to exact specs; Claude reviews, integrates, tests, commits. The local Claude Code "worker" runs the two VM/BQ data jobs (it has SSH `~/.ssh/pm`).

**Tech Stack:** Python 3.13 venv (`numpy`, `scikit-learn` only — no pandas), Node ≥20 ESM (no deps), existing `bq-export-bars.mjs` tooling, OpenRouter MCP (`z-ai/glm-5.2`), node:test.

## Global Constraints

- **Version isolation is ABSOLUTE:** no file under `v1/`–`v7s/`, `v7c/`, `runner/`, `web/` is modified, except the two explicitly listed: `.gitignore` (additive lines) and — Phase C only, additive, user-approved — `v5/ourWebSocket/compute.py` deploy copy.
- **Signal-logic changes are discussion-first:** Task 7 is a mandatory stop; nothing in Phase B starts without explicit user approval of the frontier report.
- **BTC 5m only.** ETH slugs (`eth-*`) are excluded everywhere.
- **Every number in reports comes from a script's output** — never computed by hand, never remembered.
- **Nothing enters live logging/compute.py on faith** — only measured winners, only in Phase C, only additively.
- **Anti-echo rule:** v8 must beat all four baselines on the value metric (Task 5) on held-out days, or it does not ship.
- **Data artifacts are gitignored; scripts and reports are committed.** Commit locally per task; push only at Task 7 (checkpoint) and Task 11 (ship), each preceded by `git pull --rebase origin main` (VM cron pushes every 5 min).
- **GLM workers:** stateless `mcp__openrouter__chat_completion` calls, model `z-ai/glm-5.2`, temperature 0.2; multiple calls dispatched in one message for parallelism. GLM returns code only; Claude integrates and tests. GLM never sees secrets; prompts contain only schemas/specs.
- Long-run local jobs pair with `caffeinate -dis`.

---

### Task 0: Preflight — dirs, venv, gitignore, data census

**Files:**
- Create: `v8/analysis/` (dir), `v8/analysis/data/` (dir)
- Modify: `.gitignore` (append 2 lines)

- [ ] **Step 1: Verify the evidence base exists** (all counts must match or exceed):
```bash
ls v6/analysis/bqbars/*_bq.json | wc -l                      # expect ≥709
python3 - <<'PY'
import json
for t in ['trades_1s','book_imb_1s','poly_5m_1s']:
    d=json.load(open(f'v6/analysis/bqbars/raw/{t}.json')); print(t,len(d))
PY
ls AUTOPSY/logs/*_v6.json | wc -l                            # expect ≥120
ls AUTOPSY/logs/*_v7s.json | wc -l                           # expect ≥46
```
- [ ] **Step 2: Create venv + deps**
```bash
mkdir -p v8/analysis/data
python3 -m venv v8/analysis/.venv
v8/analysis/.venv/bin/pip install -q numpy scikit-learn
v8/analysis/.venv/bin/python -c "import numpy, sklearn; print('deps OK')"
```
- [ ] **Step 3: Gitignore the data dir + venv** — append to `.gitignore`:
```
v8/analysis/data/
v8/analysis/.venv/
```
- [ ] **Step 4: Commit** — `git add .gitignore && git commit -m "v8: research scaffold (gitignore data dir + venv)"`

---

### Task 1: Worker data jobs (run in background; Tasks 2–4 proceed on existing 709 bars meanwhile)

**Interfaces — Produces:** refreshed `v6/analysis/bqbars/raw/*.json` (+~2 days), refreshed `*_bq.json` set (~1,270 bars), and `v8/analysis/data/book_levels.jsonl` (per-second bid/ask USD levels) **iff** the BQ table stores them.

- [ ] **Step 1: Verify `book_imb_1s` schema** (worker, read-only):
```bash
ssh -i ~/.ssh/pm vincent@34.89.159.108 "bq show --schema --format=prettyjson lithe-hallway-493420-r4:bin.book_imb_1s"
```
Decision rule: if fields like `bid_usd`/`ask_usd`/`best_bid`/`best_ask` exist → Step 3 runs. If only `imb` → the book pull/stack family is **dropped with a note in the frontier report** (measured absence, not silence).
- [ ] **Step 2: Fresh full export** (worker):
```bash
cd /Users/vitolo/Desktop/61426 && rm -rf v6/analysis/bqbars/raw && caffeinate -dis node v6/analysis/bq-export-bars.mjs
ls v6/analysis/bqbars/*_bq.json | wc -l    # report count; STOP if any raw count == 500000 (truncation)
```
- [ ] **Step 3: Book-levels export** (worker; only if Step 1 found level columns; adjust column names to actual schema):
```bash
ssh -i ~/.ssh/pm vincent@34.89.159.108 "bq query --nouse_legacy_sql --format=json --max_rows=500000 'SELECT ts_second, bid_usd, ask_usd, best_bid, best_ask FROM \`lithe-hallway-493420-r4.bin.book_imb_1s\` ORDER BY ts_second'" > v8/analysis/data/book_levels.jsonl
python3 -c "import json;d=json.load(open('v8/analysis/data/book_levels.jsonl'));print(len(d),'rows')"   # STOP if exactly 500000 → chunked re-pull by day
```
- [ ] **Step 4: Report back** — file counts, row counts, any truncation. No commits (all gitignored).

---

### Task 2: Bar builder — clean + join raw caches into per-bar per-second series

**Files:**
- Create: `v8/analysis/10_build_bars.py`, `v8/analysis/test_10_build_bars.py`

**Interfaces — Produces:** `v8/analysis/data/bars/<slug>.json`, each:
`{"slug": str, "settle": "UP"|"DOWN", "open": float, "close": float, "abs_move": float, "sec": {"<epoch>": {"spot_close","perp_close","buy_usd","sell_usd","buy_base","sell_base","lg_buy","lg_sell","imb","up_mid","poly_imb","bid_usd?","ask_usd?"}}}` (300 entries; nulls where masked) — plus `v8/analysis/data/bars_index.json` (`[{slug, day_utc, n_sec_valid}]`).

**Cleaning rules (locked):** print distinct `quality_flag` values, drop rows whose flag marks bad data; dedupe on `(ts_second, venue)` keep-last; trades missing second → vols 0 + `spot_close` carried forward (flagged); `imb`/`up_mid`/poly forward-fill ≤3s, longer gap → null; **bar valid iff** ≥270 s with trades AND ≥270 non-null `up_mid` AND both venues ≥270 s AND a settle row exists in its `_bq.json`; label = `_bq.json` settle row (`settled`, `open`, `close`), recompute `sign(close−open)` and log mismatches (trust settle row); store `abs_move=|close−open|`; ETH excluded; epochs must satisfy `epoch % 300 == 0`.

- [ ] **Step 1: GLM-parallel dispatch (batch A, call 1 of 3)** — send `chat_completion` (model `z-ai/glm-5.2`, temperature 0.2) with: the exact raw-cache schemas (from Task 0 census), the output contract above, the cleaning rules verbatim, stdlib+numpy only, and: "Return only the complete `10_build_bars.py`. CLI: `--raw v6/analysis/bqbars/raw --bq v6/analysis/bqbars --out v8/analysis/data`. Print: bars kept/dropped by reason, distinct quality_flags seen, settle mismatch count."
- [ ] **Step 2: Write the failing test** (`test_10_build_bars.py`, runs on real data):
```python
import json, subprocess, glob, sys
def test_bars_built():
    subprocess.run([sys.executable, 'v8/analysis/10_build_bars.py',
        '--raw','v6/analysis/bqbars/raw','--bq','v6/analysis/bqbars','--out','v8/analysis/data'], check=True)
    idx = json.load(open('v8/analysis/data/bars_index.json'))
    assert len(idx) >= 650                      # ≥92% of 709 survive cleaning
    b = json.load(open(glob.glob('v8/analysis/data/bars/*.json')[0]))
    assert b['settle'] in ('UP','DOWN') and len(b['sec']) == 300
    s = next(iter(b['sec'].values()))
    for k in ('spot_close','perp_close','buy_usd','sell_usd','lg_buy','lg_sell','imb','up_mid'):
        assert k in s
```
- [ ] **Step 3: Review GLM code, integrate, run test** — `v8/analysis/.venv/bin/python -m pytest v8/analysis/test_10_build_bars.py -x -q` (or plain `python test_...py` with asserts). Expected: PASS; fix integration issues myself, re-dispatch to GLM only for full rewrites.
- [ ] **Step 4: Commit** — `git add v8/analysis/10_build_bars.py v8/analysis/test_10_build_bars.py && git commit -m "v8: bar builder (clean+join raw 1s caches)"`

---

### Task 3: Engine-field replay — byte-faithful v6 features + the v6 baseline stream

**Files:**
- Create: `v8/analysis/21_replay_engine_fields.mjs`, `v8/analysis/test_21_replay.mjs`

**Interfaces — Produces:** `v8/analysis/data/engine/<slug>.json`: per-second `{imb_ewma, mom_z, sig}` from the **real** `v6/src/signals.mjs` (`newSession`+`tick` replayed over the bar's series, inputs built exactly as the dashboard builds `inp`: cushion, bimb=imb, pimb=poly_imb, largePrints=lg_buy−lg_sell 3m rolling, efficiency, cvd3m, remS, vol1m computed from spot_close diffs — mirror `runner/engine-adapter.mjs buildInp`).

- [ ] **Step 1: Write the failing validation test** — replay must reproduce the fields a real live log recorded:
```js
// test_21_replay.mjs — node --test
// Load AUTOPSY/logs/btc-updown-5m-1783390500_v6.json, feed its own raw inputs
// (btc_imb, poly_imb, cushion, ...) through the replayer, assert replayed
// imb_ewma matches the logged imb_ewma within |Δ|≤0.02 on ≥95% of rows,
// and replayed sig matches logged signal on ≥98% of rows.
```
(Complete test written inline at execution; the two thresholds above are the acceptance contract.)
- [ ] **Step 2: Write the replayer myself** (not GLM — it must mirror `engine-adapter.mjs`/dashboard input construction exactly; ~80 lines importing `../../v6/src/signals.mjs`).
- [ ] **Step 3: Run** `node --test v8/analysis/test_21_replay.mjs` → PASS, then run over all bars → `data/engine/`.
- [ ] **Step 4: Commit** — `git commit -m "v8: byte-faithful v6 engine-field replay over BQ bars"`

---

### Task 4: Feature families → the per-tick matrix

**Files:**
- Create: `v8/analysis/20_features.py`, `v8/analysis/test_20_features.py`

**Interfaces — Produces:** `v8/analysis/data/matrix.npz` (`X` float32 [n_ticks × n_feat], `y` int8 (1=UP), `meta` = slug idx/rem/poly_mid/cushion/vol_1m/abs_move/day), `v8/analysis/data/features_manifest.json` (ordered names). Ticks sampled every 5 s at `rem ∈ {295,290,…,5}`.

**Feature spec (exact names; windows 10/30/60 s; all rolling values null-masked to 0 with a paired `_valid` flag where nulls occur):**
- Aggression: `agg_ratio_{10,30,60} = (Σbuy−Σsell)/(Σbuy+Σsell+1)`, `agg_accel = agg_ratio_10 − agg_ratio_60`, `agg_persist_60` (fraction of last 60 s with same sign as `agg_ratio_60`), `agg_intensity_30 = Σ(buy+sell)_30 / (Σ(buy+sell)_since_open/elapsed·30 + 1)`
- Whales: `whale_net_{30,60} = Σ(lg_buy−lg_sell)`, `whale_against_move_60 = −sign(cushion)·whale_net_60`, `whale_burst = max_10s(lg_buy+lg_sell)/(Σ60+1)`
- Basis: `basis = perp_close−spot_close`, `basis_vel_{10,30}` (Δbasis/window), `basis_div = sign(basis_vel_10) − sign(cushion_vel_10)`
- Book (iff levels exported): `bid_pull_30 = (bid_usd_now−bid_usd_30s_ago)/(bid_usd_30s_ago+1)`, `ask_pull_30` same, `pull_skew = ask_pull_30 − bid_pull_30`, `imb_vel_10`
- Poly: `mid_vel_{10,30}` (Δup_mid), `mid_accel = mid_vel_10 − mid_vel_30`, `pimb_vel_10`, `mid_cush_gap = (up_mid−0.5) − tanh(cushion/(2·floor))`
- VWAP: `vwap = Σbuy_usd+sell_usd / Σbuy_base+sell_base` since open, `px_vs_vwap = spot_close−vwap`, `vwap_conf = sign(px_vs_vwap)·sign(cushion)`, `hollow = |cushion| − |px_vs_vwap|` (vol-normalized)
- Trajectory: `cush_vel_{10,30,60}`, `cush_accel`, `cvd_slope_60`, `absorb_60 = zscore(|Δprice_60|) − zscore(|Σnet_usd_60|)`, `imb_whipsaw_60` (sign changes count), `cush_path_r2` (linear-fit R² of cushion over elapsed — grind vs V), `range_pos = (spot_close−min_so_far)/(max_so_far−min_so_far+ε)`
- Normalization: every $-denominated feature divided by `max(10, 0.5·vol_1m)`; `rem` and `elapsed/300` included as features.

- [ ] **Step 1: GLM-parallel dispatch (batch A, calls 2+3 of 3)** — two parallel `chat_completion` calls: call 2 implements families Aggression/Whales/Basis/Book, call 3 implements Poly/VWAP/Trajectory + the matrix assembler; each gets the bar JSON contract (Task 2), the exact spec above verbatim, numpy-only, and one synthetic-bar unit test to satisfy (provided in the prompt: a constructed 300-s bar with known buy/sell pattern → asserted feature values, e.g. constant buys ⇒ `agg_ratio_60 == 1.0`, linear cushion ⇒ `cush_path_r2 > 0.99`).
- [ ] **Step 2: Integrate both halves into `20_features.py`; run the synthetic tests** → PASS.
- [ ] **Step 3: Build the matrix** — `caffeinate -dis v8/analysis/.venv/bin/python v8/analysis/20_features.py`; print: n_ticks, n_features, null-mask rates per family (any family >30% masked gets flagged in the report).
- [ ] **Step 4: Commit** — `git commit -m "v8: feature families + per-tick matrix builder"`

---

### Task 5: Scoring rule + the four baselines

**Files:**
- Create: `v8/analysis/30_scoring.py`, `v8/analysis/test_30_scoring.py`

**Interfaces — Produces:** `score_ticks(calls, meta) -> dict` used by Tasks 6/8/10; `v8/analysis/data/baselines.json` + printed report.

- [ ] **Step 1: Write the failing test with hand-computed fixtures:**
```python
from importlib import import_module
S = import_module('30_scoring')  # sys.path trick in real test
def test_values():
    # correct, early (rem=250), unpriced (mid=0.55): u=0.9, e=0.8333 -> +0.75
    assert abs(S.tick_value('UP','UP',0.55,250,+20,10) - 0.75) < 1e-9
    # wrong direction: flat -1.0
    assert S.tick_value('DOWN','UP',0.55,250,+20,10) == -1.0
    # MIXED during fire-worthy lead (cushion +30 ≥ floor 10, lead==settle): -0.25
    assert S.tick_value('MIXED','UP',0.55,250,+30,10) == -0.25
    # MIXED, not fire-worthy: 0
    assert S.tick_value('MIXED','UP',0.55,250,+3,10) == 0.0
```
- [ ] **Step 2: Implement (myself — this is the constitution, not GLM's):**
```python
def floor(vol_1m): return max(10.0, 0.5*(vol_1m or 0.0))
def tick_value(call, settle, poly_mid, rem, cushion, vol_1m, lam=1.0, mu=0.25):
    u = max(0.0, 1.0 - 2.0*abs((0.5 if poly_mid is None else poly_mid) - 0.5))
    e = rem/300.0
    lead = 'UP' if cushion > 0 else ('DOWN' if cushion < 0 else None)
    fire_worthy = (lead == settle) and abs(cushion) >= floor(vol_1m)
    if call == 'MIXED': return -mu if fire_worthy else 0.0
    return u*e if call == settle else -lam
```
Baselines (each emits a call per tick): **(a)** `sign(cushion)` if `|cushion|≥floor` else MIXED; **(b)** the replayed v6 `sig` (Task 3); **(c)** `sign(poly_mid−0.5)` if `|poly_mid−0.5|≥0.02` else MIXED; **(d)** `sign(px_vs_vwap)` if `|px_vs_vwap|≥floor` else MIXED.
- [ ] **Step 3: Run over the matrix** → per-baseline: total value, value/bar, accuracy, coverage, per-rem-band table (bands 300–240/240–180/180–120/120–60/60–0), sensitivity grid λ∈{0.5,1,2}×μ∈{0.1,0.25,0.5}. Also: scan for the user's pain-case bars (`cushion ≤ −150 and cvd_since_open ≤ −1e6 and v6 sig == MIXED`) → list slugs (these become Task 9 fixtures).
- [ ] **Step 4: Commit** — `git commit -m "v8: value scoring rule + four anti-echo baselines"`

---

### Task 6: The ceiling — walk-forward ML frontier

**Files:**
- Create: `v8/analysis/40_ceiling.py`, `v8/analysis/2026-07-XX-frontier.md` (the report; dated at run time)

- [ ] **Step 1: GLM-parallel dispatch (batch B, 2 calls)** — call 1: walk-forward harness (folds = consecutive UTC days from `meta.day`; train days ≤k → test day k+1, all k≥2; models: `HistGradientBoostingClassifier(max_iter=300, learning_rate=0.08, max_leaf_nodes=31, early_stopping=True)` and `LogisticRegression(max_iter=2000)` on standardized X; predict P(UP) per test tick; convert to calls at thresholds τ∈{0.55,…,0.95 step 0.05}: UP if p≥τ, DOWN if p≤1−τ, else MIXED). Call 2: reporting — per rem-band × τ: accuracy/coverage/value (via Task 5's `score_ticks`), vs all 4 baselines on identical test ticks; permutation importance top-20; **group importance** = value drop when each family's columns are shuffled; coin-flip sensitivity (repeat headline with `abs_move<$10` bars excluded).
- [ ] **Step 2: Integrate, smoke-test on 2 folds, then full run** — `caffeinate -dis v8/analysis/.venv/bin/python v8/analysis/40_ceiling.py` (expect minutes, not hours, at ~54k sampled ticks).
- [ ] **Step 3: Write `2026-07-XX-frontier.md`** — the honest record: frontier table, does ANY (model, τ, band) beat all four baselines on value on held-out days; which families carry it; what's dead; whether book-levels absence (Task 1) blinded a family; recommendation.
- [ ] **Step 4: Commit** — `git commit -m "v8: walk-forward ceiling/frontier report"`

---

### Task 7: CHECKPOINT — discussion-first gate (mandatory stop)

- [ ] **Step 1:** `git pull --rebase origin main && git push origin main` (research scripts + report land on main).
- [ ] **Step 2:** Present the frontier to the user: the achievable numbers by rem-band, what beats the baselines and by how much, the carrying features, and my recommendation (proceed to distill / expand data first / stop). **Nothing below runs without explicit approval.** If the ceiling barely clears the anchors → the approved fallback discussion is new collection (deeper book beyond ±0.12%, a VM collector change) — its own mini-plan.

---

## Phase B (contingent on Task 7 approval)

### Task 8: Distill readable rules + dynamic replay harness

**Files:**
- Create: `v8/analysis/50_distill.py`, `v8/analysis/replay-harness.mjs`

- [ ] **Step 1:** `50_distill.py` (GLM batch C, call 1): fit a depth-3 `DecisionTreeClassifier` on the top-8 permutation features at the chosen operating point; emit its rules as JSON `{feature, op, threshold}` clauses; ALSO emit a threshold grid (top-4 features × 3 thresholds each) for the replay sweep.
- [ ] **Step 2:** `replay-harness.mjs` (myself): runs candidate rule-sets **inside a real tick loop** with hysteresis state (enter/exit/dwell params swept: enter ∈ {2,3,4} consecutive qualifying ticks, release ∈ {5,10,15}) over held-out-day bars; scores with the Task 5 value function (ported constants); prints per-candidate: value/bar, acc, coverage, wrong-ticks vs v6, per-bar no-harm violations, LOBO (leave-one-day-out) worst day.
- [ ] **Step 3:** Select the winner: highest held-out value/bar subject to — beats all 4 baselines, wrong-tick rate ≤ v6's, zero bars losing >10% of v6-correct ticks, LOBO holds on every day. Document runner-ups + kill reasons (basis-doc style).
- [ ] **Step 4: Commit** — `git commit -m "v8: distilled candidates + dynamic replay selection"`

### Task 9: The v8 engine fork (TDD)

**Files:**
- Create: `v8/src/signals.mjs` (fork of `v7s/src/signals.mjs`), `v8/test/signals.test.mjs`

**Interfaces — Produces:** same exports as v7s (`newSession, tick, CFG, momentumOf, decideDebounced, flipRisk, earlyCallOf, …` — identical names/signatures so the dashboard and `runner/engine-adapter.mjs` swap engines by path alone). `decideDebounced` internally delegates to the new distilled rule set (`decideV8`); `earlyCallOf` is **byte-identical to v7s**.

- [ ] **Step 1: Write failing tests first:** fork `v7s/test/signals.test.mjs` → keep every early-call test unchanged; add (i) the flip-bar TRUE-POSITIVE fixture (an alert/signal MUST fire on `btc-updown-5m-1781724300` — never weaken), (ii) **the pain-case fixture(s)** from Task 5's scan: replay the real log, assert the v8 stream is not MIXED (and is on the settle side) at the ticks where `cushion ≤ −150 ∧ cvd_since_open ≤ −1M`, (iii) rule-unit tests with synthetic inputs per distilled clause.
- [ ] **Step 2:** `node --test v8/test/signals.test.mjs` → FAIL (decideV8 undefined).
- [ ] **Step 3:** Implement `decideV8` — explicit, commented rules (every clause traceable to the frontier report; no magic numbers without a measured source).
- [ ] **Step 4:** Tests PASS. **Step 5: Commit** — `git commit -m "v8: engine fork with distilled per-tick rules"`

### Task 10: Gates — dominance + value + tie-check

**Files:**
- Create: `v8/analysis/replay-compare.mjs`, `v8/analysis/validate.mjs`

- [ ] **Step 1:** `replay-compare.mjs` (pattern: `v7s/analysis/replay-compare.mjs`): replays real v8 vs real v6 over `AUTOPSY/logs` **and** the BQ bars; classic ledger (correct/wrong/missed) + value metric; PASS requires the Task 8 winner's criteria on the full pooled set. `validate.mjs`: per-band value/acc/coverage vs the 4 baselines.
- [ ] **Step 2:** Run both → GATE PASS printed. Any FAIL → back to Task 8 with the failure documented; never tune on the test days.
- [ ] **Step 3: Commit** — `git commit -m "v8: dominance/value gates PASS"`

### Task 11: Dashboard fork + ship

**Files:**
- Create: `v8/updown-liquidity-overlap.html` (fork of `v7s/…`: title [V8], engine import `./src/signals.mjs`, log suffix `_v8`, Web Worker ticker inherited; EARLY CALL badge unchanged; signal-row mechanics unchanged — only the stream feeding it is new), `v8/README.md` (numbers + provenance), `v8/analysis/2026-07-XX-v8-basis.md` (full basis record, v7-basis pattern)
- Modify: `CLAUDE.md` + `CONTEXT.md` + `SUMMARY.md` (ladder/current-state, same surgical pattern as the v7 doc update)

- [ ] **Step 1:** Build fork; syntax-check the inline script (`python3` extractor + `node --check`, the PR-#2 pattern); verify `_v8` log POST path.
- [ ] **Step 2:** Full test suite: `node --test v8/test/signals.test.mjs` + re-run both gates + `cd runner && node --test test/engine-adapter.test.mjs` (adapter must load v8 by path unchanged).
- [ ] **Step 3:** `git pull --rebase origin main`, branch `claude/v8-ship`, PR to main, squash-merge; verify Vercel deploy READY (web/ untouched → trivial).
- [ ] **Step 4:** Hand the user the run block: `git pull --rebase origin main` → `http://localhost:7724/v8/updown-liquidity-overlap.html` (or :5173) + hard-refresh + `caffeinate -dis` for long runs. First-night grading script rerun (the Task 5 grader pointed at `_v8` logs).

### Task 12 (conditional — only if winning features need live tape fields): compute.py additive plumbing

- [ ] Additive fields in the VM tape (e.g. `tape.buy_vol_usd_30s/sell_vol_usd_30s`, `tape.vwap_bar`, `tape.basis`): spec exact JSON keys; worker deploys via SSH (backup `compute.py.bak-pre-v8`, `python3 -m unittest test_compute test_server -v` on VM copy first, systemd restart, `/health` check); dashboard maps new fields into `inp`; v6/v7s ignore extras by construction. **User approval required before any VM touch.**

---

## Verification (end-to-end)

1. Task-level: each task's tests + committed artifacts.
2. Frontier honesty: every number in the checkpoint report regenerable by rerunning `40_ceiling.py` (seeded).
3. Ship honesty: gates PASS on pooled live+BQ; v8 badge/docs numbers = gate outputs verbatim.
4. Live: first ~50 `_v8` bars graded by the same script as tonight's v7s check; compared against the frontier's predicted band. Divergence >10pp → investigate before trusting.
5. The goal condition (Stop-hook charter) is satisfied at Task 11-complete with gates PASS + docs updated; Task 12 only if measured winners demand tape fields.

## GLM worker utilization map (parallel batches)

- **Batch A (3 parallel calls):** Task 2 builder, Task 4 families 1–4, Task 4 families 5–7+assembler.
- **Batch B (2 parallel calls):** Task 6 walk-forward harness, Task 6 reporting.
- **Batch C (2 parallel calls):** Task 8 distiller, Task 11 README/basis-doc draft.
- Claude writes personally: the replayer (Task 3), the scoring constitution (Task 5), the replay harness (Task 8), `decideV8` (Task 9), the gates (Task 10). Reason: these are the correctness-critical, house-pattern-bound pieces.
