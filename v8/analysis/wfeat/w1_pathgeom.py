import numpy as np

FEATURES = [
    ('er_60', 'T1'),
    ('er_120', 'T1'),
    ('crossings_sofar', 'T1'),
    ('opp_excursion_ratio', 'T1'),
    ('half_life', 'T1'),
    ('vel_decel', 'T1'),
    ('range_ratio', 'T1'),
]


def _efficiency_ratio(spot, trig, w):
    if trig < w:
        return np.nan
    start = trig - w
    seg = spot[start:trig + 1]
    if not np.isfinite(seg[0]) or not np.isfinite(seg[-1]):
        return np.nan
    valid_count = int(np.isfinite(seg).sum())
    if valid_count < w / 2:
        return np.nan
    diffs = np.abs(np.diff(seg))
    denom = np.nansum(diffs)
    num = abs(seg[-1] - seg[0])
    if denom == 0:
        return 0.0 if num == 0 else np.nan
    return float(num / denom)


def _crossings_sofar(cushion, floor, trig):
    c = cushion[:trig + 1]
    f = floor[:trig + 1]
    s = np.zeros(len(c), dtype=np.float64)
    valid = np.isfinite(c) & np.isfinite(f)
    s[valid] = np.sign(c[valid]) * (np.abs(c[valid]) >= f[valid]).astype(np.float64)
    nonzero = s[s != 0]
    if len(nonzero) < 2:
        return 0.0
    return float(np.sum(np.diff(nonzero) != 0))


def _opp_excursion_ratio(cushion, floor, trig):
    c_trig = cushion[trig]
    if not np.isfinite(c_trig) or c_trig == 0:
        return 0.0
    side = np.sign(c_trig)
    c = cushion[:trig + 1]
    f = floor[:trig + 1]
    valid = np.isfinite(c) & np.isfinite(f) & (f > 0)
    opp = valid & (np.sign(c) == -side)
    if not np.any(opp):
        return 0.0
    return float(np.max(np.abs(c[opp]) / f[opp]))


def _half_life(cushion, floor, trig):
    c = cushion[:trig + 1]
    f = floor[:trig + 1]
    abs_c = np.abs(c)
    valid = np.isfinite(c) & np.isfinite(f)
    abs_c_safe = np.where(valid, abs_c, 0.0)
    threshold = 0.5 * np.where(valid, f, 0.0)
    peaks = []
    for i in range(1, len(abs_c_safe) - 1):
        if not valid[i]:
            continue
        if abs_c_safe[i] >= threshold[i] and \
           abs_c_safe[i] >= abs_c_safe[i - 1] and \
           abs_c_safe[i] > abs_c_safe[i + 1]:
            peaks.append(i)
    if len(peaks) < 2:
        return np.nan
    half_lives = []
    for p in peaks:
        half_val = abs_c_safe[p] / 2.0
        for j in range(p + 1, len(abs_c_safe)):
            if valid[j] and abs_c_safe[j] <= half_val:
                half_lives.append(j - p)
                break
    if len(half_lives) == 0:
        return np.nan
    return float(np.median(half_lives))


def _vel_decel(cushion, trig):
    if trig < 20:
        return np.nan
    c0 = cushion[trig]
    c10 = cushion[trig - 10]
    c20 = cushion[trig - 20]
    if not (np.isfinite(c0) and np.isfinite(c10) and np.isfinite(c20)):
        return np.nan
    s = np.sign(c0)
    if s == 0:
        return np.nan
    v1 = (c0 - c10) / 10.0 * s
    v2 = (c10 - c20) / 10.0 * s
    return float(v1 - v2)


def _range_ratio(spot, floor, trig):
    s = spot[:trig + 1]
    valid = np.isfinite(s)
    if int(valid.sum()) < 2:
        return np.nan
    rng = np.nanmax(s) - np.nanmin(s)
    f = floor[trig]
    if not np.isfinite(f) or f == 0:
        return np.nan
    return float(rng / f)


def compute(bar, trig, pre):
    spot = bar['spot']
    cushion = bar['cushion']
    floor = bar['floor']
    return {
        'er_60': _efficiency_ratio(spot, trig, 60),
        'er_120': _efficiency_ratio(spot, trig, 120),
        'crossings_sofar': _crossings_sofar(cushion, floor, trig),
        'opp_excursion_ratio': _opp_excursion_ratio(cushion, floor, trig),
        'half_life': _half_life(cushion, floor, trig),
        'vel_decel': _vel_decel(cushion, trig),
        'range_ratio': _range_ratio(spot, floor, trig),
    }


if __name__ == '__main__':
    np.random.seed(42)
    n = 300
    spot = np.cumsum(np.random.randn(n) * 0.1) + 100.0
    floor = np.full(n, 0.5)
    cushion = spot - 100.0
    bar = {'spot': spot, 'cushion': cushion, 'floor': floor}
    trig = 150
    pre = {}
    result = compute(bar, trig, pre)
    assert set(result.keys()) == {name for name, _ in FEATURES}
    print('SELFTEST OK')
