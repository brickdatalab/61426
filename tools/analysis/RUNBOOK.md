# Polymarket Edge Engine — Runbook

How to run one analysis end-to-end. Read `METHODOLOGY.md` for the rules; this is the
operator's step-by-step. The deterministic data + logging is in
`analysis/run_market_analysis.py`; the parallel lanes are dispatched by the orchestrating
model via the Agent tool.

## Prereqs
- `cd /Users/vitolo/Desktop/61426/tools`
- Use the project interpreter: `.venv/bin/python`
- Tools auto-register on import (`polymarket_tools.server._load_tools()`); no wiring needed.
- Helper to call any tool handler directly:
  ```python
  import asyncio
  from polymarket_tools.client import PolyClient, WS_URL, Ctx
  from polymarket_tools.ws_manager import WsManager
  from polymarket_tools.registry import REGISTRY
  from polymarket_tools import server; server._load_tools()
  def h(ctx, name, args): return REGISTRY[name].handler(ctx, args)
  ```

## Step 1 — Get the `game_id` and every child event
From a market URL/slug, resolve the game and pull ALL its sub-events:
```python
ev = await ctx.client.get("https://gamma-api.polymarket.com", "/events/slug/<event-slug>")
game_id = ev["gameId"]
events  = await ctx.client.get("https://gamma-api.polymarket.com",
                               "/events", {"game_id": game_id, "limit": 50})
# events = [moneyline, halftime, exact-score, second-half, totals, btts, ...]
```
(`game_id` is snake_case; `gameId` camel is ignored by the API.)

## Step 2 — Phase 0 snapshot (immutable T0)
```python
import time
from analysis.run_market_analysis import scope_event   # async: fetch + build
# or build_snapshot(events, t0) if you already fetched `events`
snapshot = await scope_event(ctx.client, game_id, t0=int(time.time()))
# snapshot = {slug, t0, markets:[{event_slug, question, condition_id,
#             clob_token_ids, yes_price}], price_vector:{condition_id: yes_price}}
```
Freeze `snapshot` — every later grade compares against this T0 price vector.

## Step 3 — Fan out the three lanes (parallel subagents, Agent tool)
Dispatch these concurrently (one message, multiple Agent calls). Each agent calls tools
via the helper above.

- **Lane A1 — External odds anchor.** WebSearch consensus/sharp book odds (Pinnacle /
  Bet365 / consensus aggregators) for the same fixture across the bet types that exist
  (1X2, totals O/U, BTTS, correct score, HT). De-vig:
  ```python
  from polymarket_tools.fairvalue.anchor import devig_decimal
  fair = devig_decimal({"spain":1.08, "draw":11.0, "cabo":26.0})  # -> fair %, sums to 1
  ```
  Output: `{leg -> {fair_prob, source}}`.
- **Lane A2 — Internal coherence.** Run model-free no-arbitrage on the snapshot:
  ```python
  from polymarket_tools.fairvalue.coherence import report
  out = report([
    {"name":"1X2","kind":"triplet","legs":[...],"probs":[0.925,0.051,0.022]},
    {"name":"exact","kind":"distribution","legs":[...],"listed":[...],"field":0.455},
  ])  # sorted by |gap|; reading = under/overpriced/coherent
  ```
- **Lane B — Smart money (ONE agent per child event).** For each market: paginate the
  full tape (`get_trades`, `taker_only=False`), compute each wallet's NET position
  (buys−sells + holdings) to drop market-makers, then score the net-directional
  candidates:
  ```python
  trades = await h(ctx, "get_trades", {"condition_id": cid, "taker_only": False, "limit": 500})
  card   = await h(ctx, "wallet_scorecard", {"wallet": w, "since": "30d"})
  # card.data: {score, label, components:{pnl,behavioral}, raw_metrics:{realized_pnl, roi, ...}}
  ```
  Output per leg: quality-weighted net smart-money lean (weight by `score`).
- **Lane C — Microstructure.** Per candidate leg: `get_book`, `get_spread`,
  `get_price_history` (token id, not conditionId). Decide: tradeable depth vs thin-book
  noise; has the edge already moved?

## Step 4 — Synthesis + adversarial skeptics
- Combine: a leg is a **candidate edge** only if ≥2 of {A-anchor gap, A-coherence break,
  B-smart-money} agree AND Lane C says tradeable.
- Dispatch **one skeptic agent per candidate** to refute it (stale anchor / wallet is a
  hedger or MM / gap is just vig-fees-tick / book too thin / price already moved). Keep
  only edges that survive.
- Score each survivor per the rubric in `METHODOLOGY.md` (≥8 requires all five legs;
  one-lane/behavioral-only capped ≤5).

## Step 5 — Write the artifact
```python
from analysis.run_market_analysis import assemble_and_log
res = assemble_and_log(
    base_dir="analysis",          # writes under analysis/
    snapshot=snapshot,
    edges=edges,                  # [{leg, condition_id, token_id, side, price_t0,
                                  #   fair_price, edge_cents, confidence, evidence{...}}]
    scorecards=scorecards,        # {wallet: scorecard dict}
    anchors=anchors,              # {leg: {fair_prob, source}}
    coherence=coherence_report,   # list from fairvalue.coherence.report
)
# -> analysis/markets/<slug>/analysis.json  +  appended row in analysis/ledger.jsonl
```

## Step 6 — Grade later
After kickoff (closing prices) and after resolution (outcomes):
```python
from analysis.grade import grade_artifact, update_scoreboard
graded = grade_artifact(art, closing_prices={leg: 0.54}, resolutions={leg: 1})  # 1=won,0=lost
board  = update_scoreboard("analysis/ledger.jsonl", [graded])  # -> analysis/scoreboard.json
```
CLV = did price move our way by close; Brier/hit = was the call right. The scoreboard
aggregates calibration + CLV win-rate across all runs.

## Output directory map
```
analysis/
  markets/<event-slug>/analysis.json   # immutable per-run record (T0 snapshot + edges)
  ledger.jsonl                         # one summary row per run
  scoreboard.json                      # cross-market CLV win-rate, mean Brier, hit-rate
```
