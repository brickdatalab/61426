from __future__ import annotations

# Verified live (2026-06-14) against data-api.polymarket.com/trades?market=<conditionId>.
# Response: flat list of trade objects with fields proxyWallet, side, asset (token id),
# conditionId, size (number), price (number), timestamp (epoch seconds int),
# outcome, outcomeIndex, transactionHash.

from ..client import DATA_BASE, PolyError
from ..normalize import to_float, to_int, epoch_seconds
from ..registry import tool
from ..schema import ok, err_from_exc

_INPUT = {
    "type": "object",
    "properties": {
        "condition_id": {
            "type": "string",
            "description": "Market conditionId (Data API key) to fetch trades for.",
        },
        "taker_only": {
            "type": "boolean",
            "description": "If true, return only taker-side trades. Default false (both sides).",
        },
        "limit": {
            "type": "integer",
            "description": "Max number of trades to return. Default 100.",
        },
        "offset": {
            "type": "integer",
            "description": "Pagination offset into the trade list. Default 0.",
        },
    },
    "required": ["condition_id"],
    "additionalProperties": False,
}


@tool(
    name="get_trades",
    description="Recent trades for a market (by conditionId). Returns a list of normalized Trade objects.",
    input_schema=_INPUT,
)
async def get_trades(ctx, args: dict) -> dict:
    condition_id = args["condition_id"]
    taker_only = bool(args.get("taker_only", False))
    limit = args.get("limit", 100)
    offset = args.get("offset", 0)

    params = {
        "market": condition_id,
        "takerOnly": taker_only,
        "limit": limit,
        "offset": offset,
    }
    try:
        raw = await ctx.client.get(DATA_BASE, "/trades", params)
    except PolyError as e:
        return err_from_exc(e)

    trades = []
    for t in raw or []:
        trades.append(
            {
                "condition_id": t.get("conditionId"),
                "token_id": t.get("asset"),
                "wallet": t.get("proxyWallet"),
                "side": t.get("side"),
                "outcome": t.get("outcome"),
                "outcome_index": to_int(t.get("outcomeIndex")),
                "size": to_float(t.get("size")),
                "price": to_float(t.get("price")),
                "timestamp": epoch_seconds(t.get("timestamp")),
                "tx_hash": t.get("transactionHash"),
            }
        )
    return ok(trades)
