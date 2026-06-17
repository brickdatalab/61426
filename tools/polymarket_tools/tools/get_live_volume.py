"""get_live_volume — per-market live volume for an event.

Verified live (2026-06-14): the documented Gamma path 404s. The endpoint lives
on DATA_BASE: GET https://data-api.polymarket.com/live-volume?id={eventId}.
It returns a LIST with one object: {"total": <float>, "markets": [{"market":
<conditionId>, "value": <volume>}]}. The first markets entry often has an empty
`market` string (an event-level rollup); we skip empty conditionIds. The
response carries NO token_id, so LiveVolumeMarket.token_id is omitted.
"""

from __future__ import annotations

from ..client import DATA_BASE, PolyError
from ..normalize import to_float
from ..registry import tool
from ..schema import err, err_from_exc, ok

_INPUT = {
    "type": "object",
    "properties": {
        "event_id": {
            "type": "string",
            "description": "Numeric Gamma event id.",
        },
    },
    "required": ["event_id"],
    "additionalProperties": False,
}


@tool(
    name="get_live_volume",
    description="Live per-market volume for an event (from the Data API live-volume endpoint).",
    input_schema=_INPUT,
)
async def get_live_volume(ctx, args: dict) -> dict:
    event_id = args["event_id"]
    try:
        raw = await ctx.client.get(DATA_BASE, "/live-volume", {"id": event_id})
    except PolyError as e:
        if e.status == 404:
            return err(
                "not_found", f"no live volume for event {event_id}", e.status, e.endpoint
            )
        return err_from_exc(e)

    obj = raw[0] if isinstance(raw, list) and raw else raw
    if not isinstance(obj, dict):
        return err("not_found", f"no live volume for event {event_id}", 404, None)

    markets = []
    summed = 0.0
    for m in obj.get("markets") or []:
        if not isinstance(m, dict):
            continue
        cid = m.get("market")
        vol = to_float(m.get("value"))
        if vol is not None:
            summed += vol
        if not cid:  # skip the empty event-level rollup entry
            continue
        markets.append({"condition_id": cid, "volume": vol})

    total = to_float(obj.get("total"))
    if total is None:
        total = summed

    return ok({"event_id": str(event_id), "total": total, "markets": markets})
