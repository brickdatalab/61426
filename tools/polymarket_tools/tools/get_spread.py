from __future__ import annotations

# VERIFIED LIVE 2026-06-14: GET /spread?token_id={asset} -> {"spread":"0.02"}.

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
    name="get_spread",
    description="Bid-ask spread for one token.",
    input_schema=_INPUT,
)
async def get_spread(ctx, args: dict) -> dict:
    token_id = args["token_id"]
    try:
        raw = await ctx.client.get(CLOB_BASE, "/spread", {"token_id": token_id})
    except PolyError as e:
        return err_from_exc(e)
    data = {
        "token_id": token_id,
        "spread": to_float(raw.get("spread")),
    }
    return ok(data)
