from __future__ import annotations

# VERIFIED LIVE 2026-06-14: GET /midpoint?token_id={asset} -> {"mid":"0.31"}.

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
    name="get_midpoint",
    description="Midpoint price (implied probability) between best bid and ask for one token.",
    input_schema=_INPUT,
)
async def get_midpoint(ctx, args: dict) -> dict:
    token_id = args["token_id"]
    try:
        raw = await ctx.client.get(CLOB_BASE, "/midpoint", {"token_id": token_id})
    except PolyError as e:
        return err_from_exc(e)
    data = {
        "token_id": token_id,
        "midpoint": to_float(raw.get("mid")),
    }
    return ok(data)
