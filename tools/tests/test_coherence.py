from polymarket_tools.fairvalue.coherence import distribution_gap, report, triplet_gap


def test_triplet_sums_to_one():
    assert abs(triplet_gap([0.925, 0.051, 0.022])) < 0.01


def test_exact_score_field_underpriced_is_negative_gap():
    g = distribution_gap([0.125, 0.155, 0.075, 0.065, 0.055, 0.029], field=0.40)
    assert g < 0  # sum 0.904 -> field underpriced


def test_report_flags_and_sorts():
    out = report([
        {"name": "1X2", "kind": "triplet", "legs": ["win", "draw", "loss"], "probs": [0.925, 0.051, 0.022]},
        {"name": "exact", "kind": "distribution", "legs": ["scores"],
         "listed": [0.125, 0.155, 0.075, 0.065, 0.055, 0.029], "field": 0.40},
    ])
    assert out[0]["check"] == "exact"  # bigger |gap| first
    assert out[0]["reading"] == "field/blowout underpriced"
