import asyncio

import pytest

from polymarket_tools.client import Ctx, PolyClient
from polymarket_tools.tools.get_portfolio_value import get_portfolio_value


@pytest.mark.live
def test_value_is_float():
    async def run():
        c = PolyClient()
        ctx = Ctx(client=c, ws=None)
        r = await get_portfolio_value(ctx, {"wallet": "0x84cfffc3f16dcc353094de30d4a45226eccd2f63"})
        await c.aclose()
        return r

    r = asyncio.run(run())
    assert r["ok"] is True
    assert isinstance(r["data"]["value"], float)
