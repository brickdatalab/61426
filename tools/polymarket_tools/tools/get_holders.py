from __future__ import annotations

# Verified live (2026-06-14) against data-api.polymarket.com/holders?market=<conditionId>.
# Response: list grouped per outcome token: [{token, holders: [{proxyWallet, asset,
# amount (number), outcomeIndex, ...}]}]. We flatten to a list of Holder objects and
# also expose the per-token grouping. The `market` query param value is the conditionId.

from ..client import DATA_BASE, PolyError
from ..normalize import to_float, to_int
from ..registry import tool
from ..schema import ok, err_from_exc

_INPUT = {
    "type": "object",
    "properties": {
        "condition_id": {
            "type": "string",
            "description": "Market conditionId (Data API key) to fetch holders for.",
        },
        "limit": {
            "type": "integer",
            "description": "Max holders per outcome token. Default 20, clamped to <=20.",
        },
        "min_balance": {
            "type": "number",
            "description": "Minimum token balance a holder must have to be included.",
        },
    },
    "required": ["condition_id"],
    "additionalProperties": False,
}


@tool(
    name="get_holders",
    description="Top holders for a market (by conditionId), grouped per outcome token. Returns a flat list of Holder objects.",
    input_schema=_INPUT,
)
async def get_holders(ctx, args: dict) -> dict:
    condition_id = args["condition_id"]
    limit = args.get("limit", 20)
    if limit is None or limit > 20:
        limit = 20
    min_balance = args.get("min_balance")

    params = {
        "market": condition_id,
        "limit": limit,
        "minBalance": min_balance,
    }
    try:
        raw = await ctx.client.get(DATA_BASE, "/holders", params)
    except PolyError as e:
        return err_from_exc(e)

    holders: list[dict] = []
    by_token: list[dict] = []
    for group in raw or []:
        token_id = group.get("token")
        token_holders: list[dict] = []
        for h in group.get("holders") or []:
            holder = {
                "condition_id": condition_id,
                "token_id": token_id or h.get("asset"),
                "wallet": h.get("proxyWallet"),
                "amount": to_float(h.get("amount")),
                "outcome_index": to_int(h.get("outcomeIndex")),
            }
            holders.append(holder)
            token_holders.append(holder)
        by_token.append({"token_id": token_id, "holders": token_holders})

    return ok({"holders": holders, "by_token": by_token})
