"""ourWebSocket — no-auth aiohttp WS that emits 6 tape/divergence metrics on-change.

Boots BOTH BTCUSDT and ETHUSDT feeds at startup (spot WS + perp WS, each backfilled), so
?symbol= selects an instant-on broadcast with no warmup. ?bar=5m|15m chooses the candle
timeframe for cvd_candle_usd (default 5m); the other five fields are fixed rolling windows.
Broadcast polls every MIN_INTERVAL_S (0.1s) and sends ONLY when a trade arrived since the
last send (on-change). No auth, no rate limit on consumers.
"""
from __future__ import annotations
import asyncio
import json
import logging
import logging.handlers
import os
import pathlib
import time

from aiohttp import web, WSMsgType

import config as C
import compute
from feeds import SpotFeed, PerpFeed, Tape, DepthTape, DepthFeed


def setup_logging() -> None:
    os.makedirs(C.LOG_DIR, exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s | %(message)s")
    fh = logging.handlers.RotatingFileHandler(C.LOG_FILE, maxBytes=10_000_000,
                                              backupCount=5, encoding="utf-8")
    fh.setFormatter(fmt)
    sh = logging.StreamHandler()
    sh.setFormatter(fmt)
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(fh)
    root.addHandler(sh)


class SymbolHub:
    def __init__(self, symbol: str):
        self.symbol = symbol
        self.spot = Tape()
        self.perp = Tape()
        self.depth = DepthTape()
        self.clients: dict = {}       # ws -> bar_ms (per-client candle timeframe)
        self.last_sent_update = 0     # Tape.last_update_ms watermark for on-change sends
        self.spot_task = None
        self.perp_task = None
        self.depth_task = None
        self.bcast_task = None

    def health(self) -> dict:
        now = int(time.time() * 1000)
        sp = (now - self.spot.last_update_ms) if self.spot.last_update_ms else None
        pp = (now - self.perp.last_update_ms) if self.perp.last_update_ms else None
        bars = {}
        for b in self.clients.values():
            k = next((k for k, v in C.ALLOWED_BARS.items() if v == b), str(b))
            bars[k] = bars.get(k, 0) + 1
        return {
            "symbol": self.symbol,
            "spot_age_s": (round(sp / 1000.0, 1) if sp is not None else None),
            "perp_age_s": (round(pp / 1000.0, 1) if pp is not None else None),
            "spot_samples": len(self.spot.cvd_1s),
            "perp_samples": len(self.perp.cvd_1s),
            "clients": len(self.clients),
            "bars": bars,
        }


HUBS: dict[str, SymbolHub] = {}
log = logging.getLogger("server")
V5_LOG_DIR = os.environ.get("V5_LOG_DIR", "/home/vincent/projects/61426/v5/logs")


def _safe_slug(slug: str) -> str:
    return ''.join(c for c in str(slug) if c.isalnum() or c in '-_') or 'unknown'


def _bar_ms(request: web.Request):
    bar = (request.query.get("bar") or C.DEFAULT_BAR).lower()
    if bar not in C.ALLOWED_BARS:
        return None, bar
    return C.ALLOWED_BARS[bar], bar


async def ws_handler(request: web.Request) -> web.WebSocketResponse:
    symbol = (request.query.get("symbol") or C.DEFAULT_SYMBOL).upper()
    if symbol not in C.ALLOWED_SYMBOLS:
        return web.json_response(
            {"error": "unsupported symbol", "allowed": sorted(C.ALLOWED_SYMBOLS)}, status=400)
    bar_ms, bar_raw = _bar_ms(request)
    if bar_ms is None:
        return web.json_response(
            {"error": "unsupported bar", "allowed": sorted(C.ALLOWED_BARS)}, status=400)
    hub = HUBS[symbol]
    ws = web.WebSocketResponse(heartbeat=90)
    await ws.prepare(request)
    hub.clients[ws] = bar_ms
    log.info("CONNECT symbol=%s bar=%s clients=%d", symbol, bar_raw, len(hub.clients))
    try:
        async for msg in ws:
            if msg.type == WSMsgType.ERROR:
                break
    finally:
        hub.clients.pop(ws, None)
        log.info("DISCONNECT symbol=%s clients=%d", symbol, len(hub.clients))
    return ws


async def root_handler(request: web.Request) -> web.Response:
    return web.json_response({
        "service": "ourWebSocket",
        "ws": "ws://<host>:%d/ws/v5/tape?symbol=BTCUSDT|ETHUSDT&bar=5m|15m" % C.PORT,
        "min_interval_s": C.MIN_INTERVAL_S,
        "mode": "on-change",
        "symbols": sorted(C.ALLOWED_SYMBOLS),
        "bars": {k: v for k, v in sorted(C.ALLOWED_BARS.items())},
        "default_bar": C.DEFAULT_BAR,
        "health": "/health",
    })


async def health_handler(request: web.Request) -> web.Response:
    return web.json_response({"status": "ok", "hubs": [HUBS[s].health() for s in sorted(HUBS)]})


def _cors(resp: web.Response) -> web.Response:
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
    return resp


async def log_options(request: web.Request) -> web.Response:
    return _cors(web.Response(status=204))


async def log_handler(request: web.Request) -> web.Response:
    if request.method == "OPTIONS":
        return _cors(web.Response(status=204))
    try:
        data = await request.json()
    except Exception:
        return _cors(web.json_response({"ok": False, "error": "invalid json"}, status=400))
    slug = (data or {}).get("slug") or "unknown"
    rows = (data or {}).get("rows", [])
    os.makedirs(V5_LOG_DIR, exist_ok=True)
    p = pathlib.Path(V5_LOG_DIR) / f"{_safe_slug(slug)}.json"
    tmp = p.with_suffix(".json.tmp")
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, p)
    log.info("v5-log saved slug=%s rows=%d -> %s", slug, len(rows), p.name)
    return _cors(web.json_response({"ok": True, "slug": slug, "rows": len(rows), "path": str(p)}))


async def broadcast_loop(hub: SymbolHub) -> None:
    while True:
        try:
            await asyncio.sleep(C.MIN_INTERVAL_S)
            newest = max(hub.spot.last_update_ms, hub.perp.last_update_ms)
            if newest <= hub.last_sent_update:
                continue                       # on-change: nothing new since last send
            hub.last_sent_update = newest
            now = int(time.time() * 1000)
            by_bar: dict[int, list] = {}
            for ws, bar_ms in hub.clients.items():
                by_bar.setdefault(bar_ms, []).append(ws)
            for bar_ms, wss in by_bar.items():
                snap = compute.snapshot(hub.spot, hub.perp, now, bar_ms, hub.depth)
                payload = json.dumps({"ts": now, "symbol": hub.symbol, "bar_ms": bar_ms, **snap})
                dead = []
                for ws in wss:
                    try:
                        await ws.send_str(payload)
                    except Exception:
                        dead.append(ws)
                for ws in dead:
                    hub.clients.pop(ws, None)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("broadcast error symbol=%s", hub.symbol)


async def on_startup(app: web.Application) -> None:
    for i, sym in enumerate(sorted(C.ALLOWED_SYMBOLS)):
        hub = SymbolHub(sym)
        HUBS[sym] = hub
        hub.spot_task = asyncio.create_task(
            SpotFeed(hub.spot, sym, logging.getLogger("feed.spot." + sym)).run())
        hub.perp_task = asyncio.create_task(
            PerpFeed(hub.perp, sym, phase_s=i * 0.5, log=logging.getLogger("feed.perp." + sym)).run())
        hub.depth_task = asyncio.create_task(
            DepthFeed(hub.depth, sym, logging.getLogger("feed.depth." + sym)).run())
        hub.bcast_task = asyncio.create_task(broadcast_loop(hub))
        log.info("started hub %s", sym)


async def on_cleanup(app: web.Application) -> None:
    for hub in HUBS.values():
        for t in (hub.spot_task, hub.perp_task, hub.depth_task, hub.bcast_task):
            if t:
                t.cancel()
        for ws in list(hub.clients):
            try:
                await ws.close()
            except Exception:
                pass


def main() -> None:
    setup_logging()
    log.info("ourWebSocket starting on %s:%d (min_interval=%.3fs, on-change, default bar=%s)",
             C.HOST, C.PORT, C.MIN_INTERVAL_S, C.DEFAULT_BAR)
    app = web.Application()
    app.router.add_get("/", root_handler)
    app.router.add_get("/health", health_handler)
    app.router.add_get("/ws/v5/tape", ws_handler)
    app.router.add_route("OPTIONS", "/log", log_handler)
    app.router.add_post("/log", log_handler)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    web.run_app(app, host=C.HOST, port=C.PORT, access_log=None)


if __name__ == "__main__":
    main()
