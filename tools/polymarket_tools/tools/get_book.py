from __future__ import annotations

# VERIFIED LIVE 2026-06-14: GET /book?token_id={asset} returns
# {market, asset_id, timestamp, hash, bids, asks, min_order_size, tick_size,
#  neg_risk, last_trade_price}. Closed markets 404 -> market_closed.

from ..client import CLOB_BASE, PolyError
from ..normalize import levels, to_float
from ..registry import tool
from ..schema import err, err_from_exc, ok

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
