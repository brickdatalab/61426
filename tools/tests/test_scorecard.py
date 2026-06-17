from polymarket_tools.tools.wallet_scorecard import _score


def test_profitable_selective_beats_breakeven_bot():
    sharp = _score(realized_pnl=250_000, roi=0.18, win_rate=0.61, volume=1_400_000,
                   n_markets=140, median_size=506, trades_per_day=7)
    bot = _score(realized_pnl=-2_000, roi=-0.001, win_rate=0.49, volume=900_000,
                 n_markets=3, median_size=12, trades_per_day=900)
    assert sharp["score"] > bot["score"]
    assert sharp["label"] == "SHARP"
    assert bot["label"] in ("NOISE-BOT", "RETAIL", "MIXED")
    assert 0.0 <= sharp["score"] <= 1.0


def test_unprofitable_is_discounted():
    loser = _score(realized_pnl=-50_000, roi=-0.1, win_rate=0.3, volume=500_000,
                   n_markets=40, median_size=300, trades_per_day=10)
    assert loser["pnl_component"] < 0.3
