"""ourWebSocket — pure tape math + price/bar_open/imbalance, ported 1:1 from payload_v5.

Symbol-agnostic. cvd_candle_usd is the ONLY candle-dependent field; its bar timeframe is
passed in via snapshot(bar_ms=...). The other fields use fixed rolling windows.
"""
from __future__ import annotations
import bisect
from typing import Optional

BAR_MS = 900_000


def _usd(x: Optional[float]) -> Optional[int]:
    return None if x is None else int(round(float(x)))


def _r(x: Optional[float], nd: int) -> Optional[float]:
    return None if x is None else round(float(x), nd)


class RingView:
    def __init__(self, ring):
        self.ts = [t for t, _ in ring]
        self.vs = [v for _, v in ring]

    def at(self, ts_ms: int) -> Optional[float]:
        i = bisect.bisect_right(self.ts, ts_ms) - 1
        return self.vs[i] if i >= 0 else None


def _series_at(ring, ts_ms: int) -> Optional[float]:
    best = None
    for t, v in ring:
        if t <= ts_ms:
            best = v
        else:
            break
    return best


def _cvd_candle_base(view: RingView, bar_start_ms: int) -> Optional[float]:
    base = view.at(bar_start_ms)
    if base is not None:
        return base
    i = bisect.bisect_left(view.ts, bar_start_ms)
    if i < len(view.ts) and view.ts[i] <= bar_start_ms + 2000:
        return view.vs[i]
    return None


def snapshot(spot, perp, now: int, bar_ms: int = BAR_MS, depth=None) -> dict:
    bar_start = (now // bar_ms) * bar_ms
    out = {
        "tape": {
            "cvd_candle_usd": None,
            "cvd_delta_1m": None,
            "cvd_delta_3m": None,
            "efficiency_3m": None,
            "large_print_net_3m_usd": 0,
            "price": spot.last_price,                                           # NEW: current spot price
            "bar_open": _series_at(spot.price_1s, bar_start),                    # NEW: price at bar open
            "binance_imb": getattr(depth, 'last_imb', None) if depth else None,  # NEW: order-book imbalance
        },
        "perp_spot_divergence": {"perp_cvd_minus_spot_cvd_5m_usd": None},
    }
    # ---- tape block (SPOT only) ----
    view = RingView(spot.cvd_1s)
    base = _cvd_candle_base(view, bar_start)
    if base is not None:
        out["tape"]["cvd_candle_usd"] = _usd(spot.cum_cvd_usd - base)
    for key, ms in (("cvd_delta_1m", 60_000), ("cvd_delta_3m", 180_000)):
        v = view.at(now - ms)
        if v is not None:
            out["tape"][key] = _usd(spot.cum_cvd_usd - v)
    out["tape"]["large_print_net_3m_usd"] = _usd(
        sum(usd for t, usd in spot.large_prints if t >= now - 180_000))
    p_now = spot.last_price
    p_3m = _series_at(spot.price_1s, now - 180_000)
    if p_now is not None and p_3m is not None:
        net_btc = 0.0
        cutoff = now - 180_000
        for t, _p, q, buy in reversed(spot.trades):
            if t < cutoff:
                break
            net_btc += q if buy else -q
        out["tape"]["efficiency_3m"] = _r(abs(p_now - p_3m) / max(abs(net_btc), 0.01), 3)
    # ---- perp_spot divergence ----
    sp5 = spot.cvd_at(now - 300_000)
    pp5 = perp.cvd_at(now - 300_000)
    if sp5 is not None and pp5 is not None:
        out["perp_spot_divergence"]["perp_cvd_minus_spot_cvd_5m_usd"] = _usd(
            (perp.cum_cvd_usd - pp5) - (spot.cum_cvd_usd - sp5))
    return out
