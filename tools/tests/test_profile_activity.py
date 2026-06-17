from polymarket_tools.tools.get_profile_activity import _INPUT, _PAGE


def test_cap_is_3500():
    assert "3500" in _INPUT["properties"]["max_items"]["description"]
    assert _PAGE <= 500
