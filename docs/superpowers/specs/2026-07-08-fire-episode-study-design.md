# Fire-Episode Conviction Study — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Answer, with numbers, the operator's exact question — *when a bar fires multiple directional runs, which fire do you trust at the moment it fires* — and turn the answer into a flat-stake betting decision card with positive held-out ROI at real Polymarket prices, or an honest documented null.

**Architecture:** Change the unit of analysis from tick to **fire episode** (a directional run of the v8 stream). Extract every episode from ~900 BQ bars (replayed through the real engine) + 72 live logs with its full at-trigger feature vector and sequence context; answer the sequence/timing questions descriptively; test **pre-registered** discriminator hypotheses walk-forward; price everything at the Polymarket price of the fired side at trigger time. The one genuinely unmeasured edge slice — **disagreement fires** (engine says D while the market still prices the other side; entry is cheap; this is "predictive before priced in" made literal) — gets its own dedicated measurement.

**Tech Stack:** Node ESM (real-engine replay capture), Python 3.13 venv (numpy/sklearn, existing `v8/analysis/.venv`), GLM-5.2 workers for bulk script drafts, existing artifacts reused: `v8/analysis/data/bars/` (823 full-tick bars), `matrix.npz` + `features_manifest.json` (40 features at 5s tick marks), `21_replay_engine_fields.mjs` pattern, `30_scoring.py` loaders.

## Global Constraints

- **Anti-hindsight is absolute:** every bet-time feature is computed at or before the trigger tick. Run length, how-the-run-ended, and settle are outcome descriptors — allowed in the "when was it right" map, BANNED from the decision card's conditions.
- **Pre-registration:** the hypothesis list in Task 3 is frozen in this plan BEFORE any result is computed. Anything discovered post-hoc goes to a "next-batch candidates" appendix, never onto the decision card.
- **Walk-forward only:** select on BQ days 1–2, validate on BQ days 3+ (untouched), confirm on the 72 live logs as a second distribution. No tuning on the full pool (the v7 mirage rule).
- **ROI is the metric:** win rate minus price paid at trigger. Evens-P&L is reported once for reference, never optimized.
- **Engine untouched.** This is analysis; any productization (conviction badge) is a separate, later, discussion-first task.
- Version isolation, `git pull --rebase --autostash` before pushes, artifacts under `v8/analysis/data/` (gitignored), scripts + reports committed.

---

## The operator's questions → the exact measurements that answer them

| Question (operator's words) | Measurement |
|---|---|
| "It fires one direction, then another, then back to the first — which one is right?" | Accuracy by **fire index** (#1/#2/#3+) and by **pattern**: A→B (P(B right)), A→B→A (P(the return-to-A fire right)), per K |
| "Fires one direction, then the other, then mixes them?" | Transition-shape table: episodes classified by how the PREVIOUS run ended — decay-through-MIXED vs snap-flip — and what that does to the new fire's accuracy |
| "Does it get it right the first time, the second time?" | Fire-index table + first-fire-vs-last-fire vs settle |
| "Is there a certain timeframe?" | Accuracy AND ROI by trigger-time band (60s bands) — separately for continuation vs reversal fires |
| "Are the new metrics popping with combinations?" | Task 3's pre-registered hypothesis tests + Task 4's interpretable model on episode features |
| "When wrong — all, or a subset? Does it negate wins?" | Wrongness concentration: share of wrong-fire losses carried by the top-N bars/days; intra-bar netting (bars where a wrong fire and a right fire both bet) |
| "Predictive, before it's priced in?" | **Disagreement-fire study**: fires where the fired side costs < 0.50 (market disagrees). Their win rate vs price = the direct measure of prediction edge. Also price-drift after trigger (did the market come TO the engine?) |
| "What flat $ rule would have yielded positive ROI?" | The decision card: bet/skip conditions with held-out ROI + CI |

## Episode definition (locked)

- Stream: the v8 per-second tag (logged live; replayed byte-faithful for BQ bars).
- An **episode** starts at the K-th consecutive same-direction tick (K swept over {3, 5, 10}; all three extracted, K=5 is the headline). Trigger tick = that K-th second.
- Episode ends when the tag leaves the direction (MIXED or opposite) or the bar settles. One episode = at most one bet.
- Label: `won = (direction == settled)`. Price: fired side's Polymarket price at trigger (`poly_mid` or `1−poly_mid`); episodes with null poly_mid at trigger are kept for accuracy tables, excluded from ROI (counted + reported).
- Sequence context (legitimately known at trigger): fire index, previous episode's direction/duration/max cushion ratio/end-shape (decayed vs snapped), seconds since previous episode, whether this direction re-affirms fire #1.

## Pre-registered hypotheses (frozen now; each tested train → held-out → live)

H1 Reversal fires (opposite the previous fire) are MORE accurate than continuation re-fires (the v6-era "lift concentrated in direction changes" replicating at episode level).
H2 Reversal fires following a decay-through-MIXED are stronger than snap-flips.
H3 **Disagreement fires (side price < 0.50 at trigger) have positive ROI** — the predictive slice.
H4 VWAP-backed fires (px_vs_vwap same sign as fire) beat hollow fires.
H5 Whale flow against the fire (whale_against_move > 0) marks weak fires.
H6 Aggression-aligned fires (agg_ratio_60 same sign, agg_persist high) beat unaligned.
H7 Basis-led fires (basis_vel_10 same sign) beat basis-opposed.
H8 Book-pull-confirmed fires (pull_skew favoring the fire side) beat opposed.
H9 p_flip at trigger stratifies: fires with p_flip > 0.5 are weaker.
H10 Late fires (rem < 120) are accurate but priced (low ROI); mid-bar fires (rem 180–120) carry the best acc−price balance.
H11 Fire #1 in the first 60s is the weakest class (information floor).
H12 cush_path_r2 (grind) at trigger beats V-shape entries.

## Tasks

### Task 0: Commit the spec + fresh data
**Files:** Create `docs/superpowers/specs/2026-07-08-fire-episode-study-design.md` (this plan's front half, verbatim).
- [ ] Copy plan → spec file, commit `spec: fire-episode conviction study (pre-registered)`.
- [ ] `python3 tools/log-clean/clean-logs.py --pull --execute` (current clean logs).
- [ ] Worker data refresh (background, same pattern as v8 build): chunked BQ re-pull + exporter + `10_build_bars.py` rerun → expect ~900+ bars/`bars/` files. Matrix rebuild (`feat_traj.py` assembler) so tick features cover the new days.

### Task 1: Episode extractor
**Files:** Create `v8/analysis/70_extract_episodes.mjs` (replay+capture), `v8/analysis/71_build_episodes.py` (join), test `v8/analysis/test_71_episodes.py`.
**Interfaces — Produces:** `v8/analysis/data/episodes.jsonl`: one line per episode: `{slug, src: 'bq'|'live', day, K, dir, idx, trigger_rem, price_side, poly_valid, won, prev: {dir, dur, max_ratio, end: 'decay'|'snap'|null, gap_s}, reaffirms_first, feat: {<the 40 matrix features at nearest tick ≤ trigger>, p_flip, imb_ewma, cushion_ratio}, outcome: {dur, end, max_ratio}}`.
- [ ] `70_extract_episodes.mjs`: extend the `21_replay` pattern — replay every `_bq.json` bar through `v8/src/signals.mjs`, dump per-second `{rem, sig, p_flip, imb_ewma}` → `data/stream/<slug>.json`. Validation step (like Task 3 of the v8 build): replay 3 LIVE logs and assert sig matches logged `signal` 100%.
- [ ] `71_build_episodes.py` (GLM batch A, call 1): state machine over per-second stream (live: logged columns; BQ: `data/stream/`) → episodes for K ∈ {3,5,10}; join `feat` from `matrix.npz` (nearest 5s tick at or before trigger, ≤4s away) + p_flip/imb_ewma from the stream capture; `prev`/sequence fields per the locked definition.
- [ ] Test (real data): every episode's trigger honors K consecutive ticks; no episode uses post-trigger data in `feat`/`prev` (assert trigger_rem ≥ all feature timestamps); counts sanity (K=5 live ≈ 219 fires matches the betting-sim count exactly — hard assertion ±0).
- [ ] Commit.

### Task 2: The sequence & timing map (their literal questions, answered descriptively)
**Files:** Create `v8/analysis/72_sequence_map.py`.
- [ ] (GLM batch A, call 2) Tables on ALL episodes (this phase is descriptive — full pool allowed, no selection happens here): fire-index accuracy/ROI; A→B and A→B→A pattern tables; transition-shape (decay vs snap) conditional accuracy; re-affirmation vs reversal; time-band × fire-type accuracy AND ROI; wrongness concentration (Lorenz share of losses by bar/day; intra-bar netting table); first-fire-vs-last-fire; price-drift after trigger (mean fired-side price at trigger+30s/+60s — did the market follow the engine?).
- [ ] Run over BQ + live separately (distribution honesty), print + `data/sequence_map.json`. Commit.

### Task 3: Pre-registered hypothesis tests
**Files:** Create `v8/analysis/73_hypotheses.py`.
- [ ] (GLM batch A, call 3) For each H1–H12: split episodes by the hypothesis condition; report n, accuracy, avg price, ROI/bet on TRAIN (BQ days 1–2) → verify direction & magnitude on HELD-OUT (BQ days 3+) → confirm on LIVE. A hypothesis SURVIVES only if the ROI lift has the same sign in all three and held-out n ≥ 30.
- [ ] Output: the survival table (H#, train lift, held-out lift, live lift, verdict). Commit.

### Task 4: Interpretable discriminator + the decision card
**Files:** Create `v8/analysis/74_decision_card.py`.
- [ ] (Claude writes this one — it's the constitution) Logistic + depth-2 tree on TRAIN episodes only (features: surviving-hypothesis conditions + the 40 + sequence fields). Extract 1–3 clause candidate rules (human-readable, e.g. "bet reversal fires at rem 180–60 when side price < 0.55 and whale_against ≤ 0").
- [ ] Score every candidate on HELD-OUT then LIVE: n, acc, avg price, **ROI/bet with binomial 90% CI**, total flat-$100 P&L, worst-day. The card ships only if held-out ROI CI clears 0 and live sign agrees. Multiple surviving rules → pick by held-out ROI, report runners-up.
- [ ] Also price the two reference strategies from the operator's manual pattern for comparison: "first K=5 fire per bar" and "every K=5 fire" (the betting-sim baselines).
- [ ] Commit.

### Task 5: The report + review gate
**Files:** Create `v8/analysis/2026-07-XX-fire-episode-study.md`.
- [ ] Full write-up: every operator question with its table; hypothesis survival; the decision card (or the honest null: "no rule cleared held-out ROI; here is the closest and why it fails"); explicit statement of what was NOT predictive; next-batch candidates appendix (post-hoc finds, untested).
- [ ] Push. **STOP — user reviews.** Any productization (dashboard conviction badge, bet-size logic, automation) is a new plan after this review.

## Verification
- Extractor: live K=5 episode count must equal the betting sim's 219 exactly; 3-log replay fidelity 100%; anti-hindsight assertion in tests.
- Every table regenerable by rerunning committed scripts (seeded).
- Discipline audit in the report: confirm no decision-card condition uses outcome fields; confirm selection never touched held-out days.

## What I expect, stated up front (so the result is judged fairly)
Favorite-following fires will price near their accuracy (the calibration wall — ROI ≈ 0). The live "it was working" feel is real but partially live-hours flattering. The genuinely open, never-measured slices are **disagreement fires (H3)** and **transition-shape conditioning (H1/H2)** — if edge exists anywhere in this system, it is there, because that is exactly where the market must lag the engine. If nothing survives, the study still delivers the complete when-right/when-wrong map you asked for — which is what makes your manual $5 decisions systematic instead of felt.
