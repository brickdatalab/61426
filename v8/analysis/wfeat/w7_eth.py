import numpy as np

FEATURES = [
    ("eth_pre_er_300", "T0"),
    ("eth_er_60", "T1"),
    ("eth_crossmatch", "T1"),
    ("eth_mid_var_60", "T1"),
    ("eth_mid_hug", "T1"),
]


def _kaufman_er(arr):
    arr = np.asarray(arr, dtype=float)
    arr = arr[np.isfinite(arr)]
    if arr.size < 2:
        return np.nan
    sd = float(np.sum(np.abs(np.diff(arr))))
    if sd == 0.0:
        return 0.0
    return float(abs(arr[-1] - arr[0]) / sd)


def compute(bar, trig, pre):
    out = {}
    t = int(trig)

    eth_pre = pre.get("eth_spot_pre")
    out["eth_pre_er_300"] = _kaufman_er(np.asarray(eth_pre, dtype=float)[-300:]) if eth_pre is not None else np.nan

    eth_spot_bar = bar.get("eth_spot_bar")
    eth_mid_bar = bar.get("eth_mid_bar")
    spot = bar.get("spot")

    if eth_spot_bar is None or t < 1:
        out["eth_er_60"] = np.nan
    else:
        e = np.asarray(eth_spot_bar, dtype=float)
        out["eth_er_60"] = _kaufman_er(e[max(0, t - 60):t + 1])

    if spot is None or eth_spot_bar is None or t < 10:
        out["eth_crossmatch"] = np.nan
    else:
        s = np.asarray(spot, dtype=float)[:t + 1]
        e = np.asarray(eth_spot_bar, dtype=float)[:t + 1]
        with np.errstate(divide="ignore", invalid="ignore"):
            s_r = s[10:] / s[:-10] - 1.0
            e_r = e[10:] / e[:-10] - 1.0
        mask = np.isfinite(s_r) & np.isfinite(e_r)
        if mask.sum() < 30:
            out["eth_crossmatch"] = np.nan
        else:
            sv, ev = s_r[mask], e_r[mask]
            if sv.std() == 0.0 or ev.std() == 0.0:
                out["eth_crossmatch"] = np.nan
            else:
                out["eth_crossmatch"] = float(np.corrcoef(sv, ev)[0, 1])

    if eth_mid_bar is None or t < 1:
        out["eth_mid_var_60"] = np.nan
        out["eth_mid_hug"] = np.nan
    else:
        em = np.asarray(eth_mid_bar, dtype=float)
        v = em[max(0, t - 60):t + 1]
        v = v[np.isfinite(v)]
        out["eth_mid_var_60"] = float(np.std(v)) if v.size >= 2 else np.nan
        h = em[max(0, t - 30):t + 1]
        h = h[np.isfinite(h)]
        out["eth_mid_hug"] = (1.0 - 2.0 * abs(float(np.mean(h)) - 0.5)) if h.size else np.nan

    return out


if __name__ == "__main__":
    np.random.seed(0)
    n = 300
    bar = {
        "spot": 100.0 + np.cumsum(np.random.randn(n) * 0.1),
        "eth_spot_bar": 50.0 + np.cumsum(np.random.randn(n) * 0.1),
        "eth_mid_bar": np.clip(0.5 + np.random.randn(n) * 0.1, 0.0, 1.0),
    }
    pre = {"eth_spot_pre": 50.0 + np.cumsum(np.random.randn(1800) * 0.1)}
    out = compute(bar, 200, pre)
    assert set(out.keys()) == {f[0] for f in FEATURES}
    out2 = compute({"spot": bar["spot"], "eth_spot_bar": np.full(n, np.nan), "eth_mid_bar": np.full(n, np.nan)}, 200, pre)
    assert set(out2.keys()) == {f[0] for f in FEATURES}
    print("SELFTEST OK")
