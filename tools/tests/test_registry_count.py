from polymarket_tools import server
from polymarket_tools.registry import REGISTRY


def test_new_tools_registered():
    server._load_tools()
    for name in ("get_positions", "get_portfolio_value", "wallet_scorecard"):
        assert name in REGISTRY
    assert len(REGISTRY) == 22
