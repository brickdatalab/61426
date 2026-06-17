# Verified live: GET data-api.polymarket.com/value?user={wallet} -> [{"user","value"}].
"""get_portfolio_value: a wallet's total current portfolio value (USDC)."""

from __future__ import annotations

from ..client import DATA_BASE, PolyError
from ..normalize import to_float
from ..registry import tool
from ..schema import err, err_from_exc, ok

_INPUT = {
    "type": "object",
    "properties": {
        "wallet": {"type": "string", "description": "Proxy wallet address (0x...). Alias: 'profile_id'."},
        "profile_id": {"type": "string", "description": "Alias for wallet."},
    },
    "required": [],
    "additionalProperties": False,
}


@tool(
    name="get_portfolio_value",
    description="A wallet's total current Polymarket portfolio value in USDC. Keys on the wallet address.",
    input_schema=_INPUT,
)
async def get_portfolio_value(ctx, args: dict) -> dict:
    wallet = (args.get("wallet") or args.get("profile_id") or "").strip()
    if not wallet:
        return err("bad_request", "wallet (proxy address) is required")
    try:
        raw = await ctx.client.get(DATA_BASE, "/value", {"user": wallet})
    except PolyError as e:
        return err_from_exc(e)
    row = raw[0] if isinstance(raw, list) and raw else (raw if isinstance(raw, dict) else {})
    return ok({"wallet": wallet, "value": to_float(row.get("value"), 0.0)})
