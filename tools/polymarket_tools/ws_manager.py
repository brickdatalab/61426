"""Persistent WebSocket subscription manager for the Polymarket market channel.

A single long-lived connection to ``WS_URL`` streams order-book updates for a
tracked set of token/asset ids. A background reader task continuously consumes
messages and maintains a per-asset cache of the latest ``schema.WsSnapshot``
(normalized book + best bid/ask + last trade). A heartbeat task sends the
literal text ``PING`` every 10 seconds. If the socket drops, a reconnect loop
re-opens it and re-subscribes the tracked asset set.

Message handling (shapes confirmed against the CARB Rust client + skill docs):
  * ``book``             -> full snapshot: replace the asset's book from
                           ``bids[]`` / ``asks[]``.
  * ``price_change``     -> incremental: apply ``changes[]`` (CARB flat form) or
                           ``price_changes[]`` (skill nested form). ``size == 0``
                           removes that price level. ``best_bid`` / ``best_ask``
                           on a change are used directly when present.
  * ``last_trade_price`` -> update ``last_trade_price``.
  * ``best_bid_ask``     -> update best_bid / best_ask / spread.

``asset_id`` may be empty on an event; we fall back to ``token_id``. A frame may
be a single JSON object OR a JSON array of events (both handled). Concurrency is
asyncio-only: shared state is guarded by a single ``asyncio.Lock``; the reader is
the only writer of the cache.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

import websockets

from .normalize import epoch_seconds, levels, to_float

logger = logging.getLogger(__name__)

_PING_INTERVAL = 10.0  # seconds, per market-channel heartbeat spec
_RECONNECT_DELAY = 2.0  # seconds between reconnect attempts


class WsManager:
    def __init__(self, url: str) -> None:
        self.url = url
        self._ws: websockets.ClientConnection | None = None
        self._assets: set[str] = set()
        # Per-asset normalized snapshot cache (schema.WsSnapshot dicts).
        self._cache: dict[str, dict] = {}
        # Per-asset live book as {"bids": {price: size}, "asks": {price: size}}
        # kept so incremental price_change deltas can be applied.
        self._books: dict[str, dict[str, dict[float, float]]] = {}
        self._lock = asyncio.Lock()
        self._reader_task: asyncio.Task | None = None
        self._ping_task: asyncio.Task | None = None
        self._closed = False

    # ------------------------------------------------------------------ #
    # Lifecycle
    # ------------------------------------------------------------------ #
    async def start(self) -> None:
        """Ensure the connection + background tasks are up.

        Safe to call with zero tracked assets (connects, sends nothing further).
        Idempotent: a no-op when already connected.
        """
        async with self._lock:
            self._closed = False
            await self._ensure_connection()

    async def _ensure_connection(self) -> None:
        """Open the socket and (re)start background tasks. Caller holds the lock."""
        if self._ws is not None and self._reader_task is not None and not self._reader_task.done():
            return
        self._ws = await websockets.connect(self.url, ping_interval=None)
        if self._reader_task is None or self._reader_task.done():
            self._reader_task = asyncio.create_task(self._read_loop())
        if self._ping_task is None or self._ping_task.done():
            self._ping_task = asyncio.create_task(self._ping_loop())

    async def aclose(self) -> None:
        """Cancel background tasks and close the socket."""
        async with self._lock:
            self._closed = True
            for task in (self._reader_task, self._ping_task):
                if task is not None:
                    task.cancel()
            ws = self._ws
            self._ws = None
            self._reader_task = None
            self._ping_task = None
        if ws is not None:
            try:
                await ws.close()
            except Exception:  # noqa: BLE001 - closing best-effort
                pass

    # ------------------------------------------------------------------ #
    # Subscriptions
    # ------------------------------------------------------------------ #
    async def subscribe(self, asset_ids: list[str]) -> dict:
        """Begin streaming the given token/asset ids."""
        ids = [a for a in (asset_ids or []) if a]
        async with self._lock:
            had_connection = (
                self._ws is not None
                and self._reader_task is not None
                and not self._reader_task.done()
            )
            self._closed = False
            await self._ensure_connection()
            new_set = self._assets | set(ids)
            if had_connection:
                # Add to an existing connection via the dynamic form.
                msg = {
                    "assets_ids": list(new_set),
                    "operation": "subscribe",
                    "custom_feature_enabled": True,
                }
            else:
                # Fresh connection: full market-channel subscribe for the whole set.
                msg = {
                    "type": "market",
                    "assets_ids": list(new_set),
                    "custom_feature_enabled": True,
                }
            await self._send(json.dumps(msg))
            self._assets = new_set
        return {"subscribed": list(self._assets), "connected": self._is_connected()}

    async def unsubscribe(self, asset_ids: list[str]) -> dict:
        """Stop streaming the given asset ids; drop them from the cache."""
        ids = [a for a in (asset_ids or []) if a]
        async with self._lock:
            if ids and self._ws is not None:
                msg = {"assets_ids": ids, "operation": "unsubscribe"}
                await self._send(json.dumps(msg))
            for a in ids:
                self._assets.discard(a)
                self._cache.pop(a, None)
                self._books.pop(a, None)
        return {"unsubscribed": ids, "assets": list(self._assets), "connected": self._is_connected()}

    async def read_latest(self, asset_id: str) -> dict | None:
        """Return the cached ``WsSnapshot`` for an asset (None if not seen yet).

        Non-blocking: a plain cache read. Returns a shallow copy so the caller
        cannot mutate the live cache entry.
        """
        async with self._lock:
            snap = self._cache.get(asset_id)
            return dict(snap) if snap is not None else None

    def status(self) -> dict[str, Any]:
        return {"connected": self._is_connected(), "assets": sorted(self._assets)}

    # ------------------------------------------------------------------ #
    # Internals
    # ------------------------------------------------------------------ #
    def _is_connected(self) -> bool:
        return (
            self._ws is not None
            and self._reader_task is not None
            and not self._reader_task.done()
        )

    async def _send(self, text: str) -> None:
        ws = self._ws
        if ws is None:
            return
        try:
            await ws.send(text)
        except Exception as e:  # noqa: BLE001
            logger.warning("ws send failed: %s", e)

    async def _ping_loop(self) -> None:
        """Send literal ``PING`` every 10s; server replies ``PONG``."""
        try:
            while not self._closed:
                await asyncio.sleep(_PING_INTERVAL)
                ws = self._ws
                if ws is not None:
                    try:
                        await ws.send("PING")
                    except Exception as e:  # noqa: BLE001
                        logger.warning("ws PING failed: %s", e)
        except asyncio.CancelledError:
            raise

    async def _read_loop(self) -> None:
        """Continuously read frames; reconnect + re-subscribe on drop."""
        try:
            while not self._closed:
                ws = self._ws
                if ws is None:
                    await self._reconnect()
                    continue
                try:
                    async for raw in ws:
                        self._handle_frame(raw)
                except asyncio.CancelledError:
                    raise
                except Exception as e:  # noqa: BLE001 - socket dropped / read error
                    logger.warning("ws read loop error: %s", e)
                if self._closed:
                    break
                await self._reconnect()
        except asyncio.CancelledError:
            raise

    async def _reconnect(self) -> None:
        """Re-open the socket and re-subscribe the tracked asset set."""
        await asyncio.sleep(_RECONNECT_DELAY)
        if self._closed:
            return
        try:
            self._ws = await websockets.connect(self.url, ping_interval=None)
        except Exception as e:  # noqa: BLE001
            logger.warning("ws reconnect failed: %s", e)
            self._ws = None
            return
        assets = list(self._assets)
        if assets:
            msg = {
                "type": "market",
                "assets_ids": assets,
                "custom_feature_enabled": True,
            }
            await self._send(json.dumps(msg))
        logger.info("ws reconnected; re-subscribed %d assets", len(assets))

    def _handle_frame(self, raw: str | bytes) -> None:
        """Parse one frame (object or array) and apply each event to the cache."""
        if isinstance(raw, bytes):
            try:
                raw = raw.decode("utf-8")
            except Exception:  # noqa: BLE001
                return
        if raw == "PONG" or raw == "":
            return
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            return
        events = payload if isinstance(payload, list) else [payload]
        for ev in events:
            if isinstance(ev, dict):
                try:
                    self._apply_event(ev)
                except Exception as e:  # noqa: BLE001 - never let one bad event crash the reader
                    logger.warning("skipping malformed ws event: %s", e)

    def _asset_of(self, ev: dict) -> str | None:
        aid = ev.get("asset_id") or ev.get("token_id")
        return aid if aid else None

    def _snap(self, asset_id: str, condition_id: str | None) -> dict:
        snap = self._cache.get(asset_id)
        if snap is None:
            snap = {"asset_id": asset_id}
            self._cache[asset_id] = snap
        if condition_id:
            snap["condition_id"] = condition_id
        return snap

    def _apply_event(self, ev: dict) -> None:
        etype = ev.get("event_type") or ev.get("type") or ""
        condition_id = ev.get("market")

        if etype == "book":
            asset_id = self._asset_of(ev)
            if not asset_id:
                return
            self._apply_book(asset_id, condition_id, ev)
        elif etype == "price_change":
            self._apply_price_change(ev, condition_id)
        elif etype == "last_trade_price":
            asset_id = self._asset_of(ev)
            if not asset_id:
                return
            snap = self._snap(asset_id, condition_id)
            ltp = to_float(ev.get("price"))
            if ltp is not None:
                snap["last_trade_price"] = ltp
            self._stamp(snap, etype)
        elif etype == "best_bid_ask":
            asset_id = self._asset_of(ev)
            if not asset_id:
                return
            snap = self._snap(asset_id, condition_id)
            bb = to_float(ev.get("best_bid"))
            ba = to_float(ev.get("best_ask"))
            if bb is not None:
                snap["best_bid"] = bb
            if ba is not None:
                snap["best_ask"] = ba
            self._stamp(snap, etype)
        # Other event types (tick_size_change, new_market, market_resolved) are
        # ignored for the snapshot cache.

    def _apply_book(self, asset_id: str, condition_id: str | None, ev: dict) -> None:
        bids = {}
        for lvl in ev.get("bids") or []:
            p = to_float(lvl.get("price"))
            s = to_float(lvl.get("size"))
            if p is not None and s is not None and s > 0:
                bids[p] = s
        asks = {}
        for lvl in ev.get("asks") or []:
            p = to_float(lvl.get("price"))
            s = to_float(lvl.get("size"))
            if p is not None and s is not None and s > 0:
                asks[p] = s
        self._books[asset_id] = {"bids": bids, "asks": asks}
        snap = self._snap(asset_id, condition_id)
        self._rebuild_book_snapshot(asset_id, snap, condition_id)
        self._stamp(snap, "book")

    def _apply_price_change(self, ev: dict, condition_id: str | None) -> None:
        # Two shapes: CARB flat `changes[]` (asset on the event) OR the skill's
        # nested `price_changes[]` (asset + best_bid/ask per change).
        changes = ev.get("price_changes")
        nested = True
        if not changes:
            changes = ev.get("changes")
            nested = False
        if not changes:
            return
        top_asset = self._asset_of(ev)
        touched: set[str] = set()
        for ch in changes:
            if not isinstance(ch, dict):
                continue
            asset_id = (ch.get("asset_id") or ch.get("token_id")) if nested else None
            asset_id = asset_id or top_asset
            if not asset_id:
                continue
            side = str(ch.get("side", "")).upper()
            p = to_float(ch.get("price"))
            s = to_float(ch.get("size"))
            if p is None or s is None:
                continue
            book = self._books.setdefault(asset_id, {"bids": {}, "asks": {}})
            if side in ("BUY", "BID"):
                book_side = book["bids"]
            elif side in ("SELL", "ASK"):
                book_side = book["asks"]
            else:
                continue
            if s <= 0:
                book_side.pop(p, None)  # size 0 removes the level
            else:
                book_side[p] = s
            snap = self._snap(asset_id, condition_id)
            bb = to_float(ch.get("best_bid"))
            ba = to_float(ch.get("best_ask"))
            if bb is not None:
                snap["best_bid"] = bb
            if ba is not None:
                snap["best_ask"] = ba
            touched.add(asset_id)
        for asset_id in touched:
            snap = self._snap(asset_id, condition_id)
            self._rebuild_book_snapshot(asset_id, snap, condition_id, keep_bba=True)
            self._stamp(snap, "price_change")

    def _rebuild_book_snapshot(
        self,
        asset_id: str,
        snap: dict,
        condition_id: str | None,
        *,
        keep_bba: bool = False,
    ) -> None:
        """Rebuild snap['book'] + derive best_bid/best_ask from the live book.

        ``keep_bba``: when True, do not overwrite best_bid/best_ask that an event
        supplied directly (the wire value is authoritative over our derived one).
        """
        book = self._books.get(asset_id, {"bids": {}, "asks": {}})
        bids = levels(
            [{"price": p, "size": s} for p, s in book["bids"].items()],
            reverse=True,
        )
        asks = levels(
            [{"price": p, "size": s} for p, s in book["asks"].items()],
            reverse=False,
        )
        book_snap: dict = {"token_id": asset_id, "bids": bids, "asks": asks}
        if condition_id:
            book_snap["condition_id"] = condition_id
        snap["book"] = book_snap
        if not (keep_bba and "best_bid" in snap):
            snap["best_bid"] = bids[0]["price"] if bids else None
        if not (keep_bba and "best_ask" in snap):
            snap["best_ask"] = asks[0]["price"] if asks else None

    def _stamp(self, snap: dict, etype: str) -> None:
        snap["last_event_type"] = etype
        snap["updated_at"] = epoch_seconds(int(time.time()))
