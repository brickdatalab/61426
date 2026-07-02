"""ourWebSocket — Binance data sources: spot aggTrade WS + perp aggTrades REST poll.

Mirrors payload_v5 tape/spot_tape.py & tape/perp_tape.py:
- cum_cvd_usd: running since process start; NEVER reset across reconnects.
- CVD sign: Binance aggTrade m==True => buyer is maker => taker SELL => negative.
- cvd_1s / price_1s sampled ~1s on the receiver wall clock (live), per active trade-second (backfill).
- large_prints (spot only): |signed_usd| >= LARGE_PRINT_USD.

Spot = WS (real-time), with id-dedup to absorb any replay on reconnect. Perp = REST polled every
PERP_POLL_S paging by fromId (continuous -> NO backfill<->live seam, accurate from the first tick;
the divergence field is 5m-windowed so the 1s poll cadence is negligible). Both feeds keep a
one-shot REST startup backfill (spot to the current 15m bar open so cvd_candle_usd is live
post-restart; perp 5m so the divergence field is live). Feed tasks never raise out of their loop.
"""
from __future__ import annotations
import asyncio
import logging
import random
import time
from collections import deque
from typing import Optional

import aiohttp

import config as C


def now_ms() -> int:
    return int(time.time() * 1000)


class Tape:
    def __init__(self):
        self.cum_cvd_usd = 0.0
        self.last_price: Optional[float] = None
        self.trades: deque = deque(maxlen=300_000)        # (t_ms, price, qty, taker_is_buy)
        self.cvd_1s: deque = deque(maxlen=4000)           # (t_ms, cum_cvd_usd)
        self.price_1s: deque = deque(maxlen=4000)         # (t_ms, last_price)
        self.large_prints: deque = deque(maxlen=2000)     # (t_ms, signed_usd)  [spot only]
        self.last_update_ms = 0

    def cvd_at(self, ts_ms: int) -> Optional[float]:
        best = None
        for t, v in self.cvd_1s:
            if t <= ts_ms:
                best = v
            else:
                break
        return best


def apply_trade(td: Tape, t_ms: int, price: float, qty: float, taker_is_buy: bool,
                large_print_usd: Optional[float] = None) -> float:
    signed_usd = price * qty if taker_is_buy else -price * qty
    td.cum_cvd_usd += signed_usd
    td.last_price = price
    td.trades.append((t_ms, price, qty, taker_is_buy))
    if large_print_usd is not None and abs(signed_usd) >= large_print_usd:
        td.large_prints.append((t_ms, signed_usd))
    td.last_update_ms = now_ms()
    return signed_usd


class SpotFeed:
    def __init__(self, tape: Tape, symbol: str, log: logging.Logger):
        self.tape = tape
        self.symbol = symbol
        self.log = log
        self.ws_url = C.SPOT_WS_TEMPLATE.format(sym=symbol.lower())
        self.backoff = 1.0
        self.last_id = 0          # monotonic aggTrade id watermark for dedup

    async def _backfill(self, session: aiohttp.ClientSession) -> None:
        now = now_ms()
        # back to the EARLIER of bar-open (for cvd_candle_usd) and 5m ago (so the 3m/5m windows
        # and the spot side of perp_minus_spot are live immediately, even if restart is at bar open)
        start_ms = min((now // C.BAR_MS) * C.BAR_MS, now - 300_000)
        from_id: Optional[int] = None
        last_sec = -1
        for _ in range(C.BACKFILL_PAGE_CAP):
            params = {"symbol": self.symbol, "limit": C.LIMIT}
            if from_id is not None:
                params["fromId"] = from_id
            else:
                params["startTime"] = start_ms
            async with session.get(C.SPOT_REST_URL, params=params) as resp:
                if resp.status >= 400:
                    self.log.warning("spot backfill HTTP %s - cold start", resp.status)
                    return
                rows = await resp.json()
            if not rows:
                break
            for row in rows:
                t_ms = int(row["T"])
                if t_ms > now:
                    break
                apply_trade(self.tape, t_ms, float(row["p"]), float(row["q"]),
                            not bool(row["m"]), C.LARGE_PRINT_USD)
                self.last_id = max(self.last_id, int(row["a"]))
                sec = t_ms // 1000
                if sec != last_sec:
                    self.tape.cvd_1s.append((t_ms, self.tape.cum_cvd_usd))
                    self.tape.price_1s.append((t_ms, self.tape.last_price))
                    last_sec = sec
            from_id = max(int(r["a"]) for r in rows) + 1
            if len(rows) < C.LIMIT or int(rows[-1]["T"]) >= now:
                break
        self.log.info("spot backfill ok: %d cvd_1s samples", len(self.tape.cvd_1s))

    async def run(self) -> None:
        timeout = aiohttp.ClientTimeout(total=None, sock_connect=10)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            try:
                await self._backfill(session)
            except Exception as e:
                self.log.warning("spot backfill failed (%s) - cold start", e)
            last_1s_ms = 0
            while True:
                try:
                    async with session.ws_connect(self.ws_url, heartbeat=20, autoping=True,
                                                  timeout=10) as ws:
                        self.log.info("spot WS connected")
                        self.backoff = 1.0
                        async for msg in ws:
                            if msg.type != aiohttp.WSMsgType.TEXT:
                                if msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                                    break
                                continue
                            data = msg.json()
                            if data.get("e") != "aggTrade":
                                continue
                            apply_trade(self.tape, int(data["T"]), float(data["p"]),
                                        float(data["q"]), not bool(data["m"]), C.LARGE_PRINT_USD)
                            now = now_ms()
                            if now - last_1s_ms >= 1000:
                                self.tape.cvd_1s.append((now, self.tape.cum_cvd_usd))
                                self.tape.price_1s.append((now, self.tape.last_price))
                                last_1s_ms = now
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    self.log.warning("spot WS error (%s) - reconnect in %.1fs", e, self.backoff)
                    await asyncio.sleep(self.backoff + random.random())
                    self.backoff = min(self.backoff * 2, C.WS_BACKOFF_MAX)


class PerpFeed:
    """Binance perp (USD-M futures) aggTrades via REST poll (fapi). Pages by fromId continuously,
    so there is NO backfill<->live seam — cum is exact from the first tick. A one-shot 5m startup
    backfill seeds cvd_1s so perp_cvd_minus_spot_cvd_5m_usd is live immediately. Staggered + 429-aware.
    """
    def __init__(self, tape: Tape, symbol: str, phase_s: float, log: logging.Logger):
        self.tape = tape
        self.symbol = symbol
        self.phase_s = phase_s
        self.log = log
        self.backoff = 1.0
        self.last_seen_id: Optional[int] = None

    async def _backfill(self, session: aiohttp.ClientSession) -> None:
        now = now_ms()
        start_ms = now - C.BACKFILL_MS
        from_id: Optional[int] = None
        last_sec = -1
        for _ in range(C.BACKFILL_PAGE_CAP):
            params = {"symbol": self.symbol, "limit": C.LIMIT}
            if from_id is not None:
                params["fromId"] = from_id
            else:
                params["startTime"] = start_ms
            async with session.get(C.PERP_REST_URL, params=params) as resp:
                if resp.status >= 400:
                    self.log.warning("perp backfill HTTP %s - cold start", resp.status)
                    return
                rows = await resp.json()
            if not rows:
                break
            for row in rows:
                t_ms = int(row["T"])
                if t_ms > now:
                    break
                apply_trade(self.tape, t_ms, float(row["p"]), float(row["q"]),
                            not bool(row["m"]), None)
                sec = t_ms // 1000
                if sec != last_sec:
                    self.tape.cvd_1s.append((t_ms, self.tape.cum_cvd_usd))
                    last_sec = sec
            self.last_seen_id = max(int(r["a"]) for r in rows)
            if len(rows) < C.LIMIT or int(rows[-1]["T"]) >= now:
                break
            from_id = self.last_seen_id + 1
        self.log.info("perp backfill ok: %d cvd_1s samples", len(self.tape.cvd_1s))

    @staticmethod
    def _retry_after(resp) -> float:
        ra = resp.headers.get("Retry-After")
        try:
            return float(ra) if ra else 5.0
        except Exception:
            return 5.0

    async def run(self) -> None:
        if self.phase_s:
            await asyncio.sleep(self.phase_s)   # stagger symbols so we don't double-hit perp REST
        timeout = aiohttp.ClientTimeout(total=None, sock_connect=10)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            try:
                await self._backfill(session)
            except Exception as e:
                self.log.warning("perp backfill failed (%s) - cold start", e)
                self.last_seen_id = None
            last_1s_ms = 0
            while True:
                rate_sleep = 0.0
                try:
                    request_send_ms = now_ms()
                    from_id = (self.last_seen_id + 1) if self.last_seen_id is not None else None
                    for _page in range(C.PAGE_CAP):
                        params = {"symbol": self.symbol, "limit": C.LIMIT}
                        if from_id is not None:
                            params["fromId"] = from_id
                        else:
                            params["startTime"] = request_send_ms - 5000
                        async with session.get(C.PERP_REST_URL, params=params) as resp:
                            if resp.status == 429:
                                rate_sleep = self._retry_after(resp)
                                self.log.error("PERP 429 rate-limit %s - backing off %.1fs",
                                               self.symbol, rate_sleep)
                                self.last_seen_id = None
                                break
                            if resp.status >= 400:
                                body = await resp.text()
                                self.log.warning("perp poll HTTP %s (%s) - re-windowing",
                                                 resp.status, body[:120])
                                self.last_seen_id = None
                                break
                            rows = await resp.json()
                        if not rows:
                            break
                        for row in rows:
                            apply_trade(self.tape, int(row["T"]), float(row["p"]),
                                        float(row["q"]), not bool(row["m"]), None)
                        self.last_seen_id = max(int(r["a"]) for r in rows)
                        if len(rows) < C.LIMIT:
                            break
                        from_id = self.last_seen_id + 1
                    now = now_ms()
                    if self.tape.last_price is not None and now - last_1s_ms >= 1000:
                        self.tape.cvd_1s.append((now, self.tape.cum_cvd_usd))
                        last_1s_ms = now
                    self.backoff = 1.0
                    await asyncio.sleep(rate_sleep if rate_sleep else C.PERP_POLL_S)
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    self.log.warning("perp poll error (%s)", e)
                    self.last_seen_id = None
                    await asyncio.sleep(self.backoff + random.random())
                    self.backoff = min(self.backoff * 2, C.WS_BACKOFF_MAX)


class DepthTape:
    """Lightweight storage for the latest order-book imbalance from the depth20 stream."""
    def __init__(self):
        self.last_imb: Optional[float] = None
        self.last_update_ms: int = 0


class DepthFeed:
    """Binance SPOT depth20@100ms WS — maintains latest top-20 book + imbalance [-1,+1].

    Subscribes to wss://stream.binance.com:9443/ws/{sym}@depth20@100ms which pushes a
    SNAPSHOT (not a diff) of the top 20 bids/asks every 100ms. Imbalance is computed
    within +/-0.12% of mid — the same formula as the dashboard's bookStats.
    """
    BAND = 0.0012

    def __init__(self, tape: DepthTape, symbol: str, log: logging.Logger):
        self.tape = tape
        self.symbol = symbol
        self.log = log
        self.ws_url = f"wss://stream.binance.com:9443/ws/{symbol.lower()}@depth20@100ms"
        self.backoff = 1.0

    @classmethod
    def _imbalance(cls, data: dict) -> Optional[float]:
        bids = data.get("bids", [])
        asks = data.get("asks", [])
        if not bids or not asks:
            return None
        best_bid = float(bids[0][0])
        best_ask = float(asks[0][0])
        mid = (best_bid + best_ask) / 2
        lo = mid * (1 - cls.BAND)
        hi = mid * (1 + cls.BAND)
        bid_usd = sum(float(p) * float(q) for p, q in bids if float(p) >= lo)
        ask_usd = sum(float(p) * float(q) for p, q in asks if float(p) <= hi)
        total = bid_usd + ask_usd
        return (bid_usd - ask_usd) / total if total > 0 else 0.0

    async def run(self) -> None:
        timeout = aiohttp.ClientTimeout(total=None, sock_connect=10)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            while True:
                try:
                    async with session.ws_connect(self.ws_url, heartbeat=20,
                                                  autoping=True, timeout=10) as ws:
                        self.log.info("depth WS connected (%s)", self.symbol)
                        self.backoff = 1.0
                        async for msg in ws:
                            if msg.type != aiohttp.WSMsgType.TEXT:
                                if msg.type in (aiohttp.WSMsgType.CLOSED,
                                                aiohttp.WSMsgType.ERROR):
                                    break
                                continue
                            data = msg.json()
                            if "bids" in data and "asks" in data:
                                imb = self._imbalance(data)
                                if imb is not None:
                                    self.tape.last_imb = imb
                                    self.tape.last_update_ms = now_ms()
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    self.log.warning("depth WS error (%s) - reconnect in %.1fs",
                                     e, self.backoff)
                    await asyncio.sleep(self.backoff + random.random())
                    self.backoff = min(self.backoff * 2, C.WS_BACKOFF_MAX)
