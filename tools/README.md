# Polymarket public-read tool server

A **persistent MCP server** (one long-lived process) exposing Polymarket
**public read** endpoints as agent tools. One shared keep-alive HTTP client,
concurrent fan-out for batch calls, and every response returned **already
normalized** to a stable schema so the consuming agent never re-parses raw JSON.

No signing, no auth, no trading — read only (Gamma + Data + CLOB public + market
WebSocket).

## Run

```bash
cd tools
python3.11 -m venv .venv && . .venv/bin/activate   # 3.11+; built/tested on 3.14
pip install -e .
python -m polymarket_tools.server                  # stdio MCP server
# or the console script:
polymarket-tools
```

### Wire into an agent (MCP stdio)

```json
{
  "mcpServers": {
    "polymarket": {
      "command": "/Users/vitolo/Desktop/61426/tools/.venv/bin/python",
      "args": ["-m", "polymarket_tools.server"]
    }
  }
}
```

## How it's built

- **One shared client** (`client.py`): a single `httpx.AsyncClient` (HTTP/2,
  keep-alive pool, 15s timeout) created once in the server lifespan and injected
  into every tool via `Ctx`. Tools never open their own connections.
- **Uniform envelope** (`schema.py`): every tool returns `{"ok": true, "data": …}`
  or `{"ok": false, "error": {type, message, status, endpoint}}`. The agent
  branches on `ok` and never touches HTTP. Quirks are mapped: closed-market book →
  `error.type="market_closed"`; thin/closed last-trade → `data.is_sentinel=true`.
- **Normalized output**: all prices/sizes/probabilities are floats (the wire
  sends strings); timestamps are epoch-seconds ints (+ ISO where useful);
  `condition_id` and `token_id` are always distinct explicit fields.
- **Concurrent fan-out** (`fanout.py`): batch tools call the real batch endpoint
  when it exists, else fan single calls out with bounded concurrency and return
  aligned results with per-item errors.
- **Auto-discovery** (`registry.py` + `server.py`): each tool file self-registers
  via `@tool`; the server imports the `tools/` package. Add a file → add a tool.
  No central registration to edit. See `CONTRACT.md` for the tool-authoring rules.

### Two keying rules (important)
- **Gamma + Data** tools key on **`condition_id`**.
- **All CLOB** pricing/history tools key on the **token/asset id**.
  `get_price_history`'s query param is literally `market`, but its value is the
  **token id**, not the conditionId.

### Snapshot shortcut
`get_market` already returns `clob_token_ids`, `best_bid`, `best_ask`, `spread`,
`last_trade_price`, and `one_hour_price_change`. For a one-shot snapshot it
replaces `get_clob_market` + several CLOB pricing calls. Use the dedicated CLOB
tools when you need live depth, batches, or history.

## Tools (22)

### Gamma — market/event metadata (key: condition_id / slug / id)
| Tool | Purpose | Key args |
|---|---|---|
| `get_market` | Full market: prices, momentum, volume, liquidity, token ids, state | one of `condition_id` / `slug` / `id` |
| `get_event` | Event metadata across child markets (liquidity, volume, neg-risk, category) | `event_slug` |
| `get_live_volume` | Current total event volume + per-market breakdown | `event_id` |
| `get_market_tags` | Tags for clustering by sport/category | `id` |
| `resolve_token` | Token id → parent conditionId + sibling Yes/No token ids | `token_id` |

### CLOB — single token (key: token id)
| Tool | Purpose | Key args |
|---|---|---|
| `get_clob_market` | CLOB params: tokens+labels, tick size, min size, fees, rewards, game start | `condition_id` |
| `get_book` | Full bid/ask depth (404 → `market_closed`) | `token_id` |
| `get_midpoint` | Midpoint = implied probability | `token_id` |
| `get_price` | Best bid or best ask | `token_id`, `side` |
| `get_spread` | Bid/ask spread (liquidity tightness) | `token_id` |
| `get_last_trade_price` | Last traded price+side (`is_sentinel` on thin/closed) | `token_id` |

### CLOB — batch + history (key: token ids)
| Tool | Purpose | Key args |
|---|---|---|
| `get_midpoints_batch` | Midpoints for many tokens in one call | `token_ids[]` |
| `get_spreads_batch` | Spreads for many tokens in one call | `token_ids[]` |
| `get_price_history` | Price time series for one token | `token_id`, `interval`, `fidelity` |
| `get_price_history_batch` | Price history for up to 20 tokens | `token_ids[]`, `interval`, `fidelity`, `start_ts`, `end_ts` |

### Data API — enrichment (key: condition_id / wallet)
| Tool | Purpose | Key args |
|---|---|---|
| `get_trades` | Full trade tape: wallet, side, size, price, ts, tx hash | `condition_id`, `taker_only`, `limit`, `offset` |
| `get_holders` | Top holders per outcome token (whale concentration) | `condition_id`, `limit` (≤20), `min_balance` |
| `get_profile_activity` | Every personal bet/activity by a profile in a time window | `profile_id`, `since` / `start_ts`+`end_ts`, `types`, `market`, `side`, `max_items` |
| `get_positions` | A wallet's current positions with realized/unrealized P&L | `wallet` |
| `get_portfolio_value` | A wallet's total portfolio value (USDC) | `wallet` |
| `wallet_scorecard` | Blended 50/50 verified-P&L + behavioral sharpness score (SHARP/MIXED/NOISE-BOT/RETAIL) | `wallet`, `since` |

`get_profile_activity` walks newest-first and **caps at 3500 items** (the API's hard
ceiling: offset ≥3400 returns HTTP 400); it stops gracefully at the ceiling and reports
`truncated` / `api_ceiling_hit`.

### WebSocket — live feed
| Tool | Purpose | Key args |
|---|---|---|
| `stream_market` | Persistent book / price_change / last_trade feed (lower latency than polling) | `action` = `subscribe` / `read` / `unsubscribe`, `asset_id` / `asset_ids[]` |

`stream_market` is backed by `ws_manager.py`: one persistent connection holds the
socket, caches the latest snapshot per asset, PINGs every 10s, and reconnects +
re-subscribes on drop. `subscribe` once, `read` repeatedly for the cached
snapshot, `unsubscribe` when done.

### `get_profile_activity` — flexible windows
A "profile id" is the proxy wallet address. The window is resolved client-side
(paginate newest-first, stop once older than the window start), so any window
works:

```jsonc
{"profile_id": "0x84cf…2f63", "since": "20m"}          // last 20 minutes
{"profile_id": "0x84cf…2f63", "since": "45m"}          // last 45 minutes
{"profile_id": "0x84cf…2f63", "since": "1h30m"}        // combos allowed
{"profile_id": "0x84cf…2f63", "since": "5d"}           // last 5 days
{"profile_id": "0x84cf…2f63", "start_ts": 1781400000, "end_ts": 1781481219}  // explicit
{"profile_id": "0x84cf…2f63", "since": "1h", "types": ["ALL"]}  // full on-chain tape
```
Default `types` is `["TRADE"]` (actual bets); `["ALL"]` adds splits/merges/
redeems/rewards/conversions. Returns the window, item count, total USDC notional,
pages scanned, a `truncated` flag (hit `max_items`, default 1000), and the
normalized `items[]` (timestamp+iso, type, side, outcome, size, price, usdc_size,
condition_id, token_id, title, slug, tx_hash, trader_name).

## Live-verified endpoint notes (differ from first-pass spec)
- `get_live_volume` is on **data-api**, not Gamma; response has no token_id.
- `resolve_token` uses `GET /markets?clob_token_ids={token}` (the spec's
  `/markets-by-token/{id}` 404s).
- `get_clob_market` uses `GET /markets/{condition_id}` (the spec's
  `/clob-markets/{id}` returns an unusable abbreviated-key shape).
- Batch endpoints `POST /midpoints`, `POST /spreads`, `POST /batch-prices-history`
  all exist and return **token-keyed maps** (normalized here to aligned lists).
- Wire field names are camelCase (`volume24hr`, `proxyWallet`, `usdcSize`,
  `transactionHash`); normalized output uses snake_case per `schema.py`.

## Analysis engine

On top of the raw tools sits a repeatable smart-money + mispricing analysis harness:

- **`polymarket_tools/fairvalue/`** — independent fair value. `anchor.py` de-vigs
  external sportsbook odds (`devig_decimal`, `devig_american`, `overround`);
  `coherence.py` runs model-free no-arbitrage checks across an event's own markets
  (`triplet_gap`, `distribution_gap`, `winner_from_scores`, `report`).
- **`analysis/`** — the harness. `run_market_analysis.py` (Phase 0 snapshot via the
  `game_id` grouping + artifact assembly), `artifact.py` (immutable per-run record +
  ledger), `grade.py` (CLV, Brier, hit-rate, scoreboard).
- **`wallet_scorecard`** tool — the verified-P&L + behavioral "sharpness" score the
  smart-money lane runs on each candidate wallet.

How to run an analysis end-to-end: **[`analysis/RUNBOOK.md`](analysis/RUNBOOK.md)**.
The rules, fan-out topology, confidence rubric, and honest limitations:
**[`analysis/METHODOLOGY.md`](analysis/METHODOLOGY.md)**.

Analysis output layout:
```
analysis/
  markets/<event-slug>/analysis.json   # immutable per-run record (T0 snapshot + edges)
  ledger.jsonl                         # one summary row per run
  scoreboard.json                      # cross-market CLV win-rate, mean Brier, hit-rate
```

## Scope
Public read only. No order signing, no L1/L2 auth, no trading, no automated betting, no
write endpoints. WebSocket is the public market channel only.
