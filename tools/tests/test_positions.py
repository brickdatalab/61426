import asyncio

import pytest

from polymarket_tools.client import Ctx, PolyClient
from polymarket_tools.tools.get_positions import get_positions


@pytest.mark.live
def test_positions_normalizes_pnl():
    async def run():
        c = PolyClient()
        ctx = Ctx(client=c, ws=None)
        r = await get_positions(ctx, {"wallet": "0x84cfffc3f16dcc353094de30d4a45226eccd2f63", "limit": 3})
        await c.aclose()
        return r

    r = asyncio.run(run())
    assert r["ok"] is True
    if r["data"]:
        p = r["data"][0]
        assert isinstance(p["realized_pnl"], float) and isinstance(p["cur_price"], float)
        assert "condition_id" in p and "token_id" in p


def test_positions_requires_wallet():
    async def run():
        c = PolyClient()
        ctx = Ctx(client=c, ws=None)
        r = await get_positions(ctx, {})
        await c.aclose()
        return r

    r = asyncio.run(run())
    assert r["ok"] is False and r["error"]["type"] == "bad_request"
