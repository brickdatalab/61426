# Verified live: POST /batch-prices-history EXISTS (200). Body
# {"markets":[token_ids], "interval", "fidelity", ...}; response is
# {"history": {token_id: [{t,p}, ...], ...}} keyed by token id (NOT a list).
# Primary path = this batch endpoint. Fallback (used only if it 404s/errors) =
# fan out single GET /prices-history calls via fanout.gather_bounded. The "path"
# field in the err/log notes which path was taken. Cap 20 tokens.
from __future__ import annotations

from ..client import CLOB_BASE, PolyError
from ..fanout import gather_bounded
from ..normalize import epoch_seconds, to_float
from ..registry import tool
from ..schema import err, err_from_exc, ok

_MAX_TOKENS = 20
_INTERVALS = ["1m", "1h", "6h", "1d", "1w", "max"]

_INPUT = {
    "type": "object",
    "properties": {
        "token_ids": {
            "type": "array",
            "items": {"type": "string"},
            "maxItems": _MAX_TOKENS,
            "description": f"CLOB token/asset ids (max {_MAX_TOKENS}). NOT conditionIds.",
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
    "required": ["token_ids"],
    "additionalProperties": False,
}


def _normalize_history(points) -> list[dict]:
    out: list[dict] = []
    for pt in points or []:
        t = epoch_seconds(pt.get("t"))
        p = to_float(pt.get("p"))
        if t is None or p is None:
            continue
        out.append({"t": t, "p": p})
    return out


def _ph(token_id: str, interval, fidelity, history: list[dict]) -> dict:
    return {
        "token_id": token_id,
        "interval": interval,
        "fidelity": fidelity,
        "history": history,
    }


async def _single_history(client, token_id: str, params: dict) -> dict:
    p = dict(params, market=token_id)
    raw = await client.get(CLOB_BASE, "/prices-history", p)
    points = raw.get("history") if isinstance(raw, dict) else raw
    return _normalize_history(points)


@tool(
    name="get_price_history_batch",
    description=(
        f"Time-series price history for up to {_MAX_TOKENS} tokens. Use interval "
        "(default 1d) OR an absolute start_ts/end_ts range. Returns a list aligned to "
        "input token_ids; each item is {token_id, interval, fidelity, history:[{t,p}]} "
        "(plus a 'path' note) or a per-item error envelope."
    ),
    input_schema=_INPUT,
)
async def get_price_history_batch(ctx, args: dict) -> dict:
    token_ids = [str(t) for t in args["token_ids"]]
    if not token_ids:
        return ok([])
    if len(token_ids) > _MAX_TOKENS:
        return err(
            "too_many_tokens",
            f"get_price_history_batch accepts at most {_MAX_TOKENS} tokens, got {len(token_ids)}.",
            None,
            "/batch-prices-history",
        )

    fidelity = args.get("fidelity")
    start_ts = args.get("start_ts")
    end_ts = args.get("end_ts")
    use_range = start_ts is not None or end_ts is not None
    interval = args.get("interval", "1d")
    out_interval = None if use_range else interval

    # Build shared query params (single-call form uses these + market=token).
    common: dict = {"fidelity": fidelity}
    if use_range:
        common["startTs"] = start_ts
        common["endTs"] = end_ts
    else:
        common["interval"] = interval

    # Primary path: POST /batch-prices-history.
    body: dict = {"markets": token_ids, "fidelity": fidelity}
    if use_range:
        body["startTs"] = start_ts
        body["endTs"] = end_ts
    else:
        body["interval"] = interval

    try:
        raw = await ctx.client.post(CLOB_BASE, "/batch-prices-history", body)
    except PolyError as e:
        if e.status == 404:
            return await _fallback(ctx, token_ids, common, out_interval, fidelity)
        return err_from_exc(e)

    # raw["history"] is {token_id: [{t,p}], ...}. Align to input order.
    hist_map = raw.get("history", {}) if isinstance(raw, dict) else {}
    out = []
    for token_id in token_ids:
        item = _ph(token_id, out_interval, fidelity, _normalize_history(hist_map.get(token_id)))
        item["path"] = "batch"
        out.append(item)
    return ok(out)


async def _fallback(ctx, token_ids, common, out_interval, fidelity) -> dict:
    results = await gather_bounded(
        [lambda t=t: _single_history(ctx.client, t, common) for t in token_ids],
        limit=_MAX_TOKENS,
    )
    out = []
    for token_id, res in zip(token_ids, results):
        if isinstance(res, Exception):
            out.append(err_from_exc(res))
        else:
            item = _ph(token_id, out_interval, fidelity, res)
            item["path"] = "fanout"
            out.append(item)
    return ok(out)
