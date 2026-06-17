"""get_market_tags — tags attached to a market.

Verified live (2026-06-14): GET /markets/{id}/tags returns a JSON LIST of tag
objects shaped {"id", "label", "slug", ...extra}. We project to {id, label, slug}.
"""

from __future__ import annotations

from ..client import GAMMA_BASE, PolyError
from ..registry import tool
from ..schema import err, err_from_exc, ok

_INPUT = {
    "type": "object",
    "properties": {
        "id": {
            "type": "string",
            "description": "Numeric Gamma market id.",
        },
    },
    "required": ["id"],
    "additionalProperties": False,
}


@tool(
    name="get_market_tags",
    description="List of tags (id/label/slug) for a market, by numeric market id.",
    input_schema=_INPUT,
)
async def get_market_tags(ctx, args: dict) -> dict:
    mid = args["id"]
    try:
        raw = await ctx.client.get(GAMMA_BASE, f"/markets/{mid}/tags")
    except PolyError as e:
        if e.status == 404:
            return err("not_found", f"market not found: {mid}", e.status, e.endpoint)
        return err_from_exc(e)

    if not isinstance(raw, list):
        return err("decode", "unexpected tags response shape", None, None)

    tags = [
        {
            "id": str(t.get("id")) if t.get("id") is not None else None,
            "label": t.get("label"),
            "slug": t.get("slug"),
        }
        for t in raw
        if isinstance(t, dict)
    ]
    return ok(tags)
