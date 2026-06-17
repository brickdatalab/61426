# Tool authoring contract (Phase B agents MUST follow this exactly)

You are adding one or more tool files under `polymarket_tools/tools/`. The shared
foundation already exists. Do NOT edit `server.py`, `registry.py`, `client.py`,
`schema.py`, `normalize.py`, or `fanout.py` — only create your own tool file(s).
One file per tool, filename == tool name (e.g. `get_book.py`).

## The shape of a tool file

```python
from __future__ import annotations

from ..client import CLOB_BASE, GAMMA_BASE, DATA_BASE, PolyError  # import what you need
from ..normalize import to_float, levels, parse_token_ids        # helpers you need
from ..registry import tool
from ..schema import ok, err, err_from_exc

_INPUT = {
    "type": "object",
    "properties": {
        "token_id": {"type": "string", "description": "CLOB token/asset id"},
    },
    "required": ["token_id"],
    "additionalProperties": False,
}


@tool(
    name="get_book",
    description="Full bid/ask depth for one token. Returns market_closed error on a closed market.",
    input_schema=_INPUT,
)
async def get_book(ctx, args: dict) -> dict:
    token_id = args["token_id"]
    try:
        raw = await ctx.client.get(CLOB_BASE, "/book", {"token_id": token_id})
    except PolyError as e:
        if e.status == 404:
            return err("market_closed", "book unavailable (closed market)", e.status, e.endpoint)
        return err_from_exc(e)
    data = {
        "token_id": token_id,
        "bids": levels(raw.get("bids"), reverse=True),
        "asks": levels(raw.get("asks"), reverse=False),
        "tick_size": to_float(raw.get("tick_size")),
        "neg_risk": bool(raw.get("neg_risk", False)),
        "last_trade_price": to_float(raw.get("last_trade_price")),
    }
    return ok(data)
```

## Hard rules

1. **Handler signature is `async def handler(ctx, args: dict) -> dict`.** `ctx.client`
   is the shared `PolyClient` (use `ctx.client.get(base, path, params)` /
   `.post(base, path, json)`). `ctx.ws` is the `WsManager` (streaming tools only).
   NEVER create your own httpx client or websockets connection.
2. **Always return a Result envelope** via `ok(data)` or `err(...)`. Catch
   `PolyError` and convert with `err_from_exc(e)` (or a quirk-specific `err(...)`).
   Never let an exception propagate.
3. **Normalize to the typed shapes in `schema.py`.** Field names and types MUST
   match the relevant `TypedDict` (e.g. `Market`, `BookSnapshot`, `Trade`). All
   prices/sizes/probabilities are `float` (wire sends strings — use `to_float`).
   Timestamps are epoch seconds ints (use `normalize.epoch_seconds`).
4. **Keying:** Gamma + Data tools key on `condition_id`; ALL CLOB pricing/history
   tools key on `token_id`/asset id. `prices-history`'s query param is literally
   `market` but its value is the TOKEN id, not the conditionId.
5. **Batch tools** (`get_midpoints_batch`, `get_spreads_batch`,
   `get_price_history_batch`): try the documented batch endpoint first; if it does
   not exist / 404s, fan out single calls concurrently with
   `fanout.gather_bounded([...])` and assemble an aligned list. Return partial
   results with per-item errors rather than failing the whole batch.
6. **`input_schema`** is JSON Schema, `additionalProperties: False`, with a clear
   `description` on every property. Mark required args in `required`.
7. **Verify-on-build for the 3 unconfirmed endpoints** (see your task): hit the
   live API, confirm the exact path/params/shape, and adjust. Note what you found
   in a one-line comment at the top of the file.

## Base URLs (from `client.py`)
`GAMMA_BASE` `https://gamma-api.polymarket.com` · `DATA_BASE`
`https://data-api.polymarket.com` · `CLOB_BASE` `https://clob.polymarket.com` ·
`WS_URL` `wss://ws-subscriptions-clob.polymarket.com/ws/market`

## Helpers available
- `schema.ok / err / err_from_exc`
- `normalize.to_float / to_int / to_bool / parse_token_ids / parse_str_list / levels / epoch_seconds / iso_from_epoch`
- `fanout.gather_bounded(factories, limit=10)` — factories are zero-arg callables returning a fresh coroutine.

## Local check before you finish
From `tools/`: `python -c "import polymarket_tools.tools.<your_module>"` must import
with no error (this triggers registration; a duplicate name or syntax error fails here).
