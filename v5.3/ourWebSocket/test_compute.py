"""Unit tests for the additive vol_1m_usd field.
Run from v5.1/ourWebSocket/ (so `import compute` resolves): python3 -m unittest test_compute -v"""
import unittest
from compute import _vol_1m_usd, snapshot


class FakeTape:
    def __init__(self):
        self.cum_cvd_usd = 0.0
        self.last_price = 60000.0
        self.trades = []
        self.cvd_1s = []
        self.price_1s = []
        self.large_prints = []

    def cvd_at(self, ts_ms):
        best = None
        for t, v in self.cvd_1s:
            if t <= ts_ms:
                best = v
        return best


class VolTest(unittest.TestCase):
    def test_flat_prices_give_zero_vol(self):
        now = 1_700_000_060_000
        ring = [(now - 60_000 + i * 1000, 60000.0) for i in range(60)]
        self.assertEqual(_vol_1m_usd(ring, now), 0.0)

    def test_alternating_jitter_gives_sane_vol(self):
        now = 1_700_000_060_000
        ring = [(now - 60_000 + i * 1000, 60000.0 + (i % 2) * 2) for i in range(60)]
        v = _vol_1m_usd(ring, now)
        self.assertIsNotNone(v)
        self.assertGreater(v, 5.0)     # ~$2 diffs * sqrt(60) ~= $15
        self.assertLess(v, 40.0)

    def test_too_few_samples_returns_none(self):
        now = 1_700_000_060_000
        ring = [(now - 3000, 60000.0), (now - 2000, 60001.0)]
        self.assertIsNone(_vol_1m_usd(ring, now))

    def test_snapshot_is_additive_only(self):
        """New field appears; every pre-existing key is still present."""
        spot, perp = FakeTape(), FakeTape()
        now = 1_700_000_060_000
        spot.price_1s = [(now - 60_000 + i * 1000, 60000.0 + i) for i in range(60)]
        out = snapshot(spot, perp, now, bar_ms=300_000)
        tape = out["tape"]
        for key in ("cvd_candle_usd", "cvd_delta_1m", "cvd_delta_3m", "efficiency_3m",
                    "large_print_net_3m_usd", "price", "bar_open", "binance_imb"):
            self.assertIn(key, tape)
        self.assertIn("vol_1m_usd", tape)
        self.assertIn("perp_spot_divergence", out)


if __name__ == "__main__":
    unittest.main()
