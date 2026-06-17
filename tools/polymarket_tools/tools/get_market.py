"""get_market — full normalized Gamma market object.

Verified live (2026-06-14): /markets?condition_ids={cid} returns a JSON LIST
(take first match); /markets/slug/{slug} and /markets/{id} each return a single
dict. clobTokenIds/outcomes arrive as JSON-encoded strings. Volume-24h field on
a market object is `volume24hr`; price change is `oneHourPriceChange`.
"""

from __future__ import annotations

from ..client import GAMMA_BASE, PolyError
from ..normalize import parse_str_list, parse_token_ids, to_float
from ..registry import tool
from ..schema import err, err_from_exc, ok

_INPUT = {
    "type": "object",
    "properties": {
        "condition_id": {
            "type": "string",
            "description": "Market conditionId (0x...). Looked up via /markets?condition_ids=",
        },
        "slug": {
            "type": "string",
            "description": "Market slug (from the market URL).",
        },
        "id": {
            "type": "string",
            "description": "Numeric Gamma market id.",
        },
    },
    "additionalProperties": False,
}


def _normalize(m: dict) -> dict:
    prices = [
        p for p in (to_float(x) for x in parse_str_list(m.get("outcomePrices"))) if p is not None
    ]
    return {
        "id": str(m.get("id")) if m.get("id") is not None else None,
        "condition_id": m.get("conditionId"),
        "question_id": m.get("questionID"),
        "slug": m.get("slug"),
        "question": m.get("question"),
        "clob_token_ids": parse_token_ids(m.get("clobTokenIds")),
        "outcomes": parse_str_list(m.get("outcomes")),
        "outcome_prices": prices,
        "best_bid": to_float(m.get("bestBid")),
        "best_ask": to_float(m.get("bestAsk")),
        "spread": to_float(m.get("spread")),
        "last_trade_price": to_float(m.get("lastTradePrice")),
        "one_hour_price_change": to_float(m.get("oneHourPriceChange")),
        "volume": to_float(m.get("volume")),
        "volume_24hr": to_float(m.get("volume24hr")),
        "liquidity": to_float(m.get("liquidity")),
        "active": bool(m.get("active", False)),
        "closed": bool(m.get("closed", False)),
        "accepting_orders": bool(m.get("acceptingOrders", False)),
        "end_date": m.get("endDate"),
        "resolution_source": m.get("resolutionSource"),
        "description": m.get("description"),
    }


@tool(
    name="get_market",
    description=(
        "Full market object from Gamma. Provide exactly one of condition_id, slug, "
        "or id. Returns the normalized Market shape."
    ),
    input_schema=_INPUT,
)
async def get_market(ctx, args: dict) -> dict:
    condition_id = args.get("condition_id")
    slug = args.get("slug")
    mid = args.get("id")

    provided = [k for k in ("condition_id", "slug", "id") if args.get(k)]
    if len(provided) != 1:
        return err(
            "bad_request",
            "provide exactly one of: condition_id, slug, id",
            None,
            None,
        )

    try:
        if condition_id:
            raw = await ctx.client.get(
                GAMMA_BASE, "/markets", {"condition_ids": condition_id}
            )
            if not isinstance(raw, list) or not raw:
                return err(
                    "not_found",
                    f"no market for condition_id {condition_id}",
                    404,
                    f"{GAMMA_BASE}/markets",
                )
            market = raw[0]
        elif slug:
            market = await ctx.client.get(GAMMA_BASE, f"/markets/slug/{slug}")
        else:
            market = await ctx.client.get(GAMMA_BASE, f"/markets/{mid}")
    except PolyError as e:
        if e.status == 404:
            return err("not_found", "market not found", e.status, e.endpoint)
        return err_from_exc(e)

    if isinstance(market, list):
        if not market:
            return err("not_found", "market not found", 404, None)
        market = market[0]
    if not isinstance(market, dict):
        return err("decode", "unexpected market response shape", None, None)

    return ok(_normalize(market))
