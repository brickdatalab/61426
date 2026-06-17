"""get_event — normalized Gamma event object (the markets it groups).

Verified live (2026-06-14): /events/slug/{slug} returns a single dict with a
`markets` list; volume-24h field is `volume24hr`; neg-risk flag is `negRisk`;
`openInterest` present. `category` is often null on the event object.
"""

from __future__ import annotations

from ..client import GAMMA_BASE, PolyError
from ..normalize import to_float
from ..registry import tool
from ..schema import err, err_from_exc, ok

_INPUT = {
    "type": "object",
    "properties": {
        "event_slug": {
            "type": "string",
            "description": "Event slug (from polymarket.com/event/{slug}).",
        },
    },
    "required": ["event_slug"],
    "additionalProperties": False,
}


@tool(
    name="get_event",
    description="Full event object from Gamma by slug, with its child market condition ids.",
    input_schema=_INPUT,
)
async def get_event(ctx, args: dict) -> dict:
    slug = args["event_slug"]
    try:
        ev = await ctx.client.get(GAMMA_BASE, f"/events/slug/{slug}")
    except PolyError as e:
        if e.status == 404:
            return err("not_found", f"event not found: {slug}", e.status, e.endpoint)
        return err_from_exc(e)

    if isinstance(ev, list):
        if not ev:
            return err("not_found", f"event not found: {slug}", 404, None)
        ev = ev[0]
    if not isinstance(ev, dict):
        return err("decode", "unexpected event response shape", None, None)

    markets = ev.get("markets") or []
    condition_ids = [
        m.get("conditionId") for m in markets if isinstance(m, dict) and m.get("conditionId")
    ]

    data = {
        "id": str(ev.get("id")) if ev.get("id") is not None else None,
        "slug": ev.get("slug"),
        "title": ev.get("title"),
        "neg_risk": bool(ev.get("negRisk", False)),
        "category": ev.get("category"),
        "volume": to_float(ev.get("volume")),
        "volume_24hr": to_float(ev.get("volume24hr")),
        "liquidity": to_float(ev.get("liquidity")),
        "open_interest": to_float(ev.get("openInterest")),
        "active": bool(ev.get("active", False)),
        "closed": bool(ev.get("closed", False)),
        "market_count": len(markets),
        "condition_ids": condition_ids,
    }
    return ok(data)
