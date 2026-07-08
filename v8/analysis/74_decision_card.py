#!/usr/bin/env python3
"""74_decision_card.py — the betting decision card (Claude-authored; selection
constitution, not GLM's). Enumerates a PRE-DECLARED grid of conjunctive rules
built ONLY from surviving/pre-registered conditions, selects on TRAIN, verdicts
on HELDOUT (ROI with normal-approx 90% CI) and LIVE. Also fits reference
logistic + depth-2 tree to check whether any materially better cut exists.

Rule grammar (fixed, declared before selection):
  type      in {any, reversal, first}
  h9        in {any, p_flip<=0.5}
  h6        in {any, aggression-aligned}
  h8        in {any, book-pull-aligned}
  band      in {any, elapsed<120, elapsed in [120,240), elapsed>=240}
Selection: TRAIN ROI/bet, require n_train >= 60. Top 5 by TRAIN ROI advance.
Ship bar: HELDOUT 90% CI for ROI/bet must clear 0 AND LIVE ROI/bet > 0.
"""
import argparse, json, math, itertools
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.tree import DecisionTreeClassifier, export_text
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline


def load(path, K):
    eps = []
    with open(path) as f:
        for line in f:
            if not line.strip(): continue
            e = json.loads(line)
            if e.get('K') == K: eps.append(e)
    return eps


def roi_of(e):
    p = e.get('price_side')
    if p is None: return None
    p = max(0.01, min(0.99, p))
    return (1 - p) / p if e['won'] else -1.0


def dsign(e): return 1 if e['dir'] == 'UP' else -1
def sgn(x): return 0 if x in (None, 0) else (1 if x > 0 else -1)

def cond_type(e, v):
    if v == 'any': return True
    if v == 'reversal': return e.get('prev') is not None and e['dir'] != e['prev']['dir']
    if v == 'first': return e.get('idx') == 1
def cond_h9(e, v):
    return True if v == 'any' else (e.get('p_flip') is not None and e['p_flip'] <= 0.5)
def cond_h6(e, v):
    if v == 'any': return True
    f = e.get('feat')
    return f is not None and sgn(f.get('agg_ratio_60')) == dsign(e) and (f.get('agg_persist_60') or 0) >= 0.5
def cond_h8(e, v):
    if v == 'any': return True
    f = e.get('feat')
    if f is None or f.get('book_valid') != 1: return False
    ps = f.get('pull_skew')
    return ps is not None and ((e['dir'] == 'UP' and ps < 0) or (e['dir'] == 'DOWN' and ps > 0))
def cond_band(e, v):
    t = e.get('trigger_elapsed')
    if v == 'any': return True
    if t is None: return False
    if v == '<120': return t < 120
    if v == '120-240': return 120 <= t < 240
    if v == '>=240': return t >= 240

GRID = list(itertools.product(
    ['any', 'reversal', 'first'],
    ['any', 'h9'],
    ['any', 'h6'],
    ['any', 'h8'],
    ['any', '<120', '120-240', '>=240'],
))

def match(e, rule):
    ty, h9, h6, h8, band = rule
    return (cond_type(e, ty) and cond_h9(e, h9) and cond_h6(e, h6)
            and cond_h8(e, h8) and cond_band(e, band))


def stats(eps):
    priced = [(e, roi_of(e)) for e in eps if roi_of(e) is not None]
    n = len(priced)
    if n == 0: return {'n': 0}
    wins = sum(1 for e, _ in priced if e['won'])
    rois = [r for _, r in priced]
    prices = [max(0.01, min(0.99, e['price_side'])) for e, _ in priced]
    mean_roi = float(np.mean(rois))
    sd = float(np.std(rois, ddof=1)) if n > 1 else 0.0
    half = 1.645 * sd / math.sqrt(n) if n > 1 else float('inf')
    return {'n': n, 'acc': wins / n, 'price': float(np.mean(prices)),
            'roi': mean_roi, 'roi_lo90': mean_roi - half, 'roi_hi90': mean_roi + half,
            'total': float(np.sum(rois))}


def fstat(s, name=''):
    if s.get('n', 0) == 0: return f"{name:<34} n=0"
    return (f"{name:<34} n={s['n']:>4} acc={s['acc']*100:5.1f}% px={s['price']:.3f} "
            f"ROI/bet={s['roi']:+.4f} [{s.get('roi_lo90', float('nan')):+.4f},{s.get('roi_hi90', float('nan')):+.4f}] total={s['total']:+.1f}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--episodes', default='v8/analysis/data/episodes.jsonl')
    ap.add_argument('--K', type=int, default=5)
    ap.add_argument('--out', default='v8/analysis/data/decision_card.json')
    args = ap.parse_args()

    eps = load(args.episodes, args.K)
    bq_days = sorted({e['day'] for e in eps if e['src'] == 'bq'})
    train = [e for e in eps if e['src'] == 'bq' and e['day'] in bq_days[:2]]
    held  = [e for e in eps if e['src'] == 'bq' and e['day'] in bq_days[2:]]
    live  = [e for e in eps if e['src'] == 'live']
    print(f"train={len(train)} heldout={len(held)} live={len(live)} (K={args.K})")

    # baselines
    print('\n--- BASELINES ---')
    print(fstat(stats(train), 'TRAIN all fires'))
    print(fstat(stats(held),  'HELDOUT all fires'))
    print(fstat(stats(live),  'LIVE all fires'))
    first_per_bar = [e for e in held if e['idx'] == 1]
    print(fstat(stats(first_per_bar), 'HELDOUT first-per-bar'))

    # grid selection on TRAIN
    rows = []
    for rule in GRID:
        tr = stats([e for e in train if match(e, rule)])
        if tr.get('n', 0) < 60: continue
        rows.append((tr['roi'], rule, tr))
    rows.sort(key=lambda r: -r[0])
    top = rows[:5]

    print('\n--- TOP 5 RULES BY TRAIN ROI (n_train >= 60) ---')
    results = []
    for troi, rule, tr in top:
        hd = stats([e for e in held if match(e, rule)])
        lv = stats([e for e in live if match(e, rule)])
        name = f"type={rule[0]},h9={rule[1]},h6={rule[2]},h8={rule[3]},band={rule[4]}"
        print(f"\nRULE {name}")
        print(fstat(tr, '  TRAIN'))
        print(fstat(hd, '  HELDOUT'))
        print(fstat(lv, '  LIVE'))
        ships = (hd.get('n', 0) >= 30 and hd.get('roi_lo90', -9) > 0 and lv.get('n', 0) >= 10 and lv.get('roi', -9) > 0)
        print(f"  SHIP BAR: {'PASS' if ships else 'FAIL'} (heldout CI clears 0: {hd.get('roi_lo90', -9) > 0}, live ROI>0: {lv.get('roi', -9) > 0})")
        results.append({'rule': name, 'train': tr, 'heldout': hd, 'live': lv, 'ships': ships})

    # reference models: does any better cut exist?
    FEATN = ['price_side', 'trigger_elapsed', 'cushion_ratio', 'p_flip']
    def vec(e):
        f = e.get('feat') or {}
        return [
            e.get('price_side') or 0.5, e.get('trigger_elapsed') or 0,
            e.get('cushion_ratio') or 0, e.get('p_flip') if e.get('p_flip') is not None else 0.5,
            1.0 if (e.get('prev') and e['dir'] != e['prev']['dir']) else 0.0,
            1.0 if cond_h6(e, 'h6') else 0.0,
            1.0 if cond_h8(e, 'h8') else 0.0,
            sgn(f.get('px_vs_vwap')) * dsign(e),
            f.get('mid_vel_30', 0) * dsign(e),
            f.get('whale_against_move_60', 0),
        ]
    names = FEATN + ['is_reversal', 'h6', 'h8', 'vwap_align', 'mid_vel_align', 'whale_against']
    Xtr = np.array([vec(e) for e in train]); ytr = np.array([1 if e['won'] else 0 for e in train])
    Xhd = np.array([vec(e) for e in held])
    tree = DecisionTreeClassifier(max_depth=2, min_samples_leaf=50, random_state=0).fit(Xtr, ytr)
    print('\n--- REFERENCE depth-2 tree (TRAIN) ---')
    print(export_text(tree, feature_names=names))
    # tree-positive rule evaluated as a bet filter on heldout
    p_hd = tree.predict_proba(Xhd)[:, 1]
    for thr in (0.70, 0.75):
        sel = [e for e, p in zip(held, p_hd) if p >= thr]
        print(fstat(stats(sel), f'HELDOUT tree p>={thr}'))

    json.dump({'baselines': {'train': stats(train), 'heldout': stats(held), 'live': stats(live)},
               'top_rules': results}, open(args.out, 'w'), indent=1, default=float)
    print('\nwrote', args.out)


if __name__ == '__main__':
    main()
