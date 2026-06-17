"""MCP stdio server. One persistent process owns the shared client + WS manager
and exposes every registered tool. Tools are auto-discovered from the ``tools``
package, so this file never changes as tools are added.
"""

from __future__ import annotations

import asyncio
import importlib
import json
import pkgutil

import mcp.types as types
from mcp.server import Server
from mcp.server.stdio import stdio_server

from .client import WS_URL, Ctx, PolyClient
from .registry import REGISTRY
from .ws_manager import WsManager

server: Server = Server("polymarket-tools")

# Set during main() before the server starts handling requests.
CTX: Ctx | None = None


def _load_tools() -> None:
    """Import every module in ``polymarket_tools.tools`` so they self-register."""
    from . import tools as tools_pkg

    for mod in pkgutil.iter_modules(tools_pkg.__path__):
        if mod.name.startswith("_"):
            continue
        importlib.import_module(f"{tools_pkg.__name__}.{mod.name}")


@server.list_tools()
async def list_tools() -> list[types.Tool]:
    return [
        types.Tool(
            name=spec.name,
            description=spec.description,
            inputSchema=spec.input_schema,
        )
        for spec in REGISTRY.values()
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict | None) -> list[types.ContentBlock]:
    spec = REGISTRY.get(name)
    if spec is None:
        payload = {
            "ok": False,
            "error": {"type": "unknown_tool", "message": f"no tool named {name!r}"},
        }
        return [types.TextContent(type="text", text=json.dumps(payload))]

    assert CTX is not None, "server context not initialized"
    try:
        result = await spec.handler(CTX, arguments or {})
    except Exception as e:  # noqa: BLE001 - never let a tool crash the server
        result = {
            "ok": False,
            "error": {"type": "tool_exception", "message": repr(e)},
        }
    return [types.TextContent(type="text", text=json.dumps(result, default=str))]


async def main() -> None:
    global CTX
    client = PolyClient()
    ws = WsManager(WS_URL)
    CTX = Ctx(client=client, ws=ws)
    _load_tools()
    await ws.start()
    try:
        async with stdio_server() as (read, write):
            await server.run(read, write, server.create_initialization_options())
    finally:
        await ws.aclose()
        await client.aclose()


def run() -> None:
    """Console-script entry point."""
    asyncio.run(main())


if __name__ == "__main__":
    run()
