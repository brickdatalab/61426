import numpy as np

FEATURES = [
    ("unbacked", "T1"),
    ("cvd_cush_div", "T1"),
    ("battle_ratio", "T1"),
    ("intensity_rel", "T1"),
    ("lg_bal", "T1"),
    ("flow_flip_60", "T1"),
]


def compute(bar, trig, pre):
    t = int(trig)
    buy = np.nan_to_num(bar["buy_usd"])
    sell = np.nan_to_num(bar["sell_usd"])
    cushion = bar["cushion"]
    floor = bar["floor"]
    lg_buy = np.nan_to_num(bar["lg_buy"])
    lg_sell = np.nan_to_num(bar["lg_sell"])

    cvd = np.cumsum(buy - sell)

    gross_all = np.sum(buy[:t + 1] + sell[:t + 1])
    denom_unbacked = 0.3 * gross_all + 1.0
    ratio = min(1.0, abs(cvd[t]) / denom_unbacked)
    ft = floor[t]
    ct = cushion[t]
    if np.isnan(ft) or np.isnan(ct) or ft == 0:
        unbacked = np.nan
    else:
        unbacked = abs(ct) / ft * (1.0 - ratio)

    t0 = max(0, t - 60)
    gross_60 = np.sum(buy[t0 + 1:t + 1] + sell[t0 + 1:t + 1]) + 1.0
    cvd_cush_div = (np.sign(ct) * (cvd[t0] - cvd[t]) / gross_60) if np.isfinite(ct) else np.nan

    sb = np.sum(buy[t0 + 1:t + 1])
    ss = np.sum(sell[t0 + 1:t + 1])
    battle_ratio = min(sb, ss) / (max(sb, ss) + 1.0)

    t1 = max(0, t - 30)
    gross_30 = np.sum(buy[t1 + 1:t + 1] + sell[t1 + 1:t + 1])
    intensity_rel = gross_30 / (gross_all / max(t, 1) * 30 + 1.0)

    slb = np.sum(lg_buy[:t + 1])
    sls = np.sum(lg_sell[:t + 1])
    lg_bal = min(slb, sls) / (max(slb, sls) + 1.0)

    diff = buy - sell
    start = max(0, t - 60)
    indices = list(range(start + 1, t + 1))
    if len(indices) == 0:
        flow_flip_60 = 0.0
    else:
        rolls = np.empty(len(indices))
        for k, i in enumerate(indices):
            lo = max(0, i - 9)
            rolls[k] = np.sum(diff[lo:i + 1])
        signs = np.sign(rolls)
        flips = 0
        prev = 0
        for s in signs:
            if s != 0:
                if prev != 0 and s != prev:
                    flips += 1
                prev = int(s)
        flow_flip_60 = float(flips)

    return {
        "unbacked": float(unbacked) if np.isfinite(unbacked) else np.nan,
        "cvd_cush_div": float(cvd_cush_div) if np.isfinite(cvd_cush_div) else np.nan,
        "battle_ratio": float(battle_ratio),
        "intensity_rel": float(intensity_rel),
        "lg_bal": float(lg_bal),
        "flow_flip_60": float(flow_flip_60),
    }


if __name__ == "__main__":
    np.random.seed(42)
    n = 300
    bar = {
        "cushion": np.random.randn(n),
        "floor": np.abs(np.random.randn(n)) + 0.1,
        "buy_usd": np.abs(np.random.randn(n)) * 1000,
        "sell_usd": np.abs(np.random.randn(n)) * 1000,
        "lg_buy": np.abs(np.random.randn(n)) * 100,
        "lg_sell": np.abs(np.random.randn(n)) * 100,
    }
    result = compute(bar, 150, {})
    assert set(result.keys()) == set(name for name, _ in FEATURES)
    print("SELFTEST OK")
