from analysis.run_market_analysis import build_snapshot


def test_build_snapshot_structure():
    events = [{
        "slug": "fifwc-esp-cvi-2026-06-15",
        "markets": [
            {"question": "Will Spain win on 2026-06-15?", "conditionId": "0xa55",
             "clobTokenIds": "[\"111\", \"222\"]", "outcomePrices": "[\"0.925\", \"0.075\"]"},
            {"question": "Draw?", "conditionId": "0xc34",
             "clobTokenIds": ["333", "444"], "outcomePrices": ["0.051", "0.949"]},
        ],
    }]
    snap = build_snapshot(events, t0=1781481219)
    assert snap["slug"] == "fifwc-esp-cvi-2026-06-15"
    assert snap["t0"] == 1781481219
    assert len(snap["markets"]) == 2
    m0 = snap["markets"][0]
    assert m0["condition_id"] == "0xa55" and m0["clob_token_ids"] == ["111", "222"]
    assert m0["yes_price"] == 0.925
    assert snap["price_vector"]["0xc34"] == 0.051
