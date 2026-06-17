"""Normalized output schema + uniform Result envelope.

Every tool returns one of::

    {"ok": True,  "data": <normalized object/list>}
    {"ok": False, "error": {"type", "message", "status", "endpoint"}}

The agent branches on ``ok`` and never re-parses raw HTTP/JSON. All prices,
sizes and probabilities are floats (the wire sends strings). ``condition_id``
(Gamma/Data key) and ``token_id`` (CLOB key) are always distinct, explicit
fields so the agent never confuses them.

The ``TypedDict``s below are the documented contract for Phase B tool authors.
They are not enforced at runtime (handlers return plain dicts) but field names
and types MUST match them exactly.
"""

from __future__ import annotations

from typing import Any, TypedDict


# --------------------------------------------------------------------------- #
# Result envelope
# --------------------------------------------------------------------------- #
def ok(data: Any) -> dict:
    return {"ok": True, "data": data}


def err(
    type: str,
    message: str,
    status: int | None = None,
    endpoint: str | None = None,
) -> dict:
    return {
        "ok": False,
        "error": {
            "type": type,
            "message": message,
            "status": status,
            "endpoint": endpoint,
        },
    }


def err_from_exc(e: Exception) -> dict:
    """Build an error envelope from a PolyError (or any exception)."""
    return err(
        getattr(e, "type", "error"),
        getattr(e, "message", str(e)),
        getattr(e, "status", None),
        getattr(e, "endpoint", None),
    )


# --------------------------------------------------------------------------- #
# Normalized types (the contract). total=False: include a field when present.
# --------------------------------------------------------------------------- #
class PriceLevel(TypedDict):
    price: float
    size: float


class BookSnapshot(TypedDict, total=False):
    token_id: str
    condition_id: str
    bids: list[PriceLevel]          # best-first (highest price first)
    asks: list[PriceLevel]          # best-first (lowest price first)
    tick_size: float
    neg_risk: bool
    last_trade_price: float


class Market(TypedDict, total=False):
    id: str
    condition_id: str
    question_id: str
    slug: str
    question: str
    clob_token_ids: list[str]       # [yes_token_id, no_token_id]
    outcomes: list[str]             # e.g. ["Yes", "No"]
    outcome_prices: list[float]
    best_bid: float
    best_ask: float
    spread: float
    last_trade_price: float
    one_hour_price_change: float
    volume: float
    volume_24hr: float
    liquidity: float
    active: bool
    closed: bool
    accepting_orders: bool
    end_date: str
    resolution_source: str
    description: str


class Event(TypedDict, total=False):
    id: str
    slug: str
    title: str
    neg_risk: bool
    category: str
    volume: float
    volume_24hr: float
    liquidity: float
    open_interest: float
    active: bool
    closed: bool
    market_count: int
    condition_ids: list[str]


class LiveVolumeMarket(TypedDict, total=False):
    condition_id: str
    token_id: str
    volume: float


class LiveVolume(TypedDict, total=False):
    event_id: str
    total: float
    markets: list[LiveVolumeMarket]


class Tag(TypedDict, total=False):
    id: str
    label: str
    slug: str


class TokenResolution(TypedDict, total=False):
    token_id: str
    condition_id: str
    outcome: str                    # outcome label for the queried token
    outcome_index: int
    token_ids: list[str]            # all sibling token ids (yes/no)
    outcomes: list[str]


class ClobMarket(TypedDict, total=False):
    condition_id: str
    question_id: str
    tokens: list[dict]              # [{token_id, outcome, price}]
    tick_size: float
    min_order_size: float
    neg_risk: bool
    fees: dict
    rewards: dict
    game_start_time: str
    accepting_orders: bool
    closed: bool


class Quote(TypedDict, total=False):
    token_id: str
    side: str                       # "BUY" | "SELL"
    price: float


class Midpoint(TypedDict, total=False):
    token_id: str
    midpoint: float                 # implied probability


class Spread(TypedDict, total=False):
    token_id: str
    spread: float


class LastTrade(TypedDict, total=False):
    token_id: str
    price: float
    side: str
    is_sentinel: bool               # True when API returned 0.5/empty (thin/closed)


class PricePoint(TypedDict):
    t: int                          # epoch seconds
    p: float


class PriceHistory(TypedDict, total=False):
    token_id: str
    interval: str
    fidelity: int
    history: list[PricePoint]


class Trade(TypedDict, total=False):
    condition_id: str
    token_id: str
    wallet: str                     # proxyWallet / maker/taker address
    side: str                       # BUY | SELL
    outcome: str
    outcome_index: int
    size: float
    price: float
    timestamp: int                  # epoch seconds
    tx_hash: str


class Holder(TypedDict, total=False):
    condition_id: str
    token_id: str
    wallet: str
    amount: float
    outcome_index: int


class WsSnapshot(TypedDict, total=False):
    asset_id: str
    condition_id: str
    book: BookSnapshot
    best_bid: float
    best_ask: float
    last_trade_price: float
    last_event_type: str
    updated_at: float               # epoch seconds of last delta applied
