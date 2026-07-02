# V5.1 — Preliminary Findings (grounding doc for future tweaks)

> **Status: PRELIMINARY.** Everything below comes from the first **14 settled bars**
> (2026-07-02, ~05:25–06:45 UTC, all BTC 5m, one continuous session block).
> 14 bars ≈ 14 independent data points — per-tick counts look big but ticks within
> a bar are correlated. Treat every percentage as directional, not calibrated.
> **Standing rule: no signal-logic or CFG changes from log review without explicit
> approval — findings get discussed first.** Re-run all of these at 50+ bars before
> tuning anything.
>
> Analysis basis: `<slug>_v51.json` session logs (VM `/home/vincent/projects/61426/v5/logs/`).
> Bars covered: `btc-updown-5m-1782969600` … `btc-updown-5m-1782974400`.

## 0. Ground truth is verified

- **Settle accuracy: 14/14.** Every log's `settled` value (Binance spot klines)
  matches Polymarket's official resolution (Chainlink BTC-USD, auto-resolved,
  verified via prediction-skills `resolve.py`). Includes tight bars (a $19.38 move).
  All grading below stands on verified ground truth.
- Polymarket resolves ~15–20s after bar end — a just-ended bar can briefly read
  "still live" when queried.
- Log health: zero WebSocket gaps >2s, zero data corruption, all 24 log fields
  populating. `poly_mid` has intermittent nulls (Polymarket book fetch hiccups),
  4–56 ticks/bar.

## 1. Flapping is fixed (the original v5 problem)

- 1–9 signal transitions per bar vs v5's 64–89 on comparable captured bars.
- Locked in by the replay regression test (`v5.1/test/replay.test.mjs`):
  transitions ≤15, DOWN false-alarm **episodes** ≤2 (episode count, not raw ticks
  — a deliberate choice; a single sustained wrong call and per-tick flapping are
  different failure modes).

## 2. The signal tag: strong mid-bar, unreliable late (biggest finding)

Per-tick agreement of non-MIXED tag with settle, by time remaining:

| phase | agreement |
|---|---|
| rem 300–240 | 63% |
| **rem 240–120** | **89%** |
| rem 120–60 | 72% |
| **rem <60** | **43%** |

- All 18 late transitions audited: every WRONG late switch was the tag flipping
  **against a large cushion** (e.g. DOWN at rem=70 with cushion **+$84.80**).
  In **all 5** wrong late switches, `p_flip` simultaneously read "leader safe"
  (≤0.11) — and was right **5/5**.
- Final-60s comparison: cushion sign alone = **96%**; leader-holds when
  `p_flip < 0.2` = **98%**; the tag = 43%.
- Mechanism: the tag is a *pressure gauge* (book imbalance EWMA) with no
  cushion/time awareness. Late in a bar, book pressure decouples from settle
  (profit-taking against the move). Not a bug — the tag answers "which way is
  pressure," the flip score answers "will the leader hold."
- Momentum was FLAT in **every** late transition — all late switching is
  imbalance-driven; the momentum layer (60s warmup + z≥2 + price gate) almost
  never fires.
- **Future-tweak candidate (discussion first):** de-emphasize or cushion-gate the
  tag in the final ~60s; the flip % is the right late-bar readout.

## 3. Persistence: run age × cushion agreement is the strongest state observed

Per-tick accuracy by how long the current signal has been firing:
1–10 ticks in: 65% · 11–30: 64% · 31–60: 72% · **61+: 87%**.

Cross-cut (the actionable composite):

| condition | accuracy |
|---|---|
| **run ≥31 ticks AND agrees with cushion side** | **96%** (1088/1139 ticks) |
| run <31 ticks, agrees with cushion | 88% |
| run ≥31 ticks, AGAINST cushion | 33% |
| run <31 ticks, against cushion | 28% |

- Persistence does NOT rehabilitate a signal fighting the price. Every sustained
  WRONG run (31+ ticks) had one of two signatures: started late-bar against the
  cushion (start rem = 126/78/70/59/51), or was a wrong opening call that died
  (start rem = 283/284, held 37–46 ticks).
- Survivorship caveat: runs get old partly because the market keeps confirming
  them; 87% at 61+ is not fully causal.

## 4. First signal of the bar: weakly predictive, fires too early to trust

- First non-MIXED signal matched settle **10/14 (71%)** — but 13/14 fired inside
  the first 45s (typically 10–25s in), i.e. **inside the 60s momentum warmup**:
  pure book-imbalance calls.
- At the first-fire tick, plain cushion sign was ALSO 10/14 — no evidence yet the
  first signal beats "which way did price open drifting."
- 3 of the 4 misses were the fastest triggers (≤17s in). Question for 50+ bars:
  does first-signal accuracy improve with firing time (e.g. ignore anything
  before ~30s)?

## 5. Flip score (p_flip): directionally honest, not yet discriminating

Per-tick realized flip rate by bucket (did the then-leader actually lose?):

| p_flip bucket | realized flips |
|---|---|
| 0.0–0.2 | 10% (160/1651) |
| 0.2–0.4 | 36% |
| 0.4–0.6 | 38% |
| 0.6–0.8 | 37% (49 ticks) |

- Good separation of "leader safe" (<0.2) vs "in danger" (>0.2); **no
  discrimination above 0.2** — expected from untuned directional priors
  (CFG weights were never fit to data, by design).
- `p_flip < 0.2` in the final 60s → leader held **98%** (577/588).

## 6. Alerts (n=2 — anecdotes, not statistics)

- 1 correct: `FLIP→DOWN` on bar …0800 with **3.5 min lead** before a genuine flip.
- 1 false: `FLIP→UP` on bar …2000.
- Both fired with **|cushion| < $3**: with no real leader, base risk ≈0.5 and
  modest opposing flow crosses the 0.6 threshold — alerts are "cheap" in the
  coin-flip zone. **Watch:** whether |cushion|-small alerts stay noise; a
  min-cushion gate is a future discussion item.

## 7. Bar-boundary bleed (user observation — confirmed in data, unproven as harm)

- The VM's rolling windows intentionally span bar boundaries: `large_prints`
  values carry **identically** across boundaries (3m window), `perp_spot_div`
  similarly (5m window), `cvd_d3m` (3m).
- At the signal level (9 consecutive boundaries): new bar's early lean matched
  the previous bar's settle only 4/9; right for its own bar 5/9 — no measurable
  directional harm yet. Early lean comes mostly from the live book, not the
  inherited windows; bleed mainly touches flip-score inputs.
- Open question, not a bug: does inherited settle-flow in the first ~90s help
  (settle flow is informative) or hurt? Needs more boundaries.

## 8. Component early reads (rem≤120/≤60 sign vs settle, n=11 bars of first pass)

- `imb_ewma`: best mid-bar direction input (9/11 at rem≤120) but 4/11 late —
  same story as the tag.
- `perp_spot_div`: mildly positive (7/11 late). `cvd_d3m`, `cvd_d60`, `mom_z`:
  ~coin-flip so far. `large_prints`: zero most ticks (sparse by nature — judge
  on flip bars specifically, where it showed the right sign in the one true
  alert case).
- `cvd_d3m` is logged but intentionally NOT in the flip math (overlaps d60 /
  large_prints; adding it before data exists would be tuning blind).

## 9. Known quirks (recorded at final review — do not "clean up" without discussion)

- Alert relabel: with p in (0.5, 0.6] the alert counter neither increments nor
  resets, so a standing alert can relabel direction without fresh persistence
  (`signals.mjs` alert block). Never observed in these 14 bars.
- Warmup gates **momentum only** — the imbalance decision can enter UP/DOWN
  before 60s (and usually does, ~10–25s in).
- `vol_1m == 0.0` from the VM would bypass the `volFromHist` fallback and clamp
  to $1 (irrelevant for BTC; matters for quiet symbols).
- VM POST logs land as `<slug>_v51.json`; browser download uses `_v5.1_log.json`.

## 10a. Deep dive at 20 bars (2026-07-02) — counterfactual replay results

Full report: `v5.1/analysis/2026-07-02-deepdive-20bars.md` (fidelity-gated replay of the
real engine over 20 Polymarket-verified bars; ~250 variants swept under the
keep-transitions-low + no-stealth-gating constraints).

- Baseline (replayed stock): acc 70.8%, fire-worthy coverage 50.6%, 5.85 trans/bar, 26 wrong episodes.
- **Dominant failure: counter-cushion entries** (18/26 wrong episodes; 601 wrong-side ticks).
- **Ranked candidates (validate forward before adopting):**
  1. Counter-cushion confirmation (entries against cushion need momentum OR whale-print corroboration): acc **+8.6pts**, wrongEp 26→15, transitions down.
  2. Cushion-aligned asymmetric ENTER (~0.12 when aligned): coverage 57→80%+ stacked with #1. Cost: first-fire accuracy 70→55%.
  3. Binance-weighted comb (W_BIN 0.75–0.9).
  4. Slower/stickier params (ALPHA 0.04 / DWELL 10 / EXIT 0.05); flagship combo: **acc 77.5% / cov 82.3% / 2.40 trans / 13 wrongEp**, LOBO-stable ±2pts.
  5. Alert min-|cushion| gate ($5–15) — directionally validated only.
- **Not recommended:** momentum re-parameterization (no tag effect — it's a confirmer, not a catcher), d10 dead-zone tie-break (worse), flip-weight tuning (too few events).
- **Structural gap found (bar …5000):** the flip-prior `Φ(−|cushion|/vol·√t)` collapses late-bar, so flow-led snap-back flips can't alert even when d60/cvd_3m/whale prints all lean the right way for a full minute. Design work, needs more late-flip examples.

## 10b. v5.3 shipped (2026-07-02) — the deep-dive candidates, gated

v5.3 (fork of v5.1) implements the user-chosen **max-accuracy profile**: counter-cushion
confirmation + aligned entry 0.14 + hold-release 15 (the third rule discovered from OOS bar
`btc-updown-5m-1782985200`, where the book stayed decoupled from a +$275 rally for a full bar).
Acceptance gate (`v5.3/analysis/replay-compare.mjs`, real modules, 28 bars): tuning 80.1%
acc / 17 wrongEp (exactly reproducing the harness prediction); out-of-sample (8 bars)
**80.8% vs v5.1's 50.2%**, wrongEp 9→5. v5.1 remains frozen as the baseline; §10's 50-bar
re-measurement list still applies to v5.3's constants (now data-fit, no longer priors).

## 10. What to re-measure at 50+ bars before any tweak

1. Late-bar tag behavior — does the 43% final-60s number hold? (drives the
   cushion-gate discussion, §2)
2. p_flip calibration curve above 0.2 — enough flip bars to fit/tune weights?
3. Alert precision/lead-time, split by |cushion| at fire time (§6)
4. First-signal accuracy by firing delay (§4)
5. Persistence composite (run age × cushion agreement) out-of-sample (§3)
6. Boundary bleed with enough flip-after-trend boundaries to matter (§7)
7. Component lead/lag on actual flip bars — which input moves first (§8)

## 10c. v5.4 shipped (2026-07-02) — the 52-bar low-hanging-fruit audit

Full findings: `v5.4/analysis/2026-07-02-lhf-52bars.md`. Method: per-tick ledger (14,618 ticks,
52 Polymarket-verified bars) -> 4 parallel evidence agents -> 33 counterfactual variants ->
binary dominance filter + LOBO. ONE winner: **BAFO** (+482 correct / -9 wrong / -473 missed /
0 bars hurt / LOBO 52/52). Notable rejections with numbers: dwell-shortening (statically
predicted 7.5:1, dynamically -2.6% correct, 20 bars hurt); lp-corroborator suppressors
(aggregate inversion is REAL — lp-corroborated counter fires run 9-14% — but removal erases
100% of correct ticks on 3 late-flip bars); DZ_RESCUE/DUAL_CORR/HZ10 stacks (near-misses,
fail LOBO wrong-not-increased by 1-3 ticks — retest when the dataset doubles).
