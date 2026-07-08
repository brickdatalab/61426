import numpy as np

FEATURES = [
    ("pre_vol_slope", "T0"),
    ("vol_slope_bar", "T1"),
    ("vol_of_vol", "T1"),
    ("floor_energy", "T1"),
    ("basis_osc", "T1"),
    ("cushion_floor_time", "T1"),
]


def _nanstd(a):
    a = a[np.isfinite(a)]
    if a.size == 0:
        return np.nan
    return float(np.std(a, ddof=0))


def _nanmean(a):
    a = a[np.isfinite(a)]
    if a.size == 0:
        return np.nan
    return float(np.mean(a))


def _finite_diff_std(seg):
    v = seg[np.isfinite(seg)]
    if v.size < 2:
        return np.nan
    return float(np.std(np.diff(v), ddof=0))


def compute(bar, trig, pre):
    out = {}

    # T0: pre_vol_slope (finite-filtered — nan-poisoning fix on integration)
    spot_pre = pre["spot"]
    s120 = _finite_diff_std(spot_pre[-120:])
    s600 = _finite_diff_std(spot_pre[-600:])
    out["pre_vol_slope"] = float(s120 / (s600 + 0.01)) if np.isfinite(s600) and np.isfinite(s120) else np.nan

    vol_1m = bar["vol_1m"]
    t = int(trig)
    if 0 <= t < vol_1m.size:
        denom = vol_1m[max(0, t - 60)]
        out["vol_slope_bar"] = float(vol_1m[t] / (denom + 0.01)) if np.isfinite(denom) and np.isfinite(vol_1m[t]) else np.nan
    else:
        out["vol_slope_bar"] = np.nan

    lo = max(0, t - 120)
    seg = vol_1m[lo:t + 1]
    m = _nanmean(seg)
    s = _nanstd(seg)
    out["vol_of_vol"] = float(s / (m + 0.01)) if np.isfinite(m) and np.isfinite(s) else np.nan

    cushion = bar["cushion"]
    floor = bar["floor"]
    if 0 <= t < cushion.size and 0 <= t < floor.size:
        ac = np.abs(cushion[: t + 1])
        fl = floor[: t + 1]
        dc = np.abs(np.diff(cushion[: t + 1]))
        cond = (ac[1:] >= 0.7 * fl[1:]) & (ac[1:] <= 1.3 * fl[1:])
        cond = cond & np.isfinite(dc)
        energy = float(np.nansum(dc[cond])) if dc.size > 0 and np.any(cond) else 0.0
        ft = floor[t]
        out["floor_energy"] = float(energy / abs(ft)) if np.isfinite(ft) and ft != 0 else np.nan
    else:
        out["floor_energy"] = np.nan

    perp = bar["perp_close"]
    spot_bar = bar["spot"]
    lo = max(0, t - 120)
    diff = perp[lo:t + 1] - spot_bar[lo:t + 1]
    valid = diff[np.isfinite(diff)]
    out["basis_osc"] = float(np.std(valid, ddof=0)) if valid.size >= 60 else np.nan

    if 0 <= t < cushion.size and 0 <= t < floor.size:
        ac = np.abs(cushion[: t + 1])
        fl = floor[: t + 1]
        with np.errstate(invalid="ignore", divide="ignore"):
            ratio = ac / fl
        mask = np.isfinite(ratio)
        if mask.sum() > 0:
            in_band = (ratio[mask] >= 0.7) & (ratio[mask] <= 1.3)
            out["cushion_floor_time"] = float(np.mean(in_band))
        else:
            out["cushion_floor_time"] = np.nan
    else:
        out["cushion_floor_time"] = np.nan

    return out


if __name__ == "__main__":
    rng = np.random.default_rng(42)
    N = 300
    bar = {
        "spot": rng.normal(100, 5, N),
        "cushion": rng.normal(0, 5, N),
        "floor": np.abs(rng.normal(1, 0.2, N)) + 1.0,
        "vol_1m": np.abs(rng.normal(1, 0.3, N)) + 0.1,
        "perp_close": rng.normal(100, 5, N),
    }
    pre = {"spot": rng.normal(100, 5, 1800)}
    pre["spot"][::40] = np.nan
    res = compute(bar, 150, pre)
    assert set(res.keys()) == {n for n, _ in FEATURES}
    assert np.isfinite(res["pre_vol_slope"])
    print("SELFTEST OK")
