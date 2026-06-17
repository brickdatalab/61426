"""Shared keep-alive HTTP client + base URLs + typed error.

One ``PolyClient`` (one ``httpx.AsyncClient``) is created in the MCP server
lifespan and injected into every tool via ``Ctx``. Tools NEVER construct their
own client - that is the whole point of a persistent server: connection reuse.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx

# Base URLs (no trailing slash). Tools pass a base + path.
GAMMA_BASE = "https://gamma-api.polymarket.com"
DATA_BASE = "https://data-api.polymarket.com"
CLOB_BASE = "https://clob.polymarket.com"
WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market"

USER_AGENT = "polyfin-tools/0.1"


class PolyError(Exception):
    """Transport/HTTP error carrying enough context for the error envelope.

    ``type``:    short machine tag ("network", "http_error", "decode", "timeout")
    ``status``:  HTTP status code if any (tools map e.g. 404 -> "market_closed")
    ``endpoint``: the URL that failed
    """

    def __init__(
        self,
        type: str,
        message: str,
        *,
        status: int | None = None,
        endpoint: str | None = None,
    ) -> None:
        super().__init__(message)
        self.type = type
        self.message = message
        self.status = status
        self.endpoint = endpoint


class PolyClient:
    """Thin async wrapper over a single shared ``httpx.AsyncClient``."""

    def __init__(self) -> None:
        self._client = httpx.AsyncClient(
            http2=True,
            timeout=httpx.Timeout(15.0, connect=5.0),
            limits=httpx.Limits(
                max_keepalive_connections=20,
                max_connections=100,
                keepalive_expiry=30.0,
            ),
            headers={"user-agent": USER_AGENT, "accept": "application/json"},
            follow_redirects=True,
        )

    @property
    def raw(self) -> httpx.AsyncClient:
        """Escape hatch for callers needing the underlying client (rare)."""
        return self._client

    async def get(
        self, base: str, path: str, params: dict[str, Any] | None = None
    ) -> Any:
        url = f"{base}{path}"
        try:
            resp = await self._client.get(url, params=_clean_params(params))
        except httpx.TimeoutException as e:
            raise PolyError("timeout", str(e), endpoint=url) from e
        except httpx.HTTPError as e:
            raise PolyError("network", str(e), endpoint=url) from e
        return _handle(resp, url)

    async def post(self, base: str, path: str, json: Any = None) -> Any:
        url = f"{base}{path}"
        try:
            resp = await self._client.post(url, json=json)
        except httpx.TimeoutException as e:
            raise PolyError("timeout", str(e), endpoint=url) from e
        except httpx.HTTPError as e:
            raise PolyError("network", str(e), endpoint=url) from e
        return _handle(resp, url)

    async def aclose(self) -> None:
        await self._client.aclose()


def _clean_params(params: dict[str, Any] | None) -> dict[str, Any] | None:
    """Drop None values and lower-case bools to Polymarket's expected form."""
    if not params:
        return params
    out: dict[str, Any] = {}
    for k, v in params.items():
        if v is None:
            continue
        out[k] = "true" if v is True else "false" if v is False else v
    return out


def _handle(resp: httpx.Response, url: str) -> Any:
    if resp.status_code >= 400:
        raise PolyError(
            "http_error",
            f"HTTP {resp.status_code} for {url}",
            status=resp.status_code,
            endpoint=url,
        )
    try:
        return resp.json()
    except Exception as e:  # noqa: BLE001 - any decode failure is a decode error
        raise PolyError("decode", str(e), endpoint=url) from e


@dataclass
class Ctx:
    """Injected into every tool handler. Holds the shared, long-lived resources."""

    client: PolyClient
    ws: Any  # WsManager (Any to avoid an import cycle with ws_manager)
