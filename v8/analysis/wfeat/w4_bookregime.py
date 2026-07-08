import numpy as np

FEATURES = [
    ("pre_depth_rel", "T0"),
    ("pre_depth_abs", "T0"),
    ("depth_rel_bar", "T1"),
    ("imb_flicker_bar", "T1"),
    ("pull_osc", "T1"),
    ("depth_slope", "T1"),
]


def _nanmean(a):
    a = np.asarray(a, dtype=np.float64)
    if a.size == 0:
        return np.nan
    with np.errstate(all="ignore"):
        return float(np.nanmean(a))


def compute(bar, trig, pre):
    out = {}

    pre_sum = np.asarray(pre["bid_usd"], dtype=np.float64) + np.asarray(pre["ask_usd"], dtype=np.float64)
    num_last = _nanmean(pre_sum[-300:])
    num_full = _nanmean(pre_sum)
    out["pre_depth_rel"] = float(num_last / (num_full + 1.0)) if np.isfinite(num_last) and np.isfinite(num_full) else np.nan
    out["pre_depth_abs"] = float(np.log10(num_last + 1.0)) if np.isfinite(num_last) and num_last >= 0 else np.nan

    bid = np.asarray(bar["bid_usd"], dtype=np.float64)
    ask = np.asarray(bar["ask_usd"], dtype=np.float64)
    imb = np.asarray(bar["imb"], dtype=np.float64)
    bar_sum = bid + ask

    lo = max(0, trig - 60)
    num_bar = _nanmean(bar_sum[lo:trig + 1])
    out["depth_rel_bar"] = float(num_bar / (num_full + 1.0)) if np.isfinite(num_bar) and np.isfinite(num_full) else np.nan

    imb_seg = imb[0:trig + 1]
    valid = imb_seg[np.isfinite(imb_seg)]
    changes = 0
    if valid.size > 1:
        s = np.sign(valid)
        s = s[s != 0]
        if s.size > 1:
            changes = int(np.sum(np.diff(s) != 0))
    out["imb_flicker_bar"] = float(changes) / float(max(trig, 1))

    with np.errstate(all="ignore"):
        spread = (ask - bid) / (ask + bid + 1.0)
    roll_vals = []
    for t in range(29, trig + 1):
        m = _nanmean(spread[t - 29:t + 1])
        if np.isfinite(m):
            roll_vals.append(m)
    if len(roll_vals) >= 2:
        out["pull_osc"] = float(np.std(np.asarray(roll_vals), ddof=0))
    elif len(roll_vals) == 1:
        out["pull_osc"] = 0.0
    else:
        out["pull_osc"] = np.nan

    s0 = max(0, trig - 120)
    seg = bar_sum[s0:trig + 1]
    idx = np.arange(s0, trig + 1, dtype=np.float64)
    valid_mask = np.isfinite(seg)
    if int(np.sum(valid_mask)) < 60:
        out["depth_slope"] = np.nan
    else:
        x = idx[valid_mask]; y = seg[valid_mask]
        xm = float(np.mean(x)); ym = float(np.mean(y))
        denom = float(np.sum((x - xm) ** 2))
        if denom == 0.0 or ym == 0.0:
            out["depth_slope"] = np.nan
        else:
            slope = float(np.sum((x - xm) * (y - ym)) / denom)
            out["depth_slope"] = float(slope / ym)

    return {name: (float(out.get(name)) if out.get(name) is not None and np.isfinite(out.get(name, np.nan)) else float("nan"))
            for name, _ in FEATURES}


if __name__ == "__main__":
    rng = np.random.default_rng(42)
    n = 300
    bar = {"bid_usd": rng.uniform(1e5, 3e5, n), "ask_usd": rng.uniform(1e5, 3e5, n), "imb": rng.uniform(-1, 1, n)}
    pre = {"bid_usd": rng.uniform(1e5, 3e5, 1800), "ask_usd": rng.uniform(1e5, 3e5, 1800)}
    res = compute(bar, 200, pre)
    assert set(res.keys()) == {f[0] for f in FEATURES}
    print("SELFTEST OK")
