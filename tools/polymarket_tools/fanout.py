"""Concurrency helpers for batch / fan-out tools.

Used by the batch tools (midpoints, spreads, price-history) to issue many
requests over the single shared client at once. When a true batch endpoint
exists, the tool calls it directly; when it does not, the tool fans out single
calls concurrently via ``gather_bounded`` and assembles aligned results.
"""

from __future__ import annotations

import asyncio
from typing import Awaitable, Callable, TypeVar

T = TypeVar("T")

DEFAULT_CONCURRENCY = 10


async def gather_bounded(
    factories: list[Callable[[], Awaitable[T]]],
    limit: int = DEFAULT_CONCURRENCY,
) -> list[T | Exception]:
    """Run coroutine *factories* with bounded concurrency.

    Takes factories (zero-arg callables returning a fresh coroutine) rather than
    coroutines so creation is also bounded. Order of results matches input order.
    Exceptions are returned in-place (not raised) so one failure does not sink the
    whole batch - callers decide how to fold them into the Result envelope.
    """
    sem = asyncio.Semaphore(max(1, limit))

    async def run(factory: Callable[[], Awaitable[T]]) -> T:
        async with sem:
            return await factory()

    return await asyncio.gather(
        *(run(f) for f in factories), return_exceptions=True
    )
