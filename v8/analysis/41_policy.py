#!/usr/bin/env python3
"""Value-optimal decision policy on top of the walk-forward model probabilities.

For a tick with model P(UP)=p, unpricedness u, earliness e (u*e = the reward for a
correct call), lam = wrong-cost, mu = missed-cost:
  EV(call UP)   = p*(u*e) - (1-p)*lam
  EV(call DOWN) = (1-p)*(u*e) - p*lam
  EV(MIXED)     = -mu * P(fire_worthy hit) where fire_worthy needs the cushion lead
                  to be on the settle side and |cushion| >= floor; P(hit) = p if
                  cushion>0 else (1-p), and 0 when |cushion| < floor.
Call the argmax. This is the policy the scoring rule actually implies — a fixed tau is not.

Fair anchors: the SAME optimal policy applied to single-feature logits
(cushion-only, poly-only) so the model must beat policy-upgraded anchors, not
policy-crippled ones.

Usage: 41_policy.py --data v8/analysis/data --engine v8/analysis/data/engine --scoring v8/analysis/30_scoring.py
"""
import argparse, importlib.util, json, os
import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline

SEED = 0

def load_scoring(path):
    spec = importlib.util.spec_from_file_location('scoring', path)
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m

def walk_forward_probs(X, y, day, days, model_factory):
    n_test_total = sum(int((day == d).sum()) for d in days[1:])
    p = np.zeros(n_test_total); pos = 0
    for k in range(1, len(days)):
        tr = np.isin(day, days[:k]); te = (day == days[k])
        m = model_factory(); m.fit(X[tr], y[tr])
        sz = int(te.sum()); p[pos:pos+sz] = m.predict_proba(X[te])[:, 1]; pos += sz
    return p

def optimal_calls(p, u, e, cushion, fl, lam=1.0, mu=0.25):
    reward = u * e
    ev_up = p * reward - (1 - p) * lam
    ev_dn = (1 - p) * reward - p * lam
    lead_up = cushion > 0
    fire_worthy_possible = np.abs(cushion) >= fl
    p_hit = np.where(lead_up, p, 1 - p) * fire_worthy_possible
    ev_mx = -mu * p_hit
    calls = np.zeros(len(p), dtype=np.int8)
    best_dir = np.where(ev_up >= ev_dn, ev_up, ev_dn)
    dir_side = np.where(ev_up >= ev_dn, 1, -1).astype(np.int8)
    calls = np.where(best_dir > ev_mx, dir_side, 0).astype(np.int8)
    return calls

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default='v8/analysis/data')
    ap.add_argument('--engine', default='v8/analysis/data/engine')
    ap.add_argument('--scoring', default='v8/analysis/30_scoring.py')
    args = ap.parse_args()

    S = load_scoring(args.scoring)
    M = S.load_all(args.data, args.engine)
    X, y, day = M['X'], M['y'], M['day']
    days = sorted(np.unique(day).tolist())
    feats = M['features']

    # pooled test indices in fold order (matches walk_forward_probs order)
    pooled = np.concatenate([np.where(day == d)[0] for d in days[1:]])
    y_t = y[pooled]; pm = M['poly_mid'][pooled]; pv = M['poly_valid'][pooled]
    rem = M['rem'][pooled]; cu = M['cushion'][pooled]; v1 = M['vol1m'][pooled]
    slug_t = M['slug_idx'][pooled]
    fold_id = np.concatenate([[k]*int((day == days[k]).sum()) for k in range(1, len(days))])
    n_bars = int(np.unique(np.stack([fold_id, slug_t], axis=1), axis=0).shape[0])

    u = np.where(pv > 0, np.maximum(0.0, 1.0 - 2.0*np.abs(pm - 0.5)), 0.0)
    e = rem / 300.0
    fl = np.maximum(10.0, 0.5 * v1)

    def report(name, calls):
        sc = S.score_calls(calls, y_t, pm, pv, rem, cu, v1)
        print(f"{name:34} vpb={sc['value']/n_bars:8.4f} acc={sc['accuracy']*100:5.1f}% cov={sc['coverage']*100:5.1f}% wrong={sc['wrong_rate']*100:4.1f}% miss={sc['missed_rate']*100:4.1f}%")
        return sc['value']/n_bars

    hgb_f = lambda: HistGradientBoostingClassifier(max_iter=300, learning_rate=0.08, max_leaf_nodes=31, early_stopping=True, random_state=SEED)
    log_f = lambda: Pipeline([('sc', StandardScaler()), ('lr', LogisticRegression(max_iter=2000, random_state=SEED))])

    results = {}
    print(f"pooled test: {len(pooled)} ticks, {n_bars} bars\n")
    print("--- value-optimal policy ---")
    for name, factory, cols in [
        ('FULL hgb', hgb_f, None),
        ('FULL logit', log_f, None),
        ('ANCHOR cushion-only logit', log_f, [feats.index('cush_norm')]),
        ('ANCHOR poly-only logit', log_f, [feats.index('mid_cush_gap'), feats.index('poly_valid')]),
        ('ANCHOR cush+poly logit', log_f, [feats.index('cush_norm'), feats.index('mid_cush_gap'), feats.index('poly_valid')]),
    ]:
        Xu = X if cols is None else X[:, cols]
        p = walk_forward_probs(Xu, y, day, days, factory)
        calls = optimal_calls(p, u, e, cu, fl)
        results[name] = report(name, calls)
        np.save(os.path.join(args.data, f"p_{name.split()[0]}_{name.split()[1]}.npy"), p)

    print("\n--- reference: raw baselines under their native rules ---")
    B = S.baselines(M)
    for nm, calls in B.items():
        report(nm, calls[pooled])

    json.dump({k: float(v) for k, v in results.items()},
              open(os.path.join(args.data, 'policy_results.json'), 'w'), indent=1)

if __name__ == '__main__':
    main()
