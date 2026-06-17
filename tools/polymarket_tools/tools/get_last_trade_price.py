from __future__ import annotations

# VERIFIED LIVE 2026-06-14: GET /last-trade-price?token_id={asset} -> {"price":"0.32","side":"BUY"}.
# QUIRK: on thin/closed markets this returns 0.5 / empty (no 404). When price is
# missing/empty, or exactly 0.5 with no side, flag is_sentinel=True.

from ..client import CLOB_BASE, PolyError
from ..normalize import to_float
from ..registry import tool
from ..schema import err_from_exc, ok

_INPUT = {
    "type": "object",
    "properties": {
        "token_id": {"type": "string", "description": "CLOB token/asset id"},
    },
    "required": ["token_id"],
    "additionalProperties": False,
}


@tool(
    name="get_last_trade_price",
    description="Last traded price and side for one token. Flags is_sentinel on thin/closed markets (0.5/empty).",
    input_schema=_INPUT,
)
async def get_last_trade_price(ctx, args: dict) -> dict:
    token_id = args["token_id"]
    try:
        raw = await ctx.client.get(CLOB_BASE, "/last-trade-price", {"token_id": token_id})
    except PolyError as e:
        return err_from_exc(e)
    raw_price = raw.get("price")
    side = raw.get("side") or ""
    price = to_float(raw_price)
    is_sentinel = (
        raw_price is None
        or raw_price == ""
        or price is None
        or (price == 0.5 and not side)
    )
    data = {
        "token_id": token_id,
        "price": price,
        "side": side,
        "is_sentinel": is_sentinel,
    }
    return ok(data)
