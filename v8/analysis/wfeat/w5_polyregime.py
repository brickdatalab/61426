import numpy as np

FEATURES = [
    ("poly_hug", "T1"),
    ("poly_price_gap", "T1"),
    ("poly_var_60", "T1"),
    ("poly_vel_30", "T1"),
    ("pimb_flicker", "T1"),
    ("poly_conviction", "T1"),
]


def _nanmean(a):
    a = a[np.isfinite(a)]
    return float(np.mean(a)) if a.size else np.nan


def _nanstd(a):
    a = a[np.isfinite(a)]
    return float(np.std(a)) if a.size else np.nan


def _sign(x):
    if not np.isfinite(x):
        return 0.0
    return 1.0 if x > 0 else (-1.0 if x < 0 else 0.0)


def compute(bar, trig, pre):
    up_mid = bar["up_mid"]
    cushion = bar["cushion"]
    pimb = bar["pimb"]
    t = int(trig)

    m = _nanmean(up_mid[max(0, t - 30):t + 1])
    poly_hug = 1.0 - 2.0 * abs(m - 0.5) if np.isfinite(m) else np.nan

    um_t = up_mid[t]
    c_t = cushion[t]
    poly_price_gap = (um_t - 0.5) * _sign(c_t) if np.isfinite(um_t) and np.isfinite(c_t) else np.nan

    poly_var_60 = _nanstd(up_mid[max(0, t - 60):t + 1])

    ib = t - 30
    if ib >= 0 and np.isfinite(up_mid[t]) and np.isfinite(up_mid[ib]) and np.isfinite(c_t):
        poly_vel_30 = (up_mid[t] - up_mid[ib]) * _sign(c_t)
    else:
        poly_vel_30 = np.nan

    pseg = pimb[0:t + 1]
    valid = pseg[np.isfinite(pseg)]
    changes = 0
    if valid.size >= 2:
        s = np.sign(valid)
        s = s[s != 0]
        if s.size >= 2:
            changes = int(np.sum(np.abs(np.diff(s)) > 0))
    pimb_flicker = changes / max(t, 1)

    std3 = _nanstd(up_mid[0:t + 1])
    poly_conviction = abs(um_t - 0.5) / (std3 + 0.01) if np.isfinite(um_t) and np.isfinite(std3) else np.nan

    return {
        "poly_hug": float(poly_hug) if np.isfinite(poly_hug) else np.nan,
        "poly_price_gap": float(poly_price_gap) if np.isfinite(poly_price_gap) else np.nan,
        "poly_var_60": float(poly_var_60) if np.isfinite(poly_var_60) else np.nan,
        "poly_vel_30": float(poly_vel_30) if np.isfinite(poly_vel_30) else np.nan,
        "pimb_flicker": float(pimb_flicker),
        "poly_conviction": float(poly_conviction) if np.isfinite(poly_conviction) else np.nan,
    }


if __name__ == "__main__":
    rng = np.random.default_rng(42)
    n = 300
    bar = {
        "up_mid": np.clip(0.5 + np.cumsum(rng.normal(0, 0.005, n)), 0.01, 0.99),
        "cushion": rng.uniform(-1, 1, n),
        "pimb": rng.uniform(-1, 1, n),
    }
    res = compute(bar, 120, {})
    assert set(res.keys()) == {f[0] for f in FEATURES}
    print("SELFTEST OK")
