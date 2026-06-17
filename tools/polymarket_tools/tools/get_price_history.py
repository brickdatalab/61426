# Verified live: GET /prices-history?market={TOKEN_ID}&interval={1d}&fidelity={min}
# returns {"history":[{t,p}, ...]}. The `market` query param value is the TOKEN id,
# NOT the conditionId. start_ts/end_ts map to startTs/endTs (mutually exclusive with
# interval per the docs).
from __future__ import annotations

from ..client import CLOB_BASE, PolyError
from ..normalize import epoch_seconds, to_float
from ..registry import tool
from ..schema import err_from_exc, ok

_INTERVALS = ["1m", "1h", "6h", "1d", "1w", "max"]

_INPUT = {
    "type": "object",
    "properties": {
        "token_id": {
            "type": "string",
            "description": "CLOB token/asset id (NOT the conditionId).",
        },
        "interval": {
            "type": "string",
            "enum": _INTERVALS,
            "description": "Lookback window: 1m, 1h, 6h, 1d, 1w, max. Default 1d. Ignored if start_ts/end_ts given.",
        },
        "fidelity": {
            "type": "integer",
            "description": "Resolution in minutes between data points (optional).",
        },
        "start_ts": {
            "type": "integer",
            "description": "Absolute range start, epoch seconds. Alternative to interval (with end_ts).",
        },
        "end_ts": {
            "type": "integer",
            "description": "Absolute range end, epoch seconds. Alternative to interval (with start_ts).",
        },
    },
    "required": ["token_id"],
    "additionalProperties": False,
}


def _normalize_history(raw) -> list[dict]:
    """Response is {history:[{t,p}]} or a bare list. -> [{t:int epoch, p:float}]."""
    points = raw.get("history") if isinstance(raw, dict) else raw
    out: list[dict] = []
    for pt in points or []:
        t = epoch_seconds(pt.get("t"))
        p = to_float(pt.get("p"))
        if t is None or p is None:
            continue
        out.append({"t": t, "p": p})
    return out


@tool(
    name="get_price_history",
    description=(
        "Time-series price history for one token. Use interval (default 1d) OR an "
        "absolute start_ts/end_ts range. Returns {token_id, interval, fidelity, "
        "history:[{t,p}]} with t in epoch seconds and p as float."
    ),
    input_schema=_INPUT,
)
async def get_price_history(ctx, args: dict) -> dict:
    token_id = str(args["token_id"])
    fidelity = args.get("fidelity")
    start_ts = args.get("start_ts")
    end_ts = args.get("end_ts")
    use_range = start_ts is not None or end_ts is not None
    interval = args.get("interval", "1d")

    params: dict = {"market": token_id, "fidelity": fidelity}
    if use_range:
        params["startTs"] = start_ts
        params["endTs"] = end_ts
    else:
        params["interval"] = interval

    try:
        raw = await ctx.client.get(CLOB_BASE, "/prices-history", params)
    except PolyError as e:
        return err_from_exc(e)

    data = {
        "token_id": token_id,
        "interval": None if use_range else interval,
        "fidelity": fidelity,
        "history": _normalize_history(raw),
    }
    return ok(data)
