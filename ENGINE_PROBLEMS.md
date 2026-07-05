- Flips in the final 60 seconds: 3/10 correct (30%) on v5.3, 4/10 (40%) on v5.4 — actively worse than doing nothing.

First vs Second Signal — accuracy against settled direction (140-bar set)

┌───────────────────────────┬────────────────┬────────────────┐
│                           │      v5.3      │      v5.4      │
├───────────────────────────┼────────────────┼────────────────┤
│ 1st signal matched settle │ 79 / 120 → 66% │ 80 / 121 → 66% │
├───────────────────────────┼────────────────┼────────────────┤
│ 2nd signal matched settle │ 71 / 92 → 77%  │ 75 / 96 → 78%  │
└───────────────────────────┴────────────────┴────────────────┘

              v5.3                          v5.4
1st signal    ██████████████████░░░░░░ 66%   ██████████████████░░░░░░ 66%
2nd signal    ██████████████████████░░ 77%   ███████████████████████░ 78%

Denominators differ because not every bar produces each call: 20/19 bars never fired at all (mostly short stubs), and 48/44 bars never made a second call — those are excluded from their respective rows, not counted as misses.

The takeaway sitting in this table: the engine's second opinion is worth ~11 points more than its first — the first call fires in the opening seconds on raw book imbalance alone; the second call comes after the bar has real structure (flow history, warmed-up momentum, an actual cushion) and is right closer to 4-in-5 than 2-in-3. True for both versions, since they're near-identical this early in a bar.

HIGH CONVICTION flash vs settled direction — first flash of the bar (140-bar set, locks replayed from logged fields)

The 2×2 (separating engine effect from gate effect):

┌────────────────────┬───────────────────────────────────┬─────────────────────────────────────┐
│                    │ sign-only lock (v5.3's card rule) │ magnitude-gated (v5.4's card rule)  │
├────────────────────┼───────────────────────────────────┼─────────────────────────────────────┤
│ v5.3 signals       │ 78% (82/105)  ← v5.3 live card    │ 80% (78/98)                         │
├────────────────────┼───────────────────────────────────┼─────────────────────────────────────┤
│ v5.4 signals       │ 79% (85/108)                      │ 80% (81/101)  ← v5.4 card           │
└────────────────────┴───────────────────────────────────┴─────────────────────────────────────┘

Headline: when the card first flashes, it's right ~78–80% — both versions; the current magnitude gate buys only ~2 points. The flash is COMMON, not special: 105 of 140 bars (75%) flash at some point.

Where the flash is actually money (first-flash slices):

┌──────────────────────────────────────────┬───────────────┬───────────────┐
│ condition at first flash                 │ v5.3 card     │ v5.4 card     │
├──────────────────────────────────────────┼───────────────┼───────────────┤
│ cushion ≥2× the vol floor                │ 98% (43/44)   │ 94% (50/53)   │
│ cushion 1–2× floor                       │ 65%           │ 65%           │
│ cushion <1× floor                        │ 63%           │ (gated out)   │
│ onset with 180–60s left                  │ 95%           │ 92%           │
│ onset very early (rem ≥180s)             │ 74%           │ 74%           │
│ lock held unbroken to settle             │ 100% (8/8)    │ 100% (13/13)  │
│ end-of-bar flash (lit at close)          │ 90%           │ 89%           │
└──────────────────────────────────────────┴───────────────┴───────────────┘

PROBLEM: v5.4's magnitude gate is set too low. It requires cushion ≥1× the vol floor, but the 1–2× tier it admits is only 65% accurate — barely better than the ungated junk (63%) it was built to remove. Nearly all real conviction lives at ≥2× the floor (94–98%). Candidate fix (display-layer only): raise the gate from 1× to 2× — the card would flash in roughly a third of bars instead of three-quarters, at ~19-out-of-20 accuracy.

Robustness: dedupe sensitivity pass (1 row/sec, corrects pre-2026-07-03 duplicated-row inflation) moves headlines ±1 point (79%/81%) — no conclusion changes. Note: the folklore "96%" was per-tick accuracy of the locked STATE (run ≥31 aligned), not the first-flash moment — different metric, both now measured.

---

# THE THREE MAJOR ENGINE PROBLEMS — v6 TUNING TARGETS
*(documented 2026-07-05 · evidence base: 42 Polymarket-verified bars, 71 wrong directional episodes, 39 pattern-flagged instances across 21 bars · every number below regenerated from the deterministic extractor (`~/.claude/skills/autopsy/scripts/autopsy_data.py`) over the staged logs in `AUTOPSY/logs/` · full per-bar case files in `AUTOPSY/<slug>.md`)*

Scope note, stated plainly: these dossiers cover only the CLASSIFIED wrong episodes. The remaining wrong episodes are unclassified — chiefly the converged-then-reversed shape (every input agreed at entry and the market genuinely turned afterward) and the split-flow shape (cvd_d3m and cvd_since_open opposed each other at entry; the engine has no tie-break) — and are recorded in the individual autopsies, not here. The flags mark wrong episodes only; correct episodes matching the same entry geometry exist and are not counted in these tables, so no table below is a hit-rate. Class hit-rates come from the separate replay measurements cited in each dossier.

## PROBLEM 1 — `thin-aligned-vs-flow` (21 wrong-entry instances, 13 bars)

**Mechanism (engine behavior as measured, not speculation):** the v5.3/v5.4 aligned-entry rule lowers the book-EWMA entry threshold from 0.20 to 0.14 whenever the candidate direction matches the cushion's SIGN. The rule checks sign only. It never checks cushion MAGNITUDE against the vol floor (max($10, 0.5 × vol_1m)) and it never checks flow direction — `cvd_d3m` has no veto over an aligned entry. Result: a cushion of $0.71 receives the same entry discount as a cushion of $60, and the entry fires even when three minutes of net flow are running hundreds of thousands of dollars the opposite way. Every instance below is a WRONG directional episode that entered aligned on a sub-floor cushion (ratio < 1×; a row displaying 1.00× is rounded up from just under 1) while `cvd_d3m` at entry ran opposite the call.

**Aggregates (this set):** 21 instances across 13 bars · **1,047 wrong signal ticks** spent inside these episodes · cushion ratio at entry: min 0.04× / median 0.59× / max 1.00× the vol floor · opposing cvd_d3m at entry: min $72,377 / median $357,546 / max $8,235,091. Context rates already measured elsewhere: thin-cushion states run 63–65% everywhere we've measured them (entries, conviction locks); the worst single specimen here went 0-for-4 in one bar (`1783034400`) against flow that never changed sign all session.

| log file | ep | rem | called | cushion@entry | ratio | opposing d3m@entry | wrong ticks |
|---|---|---|---|---|---|---|---|
| btc-updown-5m-1782988500_v53.json | 2 | 289→183 | DOWN | -3.15 | 0.32× | +169,173 | 107 |
| btc-updown-5m-1782997800_v53.json | 2 | 236→205 | DOWN | -13.45 | 0.73× | +82,929 | 32 |
| btc-updown-5m-1783004700_v53.json | 2 | 289→269 | UP | 13.37 | 0.61× | -8,235,091 | 18 |
| btc-updown-5m-1783005000_v53.json | 2 | 287→252 | DOWN | -16.01 | 0.68× | +580,700 | 36 |
| btc-updown-5m-1783005300_v53.json | 6 | 83→64 | UP | 41.07 | 1.00× | -1,176,333 | 20 |
| btc-updown-5m-1783010400_v53.json | 2 | 288→269 | DOWN | -19.99 | 0.97× | +4,084,186 | 20 |
| btc-updown-5m-1783015500_v53.json | 2 | 289→271 | DOWN | -2.72 | 0.27× | +870,880 | 19 |
| btc-updown-5m-1783015500_v53.json | 4 | 241→220 | DOWN | -0.71 | 0.06× | +982,763 | 22 |
| btc-updown-5m-1783026300_v53.json | 2 | 272→220 | UP | 7.03 | 0.70× | -578,507 | 106 |
| btc-updown-5m-1783026300_v53.json | 10 | 93→64 | UP | 6.43 | 0.64× | -92,046 | 59 |
| btc-updown-5m-1783033500_v53.json | 2 | 288→268 | DOWN | -0.38 | 0.04× | +472,049 | 41 |
| btc-updown-5m-1783033500_v53.json | 4 | 244→232 | DOWN | -5.86 | 0.59× | +461,747 | 24 |
| btc-updown-5m-1783033500_v53.json | 7 | 173→27 | DOWN | -8.12 | 0.81× | +357,546 | 54 |
| btc-updown-5m-1783034400_v53.json | 2 | 289→220 | DOWN | -4.84 | 0.48× | +116,796 | 140 |
| btc-updown-5m-1783034400_v53.json | 4 | 213→196 | DOWN | -4.66 | 0.47× | +151,027 | 34 |
| btc-updown-5m-1783034400_v53.json | 7 | 128→115 | DOWN | -6 | 0.42× | +72,377 | 28 |
| btc-updown-5m-1783034400_v53.json | 9 | 92→80 | DOWN | -2.71 | 0.19× | +178,199 | 25 |
| btc-updown-5m-1783040100_v53.json | 2 | 289→257 | UP | 12.14 | 0.89× | -728,007 | 33 |
| btc-updown-5m-1783092900_v53.json | 4 | 227→103 | UP | 9.65 | 0.97× | -107,993 | 125 |
| btc-updown-5m-1783188300_v53.json | 2 | 289→220 | UP | 3.29 | 0.33× | -180,114 | 70 |
| btc-updown-5m-1783188300_v53.json | 7 | 102→69 | UP | 3.29 | 0.18× | -297,480 | 34 |

**Distinct source logs (13):** `btc-updown-5m-1782988500_v53.json`, `btc-updown-5m-1782997800_v53.json`, `btc-updown-5m-1783004700_v53.json`, `btc-updown-5m-1783005000_v53.json`, `btc-updown-5m-1783005300_v53.json`, `btc-updown-5m-1783010400_v53.json`, `btc-updown-5m-1783015500_v53.json`, `btc-updown-5m-1783026300_v53.json`, `btc-updown-5m-1783033500_v53.json`, `btc-updown-5m-1783034400_v53.json`, `btc-updown-5m-1783040100_v53.json`, `btc-updown-5m-1783092900_v53.json`, `btc-updown-5m-1783188300_v53.json`

## PROBLEM 2 — `inverted-whale-corroborator` (9 wrong-entry instances, 7 bars)

**Mechanism:** rule 2 (counter-cushion confirmation) blocks entries that fire AGAINST the price lead unless a corroborator agrees — momentum or `large_prints`. Momentum is FLAT on ~95% of ticks, so in practice the whale-print door is the corroborator. Measured in the 52-bar audit: whale-'confirmed' counter-cushion fires run **9–14% accurate** — the signal is inverted for this use. Worse, the same signal IMMUNIZES the wrong fire it admitted: rule 3 (hold-release) kills uncorroborated counter-holds after 15 ticks, but its counter resets on every tick that `large_prints` keeps 'backing' the held side — so a persistent whale print both opens the door and holds it open. Every instance below is a WRONG counter-cushion entry admitted by whale prints against an opposing cushion at ≥1× the vol floor (the flag deliberately marks only the fat-opposing-cushion subset — the worst of the class, where the price lead being fought was real).

**Aggregates (this set):** 9 instances across 7 bars · **415 wrong signal ticks** · opposing-cushion ratio being fought: min 1.44× / median 2.68× / max 5.14× the floor · escalation specimen: `1783034100` fired wrong THREE times at 2.05×, 4.30×, 5.14× — leaning harder into the wrong call exactly as the true signal grew more reliable. Prior live specimen outside this set: the 2026-07-02 tab-throttled bar.

| log file | ep | rem | called | opposing cushion@entry | ratio | lp range in episode | wrong ticks |
|---|---|---|---|---|---|---|---|
| btc-updown-5m-1782986400_v53.json | 2 | 131→74 | UP | -64.01 | 4.67× | 179,966..445,911 | 58 |
| btc-updown-5m-1782997800_v53.json | 5 | 90→0 | DOWN | 67.55 | 3.71× | -99,536..-99,536 | 90 |
| btc-updown-5m-1782999000_v53.json | 4 | 120→98 | DOWN | 57.13 | 1.44× | -54,087..58,635 | 22 |
| btc-updown-5m-1783005000_v53.json | 6 | 131→70 | DOWN | 46 | 2.20× | -623,232..-212,049 | 62 |
| btc-updown-5m-1783014900_v53.json | 2 | 289→256 | UP | -21.09 | 1.54× | 6,888..6,888 | 34 |
| btc-updown-5m-1783017900_v53.json | 5 | 14→1 | DOWN | 75.99 | 2.68× | -168,073..-168,073 | 14 |
| btc-updown-5m-1783034100_v53.json | 2 | 210→200 | DOWN | 20.46 | 2.05× | -712,174..-712,174 | 20 |
| btc-updown-5m-1783034100_v53.json | 4 | 173→158 | DOWN | 49.71 | 4.30× | -712,174..-552,167 | 31 |
| btc-updown-5m-1783034100_v53.json | 6 | 148→106 | DOWN | 51.42 | 5.14× | -306,759..-306,759 | 84 |

**Distinct source logs (7):** `btc-updown-5m-1782986400_v53.json`, `btc-updown-5m-1782997800_v53.json`, `btc-updown-5m-1782999000_v53.json`, `btc-updown-5m-1783005000_v53.json`, `btc-updown-5m-1783014900_v53.json`, `btc-updown-5m-1783017900_v53.json`, `btc-updown-5m-1783034100_v53.json`

## PROBLEM 3 — `late-deadzone-release` (7 instances, 7 bars)

**Mechanism:** when the smoothed book pressure decays inside the dead zone (|imbEwma| < EXIT = 0.08), the tag releases to MIXED — unconditionally. The release logic never consults the cushion. So when the order book goes quiet late in a bar (which it routinely does), the engine drops a correct directional call and sits silent while a fat, correct-side price lead sits on the board — ignoring the single most reliable late-bar input ever measured on this project (final-60s cushion sign alone ≈96%; fat-cushion states 94–98%). Each instance below is a bar whose FINAL episode was ≥15 consecutive MIXED ticks with a correct-side cushion ≥2× the vol floor: pure missed fires at the moment of highest certainty.

**Aggregates (this set):** 7 instances (one per bar, by construction — the flag marks the bar's closing silence) · **645 silent ticks** with a fat correct-side cushion on the board · |cushion| at close: min $31.25 / median $74.01 / max $201.60 · longest silence: 229 ticks (`btc-updown-5m-1783001400`). BAFO note (factual, from the v5.4 mirrors): BAFO recovered part of two of these windows (27 of 56 silent ticks on `1783093800`; 82 diff ticks on `1783001400` against its 229-tick window) and none of the others — a DEAD book is not a DISSENTING book, so BAFO's precondition usually never arms here.

| log file | final MIXED window (ticks) | rem span | cushion at close | settle | v5.4 diff ticks on bar |
|---|---|---|---|---|---|
| btc-updown-5m-1782986400_v53.json | 42 | 41→0 | -74.01 | DOWN | 0 |
| btc-updown-5m-1782998400_v53.json | 171 | 171→0 | 93.82 | UP | 0 |
| btc-updown-5m-1783001400_v53.json | 229 | 229→0 | 201.6 | UP | 82 |
| btc-updown-5m-1783005000_v53.json | 62 | 68→1 | 40.42 | UP | 0 |
| btc-updown-5m-1783005300_v53.json | 25 | 24→0 | -72.42 | DOWN | 0 |
| btc-updown-5m-1783040100_v53.json | 60 | 59→0 | -31.25 | DOWN | 0 |
| btc-updown-5m-1783093800_v53.json | 56 | 141→84 | 92.89 | UP | 27 |

**Distinct source logs (7):** `btc-updown-5m-1782986400_v53.json`, `btc-updown-5m-1782998400_v53.json`, `btc-updown-5m-1783001400_v53.json`, `btc-updown-5m-1783005000_v53.json`, `btc-updown-5m-1783005300_v53.json`, `btc-updown-5m-1783040100_v53.json`, `btc-updown-5m-1783093800_v53.json`

*(Fourth flagged class for completeness: `late-hard-flip` — 2 flagged instances in this set — already documented at the top of this file: final-60s flips run 3/10 and 4/10 correct.)*
