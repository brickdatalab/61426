import numpy as np

EPS = 1.0
N_SEC = 300
ELAPSED_LIST = list(range(5, 300, 5))  # 59 ticks: 5,10,...,295

FEATURES_MICRO = [
    "agg_ratio_10", "agg_ratio_30", "agg_ratio_60",
    "agg_accel", "agg_persist_60", "agg_intensity_30",
    "whale_net_30", "whale_net_60", "whale_against_move_60", "whale_burst",
    "basis", "basis_vel_10", "basis_vel_30", "basis_div", "basis_valid",
    "bid_pull_30", "ask_pull_30", "pull_skew", "imb_vel_10", "book_valid",
    "rem_norm",
]

_FIELDS = [
    "spot_close", "perp_close", "buy_usd", "sell_usd", "buy_base", "sell_base",
    "p_buy_usd", "p_sell_usd", "lg_buy", "lg_sell", "imb", "up_mid", "poly_imb",
    "bid_usd", "ask_usd",
]


def _build_arrays(bar):
    sec = bar.get("sec") or {}
    try:
        epoch = int(bar["slug"].rsplit("-", 1)[1])
    except Exception:
        epoch = 0
    arrays = {f: np.full(N_SEC, np.nan, dtype=np.float64) for f in _FIELDS}
    for k in range(N_SEC):
        s = sec.get(str(epoch + k))
        if not isinstance(s, dict):
            continue
        for f in _FIELDS:
            v = s.get(f)
            if v is not None:
                try:
                    arrays[f][k] = float(v)
                except (TypeError, ValueError):
                    pass
    return arrays


def _win_slice(t, w):
    start = max(0, t - w + 1)
    return slice(start, t + 1)


def _nansum(a, sl):
    return float(np.nansum(a[sl]))


def _vol_1m(spot, t):
    start = max(0, t - 60)
    vals = spot[start:t + 1]
    valid = vals[~np.isnan(vals)]
    if valid.size < 10:
        return 10.0
    diffs = np.diff(valid)
    if diffs.size < 2:
        return 10.0
    return float(np.std(diffs) * np.sqrt(60.0))


def _floor_vol(spot, t):
    return max(10.0, 0.5 * _vol_1m(spot, t))


def _ratio(b, s):
    num = b - s
    den = b + s
    if den < EPS:
        den = EPS
    return num / den


def _basis_at(perp, spot, k):
    if k < 0 or k >= N_SEC:
        return np.nan
    if np.isnan(perp[k]) or np.isnan(spot[k]):
        return np.nan
    return float(perp[k] - spot[k])


def compute_micro(bar):
    arr = _build_arrays(bar)
    spot = arr["spot_close"]
    perp = arr["perp_close"]
    buy = arr["buy_usd"]
    sell = arr["sell_usd"]
    lg_buy = arr["lg_buy"]
    lg_sell = arr["lg_sell"]
    imb = arr["imb"]
    bid = arr["bid_usd"]
    ask = arr["ask_usd"]

    valid_spot = spot[~np.isnan(spot)]
    bar_open = float(valid_spot[0]) if valid_spot.size > 0 else np.nan

    book_valid = 1.0 if (np.any(~np.isnan(bid)) or np.any(~np.isnan(ask))) else 0.0

    F = len(FEATURES_MICRO)
    out = np.zeros((len(ELAPSED_LIST), F), dtype=np.float32)

    for row, t in enumerate(ELAPSED_LIST):
        s10 = _win_slice(t, 10)
        s30 = _win_slice(t, 30)
        s60 = _win_slice(t, 60)

        b10 = _nansum(buy, s10); q10 = _nansum(sell, s10)
        b30 = _nansum(buy, s30); q30 = _nansum(sell, s30)
        b60 = _nansum(buy, s60); q60 = _nansum(sell, s60)

        r10 = _ratio(b10, q10)
        r30 = _ratio(b30, q30)
        r60 = _ratio(b60, q60)
        agg_accel = r10 - r60

        if r60 == 0.0:
            persist = 0.0
        else:
            sg = np.sign(r60)
            start = max(0, t - 60 + 1)
            seg_b = np.where(np.isnan(buy[start:t + 1]), 0.0, buy[start:t + 1])
            seg_s = np.where(np.isnan(sell[start:t + 1]), 0.0, sell[start:t + 1])
            diff = seg_b - seg_s
            cnt = float(np.sum(np.sign(diff) == sg))
            n = seg_b.size
            persist = (cnt / n) if n > 0 else 0.0

        sum30 = b30 + q30
        total_open = _nansum(buy, slice(0, t + 1)) + _nansum(sell, slice(0, t + 1))
        rate = (total_open / t) if t > 0 else 0.0
        intensity = sum30 / (rate * 30.0 + EPS)

        fv = _floor_vol(spot, t)
        wn30 = (_nansum(lg_buy, s30) - _nansum(lg_sell, s30)) / (fv * 100.0)
        wn60 = (_nansum(lg_buy, s60) - _nansum(lg_sell, s60)) / (fv * 100.0)

        if np.isnan(spot[t]) or np.isnan(bar_open):
            cushion = 0.0
        else:
            cushion = float(spot[t]) - bar_open
        whale_against = -np.sign(cushion) * wn60

        start = max(0, t - 60 + 1)
        lb = np.where(np.isnan(lg_buy[start:t + 1]), 0.0, lg_buy[start:t + 1])
        ls = np.where(np.isnan(lg_sell[start:t + 1]), 0.0, lg_sell[start:t + 1])
        lgs = lb + ls
        burst_max = 0.0
        for i in range(lgs.size):
            jstart = max(0, i - 9)
            burst_max = max(burst_max, float(lgs[jstart:i + 1].sum()))
        sum60_lg = float(lgs.sum())
        whale_burst = burst_max / (sum60_lg + EPS)

        bt = _basis_at(perp, spot, t)
        if np.isnan(bt):
            basis = 0.0
            basis_valid = 0.0
        else:
            basis = bt
            basis_valid = 1.0
        b10v = _basis_at(perp, spot, t - 10)
        b30v = _basis_at(perp, spot, t - 30)
        basis_vel_10 = 0.0 if (np.isnan(bt) or np.isnan(b10v)) else (bt - b10v) / 10.0
        basis_vel_30 = 0.0 if (np.isnan(bt) or np.isnan(b30v)) else (bt - b30v) / 30.0

        sp_t = spot[t] if (0 <= t < N_SEC) else np.nan
        sp_t10 = spot[t - 10] if (0 <= t - 10 < N_SEC) else np.nan
        if (np.isnan(bt) or np.isnan(b10v) or np.isnan(sp_t) or np.isnan(sp_t10)):
            basis_div = 0.0
        else:
            basis_div = float(np.sign(bt - b10v) - np.sign(sp_t - sp_t10))

        if book_valid == 0.0:
            bid_pull = 0.0
            ask_pull = 0.0
            pull_skew = 0.0
            imb_vel = 0.0
        else:
            if t - 30 < 0 or np.isnan(bid[t]) or np.isnan(bid[t - 30]):
                bid_pull = 0.0
            else:
                bid_pull = (bid[t] - bid[t - 30]) / (bid[t - 30] + EPS)
            if t - 30 < 0 or np.isnan(ask[t]) or np.isnan(ask[t - 30]):
                ask_pull = 0.0
            else:
                ask_pull = (ask[t] - ask[t - 30]) / (ask[t - 30] + EPS)
            pull_skew = ask_pull - bid_pull
            if t - 10 < 0 or np.isnan(imb[t]) or np.isnan(imb[t - 10]):
                imb_vel = 0.0
            else:
                imb_vel = float(imb[t] - imb[t - 10])

        rem_norm = (300 - t) / 300.0

        vals = np.array([
            r10, r30, r60, agg_accel, persist, intensity,
            wn30, wn60, whale_against, whale_burst,
            basis, basis_vel_10, basis_vel_30, basis_div, basis_valid,
            bid_pull, ask_pull, pull_skew, imb_vel, book_valid,
            rem_norm,
        ], dtype=np.float64)
        vals = np.clip(vals, -50.0, 50.0)
        out[row] = vals.astype(np.float32)

    return out


if __name__ == "__main__":
    epoch = 1000000
    sec = {}
    for k in range(N_SEC):
        sp = 100.0 + 0.1 * k
        sec[str(epoch + k)] = {
            "spot_close": sp,
            "perp_close": sp + 1.0,
            "buy_usd": 200.0,
            "sell_usd": 0.0,
            "buy_base": 200.0 / sp,
            "sell_base": 0.0,
            "p_buy_usd": 200.0,
            "p_sell_usd": 0.0,
            "lg_buy": 0.0,
            "lg_sell": 0.0,
            "imb": None,
            "up_mid": None,
            "poly_imb": None,
            "bid_usd": 5000.0,
            "ask_usd": 5000.0 * (0.99 ** (k / 30.0)),
        }
    bar = {
        "slug": "BTC-1000000", "settle": "BTC",
        "open": 100.0, "close": 130.0, "abs_move": 30.0, "sec": sec,
    }
    out = compute_micro(bar)
    assert out.shape == (59, len(FEATURES_MICRO)), out.shape
    idx = 150 // 5 - 1  # elapsed 150 -> row 29
    assert abs(out[idx, FEATURES_MICRO.index("agg_ratio_60")] - 1.0) < 1e-6
    assert abs(out[idx, FEATURES_MICRO.index("basis_vel_10")] - 0.0) < 1e-9
    assert abs(out[idx, FEATURES_MICRO.index("bid_pull_30")] - 0.0) < 1e-6
    assert out[idx, FEATURES_MICRO.index("ask_pull_30")] < 0.0
    print("SELFTEST OK")
