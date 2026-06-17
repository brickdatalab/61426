from analysis.artifact import build_artifact
from analysis.grade import brier, clv, grade_artifact, update_scoreboard


def test_clv_positive_when_price_moves_our_way():
    assert abs(clv(side="BUY", price_t0=0.45, close=0.54) - 0.09) < 1e-9
    assert abs(clv(side="SELL", price_t0=0.45, close=0.40) - 0.05) < 1e-9


def test_brier():
    assert abs(brier(conf=0.7, outcome=1) - 0.09) < 1e-9


def test_grade_and_scoreboard(tmp_path):
    edge = {"leg": "aos", "side": "BUY", "price_t0": 0.45, "confidence": 7, "confidence_prob": 0.7}
    art = build_artifact(t0=1, slug="s", price_vector={}, edges=[edge], scorecards={}, anchors={})
    graded = grade_artifact(art, closing_prices={"aos": 0.54}, resolutions={"aos": 1})
    e = graded["edges"][0]
    assert graded["graded"] is True
    assert abs(e["clv"] - 0.09) < 1e-9 and e["hit"] is True and abs(e["brier"] - 0.09) < 1e-9
    board = update_scoreboard(str(tmp_path / "ledger.jsonl"), [graded])
    assert board["clv_win_rate"] == 1.0 and board["hit_rate"] == 1.0
