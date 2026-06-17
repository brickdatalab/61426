"""Tool registry. Tools self-register on import via the ``@tool`` decorator.

This is the mechanism that lets many tool files be authored in parallel without
ever co-editing ``server.py``: each file declares its own ``@tool(...)`` and the
server discovers them by importing the ``tools`` package.

A tool handler is::

    async def handler(ctx: Ctx, args: dict) -> dict

It returns a Result envelope (see ``schema.ok`` / ``schema.err``). It must not
raise for expected API conditions - catch ``PolyError`` and convert with
``schema.err_from_exc`` (or a quirk-specific mapping).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable

Handler = Callable[[Any, dict], Awaitable[dict]]


@dataclass
class ToolSpec:
    name: str
    description: str
    input_schema: dict  # JSON Schema for the tool's arguments
    handler: Handler


REGISTRY: dict[str, ToolSpec] = {}


def tool(name: str, description: str, input_schema: dict) -> Callable[[Handler], Handler]:
    """Register a tool handler. Raises on duplicate names (catches copy-paste bugs)."""

    def deco(fn: Handler) -> Handler:
        if name in REGISTRY:
            raise ValueError(f"duplicate tool name registered: {name!r}")
        REGISTRY[name] = ToolSpec(name, description, input_schema, fn)
        return fn

    return deco
