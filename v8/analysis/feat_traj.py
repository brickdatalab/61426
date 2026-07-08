import numpy as np
import json
import os
import sys
import argparse
import datetime

EPS = 1.0
ELAPSED_LIST = list(range(5, 300, 5))  # 59 ticks

FEATURES_TRAJ = [
    "mid_vel_10", "mid_vel_30", "mid_accel", "pimb_vel_10", "mid_cush_gap", "poly_valid",
    "px_vs_vwap", "vwap_conf", "hollow",
    "cush_vel_10", "cush_vel_30", "cush_vel_60", "cush_accel", "cvd_slope_60",
    "absorb_60", "imb_whipsaw_60", "cush_path_r2", "range_pos", "cush_norm",
]


def _prepare_bar(bar):
    sec = bar['sec']
    epochs = sorted(int(k) for k in sec.keys())
    base = epochs[0]
    N = 300

    spot = np.full(N, np.nan)
    up_mid = np.full(N, np.nan)
    pimb = np.full(N, np.nan)
    buy_usd = np.full(N, np.nan)
    sell_usd = np.full(N, np.nan)
    buy_base = np.full(N, np.nan)
    sell_base = np.full(N, np.nan)
    imb_arr = np.full(N, np.nan)

    for ep in epochs:
        s = ep - base
        if s < 0 or s >= N:
            continue
        d = sec[str(ep)]
        for key, arr in [('spot_close', spot), ('up_mid', up_mid), ('poly_imb', pimb),
                         ('buy_usd', buy_usd), ('sell_usd', sell_usd),
                         ('buy_base', buy_base), ('sell_base', sell_base),
                         ('imb', imb_arr)]:
            v = d.get(key)
            if v is not None:
                arr[s] = float(v)

    valid_idx = np.where(~np.isnan(spot))[0]
    bar_open = float(spot[valid_idx[0]]) if len(valid_idx) > 0 else 100.0

    cushion = spot - bar_open

    vol_1m = np.full(N, 10.0)
    for t in range(N):
        lo = max(0, t - 60)
        seg = spot[lo:t + 1]
        valid = seg[~np.isnan(seg)]
        if len(valid) < 11:
            vol_1m[t] = 10.0
        else:
            diffs = np.diff(valid)
            if len(diffs) < 10:
                vol_1m[t] = 10.0
            else:
                vol_1m[t] = float(np.std(diffs)) * np.sqrt(60.0)

    floor_arr = np.maximum(10.0, 0.5 * vol_1m)

    spot_0 = np.nan_to_num(spot, nan=0.0)
    cushion_0 = np.nan_to_num(cushion, nan=0.0)
    up_mid_0 = np.nan_to_num(up_mid, nan=0.0)
    pimb_0 = np.nan_to_num(pimb, nan=0.0)
    buy_usd_0 = np.nan_to_num(buy_usd, nan=0.0)
    sell_usd_0 = np.nan_to_num(sell_usd, nan=0.0)
    buy_base_0 = np.nan_to_num(buy_base, nan=0.0)
    sell_base_0 = np.nan_to_num(sell_base, nan=0.0)

    cum_buy_usd = np.cumsum(buy_usd_0)
    cum_sell_usd = np.cumsum(sell_usd_0)
    cum_buy_base = np.cumsum(buy_base_0)
    cum_sell_base = np.cumsum(sell_base_0)
    cum_cvd = np.cumsum(buy_usd_0 - sell_usd_0)
    cum_vol_usd = cum_buy_usd + cum_sell_usd
    cum_vol_base = cum_buy_base + cum_sell_base
    vwap = cum_vol_usd / (cum_vol_base + 1e-9)

    return {
        'base': base, 'N': N, 'spot': spot, 'up_mid': up_mid, 'pimb': pimb,
        'imb_arr': imb_arr, 'bar_open': bar_open, 'cushion': cushion,
        'vol_1m': vol_1m, 'floor_arr': floor_arr,
        'spot_0': spot_0, 'cushion_0': cushion_0, 'up_mid_0': up_mid_0, 'pimb_0': pimb_0,
        'buy_usd_0': buy_usd_0, 'sell_usd_0': sell_usd_0,
        'buy_base_0': buy_base_0, 'sell_base_0': sell_base_0,
        'cum_cvd': cum_cvd, 'vwap': vwap,
    }


def compute_traj(bar):
    p = _prepare_bar(bar)
    N = p['N']
    spot = p['spot']
    cushion = p['cushion']
    cushion_0 = p['cushion_0']
    up_mid_0 = p['up_mid_0']
    pimb_0 = p['pimb_0']
    up_mid = p['up_mid']
    floor_arr = p['floor_arr']
    cum_cvd = p['cum_cvd']
    vwap = p['vwap']
    imb_arr = p['imb_arr']
    buy_usd_0 = p['buy_usd_0']
    sell_usd_0 = p['sell_usd_0']
    bar_open = p['bar_open']

    n_ticks = 59
    n_feat = len(FEATURES_TRAJ)
    out = np.zeros((n_ticks, n_feat), dtype=np.float32)

    for ti, t in enumerate(ELAPSED_LIST):
        fl = floor_arr[t]

        # ---- POLY ----
        um_t = up_mid_0[t]
        um_t10 = up_mid_0[t - 10] if t - 10 >= 0 else 0.0
        um_t30 = up_mid_0[t - 30] if t - 30 >= 0 else 0.0

        mid_vel_10 = um_t - um_t10
        mid_vel_30 = um_t - um_t30
        mid_accel = mid_vel_10 - (mid_vel_30 / 3.0)

        pi_t = pimb_0[t]
        pi_t10 = pimb_0[t - 10] if t - 10 >= 0 else 0.0
        pimb_vel_10 = pi_t - pi_t10

        cush_t = cushion_0[t]
        mid_cush_gap = (um_t - 0.5) - np.tanh(cush_t / (2.0 * fl))

        poly_valid = 1.0 if not np.isnan(up_mid[t]) else 0.0

        # ---- VWAP ----
        vwap_t = vwap[t]
        spot_t = float(spot[t]) if not np.isnan(spot[t]) else bar_open
        px_vs_vwap = (spot_t - vwap_t) / fl
        vwap_conf = float(np.sign(px_vs_vwap) * np.sign(cush_t))
        hollow = (abs(cush_t) - abs(spot_t - vwap_t)) / fl

        # ---- TRAJECTORY ----
        cush_t10 = cushion_0[t - 10] if t - 10 >= 0 else 0.0
        cush_t30 = cushion_0[t - 30] if t - 30 >= 0 else 0.0
        cush_t60 = cushion_0[t - 60] if t - 60 >= 0 else 0.0

        cush_vel_10 = (cush_t - cush_t10) / fl
        cush_vel_30 = (cush_t - cush_t30) / fl
        cush_vel_60 = (cush_t - cush_t60) / fl
        cush_accel = cush_vel_10 - cush_vel_60

        cvd_now = cum_cvd[t]
        cvd_60 = cum_cvd[t - 60] if t - 60 >= 0 else 0.0
        cvd_slope_60 = (cvd_now - cvd_60) / (fl * 100.0)

        spot_t60 = float(spot[t - 60]) if (t - 60 >= 0 and not np.isnan(spot[t - 60])) else spot_t
        lo60 = max(0, t - 60)
        vol_60 = float(np.sum(buy_usd_0[lo60:t + 1] + sell_usd_0[lo60:t + 1]))
        absorb_60 = abs(spot_t - spot_t60) / fl - abs(cvd_now - cvd_60) / (vol_60 + EPS)

        # imb whipsaw
        lo = max(0, t - 60)
        imb_seg = imb_arr[lo:t + 1]
        valid_imb = imb_seg[~np.isnan(imb_seg)]
        if len(valid_imb) < 2:
            imb_whipsaw = 0.0
        else:
            signs = np.sign(valid_imb)
            sign_changes = 0
            prev_s = None
            for sv in signs:
                if sv == 0:
                    continue
                if prev_s is not None and sv != prev_s:
                    sign_changes += 1
                prev_s = sv
            imb_whipsaw = sign_changes / 60.0

        # cush_path_r2
        cush_so_far = cushion[0:t + 1]
        valid_mask = ~np.isnan(cush_so_far)
        n_valid = int(valid_mask.sum())
        if n_valid < 20:
            cush_path_r2 = 0.0
        else:
            xs = np.arange(t + 1)[valid_mask].astype(np.float64)
            ys = cush_so_far[valid_mask].astype(np.float64)
            n = len(xs)
            sx = float(xs.sum())
            sy = float(ys.sum())
            sxx = float((xs * xs).sum())
            sxy = float((xs * ys).sum())
            denom = n * sxx - sx * sx
            if abs(denom) < 1e-12:
                cush_path_r2 = 0.0
            else:
                slope = (n * sxy - sx * sy) / denom
                intercept = (sy - slope * sx) / n
                y_pred = slope * xs + intercept
                ss_res = float(((ys - y_pred) ** 2).sum())
                ss_tot = float(((ys - ys.mean()) ** 2).sum())
                if ss_tot < 1e-12:
                    cush_path_r2 = 0.0
                else:
                    r2 = 1.0 - ss_res / ss_tot
                    cush_path_r2 = max(0.0, min(1.0, r2))

        # range_pos
        spot_so_far = spot[0:t + 1]
        valid_spot_sf = spot_so_far[~np.isnan(spot_so_far)]
        if len(valid_spot_sf) == 0:
            range_pos = 0.0
        else:
            mn = float(valid_spot_sf.min())
            mx = float(valid_spot_sf.max())
            range_pos = (spot_t - mn) / (mx - mn + 1e-9)

        cush_norm = cush_t / fl
        cush_norm = max(-10.0, min(10.0, cush_norm))

        vals = np.array([
            mid_vel_10, mid_vel_30, mid_accel, pimb_vel_10, mid_cush_gap, poly_valid,
            px_vs_vwap, vwap_conf, hollow,
            cush_vel_10, cush_vel_30, cush_vel_60, cush_accel, cvd_slope_60,
            absorb_60, imb_whipsaw, cush_path_r2, range_pos, cush_norm,
        ], dtype=np.float64)
        vals = np.clip(vals, -50.0, 50.0)
        out[ti] = vals.astype(np.float32)

    return out


# ---------------------------------------------------------------------------
# Synthetic self-test
# ---------------------------------------------------------------------------

def _build_synthetic_bar():
    base = 1700000000
    sec = {}
    for s in range(300):
        ep = base + s
        sec[str(ep)] = {
            'spot_close': 100.0 + 0.1 * s,
            'perp_close': 100.0 + 0.1 * s,
            'buy_usd': 100.0,
            'sell_usd': 100.0,
            'buy_base': 1.0,
            'sell_base': 1.0,
            'p_buy_usd': None,
            'p_sell_usd': None,
            'lg_buy': None,
            'lg_sell': None,
            'imb': None,
            'up_mid': 0.5 + 0.2 * s / 299.0,
            'poly_imb': None,
            'bid_usd': None,
            'ask_usd': None,
        }
    return {
        'slug': 'SYNTH-1700000000',
        'settle': 'UP',
        'open': 100.0,
        'close': 130.0,
        'abs_move': 30.0,
        'sec': sec,
    }


def run_selftest():
    bar = _build_synthetic_bar()
    X = compute_traj(bar)
    ti_295 = ELAPSED_LIST.index(295)
    ti_100 = ELAPSED_LIST.index(100)
    # cush_path_r2 is index 16
    assert X[ti_295, 16] > 0.99, f"cush_path_r2={X[ti_295, 16]}"
    # vwap_conf is index 7
    assert X[ti_100, 7] in (-1.0, 0.0, 1.0), f"vwap_conf={X[ti_100, 7]}"
    # mid_vel_30 is index 1
    assert X[ti_100, 1] > 0, f"mid_vel_30={X[ti_100, 1]}"
    print("SELFTEST OK")


# ---------------------------------------------------------------------------
# Assembler
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--bars')
    parser.add_argument('--micro')
    parser.add_argument('--out')
    parser.add_argument('--selftest', action='store_true')
    args = parser.parse_args()

    if args.selftest:
        run_selftest()
        return

    sys.path.insert(0, args.micro)
    import feat_micro

    bars_dir = args.bars.rstrip('/')
    index_path = os.path.join(os.path.dirname(bars_dir), 'bars_index.json')
    with open(index_path) as f:
        index = json.load(f)
    if isinstance(index, list):
        slugs = [item['slug'] for item in index]
    elif isinstance(index, dict):
        slugs = index.get('slugs', list(index.keys()))
    else:
        slugs = []

    X_parts = []
    y_parts = []
    meta_rem_parts = []
    meta_poly_mid_parts = []
    meta_cushion_parts = []
    meta_vol1m_parts = []
    meta_absmove_parts = []
    meta_day_parts = []
    meta_slug_idx_parts = []
    meta_poly_valid_parts = []

    total_ticks = 0
    poly_valid_zero = 0
    basis_valid_zero = 0
    book_valid_zero = 0

    for si, slug in enumerate(slugs):
        bar_path = os.path.join(args.bars, f'{slug}.json')
        with open(bar_path) as f:
            bar = json.load(f)

        X_micro = feat_micro.compute_micro(bar)
        X_traj = compute_traj(bar)
        X = np.hstack([X_micro, X_traj])

        # validity tracking
        poly_valid_col = X_traj[:, FEATURES_TRAJ.index('poly_valid')]
        poly_valid_zero += int(np.sum(poly_valid_col == 0))
        basis_col = X_micro[:, feat_micro.FEATURES_MICRO.index('basis_valid')]
        basis_valid_zero += int(np.sum(basis_col == 0))
        book_col = X_micro[:, feat_micro.FEATURES_MICRO.index('book_valid')]
        book_valid_zero += int(np.sum(book_col == 0))

        # meta extraction
        p = _prepare_bar(bar)
        base = p['base']
        day_utc = int(datetime.datetime.fromtimestamp(
            base, tz=datetime.timezone.utc).strftime('%Y%m%d'))
        abs_move = float(bar.get('abs_move', 0.0))
        settle = bar.get('settle', 'DOWN')
        y_val = 1 if settle == 'UP' else 0

        spot = p['spot']
        up_mid = p['up_mid']
        cushion = p['cushion']
        vol_1m = p['vol_1m']

        for ti, t in enumerate(ELAPSED_LIST):
            rem = 300 - t
            um = up_mid[t]
            poly_mid = float(um) if not np.isnan(um) else 0.5
            meta_poly_valid_parts.append(0 if np.isnan(um) else 1)
            cush_raw = float(cushion[t]) if not np.isnan(cushion[t]) else 0.0
            v1m = float(vol_1m[t])

            meta_rem_parts.append(rem)
            meta_poly_mid_parts.append(poly_mid)
            meta_cushion_parts.append(cush_raw)
            meta_vol1m_parts.append(v1m)
            meta_absmove_parts.append(abs_move)
            meta_day_parts.append(day_utc)
            meta_slug_idx_parts.append(si)
            y_parts.append(y_val)

        X_parts.append(X)
        total_ticks += 59

    X_all = np.vstack(X_parts).astype(np.float32)
    y_all = np.array(y_parts, dtype=np.int8)
    meta_rem = np.array(meta_rem_parts, dtype=np.int32)
    meta_poly_mid = np.array(meta_poly_mid_parts, dtype=np.float32)
    meta_cushion = np.array(meta_cushion_parts, dtype=np.float32)
    meta_vol1m = np.array(meta_vol1m_parts, dtype=np.float32)
    meta_absmove = np.array(meta_absmove_parts, dtype=np.float32)
    meta_day = np.array(meta_day_parts, dtype=np.int32)
    meta_slug_idx = np.array(meta_slug_idx_parts, dtype=np.int32)
    meta_poly_valid = np.array(meta_poly_valid_parts, dtype=np.int8)

    os.makedirs(args.out, exist_ok=True)
    np.savez(
        os.path.join(args.out, 'matrix.npz'),
        X=X_all, y=y_all,
        meta_rem=meta_rem, meta_poly_mid=meta_poly_mid,
        meta_cushion=meta_cushion, meta_vol1m=meta_vol1m,
        meta_absmove=meta_absmove, meta_day=meta_day,
        meta_slug_idx=meta_slug_idx, meta_poly_valid=meta_poly_valid,
    )

    features_micro = list(getattr(feat_micro, 'FEATURES_MICRO', []))
    manifest = {
        'features': features_micro + list(FEATURES_TRAJ),
        'slugs': list(slugs),
    }
    with open(os.path.join(args.out, 'features_manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=2)

    print(f"n_ticks: {total_ticks}")
    print(f"n_features: {X_all.shape[1]}")
    print(f"poly_valid_zero_rate: {poly_valid_zero / total_ticks:.4f}")
    print(f"basis_valid_zero_rate: {basis_valid_zero / total_ticks:.4f}")
    print(f"book_valid_zero_rate: {book_valid_zero / total_ticks:.4f}")


if __name__ == '__main__':
    main()
