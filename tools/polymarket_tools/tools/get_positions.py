# Verified live against data-api.polymarket.com/positions (2026-06).
# GET /positions?user={wallet}&limit&sortBy=CURRENT&sortDirection=DESC
# Item keys: asset, conditionId, outcome, outcomeIndex, size, avgPrice, curPrice,
#   currentValue, initialValue, cashPnl, percentPnl, realizedPnl,
#   percentRealizedPnl, totalBought, redeemable, title, slug, eventSlug.
"""get_positions: a wallet's current positions with realized/unrealized P&L."""

from __future__ import annotations

from ..client import DATA_BASE, PolyError
from ..normalize import to_bool, to_float, to_int
from ..registry import tool
from ..schema import err, err_from_exc, ok

_INPUT = {
    "type": "object",
    "properties": {
        "wallet": {"type": "string", "description": "Proxy wallet address (0x...). Alias: 'profile_id'."},
        "profile_id": {"type": "string", "description": "Alias for wallet."},
        "limit": {"type": "integer", "description": "Max positions to return. Default 100."},
        "sort_by": {"type": "string", "description": "Sort key (CURRENT, REALIZEDPNL, ...). Default CURRENT."},
    },
    "required": [],
    "additionalProperties": False,
}


@tool(
    name="get_positions",
    description="A wallet's current Polymarket positions with realized/unrealized P&L "
    "(realized_pnl, cash_pnl, percent_pnl, avg_price, current_value). Keys on the wallet address.",
    input_schema=_INPUT,
)
async def get_positions(ctx, args: dict) -> dict:
    wallet = (args.get("wallet") or args.get("profile_id") or "").strip()
    if not wallet:
        return err("bad_request", "wallet (proxy address) is required")
    params = {
        "user": wallet,
        "limit": to_int(args.get("limit")) or 100,
        "sortBy": args.get("sort_by") or "CURRENT",
        "sortDirection": "DESC",
    }
    try:
        raw = await ctx.client.get(DATA_BASE, "/positions", params)
    except PolyError as e:
        return err_from_exc(e)
    if not isinstance(raw, list):
        return ok([])
    return ok([_normalize(p) for p in raw])


def _normalize(p: dict) -> dict:
    return {
        "condition_id": p.get("conditionId"),
        "token_id": p.get("asset"),
        "outcome": p.get("outcome"),
        "outcome_index": to_int(p.get("outcomeIndex")),
        "size": to_float(p.get("size")),
        "avg_price": to_float(p.get("avgPrice")),
        "cur_price": to_float(p.get("curPrice")),
        "current_value": to_float(p.get("currentValue")),
        "initial_value": to_float(p.get("initialValue")),
        "cash_pnl": to_float(p.get("cashPnl")),
        "percent_pnl": to_float(p.get("percentPnl")),
        "realized_pnl": to_float(p.get("realizedPnl")),
        "percent_realized_pnl": to_float(p.get("percentRealizedPnl")),
        "total_bought": to_float(p.get("totalBought")),
        "redeemable": to_bool(p.get("redeemable")),
        "title": p.get("title"),
        "slug": p.get("slug"),
        "event_slug": p.get("eventSlug"),
    }
