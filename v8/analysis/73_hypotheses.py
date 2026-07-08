#!/usr/bin/env python3
# 73_hypotheses.py — pre-registered hypothesis tests (H1-H12) over fire episodes,
# walk-forward splits (TRAIN = first 2 BQ days, HELDOUT = rest, LIVE = live logs).
import argparse, json
from pathlib import Path

def sign(x):
    if x is None: return None
    if x == 0: return 0
    return 1 if x > 0 else -1

def dir_sign(e):
    return 1 if e['dir'] == 'UP' else -1

def roi_of(e):
    p = e.get('price_side')
    if p is None: return None
    p = max(0.01, min(0.99, p))
    return (1 - p) / p if e['won'] else -1.0

def h1(e):
    if e.get('prev') is None: return None
    return 'A' if e['dir'] != e['prev']['dir'] else 'B'

def h2(e):
    prev = e.get('prev')
    if prev is None: return None
    if e['dir'] == prev['dir']: return None
    end = prev.get('end')
    if end == 'decay': return 'A'
    if end == 'snap': return 'B'
    return None

def h3(e):
    p = e.get('price_side')
    if p is None: return None
    return 'A' if p < 0.50 else 'B'

def h4(e):
    f = e.get('feat')
    if f is None: return None
    return 'A' if sign(f.get('px_vs_vwap')) == dir_sign(e) else 'B'

def h5(e):
    f = e.get('feat')
    if f is None: return None
    v = f.get('whale_against_move_60')
    return 'A' if v is not None and v > 0 else 'B'

def h6(e):
    f = e.get('feat')
    if f is None: return None
    return 'A' if sign(f.get('agg_ratio_60')) == dir_sign(e) and (f.get('agg_persist_60') or 0) >= 0.5 else 'B'

def h7(e):
    f = e.get('feat')
    if f is None or f.get('basis_valid') != 1: return None
    return 'A' if sign(f.get('basis_vel_10')) == dir_sign(e) else 'B'

def h8(e):
    f = e.get('feat')
    if f is None or f.get('book_valid') != 1: return None
    ps = f.get('pull_skew')
    cond = (e['dir'] == 'UP' and ps is not None and ps < 0) or (e['dir'] == 'DOWN' and ps is not None and ps > 0)
    return 'A' if cond else 'B'

def h9(e):
    pf = e.get('p_flip')
    if pf is None: return None
    return 'A' if pf <= 0.5 else 'B'

def h10(e):
    tr = e.get('trigger_rem')
    if tr is None or tr > 180: return None
    return 'A' if tr > 120 else 'B'

def h11(e):
    if e.get('idx') != 1: return None
    te = e.get('trigger_elapsed')
    return 'A' if te is not None and te >= 60 else 'B'

def h12(e):
    f = e.get('feat')
    if f is None: return None
    r2 = f.get('cush_path_r2')
    return 'A' if r2 is not None and r2 >= 0.7 else 'B'

HYPS = [('H1',h1),('H2',h2),('H3',h3),('H4',h4),('H5',h5),('H6',h6),
        ('H7',h7),('H8',h8),('H9',h9),('H10',h10),('H11',h11),('H12',h12)]

def group_stats(es):
    n = len(es)
    if n == 0:
        return {'n': 0, 'acc': None, 'price': None, 'roi': None}
    acc = sum(1 for e in es if e['won']) / n
    priced = [e for e in es if e.get('price_side') is not None]
    if priced:
        price = sum(e['price_side'] for e in priced) / len(priced)
        roi = sum(roi_of(e) for e in priced) / len(priced)
    else:
        price = None
        roi = None
    return {'n': n, 'acc': acc, 'price': price, 'roi': roi}

def split_stats(episodes, hfn):
    A, B = [], []
    for e in episodes:
        g = hfn(e)
        if g == 'A': A.append(e)
        elif g == 'B': B.append(e)
    sA, sB = group_stats(A), group_stats(B)
    lift = None
    if sA['roi'] is not None and sB['roi'] is not None:
        lift = sA['roi'] - sB['roi']
    return {'A': sA, 'B': sB, 'lift': lift}

def fmt(x, p=4):
    if x is None: return 'n/a'
    return f"{x:.{p}f}"

def survival(tr, hd, lv):
    lt, lh, ll = tr['lift'], hd['lift'], lv['lift']
    if lt is None or lh is None:
        return False, 'lift missing'
    if sign(lt) != sign(lh):
        return False, 'sign mismatch train/held'
    if min(hd['A']['n'], hd['B']['n']) < 30:
        return False, f"heldout n<30 ({min(hd['A']['n'],hd['B']['n'])})"
    if ll is None:
        return True, 'live:n/a'
    if sign(ll) != sign(lt):
        return False, 'live sign mismatch'
    return True, 'ok'

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--episodes', required=True)
    ap.add_argument('--K', type=int, required=True)
    ap.add_argument('--out', required=True)
    args = ap.parse_args()

    eps = []
    with open(args.episodes) as fh:
        for line in fh:
            line = line.strip()
            if not line: continue
            e = json.loads(line)
            if e.get('K') != args.K: continue
            eps.append(e)

    bq_days = sorted({e['day'] for e in eps if e.get('src') == 'bq' and e.get('day')})
    train_days = set(bq_days[:2])
    held_days = set(bq_days[2:])

    splits = {
        'TRAIN': [e for e in eps if e.get('src') == 'bq' and e['day'] in train_days],
        'HELDOUT': [e for e in eps if e.get('src') == 'bq' and e['day'] in held_days],
        'LIVE': [e for e in eps if e.get('src') == 'live'],
    }
    print(f"K={args.K} | TRAIN days {sorted(train_days)} n={len(splits['TRAIN'])} | HELDOUT days {sorted(held_days)} n={len(splits['HELDOUT'])} | LIVE n={len(splits['LIVE'])}\n")

    out = {}
    summary = []
    for hid, hfn in HYPS:
        res = {sp: split_stats(eps_sp, hfn) for sp, eps_sp in splits.items()}
        surv, reason = survival(res['TRAIN'], res['HELDOUT'], res['LIVE'])
        verdict = 'SURVIVES' if surv else 'FAILS'
        out[hid] = {
            'splits': {sp: {'A': res[sp]['A'], 'B': res[sp]['B'], 'lift': res[sp]['lift']} for sp in splits},
            'verdict': verdict, 'reason': reason,
            'lift_train': res['TRAIN']['lift'], 'lift_heldout': res['HELDOUT']['lift'], 'lift_live': res['LIVE']['lift'],
        }
        for sp in ['TRAIN', 'HELDOUT', 'LIVE']:
            sA, sB, lift = res[sp]['A'], res[sp]['B'], res[sp]['lift']
            print(f"{hid} {sp:7s} n_A={sA['n']:4d} n_B={sB['n']:4d} "
                  f"acc_A={fmt(sA['acc'])} acc_B={fmt(sB['acc'])} "
                  f"price_A={fmt(sA['price'])} price_B={fmt(sB['price'])} "
                  f"roi_A={fmt(sA['roi'])} roi_B={fmt(sB['roi'])} lift={fmt(lift)}")
        print(f"{hid} verdict: {verdict} ({reason})")
        print()
        summary.append((hid, verdict, res['TRAIN']['lift'], res['HELDOUT']['lift'], res['LIVE']['lift']))

    print("SUMMARY")
    print(f"{'H#':4s} {'verdict':10s} {'lift_train':>12s} {'lift_heldout':>14s} {'lift_live':>12s}")
    for hid, verdict, lt, lh, ll in summary:
        print(f"{hid:4s} {verdict:10s} {fmt(lt):>12s} {fmt(lh):>14s} {fmt(ll):>12s}")

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, 'w') as fh:
        json.dump(out, fh, indent=2)

if __name__ == '__main__':
    main()
