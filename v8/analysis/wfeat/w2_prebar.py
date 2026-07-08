import numpy as np

FEATURES = [
    ('pre_er_300', 'T0'),
    ('pre_er_900', 'T0'),
    ('open_in_range', 'T0'),
    ('range_compress', 'T0'),
    ('pre_vol_60', 'T0'),
    ('prior_crossings', 'T0'),
    ('prior_whipsaw', 'T0'),
    ('prev_poly_var', 'T0'),
    ('pre_imb_flicker', 'T0'),
]

def _kaufman_er(arr):
    valid = arr[~np.isnan(arr)]
    if len(valid) < 2:
        return np.nan
    diffs = np.abs(np.diff(valid))
    sum_diffs = np.sum(diffs)
    if sum_diffs < 1e-9:
        return 0.0
    net = np.abs(valid[-1] - valid[0])
    return float(net / sum_diffs)

def compute(bar, trig, pre):
    spot = pre['spot']

    pre_er_300 = _kaufman_er(spot[-300:])
    pre_er_900 = _kaufman_er(spot[-900:])

    valid_spot = spot[~np.isnan(spot)]
    if len(valid_spot) == 0:
        open_in_range = np.nan
        range_1800 = np.nan
    else:
        last_valid = valid_spot[-1]
        min_spot = np.min(valid_spot)
        max_spot = np.max(valid_spot)
        open_in_range = (last_valid - min_spot) / (max_spot - min_spot + 1e-9)
        range_1800 = max_spot - min_spot

    spot_300 = spot[-300:]
    valid_300 = spot_300[~np.isnan(spot_300)]
    if len(valid_300) == 0 or np.isnan(range_1800):
        range_compress = np.nan
    else:
        range_300 = np.max(valid_300) - np.min(valid_300)
        range_compress = range_300 / (range_1800 + 1e-9)

    spot_60 = spot[-60:]
    valid_60 = spot_60[~np.isnan(spot_60)]
    if len(valid_60) < 2:
        pre_vol_60 = np.nan
    else:
        diffs = np.diff(valid_60)
        pre_vol_60 = np.std(diffs) * np.sqrt(60)

    prior_crossings = float(pre['prior_crossings'])
    prior_whipsaw = float(pre['prior_whipsaw'])
    prev_poly_var = float(pre['prev_poly_var'])

    imb_600 = pre['imb'][-600:]
    valid_imb = imb_600[~np.isnan(imb_600)]
    if len(valid_imb) < 2:
        pre_imb_flicker = np.nan
    else:
        signs = np.sign(valid_imb)
        signs = signs[signs != 0]
        if len(signs) < 2:
            pre_imb_flicker = 0.0
        else:
            changes = np.sum(signs[1:] != signs[:-1])
            pre_imb_flicker = changes / 600.0

    return {
        'pre_er_300': pre_er_300,
        'pre_er_900': pre_er_900,
        'open_in_range': float(open_in_range) if not np.isnan(open_in_range) else np.nan,
        'range_compress': float(range_compress) if not (isinstance(range_compress, float) and np.isnan(range_compress)) else np.nan,
        'pre_vol_60': float(pre_vol_60) if not (isinstance(pre_vol_60, float) and np.isnan(pre_vol_60)) else np.nan,
        'prior_crossings': prior_crossings,
        'prior_whipsaw': prior_whipsaw,
        'prev_poly_var': prev_poly_var,
        'pre_imb_flicker': float(pre_imb_flicker),
    }

if __name__ == '__main__':
    np.random.seed(42)
    spot = np.cumsum(np.random.randn(1800)) + 100.0
    spot[::50] = np.nan
    imb = np.random.randn(1800)
    imb[::30] = np.nan
    pre = {'spot': spot, 'bid_usd': np.random.rand(1800), 'ask_usd': np.random.rand(1800), 'imb': imb,
           'prior_crossings': 3.0, 'prior_whipsaw': 1.0, 'prev_poly_var': 0.05}
    res = compute({}, 10, pre)
    assert len(res) == len(FEATURES)
    print('SELFTEST OK')
