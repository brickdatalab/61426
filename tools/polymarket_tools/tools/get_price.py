from __future__ import annotations

# VERIFIED LIVE 2026-06-14: GET /price?token_id={asset}&side={BUY|SELL} -> {"price":"0.3"}.
# BUY = best ask, SELL = best bid.

from ..client import CLOB_BASE, PolyError
from ..normalize import to_float
from ..registry import tool
from ..schema import err_from_exc, ok

_INPUT = {
    "type": "object",
    "properties": {
        "token_id": {"type": "string", "description": "CLOB token/asset id"},
        "side": {
            "type": "string",
            "enum": ["BUY", "SELL"],
            "description": "BUY returns the best ask, SELL returns the best bid",
        },
    },
    "required": ["token_id", "side"],
    "additionalProperties": False,
}


@tool(
    name="get_price",
    description="Best price for one token on a given side (BUY=best ask, SELL=best bid).",
    input_schema=_INPUT,
)
async def get_price(ctx, args: dict) -> dict:
    token_id = args["token_id"]
    side = args["side"]
    try:
        raw = await ctx.client.get(CLOB_BASE, "/price", {"token_id": token_id, "side": side})
    except PolyError as e:
        return err_from_exc(e)
    data = {
        "token_id": token_id,
        "side": side,
        "price": to_float(raw.get("price")),
    }
    return ok(data)
