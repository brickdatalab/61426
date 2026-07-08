#!/usr/bin/env python3
"""80_whipsaw_labels.py — bar-level whipsaw labels + the persistence check.

Label definition (locked):
  whipsaw  := the bar produced K=5 fires in BOTH directions (identical to the
              'mixed bar' loss pool measured in the fire-episode study §3)
  one-sided:= >=1 fire, single direction
  no-fire  := zero K=5 fires
Also per bar: n_fires, crossings (floor-crossing count of the signed beyond-floor
state), fire_pnl (flat-$1 at real prices, from episodes.jsonl).

Persistence check: P(whipsaw_t | whipsaw_{t-1}) over consecutive slugs (epoch+300)
vs the base rate — the single number that decides whether chop autocorrelation
is a real, harvestable signal.

Also builds data/continuous.npz: epoch-indexed continuous arrays (spot, bid_usd,
ask_usd, imb) across the whole BQ span for T0 (pre-open) features.

Usage: 80_whipsaw_labels.py [--data v8/analysis/data] [--raw v6/analysis/bqbars/raw]
Outputs: data/whipsaw_labels.json, data/continuous.npz, printed persistence table.
"""
import argparse, json, glob, os
from datetime import datetime, timezone
import numpy as np


def floor_of(v):
    return np.maximum(10.0, 0.5 * v)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default='v8/analysis/data')
    ap.add_argument('--raw', default='v6/analysis/bqbars/raw')
    args = ap.parse_args()

    # ---- fires per bar from episodes.jsonl (K=5, bq only) ----
    fires = {}
    for line in open(os.path.join(args.data, 'episodes.jsonl')):
        e = json.loads(line)
        if e['K'] != 5 or e['src'] != 'bq':
            continue
        fires.setdefault(e['slug'], []).append(e)

    # ---- per-bar label ----
    import sys
    sys.path.insert(0, 'v8/analysis')
    import feat_traj
    labels = {}
    for bp in sorted(glob.glob(os.path.join(args.data, 'bars', '*.json'))):
        bar = json.load(open(bp))
        slug = bar['slug']
        p = feat_traj._prepare_bar(bar)
        cush, vol = p['cushion'], p['vol_1m']
        fl = floor_of(vol)
        state = np.where(np.isnan(cush), 0, np.where(np.abs(cush) >= fl, np.sign(cush), 0)).astype(int)
        crossings = 0
        last = 0
        for s in state:
            if s != 0:
                if last != 0 and s != last:
                    crossings += 1
                last = s
        eps = fires.get(slug, [])
        dirs = {e['dir'] for e in eps}
        if len(dirs) == 2:
            grade = 'whipsaw'
        elif len(dirs) == 1:
            grade = 'one-sided'
        else:
            grade = 'no-fire'
        pnl = 0.0
        for e in eps:
            ps = e.get('price_side')
            if ps is None:
                continue
            ps = max(0.01, min(0.99, ps))
            pnl += (1 - ps) / ps if e['won'] else -1.0
        epoch = int(slug.rsplit('-', 1)[1])
        labels[slug] = {'epoch': epoch, 'day': datetime.fromtimestamp(epoch, tz=timezone.utc).strftime('%Y-%m-%d'),
                        'grade': grade, 'crossings': crossings, 'n_fires': len(eps), 'fire_pnl': round(pnl, 4)}

    # ---- persistence ----
    by_epoch = {v['epoch']: v for v in labels.values()}
    pairs = [(by_epoch[ep], by_epoch[ep + 300]) for ep in by_epoch if ep + 300 in by_epoch]
    n = len(pairs)
    base = sum(1 for v in labels.values() if v['grade'] == 'whipsaw') / len(labels)
    pw_w = [b for a, b in pairs if a['grade'] == 'whipsaw']
    pw_given_w = (sum(1 for b in pw_w if b['grade'] == 'whipsaw') / len(pw_w)) if pw_w else float('nan')
    pnw = [b for a, b in pairs if a['grade'] != 'whipsaw']
    pw_given_nw = (sum(1 for b in pnw if b['grade'] == 'whipsaw') / len(pnw)) if pnw else float('nan')
    # crossings autocorrelation
    xa = np.array([a['crossings'] for a, b in pairs], dtype=float)
    xb = np.array([b['crossings'] for a, b in pairs], dtype=float)
    r = float(np.corrcoef(xa, xb)[0, 1]) if n > 2 else float('nan')

    print(f"bars labeled: {len(labels)} | grades: "
          f"whipsaw {sum(1 for v in labels.values() if v['grade']=='whipsaw')}, "
          f"one-sided {sum(1 for v in labels.values() if v['grade']=='one-sided')}, "
          f"no-fire {sum(1 for v in labels.values() if v['grade']=='no-fire')}")
    print(f"whipsaw base rate:            {base*100:.1f}%")
    print(f"P(whipsaw | prev whipsaw):    {pw_given_w*100:.1f}%   (n={len(pw_w)} consecutive pairs)")
    print(f"P(whipsaw | prev NOT whipsaw):{pw_given_nw*100:.1f}%   (n={len(pnw)})")
    print(f"crossings autocorr (lag-1):   r={r:.3f}  (n={n})")
    wl = [v['fire_pnl'] for v in labels.values() if v['grade'] == 'whipsaw']
    os_ = [v['fire_pnl'] for v in labels.values() if v['grade'] == 'one-sided']
    print(f"fire P&L: whipsaw bars total {sum(wl):+.1f} | one-sided total {sum(os_):+.1f}")

    json.dump(labels, open(os.path.join(args.data, 'whipsaw_labels.json'), 'w'))

    # ---- continuous arrays for T0 features ----
    print('building continuous arrays...')
    def parse_ts(ts):
        return int(datetime.strptime(ts, '%Y-%m-%d %H:%M:%S').replace(tzinfo=timezone.utc).timestamp())
    trades = json.load(open(os.path.join(args.raw, 'trades_1s.json')))
    book = json.load(open(os.path.join(args.raw, 'book_imb_1s.json')))
    epochs = [parse_ts(r['ts_second']) for r in trades if r.get('venue') == 'spot']
    e0, e1 = min(epochs), max(epochs)
    N = e1 - e0 + 1
    spot = np.full(N, np.nan); bid = np.full(N, np.nan); ask = np.full(N, np.nan); imb = np.full(N, np.nan)
    for r in trades:
        if r.get('venue') != 'spot':
            continue
        i = parse_ts(r['ts_second']) - e0
        if r.get('close') is not None:
            spot[i] = float(r['close'])
    for r in book:
        i = parse_ts(r['ts_second']) - e0
        if 0 <= i < N:
            if r.get('imb') is not None: imb[i] = float(r['imb'])
            if r.get('bid_usd') is not None: bid[i] = float(r['bid_usd'])
            if r.get('ask_usd') is not None: ask[i] = float(r['ask_usd'])
    np.savez(os.path.join(args.data, 'continuous.npz'), e0=np.int64(e0), spot=spot, bid_usd=bid, ask_usd=ask, imb=imb)
    print(f"continuous.npz: {N} seconds from {datetime.fromtimestamp(e0, tz=timezone.utc)} (spot valid {np.isfinite(spot).mean()*100:.1f}%)")


if __name__ == '__main__':
    main()
