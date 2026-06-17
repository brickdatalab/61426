from __future__ import annotations

# Single streaming tool over the persistent WsManager (ctx.ws). One tool with an
# `action` dispatch keeps the server at its 18-tool budget. subscribe/unsubscribe
# accept either `asset_id` (single) or `asset_ids` (many); read uses `asset_id`.

from ..registry import tool
from ..schema import err, ok

_INPUT = {
    "type": "object",
    "properties": {
        "action": {
            "type": "string",
            "enum": ["subscribe", "read", "unsubscribe"],
            "description": "subscribe/unsubscribe a token from the live market feed, or read its latest cached snapshot.",
        },
        "asset_id": {
            "type": "string",
            "description": "CLOB token/asset id. Required for read; accepted by subscribe/unsubscribe for a single id.",
        },
        "asset_ids": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Multiple CLOB token/asset ids for subscribe/unsubscribe.",
        },
    },
    "required": ["action"],
    "additionalProperties": False,
}


def _ids(args: dict) -> list[str]:
    ids = list(args.get("asset_ids") or [])
    single = args.get("asset_id")
    if single:
        ids.append(single)
    # de-dup while preserving order
    seen: set[str] = set()
    out: list[str] = []
    for a in ids:
        if a and a not in seen:
            seen.add(a)
            out.append(a)
    return out


@tool(
    name="stream_market",
    description=(
        "Live order-book feed over a persistent WebSocket. action=subscribe starts "
        "streaming token id(s); action=read returns the latest cached book/best "
        "bid-ask/last-trade snapshot for one token (non-blocking); "
        "action=unsubscribe stops streaming token id(s)."
    ),
    input_schema=_INPUT,
)
async def stream_market(ctx, args: dict) -> dict:
    action = args["action"]

    if action == "subscribe":
        ids = _ids(args)
        if not ids:
            return err("bad_request", "subscribe requires asset_id or asset_ids")
        await ctx.ws.subscribe(ids)
        return ok(ctx.ws.status())

    if action == "unsubscribe":
        ids = _ids(args)
        if not ids:
            return err("bad_request", "unsubscribe requires asset_id or asset_ids")
        await ctx.ws.unsubscribe(ids)
        return ok(ctx.ws.status())

    if action == "read":
        asset_id = args.get("asset_id")
        if not asset_id:
            return err("bad_request", "read requires asset_id")
        snap = await ctx.ws.read_latest(asset_id)
        if snap is None:
            return ok({"snapshot": None, "note": "no data yet"})
        return ok(snap)

    return err("bad_request", f"unknown action: {action}")
