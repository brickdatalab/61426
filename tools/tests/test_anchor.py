from polymarket_tools.fairvalue.anchor import devig_decimal, overround


def test_devig_two_way():
    fair = devig_decimal({"yes": 1.5, "no": 2.5})
    assert abs(sum(fair.values()) - 1.0) < 1e-9
    assert abs(fair["yes"] - 0.625) < 0.01


def test_overround_positive():
    assert overround({"yes": 1.5, "no": 2.5}) > 0
