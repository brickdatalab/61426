# Polymarket Edge Engine — Methodology

The canonical playbook for analyzing any Polymarket market. `run_market_analysis.py`
references this file. Read `RUNBOOK.md` (next to this file) for the step-by-step
operator guide; this document is the *why* and the *rules*.

## Purpose

Given a market (a game / event with one or more sub-markets), the engine answers two
questions and logs the answer so it can be graded later:

1. **Where is verified-profitable smart money going?** — not "who is big or stylish,"
   but wallets with real realized P&L.
2. **Which legs are mispriced** versus an independent fair value (external sharp-book
   odds + internal no-arbitrage), and by how much?

Hard boundaries: **public-read only** (no signing, no trading, no automated betting).
The engine **never claims a certain winner** — it prices probabilities, flags gaps vs
an anchor, and is graded on closing-line value + calibration across many markets, not
on any single game's result.

## The 5-phase pipeline

- **Phase 0 — Scope & immutable snapshot (deterministic spine).** Resolve the whole
  game via the `game_id` grouping (`gamma /events?game_id={id}` returns every child
  event: moneyline, halftime, 2nd-half, exact-score, totals, BTTS, spreads). Enumerate
  every sub-market (`question`, `condition_id`, `clob_token_ids`, current Yes price).
  Stamp `T0` and freeze the **price vector** — this is what the run is graded against.
  Implemented by `run_market_analysis.scope_event` / `build_snapshot`.
- **Phase 1 — Three independent evidence lanes, IN PARALLEL (subagent fan-out).**
  - *Lane A — Fair value (2 agents):* **A1** external consensus/sharp odds (via
    WebSearch) → de-vig with `fairvalue.anchor.devig_decimal` → fair %. **A2** internal
    no-arbitrage via `fairvalue.coherence`.
  - *Lane B — Smart money (one agent per child event):* full trade tape (paginated
    `get_trades`) → net position per wallet (strip market-makers) → `wallet_scorecard`
    per candidate. Output: quality-weighted net lean per leg.
  - *Lane C — Microstructure (1 agent):* `get_book` / `get_spread` / `get_price_history`
    — is the gap tradeable, or thin-book noise / already moved?
- **Phase 2 — Synthesis + adversarial refutation.** A leg becomes a *candidate edge*
  only if ≥2 of {A-fairvalue-gap, A-coherence-break, B-smart-money-agreement} agree AND
  Lane C says it's tradeable. Then one **skeptic agent per candidate** tries to KILL it
  (stale anchor? wallet is a hedger/MM? gap explained by vig/fees/tick? book too thin?
  price already moved?). An edge survives only if skeptics can't break it.
- **Phase 3 — Immutable artifact.** `analysis.artifact.build_artifact` →
  `write_artifact`: `markets/<slug>/analysis.json` (T0, price vector, edges, scorecards,
  anchors, coherence) + one row appended to `ledger.jsonl`. Never mutated after T0.
- **Phase 4 — Grade later.** After kickoff fill closing prices; after resolution fill
  outcomes. `analysis.grade` computes CLV + Brier + hit-rate and updates
  `scoreboard.json`.

## Fan-out topology (runs EVERY analysis)

```
Phase 0 (spine)                 -> price snapshot @ T0
Phase 1 PARALLEL:
   A1 external-odds agent
   A2 coherence agent
   B  N agents (one per child event)   <- smart money + P&L scorecards
   C  microstructure agent
Phase 2 PARALLEL: K skeptic agents (one per candidate edge)
Phase 3 (spine) -> analysis.json + ledger.jsonl
Phase 4 later   -> grade.py -> scoreboard.json
```

The fan-out is not optional — it is how the engine stays comprehensive and how each
lane stays independent (so agreement between lanes is meaningful, not circular).

## Smart-money definition (blended 50/50)

A wallet's "sharpness" is `wallet_scorecard._score(...)`, an even blend of:

- **Verified P&L (50%)** — realized P&L, ROI, and win-rate from `get_positions`
  (`realizedPnl`, `cashPnl`, `percentPnl`) and `get_portfolio_value`. The P&L component
  is **heavily discounted** unless realized P&L is positive AND volume is meaningful
  (≥ $5k). Style without profit does not count.
- **Behavioral (50%)** — conviction size (median bet), breadth (distinct markets), and
  selectivity (cadence; bot-like churn is penalized), from `get_profile_activity` at
  **3500** items.

Labels: `SHARP` (≥0.66), `MIXED` (≥0.40), else `NOISE-BOT` (if hyperactive) or `RETAIL`.

## Fair value (independent of Polymarket)

- **External anchor** — the strongest signal. Scrape consensus/sharp book odds for the
  same fixture/bet type, de-vig with `fairvalue.anchor.devig_decimal` (multiplicative
  normalization; `overround` reports the margin). Mispricing = Polymarket price vs
  de-vigged fair %.
- **Internal no-arbitrage** — model-free, always available (`fairvalue.coherence`):
  - `triplet_gap(probs)` — a mutually-exclusive result set (win/draw/loss; HT
    lead/draw/lead; 2H win/draw/win) should sum to ≈1 after de-vig.
  - `distribution_gap(listed, field)` — exact-score listed Yes-probs + "Any Other Score"
    should sum to ≈1; negative ⇒ field/blowout underpriced, positive ⇒ overpriced.
  - `winner_from_scores(...)` — derive P(win/draw/loss) from the exact-score market and
    cross-check against the 1X2 market.
  - `report(checks)` runs a batch and sorts by |gap|.

External anchor and internal coherence are independent of the order flow, so when smart
money *also* agrees, the three legs corroborate rather than echo each other.

## The 8-9 confidence rubric

An edge is scored 1-10. It reaches **≥8 only when ALL of these hold**:
1. independent **external anchor** gap,
2. corroborating **internal coherence** signal,
3. **P&L-validated** smart-money agreement,
4. **microstructure**-tradeable (real book, edge not already gone),
5. **survived adversarial refutation**.

A claim backed by **one lane only**, or by **behavioral-only** money, is **capped at ≤5**
in the artifact. Never inflate. If the data is thin, the confidence is low and the
artifact says so.

## Grading

- **CLV** (`grade.clv(side, price_t0, close)`) — did the price move toward our side by
  close? Measures edge *detection* without waiting for the result.
- **Brier** (`grade.brier(conf, outcome)`) and hit-rate — measures the actual call.
- **Scoreboard** (`grade.update_scoreboard`) — aggregates CLV win-rate, mean Brier
  (calibration), and hit-rate across ALL graded runs into `scoreboard.json`. This is how
  the method is judged and improved over many markets.

## Worked cautionary example — why the P&L + coherence layers exist

On Spain vs Cabo Verde (2026-06-15), a behavioral-only first pass labeled
`0x2f63db…` the "standout SHARP" (one $6.6k bet + cross-event coherence). The P&L
scorecard at 3500 items inverted it: **NOISE-BOT** — realized P&L only **+$1,642**,
median bet **$3.75**, ~217 trades/day. Meanwhile `0x84cf…`, dismissed as a bot in the
first pass, was actually **profitable: +$140,643 realized, 23% ROI, 65% win rate**. The
behavioral read had the two essentially backwards.

Separately, the first pass claimed "Any Other Score is underpriced." The rigorous
`distribution_gap` over the **full 16-score** distribution + field summed to **+0.035**
(mild overround, ~coherent / slightly rich) — the earlier claim used a partial subset of
scores and an assumed field value, and did **not** survive the model-free check.

Lesson, and the reason these layers are mandatory: **P&L-validation overrides behavioral
hunches, and full-distribution coherence overrides partial math.** Both corrections came
from the tooling, not intuition.

## Honest limitations

- **3500 ceiling.** `/activity` hard-caps retrieval at 3500 items (offset ≥3400 →
  HTTP 400; `get_profile_activity` stops gracefully). For hyperactive wallets, 3500 items
  may span only ~1 day, so their cadence/window/behavioral stats are **lower bounds**,
  not true 30-day figures. **Realized P&L from `/positions` is NOT truncated** and stays
  solid — which is why the P&L half of the score is the trustworthy half for bots.
- **Discourse/market data ≠ ground truth.** Flow and prices reflect what people and money
  *expect*, not what will happen.
- **Single-game variance is high.** Grade on CLV + calibration across many markets, never
  on one result. A correct edge can lose a coin-flip; a wrong edge can win one.

## Calibration log (graded runs — append one block per market)

This section is the engine's memory. Every graded run adds what worked / what didn't and
any rule change it forces. The hardened rules below are MANDATORY on all future runs.

### Run #1 — Belgium vs Egypt (2026-06-15) — final 1-1 draw, Egypt led at HT
Pre-match verdict: "market efficient, no actionable edge." Graded: hit-rate 2/3, Brier 0.22
(≈ chance — confidences were correctly low). The conf-5 `SELL BEL 1-1` lost (1-1 was the
actual score); the two hits were low-information fades of unlikely outcomes. CLV was
**ungradeable** — no closing-line snapshot was captured.

**What worked (keep):**
- The honesty gate. "No actionable edge, don't bet at size" meant no confident wrong bet
  into an upset. The ≤5 cap on single-lane/behavioral signals is the moat — it held.
- External anchor + coherence correctly read the market as efficient (1X2 within 0.4¢ of
  book consensus; a 63.5% favourite drawing is a normal ~36%-tail event, not a mispricing).
- Infrastructure: parallel fan-out, P&L scorecards, the gradeable artifact + ledger all
  delivered and graded cleanly against resolution.

**What didn't (fix — now mandatory rules):**
1. **Always capture a closing-line snapshot at/near kickoff.** Without it CLV — the metric
   that judges edge-detection independent of one coin-flip result — cannot be computed.
   T0 + resolution alone is insufficient. (Process gap in Run #1.)
2. **One sharp wallet on one leg is NOT a confidence-5 signal.** A single P&L-validated
   wallet fading one exact score (`0x9106cf` fading 1-1) is high-variance and may be a
   correlated hedge. Require **≥2 independent P&L-validated wallets agreeing** before any
   smart-money edge exceeds confidence 3. One wallet = observation, not edge.
3. **"Smart money confirms the favourite" is NOT a signal.** Favourites attract confirming
   flow by construction; it is the market, not an edge. Smart-money is only informative
   when it **diverges from price**. Drop favourite-confirmation from the synthesis.
4. **Gate every flagged edge by Lane-C liquidity.** Do not assign confidence ≥4 to a leg
   whose book depth is too thin to trade (Run #1 exact-score/HT legs had $2-4k depth).
   Thin book → observation only, confidence ≤3, labelled untradeable.
5. **Consistency target, restated:** success is well-calibrated confidences graded on CLV
   across many markets — never a hit on the next single game. Do not chase the next result;
   keep the process honest and let the scoreboard accumulate.
