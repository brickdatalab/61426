# v6 — First Live Session: 16 Bars (2026-07-05, 19:15–20:35 UTC)

First live read on the shipped v6 engine. n=16 is an early sample — everything here is directional; Wilson 95% CI on the headline accuracy is ~44–86%. Logs: `btc-updown-5m-1783278600_v6.json` … `1783283400_v6.json` (VM `logs/`, staged in `AUTOPSY/logs/`). Grading scripts were session-scratchpad; every number below was produced by script, then the settle side independently re-verified against Polymarket.

## Headline

- **Coverage 16/16** — every settled bar produced a latched EARLY CALL (the always-call mandate held live).
- **11/16 (68.8%) correct vs our own settle records; 10/16 (62.5%) vs Polymarket's actual payouts** — the difference is one razor-thin bar where our settle and Polymarket's resolution disagree (below).
- Replay fidelity: side and tier match a real-engine replay of the logged inputs **16/16**; only latch-timing granularity differs (≤2s, display rounding of `rem`).

## SETTLE MISMATCH — first ever observed (lifetime was 192/192 before this)

`btc-updown-5m-1783282200`: our log settled **DOWN** (open 62820.00, close 62816.64 — a $3.36 move; internally consistent), but Polymarket UMA-resolved **UP** (`outcomePrices ["1","0"]` on outcomes `["Up","Down"]`, closed 20:15:53 UTC). On near-flat bars the settlement oracle's reference price can disagree with our Binance-spot capture by a few dollars. Consequences:

1. Our engine's call on that bar (DOWN, lean) graded "correct" against our own settle and **lost the actual market**.
2. Any accuracy number in this project carries this hazard on near-flat bars. All prior verification (192/192, incl. the 140-bar mirror set) matched — this is the first divergence, observed on a $3.36 bar.
3. **Open follow-up (not yet implemented):** grade against Polymarket resolutions instead of (or alongside) our close-vs-open when `|close − open|` is small; candidate rule: always fetch the Gamma resolution when the move is under ~0.5× the vol floor.

The 16th bar (`1783283400`) showed Gamma `closed:false` at check time with implied 0.995 UP — consistent with our UP settle, formally pending only.

## Grading table

| slug (…5m-) | firstRem | latch rem | side | tier | our settle | Polymarket | correct (PM truth) |
|---|---|---|---|---|---|---|---|
| 1783278600 | 180 (late) | 179 | DOWN | lean | UP | UP | ✗ |
| 1783279200 | 274 | 210 | DOWN | lean | DOWN | DOWN | ✓ |
| 1783279500 | 295 | 209 | DOWN | lean | UP | UP | ✗ |
| 1783279800 | 296 | 209 | UP | lean | UP | UP | ✓ |
| 1783280100 | 296 | 210 | DOWN | lean | DOWN | DOWN | ✓ |
| 1783280400 | 297 | 209 | DOWN | lean | UP | UP | ✗ |
| 1783280700 | 282 | 177* | DOWN | lean | DOWN | DOWN | ✓ |
| 1783281000 | 291 | 209 | DOWN | lean | DOWN | DOWN | ✓ |
| 1783281300 | 287 | 208 | DOWN | lean | DOWN | DOWN | ✓ |
| 1783281600 | 294 | 188* | UP | lean | DOWN | DOWN | ✗ |
| 1783281900 | 296 | 210 | UP | lean | UP | UP | ✓ |
| 1783282200 | 297 | 209 | DOWN | lean | DOWN | **UP** | **✗ (settle mismatch)** |
| 1783282500 | 296 | 210 | UP | lean | DOWN | DOWN | ✗ |
| 1783282800 | 247 | 210 | UP | lean | UP | UP | ✓ |
| 1783283100 | 296 | 209 | DOWN | **strong** | DOWN | DOWN | ✓ |
| 1783283400 | 295 | 210 | UP | lean | UP | (pending, implied UP) | ✓ |

\* delayed latch — see tick-delivery finding.

## Tier summary vs the shipped expectations (basis doc §5)

| Tier | n | acc (our settle) | basis pooled | basis live |
|---|---|---|---|---|
| strong | 1 | 1/1 | 87.0% | 96.2% |
| qualified | 0 | — | 80.0% | 84.6% |
| lean (non-late) | 14 | 10/14 = 71.4% | 59.6% | 62.0% |
| late | 1 | 0/1 | 83.3% (n=6) | — |

- Lean running above its measured rate — n=14 noise until proven otherwise.
- **Zero qualified calls in 16 bars**: P(0/16) ≈ 16% under the pooled qualified rate — plausible, on the watch list.
- Priced-in: median implied of the called side at latch **61.5¢** (all 16 had poly_mid); raw accuracy 68.8% — directionally positive edge vs implied in this sample, opposite sign from the basis lean finding; n=16 resolves nothing.

## Behavior findings

1. **Latch semantics correct**: 14/16 latched within 0–2s of the rem-210 mark. The late-connect session (`1783278600`, firstRem 180) took the keep-evaluating path for exactly one tick (cushion/imbEwma null) then latched — as designed.
2. **Tick-delivery gaps on 2/16 bars** (`1783280700` latched rem 177, `1783281600` rem 188): wall-clock gaps of 29–70s between log rows (rem jumps 277→248→177; 231→214→188). On `1783281600` the call was fully determinable at rem 214 — no tick arrived until 188. This is the known **Chrome background-tab throttling signature** (same failure that invalidated the 2026-07-02 v5.4 A/B), not an engine defect. Operational rule: keep the v6 tab focused/visible or the early call loses its lead time.
3. **Logging gap**: the engine computes `late` on the latched call but the log row only persists `early_call`/`early_tier` — lateness must be reconstructed from the log's first-row rem. Candidate one-line dashboard fix: persist `early_late` (display/logging layer, no signal change).
4. **Lean-stream sanity**: transitions 1–6/bar (avg 3.19), no zero-signal bars — inside the expected band, low end.

## Verdict

v6 is doing what it was measured to do: full coverage, correct latch semantics, replay-faithful calls, tier behavior consistent with the shipped table at this sample size. The two real items to carry forward: **(a) the settle-oracle divergence on near-flat bars** — grade vs Polymarket resolutions when the move is tiny; **(b) tab throttling still degrades tick delivery** — an operational constraint until time-based hardening (SUMMARY "tick-vs-time semantics" open item) is addressed. Re-grade at ~100 live v6 bars alongside the v6.1 earlier-mark sweep.

---

## HIGH CONVICTION lock — why 8 were right and 4 were wrong (added 2026-07-05)

Separate from the EARLY CALL channel above, this section analyzes the **HIGH CONVICTION flash** (the run-based lock card, unchanged from v5.4 in v6). Reconstructed from logged fields with the verbatim dashboard formula (`sigRun≥31 AND signal agrees with cushion sign AND |cushion| ≥ max($10, 0.5·vol_1m)`). Of the 16 bars, 13 locked; 12 locked a single direction (the 13th, `1783279800`, locked BOTH directions — an inherent stability failure, set aside). Of the 12: **8 accurate** (lock dir = settle), **4 wrong**. All 12 settle directions independently re-confirmed against Polymarket Gamma — **12/12 MATCH**. n=12 (8 vs 4): descriptive, not statistically conclusive.

The 12:
- Accurate (8): 1783278600, 1783279200, 1783280100, 1783281000, 1783281300, 1783281900, 1783282500, 1783283100
- Wrong (4): 1783280400, 1783280700, 1783281600, 1783283400

### Headline (counter to the prior)
The 4 wrong locks were **not lower-quality at the moment they fired**. They fired on cushions that were, if anything, **fatter** than the correct ones (onset ratio: wrong min 1.74× / med 2.0× vs accurate min 1.04× / med 1.59×), with flow mostly agreeing and unanimous book imbalance — at fire time they are essentially indistinguishable from the winners. **What separated the groups is entirely post-lock: the market reversed after the lock.**

### Discriminators tested against all 12
| Candidate | Accurate (8) | Wrong (4) | Verdict |
|---|---|---|---|
| Cushion ratio at lock onset (primary hypothesis) | min 1.04× / med 1.59× | min 1.74× / med 2.0× | **REFUTED** — wrong locks were *fatter* at onset |
| Flow (cvd_d3m) agrees at onset | 5/8 | 3/4 | No separation |
| Book imbalance agrees at onset | 8/8 | 4/4 | No separation (trivially required) |
| **Cushion crossed to opposite side after lock** | **0/8** | **3/4** | **CLEANEST SEPARATOR** |
| Cushion grew by close | 6/8 | 0/4 | Strong, not perfectly clean (2 accurate shrank *without* crossing) |
| p_flip after lock stayed elevated | decays to ~0 (8/8) | med ~0.40, stayed nervous | Real trend — the engine's own flip channel "knew" |

The clean line: an accurate lock's cushion never crosses zero (0/8); a wrong lock's crosses zero before settle (3/4). The 4th wrong bar is the sole exception, explained below.

### The 4 wrong bars, by failure mode
- **1783281600** (UP→DOWN) — the only "engine could have caught it" case. Locked UP at rem 214 while 3-min flow was −$336k and since-open negative — bought by short 60s flow + book while the deeper tape was already against it. This is ENGINE_PROBLEMS **Problem 1** (lock ignores opposing flow). Settled DOWN by $1.98.
- **1783280700** (UP→DOWN) and **1783283400** (DOWN→UP) — genuine intra-bar reversals. Well-supported fat locks (2.41×, 2.0×, flow agreeing, one with a confirming whale print) overrun by a large late surge (1783283400's since-open flow swung ~$972k in the final 30s). Not foreseeable at lock time.
- **1783280400** (DOWN→UP) — not a signal failure. Cushion held DOWN (−17.44) through the last logged tick; the flip to UP happened in the final ~20s outside the log. Same near-flat settle-divergence family as the 1783282200 bar.

### The "one clean thing" question — cushion crossing back through the open
As a **hindsight classifier**, cushion-crosses-zero separates the groups (0/8 vs 3/4) and would touch none of the 8 winners. But as a **live rule** it is the "stop flashing / stop calling it high conviction once price crosses back through the open" version, NOT "never flash." At the moment they lit up, the wrong locks looked identical to the winners — they earned the flash and went bad later. And the crossing itself is late: on the three real bars it happened 22s, 11s, and ~2s before close — i.e. it retracts the flash once the reversal is essentially already the outcome. As **cleanup** (stop showing a confident wrong call at the buzzer) it's clean and free on the winners; as **loss-prevention with lead time** it fires too late on 2 of 3 on its own.

### Slope / progression analysis — was the reversal an instant snap or gradual?
Measured per-tick from lock onset to close (cushion + `cush_d10` 10s slope + flow). Correction to an earlier overstatement that the reversals had "no warning":
- **1783283400 — gradual, ~15s of warning.** Cushion slid −20 → −16.6 → −11.8 → −7.4 → −4.4 → −3.2 → +1.9 (cross at rem 22), monotonic over ~15s; `cush_d10` flipped hard against the DOWN lock (+3.4 → +15.6) the whole way while flow surged −$144k → +$827k.
- **1783281600 — gradual final leg, ~18s.** Held +17 for over a minute, then +17 → +8.7 → +5.8 → +3.4 → +0.5 → cross over ~18s, `cush_d10` −8 to −11.5; and 3-min flow was already negative at lock.
- **1783280700 — cushion snapped (~1 tick: +9.7 → −6.3, `cush_d10` −17.6), but flow gave ~68s of warning.** `cvd_since_open` bled +$51k → +$2k → −$10k → −$111k → −$229k while price stubbornly held +17 — textbook absorption; the engine's own p_flip did tick 0.21 → 0.30.

So lead time IS real: 15–20s via the cushion slope on two bars, ~60–70s via diverging flow on the third.

**But the fix is not free — the clean separation breaks on the winners.** Accurate bar **1783281000** was a correct DOWN lock whose cushion compressed just as hard (−20 → −11.5 → −5.95, `cush_d10` +8.5 against its own lock) and whose flow even flipped positive (since-open swung to +$210k) — and it still settled DOWN. It carries the same adverse-slope-plus-flow-flip signature as the losers and was right. A "downgrade the lock on adverse cushion slope / flow divergence" rule would cost this winner, or force a threshold tuned to n=1.

### Actionable conclusion (v6.1 candidate)
- 3 of 4 misses are late reversals a static-at-fire-time signal cannot see; only 1 (1783281600) had an at-onset tell (opposing flow — the Problem 1 flow-veto), and 1 (1783280400) isn't a signal failure at all.
- The under-used early-warning is the engine's own **p_flip** channel (decays to ~0 on winners, stays elevated on losers) plus the **cushion slope / flow divergence** — all *dynamic*, not static-at-onset. The lock ignores all of them today.
- **Direction of the fix is supported; the threshold is not.** A dynamic downgrade rule (drop/soften the lock when p_flip stays high AND the cushion slope or flow turns against it) is the natural v6.1 candidate — but the threshold that catches the 3 losers without killing winners like 1783281000 can only be found on ≫12 bars. Revisit at BQ scale.

---

## First-call vs second-call behavior — all 25 v6 logs (added 2026-07-06)

Expanded to the full 25 v6 logs (16 first-session + 9 later, all settle-verified against Polymarket; two near-flat settle-divergence bars corrected to Polymarket's resolution: `1783282200`→UP, `1783284300`→UP). A "call" = a contiguous directional run in the `signal` field; two same-direction calls are counted separately only when a MIXED sits between them.

**First-signal accuracy across all 25: 12/25 = 48.0%** (all 25 produced a directional signal; median onset ~rem 285–290, i.e. ~10–15s into the bar, on raw book imbalance before flow/momentum/cushion exist). This is *below* the historical 140-bar first-signal rate (~66%); n=25 (95% CI ≈ 30–66%). It is the "act at ~14 seconds" number and is exactly why the EARLY CALL channel waits to the 90s mark instead.

### Call-structure groups (partition all 25)

| Group | n | first-call acc | second-call acc |
|---|---|---|---|
| Q1a — switched via MIXED (dir → MIXED → opposite) | 6 | 33.3% (2/6) | **66.7% (4/6)** |
| Q1b — switched DIRECT (UP↔DOWN, no MIXED, both very early) | 2 | 50% (1/2) | 50% (1/2) |
| Q2 — reaffirmed (dir → MIXED → SAME dir) | 11 | 45.5% (5/11) | 45.5% (5/11) — identical by construction |
| one-call-only (committed once, never reconsidered) | 6 | **66.7% (4/6)** | (no second call) |

Q1 totals: 8 bars switched first→second; **6 of the 8 switched via MIXED, 2 switched directly tick-to-tick** (both direct flips were in the first ~20–40s: `1783282200` UP@290→DOWN@248, `1783346100` UP@289→DOWN@269).

### What the splits say
- **Best behavior = commit-and-hold (66.7%)** and **flip-away-from-a-wrong-first-call (Q1a second call, 66.7%)**. When the engine abandoned a bad first call through MIXED and reversed, the reversal was right 4 of 6 times.
- **Worst behavior = Q2 reaffirmation.** Going to MIXED and then re-committing to the SAME direction added nothing (45.5% both times); when the reaffirmed call was wrong it stayed wrong — 6 of 11 were wrong round-trips (the engine returned to a losing side after having the chance to drop it). This is the single largest pool of burned calls.
- Second-opinion value is real but concentrated: across the 19 bars that produced a second call, second-call accuracy 10/19 = 52.6% vs first-call 8/19 = 42.1% — but nearly all the lift came from the 6 bars that actually SWITCHED direction, not the 11 that reaffirmed.

### Candidate implication (not yet a rule)
The reaffirmation loop (Q2) is where the engine wastes its second look. A dir→MIXED→same-dir return that carries no new corroboration is worth no more than the original call and, when wrong, is sticky. This echoes the conviction-lock finding (the wrong locks were reasonable at fire time and went bad later) and the hold-release intent (Problem 2). Worth measuring at BQ scale: does requiring fresh corroboration (flow/whale/p_flip improvement) to *re-commit* after a MIXED gap filter the wrong round-trips without harming the correct commit-and-hold bars? n here is too small (11) to set a threshold.
