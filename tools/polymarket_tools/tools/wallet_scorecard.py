"""wallet_scorecard: blended (50/50) verified-P&L + behavioral 'sharpness' score.

Composes get_positions (realized P&L, win-rate), get_portfolio_value, and
get_profile_activity at 3500 items (volume, breadth, cadence, conviction size).
The pure `_score` function holds the formula and is unit-tested with synthetic
inputs (no network). "Smart" requires positive realized P&L and meaningful
volume - style alone is not enough.
"""

from __future__ import annotations

import math
import statistics

from ..registry import tool
from ..schema import err, ok
from .get_portfolio_value import get_portfolio_value
from .get_positions import get_positions
from .get_profile_activity import get_profile_activity


def _sig(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def _score(realized_pnl, roi, win_rate, volume, n_markets, median_size, trades_per_day) -> dict:
    # P&L component (0..1): real realized profit + ROI, gated on volume.
    pnl_c = _sig(realized_pnl / 100_000) * _sig((roi - 0.0) * 8)
    if volume < 5_000 or realized_pnl <= 0:
        pnl_c *= 0.2  # unproven / unprofitable -> heavy discount
    # Behavioral component (0..1): conviction size + breadth + selectivity.
    size_c = _sig((median_size - 50) / 150)
    breadth_c = _sig((n_markets - 5) / 20)
    cadence_c = 1.0 if trades_per_day <= 30 else max(0.1, 30 / trades_per_day)
    beh_c = 0.45 * size_c + 0.30 * breadth_c + 0.25 * cadence_c
    score = 0.5 * pnl_c + 0.5 * beh_c
    label = (
        "SHARP" if score >= 0.66
        else "MIXED" if score >= 0.40
        else "NOISE-BOT" if trades_per_day > 200
        else "RETAIL"
    )
    return {
        "score": round(score, 3),
        "label": label,
        "pnl_component": round(pnl_c, 3),
        "behavioral_component": round(beh_c, 3),
    }


_INPUT = {
    "type": "object",
    "properties": {
        "wallet": {"type": "string", "description": "Proxy wallet address (0x...). Alias: 'profile_id'."},
        "profile_id": {"type": "string", "description": "Alias for wallet."},
        "since": {"type": "string", "description": "Activity window for behavioral stats. Default '30d'."},
    },
    "required": [],
    "additionalProperties": False,
}


@tool(
    name="wallet_scorecard",
    description="Blended 50/50 verified-P&L + behavioral sharpness score for a wallet. "
    "Pulls positions (realized P&L, win-rate), portfolio value, and 3500-item activity "
    "(volume, breadth, conviction size, cadence). Returns score 0-1 and a SHARP/MIXED/"
    "NOISE-BOT/RETAIL label. 'Smart' requires positive realized P&L + real volume.",
    input_schema=_INPUT,
)
async def wallet_scorecard(ctx, args: dict) -> dict:
    wallet = (args.get("wallet") or args.get("profile_id") or "").strip()
    if not wallet:
        return err("bad_request", "wallet (proxy address) is required")
    since = args.get("since") or "30d"

    pos = await get_positions(ctx, {"wallet": wallet, "limit": 500})
    val = await get_portfolio_value(ctx, {"wallet": wallet})
    act = await get_profile_activity(ctx, {"profile_id": wallet, "since": since, "types": ["TRADE"], "max_items": 3500})
    if not pos["ok"] or not act["ok"]:
        return err("upstream", "could not fetch positions/activity for wallet")

    positions = pos["data"]
    items = act["data"]["items"]

    realized_pnl = round(sum((p.get("realized_pnl") or 0.0) for p in positions), 2)
    resolved = [p for p in positions if (p.get("realized_pnl") or 0.0) != 0.0]
    win_rate = (
        round(sum(1 for p in resolved if (p.get("realized_pnl") or 0.0) > 0) / len(resolved), 3)
        if resolved else None
    )
    sizes = [i.get("usdc_size") or 0.0 for i in items if (i.get("usdc_size") or 0.0) > 0]
    volume = round(sum(sizes), 2)
    n_markets = len({i.get("condition_id") for i in items if i.get("condition_id")})
    median_size = round(statistics.median(sizes), 2) if sizes else 0.0
    ts = [i.get("timestamp") for i in items if i.get("timestamp")]
    span_days = max((max(ts) - min(ts)) / 86400.0, 1.0) if len(ts) >= 2 else 1.0
    trades_per_day = round(len(items) / span_days, 2)
    roi = round(realized_pnl / volume, 4) if volume else 0.0

    sc = _score(realized_pnl, roi, win_rate or 0.0, volume, n_markets, median_size, trades_per_day)
    return ok({
        "wallet": wallet,
        "score": sc["score"],
        "label": sc["label"],
        "components": {"pnl": sc["pnl_component"], "behavioral": sc["behavioral_component"]},
        "raw_metrics": {
            "realized_pnl": realized_pnl,
            "roi": roi,
            "win_rate": win_rate,
            "portfolio_value": val["data"]["value"] if val["ok"] else None,
            "activity_volume_usdc": volume,
            "n_markets": n_markets,
            "median_bet_usdc": median_size,
            "trades_per_day": trades_per_day,
            "activity_count": len(items),
            "window": since,
        },
    })
