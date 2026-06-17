# Verified live: POST /midpoints with body [{"token_id": ...}] works (200, returns
# {token_id: "0.195", ...} map). GET /midpoints?token_ids=csv -> 400, and POST with
# {"params":[...]} -> 400. So the working batch form is POST /midpoints with a bare
# list of {token_id} objects. We use that; if it fails we fan out single GET /midpoint.
from __future__ import annotations

from ..client import CLOB_BASE, PolyError
from ..fanout import gather_bounded
from ..normalize import to_float
from ..registry import tool
from ..schema import err, err_from_exc, ok

_INPUT = {
    "type": "object",
    "properties": {
        "token_ids": {
            "type": "array",
            "items": {"type": "string"},
            "description": "CLOB token/asset ids to fetch midpoints for.",
        },
    },
    "required": ["token_ids"],
    "additionalProperties": False,
}


async def _single_midpoint(client, token_id: str) -> dict:
    """Fan-out fallback: GET /midpoint for one token. Returns a Midpoint or err dict."""
    try:
        raw = await client.get(CLOB_BASE, "/midpoint", {"token_id": token_id})
    except PolyError as e:
        if e.status == 404:
            return err("market_closed", "midpoint unavailable (closed/no orderbook)", e.status, e.endpoint)
        return err_from_exc(e)
    return {"token_id": token_id, "midpoint": to_float(raw.get("mid"))}


@tool(
    name="get_midpoints_batch",
    description=(
        "Midpoints for many tokens. Returns a list aligned to input token_ids; "
        "each item is {token_id, midpoint} or a per-item error envelope. Uses the "
        "batch POST /midpoints endpoint, falling back to single GET /midpoint."
    ),
    input_schema=_INPUT,
)
async def get_midpoints_batch(ctx, args: dict) -> dict:
    token_ids = [str(t) for t in args["token_ids"]]
    if not token_ids:
        return ok([])

    try:
        raw = await ctx.client.post(
            CLOB_BASE, "/midpoints", [{"token_id": t} for t in token_ids]
        )
    except PolyError:
        # Batch endpoint failed entirely -> fan out single GET /midpoint calls.
        results = await gather_bounded(
            [lambda t=t: _single_midpoint(ctx.client, t) for t in token_ids]
        )
        out = []
        for token_id, res in zip(token_ids, results):
            if isinstance(res, Exception):
                out.append(err_from_exc(res))
            else:
                out.append(res)
        return ok(out)

    # raw is a {token_id: "0.195", ...} map. Align to input order; tokens with no
    # orderbook are simply absent from the map -> per-item error.
    out = []
    for token_id in token_ids:
        if token_id in raw:
            out.append({"token_id": token_id, "midpoint": to_float(raw[token_id])})
        else:
            out.append(
                err("market_closed", "midpoint unavailable (closed/no orderbook)", None, "/midpoints")
            )
    return ok(out)
