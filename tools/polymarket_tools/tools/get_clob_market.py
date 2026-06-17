from __future__ import annotations

# VERIFIED LIVE 2026-06-14: the SPEC path GET /clob-markets/{condition_id} returns
# HTTP 200 but an UNUSABLE abbreviated-key shape (keys: r,t,c,mos,mts,mbf,tbf,...)
# that does not carry the documented field names. GET /markets/{condition_id}
# returns the full, well-named CLOB market object (condition_id, question_id,
# tokens[{token_id,outcome,price}], minimum_tick_size, minimum_order_size,
# neg_risk, maker_base_fee, taker_base_fee, rewards, game_start_time,
# accepting_orders, closed). We try /clob-markets first; if it 404s OR returns the
# abbreviated shape (no "condition_id" key), we fall back to /markets, which is the
# path actually used here.

from ..client import CLOB_BASE, PolyError
from ..normalize import to_bool, to_float
from ..registry import tool
from ..schema import err_from_exc, ok

_INPUT = {
    "type": "object",
    "properties": {
        "condition_id": {"type": "string", "description": "Market condition id (0x...)"},
    },
    "required": ["condition_id"],
    "additionalProperties": False,
}


def _has_full_shape(raw: object) -> bool:
    return isinstance(raw, dict) and "condition_id" in raw


@tool(
    name="get_clob_market",
    description="CLOB market metadata (tokens, tick size, fees, rewards, status) by condition id.",
    input_schema=_INPUT,
)
async def get_clob_market(ctx, args: dict) -> dict:
    condition_id = args["condition_id"]

    raw = None
    try:
        candidate = await ctx.client.get(CLOB_BASE, f"/clob-markets/{condition_id}")
        if _has_full_shape(candidate):
            raw = candidate
    except PolyError as e:
        if e.status != 404:
            return err_from_exc(e)

    if raw is None:
        try:
            raw = await ctx.client.get(CLOB_BASE, f"/markets/{condition_id}")
        except PolyError as e:
            return err_from_exc(e)

    tokens = [
        {
            "token_id": str(t.get("token_id")),
            "outcome": t.get("outcome"),
            "price": to_float(t.get("price")),
        }
        for t in (raw.get("tokens") or [])
    ]

    data = {
        "condition_id": raw.get("condition_id"),
        "question_id": raw.get("question_id"),
        "tokens": tokens,
        "tick_size": to_float(raw.get("minimum_tick_size")),
        "min_order_size": to_float(raw.get("minimum_order_size")),
        "neg_risk": bool(raw.get("neg_risk", False)),
        "fees": {
            "maker_fee_base_bps": to_float(raw.get("maker_base_fee")),
            "taker_fee_base_bps": to_float(raw.get("taker_base_fee")),
        },
        "rewards": raw.get("rewards") or {},
        "game_start_time": raw.get("game_start_time"),
        "accepting_orders": to_bool(raw.get("accepting_orders")),
        "closed": to_bool(raw.get("closed")),
    }
    return ok(data)
