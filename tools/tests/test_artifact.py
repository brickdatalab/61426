import json
import os

from analysis.artifact import REQUIRED_KEYS, build_artifact, read_artifact, write_artifact


def _edge():
    return {"leg": "any_other_score", "condition_id": "0xabc", "token_id": "111",
            "side": "BUY", "price_t0": 0.455, "fair_price": 0.52, "edge_cents": 6.5,
            "confidence": 7, "evidence": {"fairvalue": "gap +0.065", "coherence": "field -0.096",
            "smart_money": "0x2f63 sharp", "microstructure": "tradeable", "refutation": "survived"}}


def test_build_has_required_keys():
    art = build_artifact(t0=1781481219, slug="fifwc-esp-cvi-2026-06-15",
                         price_vector={"0xabc": 0.455}, edges=[_edge()], scorecards={}, anchors={})
    for k in REQUIRED_KEYS:
        assert k in art
    assert art["graded"] is False


def test_write_and_roundtrip(tmp_path):
    art = build_artifact(t0=1781481219, slug="demo-slug",
                         price_vector={"0xabc": 0.455}, edges=[_edge()], scorecards={}, anchors={})
    paths = write_artifact(str(tmp_path), art)
    assert os.path.exists(paths["artifact_path"])
    assert read_artifact(paths["artifact_path"]) == art
    with open(paths["ledger_path"]) as f:
        rows = [json.loads(line) for line in f]
    assert len(rows) == 1 and rows[0]["slug"] == "demo-slug" and rows[0]["n_edges"] == 1
