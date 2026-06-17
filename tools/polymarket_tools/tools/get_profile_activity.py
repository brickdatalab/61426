# Verified live against data-api.polymarket.com/activity (2026-06).
# Endpoint: GET /activity?user={proxyWallet}&limit&offset&sortBy=TIMESTAMP&sortDirection=DESC
# Item fields: proxyWallet, timestamp(epoch s), conditionId, type, size, usdcSize,
#   transactionHash, price, asset(token id), side, outcomeIndex, title, slug,
#   eventSlug, outcome, name, pseudonym.
# A "profile id" on Polymarket is the proxy wallet address. Time window is resolved
# CLIENT-SIDE (paginate DESC, stop once older than start) so any window works:
# "20m", "45m", "1h", "5d", "2w", or explicit start_ts/end_ts.
"""get_profile_activity: every personal bet/activity by one profile in a window."""

from __future__ import annotations

import re
import time

from ..client import DATA_BASE, PolyError
from ..fanout import DEFAULT_CONCURRENCY  # noqa: F401  (kept for parity; not required)
from ..normalize import epoch_seconds, iso_from_epoch, to_float, to_int
from ..registry import tool
from ..schema import err, err_from_exc, ok

_VALID_TYPES = {"TRADE", "SPLIT", "MERGE", "REDEEM", "REWARD", "CONVERSION"}
_PAGE = 100  # API page size for limit/offset walk
_API_MAX_ITEMS = 3500  # /activity hard ceiling: offset>=3400 returns HTTP 400
_DUR_RE = re.compile(r"(\d+)\s*([smhdw])", re.IGNORECASE)
_UNIT_SECONDS = {"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}

_INPUT = {
    "type": "object",
    "properties": {
        "profile_id": {
            "type": "string",
            "description": "Profile / proxy wallet address (0x...). Alias: 'address'.",
        },
        "address": {"type": "string", "description": "Alias for profile_id."},
        "since": {
            "type": "string",
            "description": "Relative window ending now: e.g. '20m', '45m', '1h', '5d', '2w'. "
            "Combos allowed ('1h30m'). Ignored if start_ts is given. Default '24h'.",
        },
        "start_ts": {"type": "integer", "description": "Window start, epoch seconds (overrides 'since')."},
        "end_ts": {"type": "integer", "description": "Window end, epoch seconds (default = now)."},
        "types": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Activity types to include: TRADE, SPLIT, MERGE, REDEEM, REWARD, "
            "CONVERSION, or 'ALL'. Default ['TRADE'] (actual bets).",
        },
        "market": {"type": "string", "description": "Optional conditionId filter."},
        "side": {"type": "string", "enum": ["BUY", "SELL"], "description": "Optional side filter (trades)."},
        "max_items": {"type": "integer", "description": "Safety cap on items returned. Default 3500 (API ceiling)."},
    },
    "required": [],
    "additionalProperties": False,
}


def _parse_duration(s: str) -> int | None:
    """'20m' -> 1200, '1h30m' -> 5400, '5d' -> 432000. None if unparseable."""
    matches = _DUR_RE.findall(s or "")
    if not matches:
        return None
    total = 0
    for num, unit in matches:
        total += int(num) * _UNIT_SECONDS[unit.lower()]
    return total or None


@tool(
    name="get_profile_activity",
    description=(
        "All personal bets/activity by a Polymarket profile (proxy wallet) within a time window. "
        "Window can be relative ('20m', '45m', '1h', '5d', '2w') or explicit start_ts/end_ts. "
        "Paginates back until the window is fully covered. Default type is TRADE (real bets); "
        "pass types=['ALL'] for the full on-chain tape (splits, merges, redeems, rewards)."
    ),
    input_schema=_INPUT,
)
async def get_profile_activity(ctx, args: dict) -> dict:
    wallet = (args.get("profile_id") or args.get("address") or "").strip()
    if not wallet:
        return err("bad_request", "profile_id (proxy wallet address) is required")

    now = int(time.time())
    end_ts = to_int(args.get("end_ts")) or now
    start_ts = to_int(args.get("start_ts"))
    if start_ts is None:
        secs = _parse_duration(args.get("since") or "24h")
        if secs is None:
            return err("bad_request", f"could not parse 'since': {args.get('since')!r}")
        start_ts = end_ts - secs
    if start_ts >= end_ts:
        return err("bad_request", "window is empty (start_ts >= end_ts)")

    # Resolve type filter.
    raw_types = args.get("types") or ["TRADE"]
    raw_types = [str(t).upper() for t in raw_types]
    if "ALL" in raw_types:
        want_types: set[str] | None = None  # no filter
    else:
        want_types = {t for t in raw_types if t in _VALID_TYPES}
        if not want_types:
            return err("bad_request", f"no valid types in {raw_types}; allowed: {sorted(_VALID_TYPES)} or 'ALL'")

    market = args.get("market")
    side = (args.get("side") or "").upper() or None
    max_items = min(to_int(args.get("max_items")) or 3500, 3500)

    params = {
        "user": wallet,
        "limit": _PAGE,
        "offset": 0,
        "sortBy": "TIMESTAMP",
        "sortDirection": "DESC",
    }
    if want_types and len(want_types) == 1:
        params["type"] = next(iter(want_types))  # let the API pre-filter when possible
    if market:
        params["market"] = market

    items: list[dict] = []
    offset = 0
    pages = 0
    truncated = False
    reached_window_start = False
    hit_api_ceiling = False
    while True:
        # The /activity endpoint hard-caps retrieval at 3500 items: offset>=3400
        # returns HTTP 400. Stop before crossing the ceiling.
        if offset + _PAGE > _API_MAX_ITEMS:
            truncated = True
            break
        params["offset"] = offset
        try:
            page = await ctx.client.get(DATA_BASE, "/activity", params)
        except PolyError as e:
            # A 400 mid-walk = we hit the API ceiling; return what we have.
            if e.status == 400 and offset > 0:
                hit_api_ceiling = True
                truncated = True
                break
            return err_from_exc(e)
        if not isinstance(page, list) or not page:
            break
        pages += 1
        for it in page:
            ts = epoch_seconds(it.get("timestamp")) or 0
            if ts < start_ts:
                reached_window_start = True
                continue
            if ts > end_ts:
                continue  # newer than window (shouldn't happen on DESC, but guard)
            a_type = (it.get("type") or "").upper()
            if want_types is not None and a_type not in want_types:
                continue
            if side and (it.get("side") or "").upper() != side:
                continue
            items.append(_normalize(it, ts))
            if len(items) >= max_items:
                truncated = True
                break
        if truncated or reached_window_start or len(page) < _PAGE:
            break
        offset += _PAGE

    items.sort(key=lambda x: x["timestamp"], reverse=True)
    total_usdc = round(sum(i.get("usdc_size") or 0.0 for i in items), 4)
    return ok(
        {
            "profile_id": wallet,
            "window": {
                "start_ts": start_ts,
                "end_ts": end_ts,
                "start_iso": iso_from_epoch(start_ts),
                "end_iso": iso_from_epoch(end_ts),
            },
            "types": sorted(want_types) if want_types else "ALL",
            "count": len(items),
            "total_usdc": total_usdc,
            "pages_scanned": pages,
            "truncated": truncated,
            "api_ceiling_hit": hit_api_ceiling,
            "items": items,
        }
    )


def _normalize(it: dict, ts: int) -> dict:
    return {
        "timestamp": ts,
        "iso": iso_from_epoch(ts),
        "type": (it.get("type") or "").upper(),
        "side": it.get("side"),
        "outcome": it.get("outcome"),
        "outcome_index": to_int(it.get("outcomeIndex")),
        "size": to_float(it.get("size")),
        "price": to_float(it.get("price")),
        "usdc_size": to_float(it.get("usdcSize")),
        "condition_id": it.get("conditionId"),
        "token_id": it.get("asset"),
        "title": it.get("title"),
        "slug": it.get("slug"),
        "event_slug": it.get("eventSlug"),
        "tx_hash": it.get("transactionHash"),
        "trader_name": it.get("name"),
        "pseudonym": it.get("pseudonym"),
    }
