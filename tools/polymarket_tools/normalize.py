"""Shared normalization helpers. Tool files use these to convert raw API JSON
into the typed shapes in ``schema.py``. Keep per-tool conversion in the tool
file; put only reusable primitives here.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any


def to_float(v: Any, default: float | None = None) -> float | None:
    """Wire prices/sizes are strings. Parse to float; return default on failure."""
    if v is None or v == "":
        return default
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def to_int(v: Any, default: int | None = None) -> int | None:
    if v is None or v == "":
        return default
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


def to_bool(v: Any, default: bool = False) -> bool:
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        return v.strip().lower() in ("true", "1", "yes")
    if v is None:
        return default
    return bool(v)


def parse_token_ids(v: Any) -> list[str]:
    """``clobTokenIds`` may arrive as a list OR a JSON-encoded string.

    Mirrors the CARB Rust client which treats it as a flexible serde Value.
    """
    if v is None:
        return []
    if isinstance(v, list):
        return [str(x) for x in v]
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return []
        try:
            parsed = json.loads(s)
            if isinstance(parsed, list):
                return [str(x) for x in parsed]
        except json.JSONDecodeError:
            pass
        return [s]
    return []


def parse_str_list(v: Any) -> list[str]:
    """Same flexible list-or-json-string handling for outcomes/labels."""
    return parse_token_ids(v)


def levels(raw: Any, *, reverse: bool) -> list[dict]:
    """Normalize an order-book side into [{price, size}] sorted best-first.

    ``reverse=True`` for bids (highest price first), ``False`` for asks.
    """
    out: list[dict] = []
    for lvl in raw or []:
        price = to_float(lvl.get("price"))
        size = to_float(lvl.get("size"))
        if price is None or size is None:
            continue
        out.append({"price": price, "size": size})
    out.sort(key=lambda x: x["price"], reverse=reverse)
    return out


def epoch_seconds(v: Any) -> int | None:
    """Normalize a timestamp (seconds or milliseconds, str or int) to epoch seconds."""
    n = to_int(v)
    if n is None:
        return None
    # Heuristic: treat 13-digit values as milliseconds.
    if n > 10_000_000_000:
        n //= 1000
    return n


def iso_from_epoch(seconds: int | None) -> str | None:
    if seconds is None:
        return None
    return datetime.fromtimestamp(seconds, tz=timezone.utc).isoformat()
