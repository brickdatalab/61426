#!/usr/bin/env python3
"""v8 value-scoring constitution + the four anti-echo baselines.

The scoring rule (locked by plan):
- per-tick target = settle direction
- a CORRECT directional tick earns u*e, where
    u = unpricedness = max(0, 1 - 2*|poly_mid - 0.5|)  (0 if poly invalid that tick)
    e = earliness    = rem/300
- a WRONG directional tick costs -lam (default 1.0)
- MIXED during a fire-worthy lead costs -mu (default 0.25); otherwise 0
  fire-worthy = the cushion lead is on the settle side AND |cushion| >= floor
- floor(vol_1m) = max(10, 0.5*vol_1m)

Baselines (each emits UP/DOWN/MIXED per tick):
  a) sign(cushion) if |cushion| >= floor else MIXED
  b) the REAL v6 lean stream (replayed by 21_replay_engine_fields.mjs)
  c) sign(poly_mid-0.5) if poly valid and |poly_mid-0.5| >= 0.02 else MIXED
  d) sign(px_vs_vwap) if |px_vs_vwap| >= 1.0 (i.e. |price-vwap| >= floor) else MIXED

Usage: 30_scoring.py --data v8/analysis/data [--engine v8/analysis/data/engine]
"""
import argparse, json, os
import numpy as np


def floor_vol(vol_1m):
    v = 0.0 if vol_1m is None else float(vol_1m)
    return max(10.0, 0.5 * v)


def tick_value(call, settle, poly_mid, rem, cushion, vol_1m, lam=1.0, mu=0.25, poly_ok=True):
    u = max(0.0, 1.0 - 2.0 * abs((0.5 if poly_mid is None else poly_mid) - 0.5)) if poly_ok else 0.0
    e = rem / 300.0
    lead = 'UP' if cushion > 0 else ('DOWN' if cushion < 0 else None)
    fire_worthy = (lead == settle) and abs(cushion) >= floor_vol(vol_1m)
    if call == 'MIXED':
        return -mu if fire_worthy else 0.0
    return u * e if call == settle else -lam


# ---------- vectorized scoring over the matrix ----------

def score_calls(calls, y, poly_mid, poly_valid, rem, cushion, vol1m, lam=1.0, mu=0.25):
    """calls: int8 array (1=UP, -1=DOWN, 0=MIXED). Returns metrics dict."""
    settle = np.where(y == 1, 1, -1).astype(np.int8)
    fl = np.maximum(10.0, 0.5 * vol1m)
    lead = np.sign(cushion).astype(np.int8)
    fire_worthy = (lead == settle) & (np.abs(cushion) >= fl)
    u = np.where(poly_valid > 0, np.maximum(0.0, 1.0 - 2.0 * np.abs(poly_mid - 0.5)), 0.0)
    e = rem / 300.0
    val = np.zeros(len(calls), dtype=np.float64)
    directional = calls != 0
    correct = directional & (calls == settle)
    wrong = directional & (calls != settle)
    mixed = ~directional
    val[correct] = (u * e)[correct]
    val[wrong] = -lam
    val[mixed & fire_worthy] = -mu
    return {
        'value': float(val.sum()),
        'n': int(len(calls)),
        'coverage': float(directional.mean()),
        'accuracy': float(correct.sum() / max(1, directional.sum())),
        'wrong_rate': float(wrong.mean()),
        'missed_rate': float((mixed & fire_worthy).mean()),
        'val_arr': val,
        'correct_arr': correct, 'wrong_arr': wrong, 'directional_arr': directional,
    }


def band_table(name, calls, M, lam=1.0, mu=0.25):
    bands = [(300, 240), (240, 180), (180, 120), (120, 60), (60, 0)]
    lines = [f"--- {name} ---"]
    tot = score_calls(calls, M['y'], M['poly_mid'], M['poly_valid'], M['rem'], M['cushion'], M['vol1m'], lam, mu)
    n_bars = len(np.unique(M['slug_idx']))
    lines.append(f"ALL     value={tot['value']:9.1f} val/bar={tot['value']/n_bars:7.3f} acc={tot['accuracy']*100:5.1f}% cov={tot['coverage']*100:5.1f}% wrong={tot['wrong_rate']*100:4.1f}% missed={tot['missed_rate']*100:4.1f}%")
    for hi, lo in bands:
        m = (M['rem'] <= hi) & (M['rem'] > lo)
        if m.sum() == 0: continue
        r = score_calls(calls[m], M['y'][m], M['poly_mid'][m], M['poly_valid'][m], M['rem'][m], M['cushion'][m], M['vol1m'][m], lam, mu)
        lines.append(f"rem{hi:3d}-{lo:3d} value={r['value']:9.1f} acc={r['accuracy']*100:5.1f}% cov={r['coverage']*100:5.1f}% wrong={r['wrong_rate']*100:4.1f}% missed={r['missed_rate']*100:4.1f}%")
    return tot, '\n'.join(lines)


def load_all(data_dir, engine_dir):
    z = np.load(os.path.join(data_dir, 'matrix.npz'))
    manifest = json.load(open(os.path.join(data_dir, 'features_manifest.json')))
    feats = manifest['features']; slugs = manifest['slugs']
    M = {
        'X': z['X'], 'y': z['y'].astype(np.int8), 'rem': z['meta_rem'].astype(np.float64),
        'poly_mid': z['meta_poly_mid'].astype(np.float64), 'cushion': z['meta_cushion'].astype(np.float64),
        'vol1m': z['meta_vol1m'].astype(np.float64), 'absmove': z['meta_absmove'].astype(np.float64),
        'day': z['meta_day'], 'slug_idx': z['meta_slug_idx'], 'poly_valid': z['meta_poly_valid'].astype(np.int8),
        'features': feats, 'slugs': slugs,
    }
    # v6 stream aligned to ticks
    v6 = np.zeros(len(M['y']), dtype=np.int8)
    sig_map = {'UP': 1, 'DOWN': -1, 'MIXED': 0}
    eng_cache = {}
    for i in range(len(M['y'])):
        si = M['slug_idx'][i]; slug = slugs[si]
        if slug not in eng_cache:
            p = os.path.join(engine_dir, f'{slug}.json')
            eng_cache[slug] = json.load(open(p))['sig_at_rem'] if os.path.exists(p) else None
        sam = eng_cache[slug]
        if sam is not None:
            v6[i] = sig_map.get(sam.get(str(int(M['rem'][i])), 'MIXED'), 0)
    M['v6_calls'] = v6
    return M


def baselines(M):
    fl = np.maximum(10.0, 0.5 * M['vol1m'])
    a = np.where(np.abs(M['cushion']) >= fl, np.sign(M['cushion']), 0).astype(np.int8)
    c = np.where((M['poly_valid'] > 0) & (np.abs(M['poly_mid'] - 0.5) >= 0.02),
                 np.sign(M['poly_mid'] - 0.5), 0).astype(np.int8)
    pxv = M['X'][:, M['features'].index('px_vs_vwap')].astype(np.float64)
    d = np.where(np.abs(pxv) >= 1.0, np.sign(pxv), 0).astype(np.int8)
    return {'a_cushion_floor': a, 'b_v6_stream': M['v6_calls'], 'c_poly_sign': c, 'd_vwap_anchor': d}


def pain_scan(data_dir, engine_dir, slugs):
    """Bars with a tick where cushion <= -150-ish (scaled: <= -8x floor) or raw <= -150
    AND heavy one-sided CVD AND v6 said MIXED at that tick."""
    hits = []
    for slug in slugs:
        ep = os.path.join(engine_dir, f'{slug}.json')
        bp = os.path.join(data_dir, 'bars', f'{slug}.json')
        if not (os.path.exists(ep) and os.path.exists(bp)): continue
        sam = json.load(open(ep))['sig_at_rem']
        bar = json.load(open(bp))
        base = int(slug.rsplit('-', 1)[-1])
        cum_cvd = 0.0; open_px = None
        sec = bar['sec']
        for k in range(300):
            s = sec[str(base + k)]
            if open_px is None and s['spot_close'] is not None: open_px = s['spot_close']
            cum_cvd += (s['buy_usd'] or 0) - (s['sell_usd'] or 0)
            if k % 5 or k == 0: continue
            rem = 300 - k
            if str(rem) not in sam: continue
            if s['spot_close'] is None or open_px is None: continue
            cush = s['spot_close'] - open_px
            if abs(cush) >= 150 and abs(cum_cvd) >= 1e6 and np.sign(cush) == np.sign(cum_cvd) and sam[str(rem)] == 'MIXED':
                hits.append((slug, rem, round(cush, 1), int(cum_cvd), bar['settle']))
                break
    return hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default='v8/analysis/data')
    ap.add_argument('--engine', default='v8/analysis/data/engine')
    args = ap.parse_args()
    M = load_all(args.data, args.engine)
    n_bars = len(np.unique(M['slug_idx']))
    print(f"ticks={len(M['y'])} bars={n_bars} features={len(M['features'])}")

    results = {}
    for name, calls in baselines(M).items():
        tot, table = band_table(name, calls, M)
        print(table)
        results[name] = {k: v for k, v in tot.items() if not k.endswith('_arr')}

    print('\n--- sensitivity (ALL-tick value per bar) ---')
    for lam in (0.5, 1.0, 2.0):
        row = []
        for mu in (0.1, 0.25, 0.5):
            vals = {}
            for name, calls in baselines(M).items():
                r = score_calls(calls, M['y'], M['poly_mid'], M['poly_valid'], M['rem'], M['cushion'], M['vol1m'], lam, mu)
                vals[name] = r['value'] / n_bars
            row.append(f"lam={lam} mu={mu}: " + ' '.join(f"{k}={v:.3f}" for k, v in vals.items()))
        print('\n'.join(row))

    print('\n--- pain-case scan (|cushion|>=150, |cvd|>=1M, same side, v6 MIXED) ---')
    hits = pain_scan(args.data, args.engine, M['slugs'])
    for h in hits[:20]: print('  ', h)
    print(f"  total pain-case bars: {len(hits)}")

    json.dump({'baselines': results, 'pain_cases': [list(h) for h in hits]},
              open(os.path.join(args.data, 'baselines.json'), 'w'), indent=1)
    print('\nwrote', os.path.join(args.data, 'baselines.json'))


if __name__ == '__main__':
    main()
