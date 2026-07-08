import argparse, json, importlib.util, os
import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline
from sklearn.inspection import permutation_importance

SEED = 0
np.random.seed(SEED)

def load_scoring(path):
    spec = importlib.util.spec_from_file_location('scoring', path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', required=True)
    ap.add_argument('--engine', required=True)
    ap.add_argument('--scoring', required=True)
    ap.add_argument('--out', required=True)
    args = ap.parse_args()

    S = load_scoring(args.scoring)
    M = S.load_all(args.data, args.engine)
    X = M['X']; y = M['y']; poly_mid = M['poly_mid']; poly_valid = M['poly_valid']
    rem = M['rem']; cushion = M['cushion']; vol1m = M['vol1m']; absmove = M['absmove']
    day = M['day']; slug_idx = M['slug_idx']; features = list(M['features'])
    v6_calls = M['v6_calls']
    n = len(y)

    days = sorted(np.unique(day).tolist())
    nf = len(days) - 1

    # Pooled test arrays
    pooled_idx = []
    fold_summaries = []
    for k in range(1, len(days)):
        tr_mask = np.isin(day, days[:k])
        te_mask = (day == days[k])
        te_idx = np.where(te_mask)[0]
        pooled_idx.append(te_idx)
        fold_summaries.append({
            'fold': k, 'train_days': days[:k], 'test_day': days[k],
            'train_ticks': int(tr_mask.sum()), 'test_ticks': int(te_mask.sum()),
            'test_bars': int(np.unique(slug_idx[te_mask]).size)
        })
    pooled_idx = np.concatenate(pooled_idx)
    n_test = pooled_idx.size

    p_hgb = np.zeros(n_test, dtype=np.float64)
    p_log = np.zeros(n_test, dtype=np.float64)

    print("=== WALK-FORWARD ===")
    for k in range(1, len(days)):
        tr_mask = np.isin(day, days[:k])
        te_mask = (day == days[k])
        Xtr, ytr = X[tr_mask], y[tr_mask]
        Xte = X[te_mask]
        start = sum(int((day == days[j]).sum()) for j in range(1, k))
        end = start + int(te_mask.sum())

        hgb = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.08,
                                             max_leaf_nodes=31, early_stopping=True,
                                             random_state=SEED)
        hgb.fit(Xtr, ytr)
        p_hgb[start:end] = hgb.predict_proba(Xte)[:, 1]

        logit = Pipeline([('sc', StandardScaler()),
                          ('lr', LogisticRegression(max_iter=2000, random_state=SEED))])
        logit.fit(Xtr, ytr)
        p_log[start:end] = logit.predict_proba(Xte)[:, 1]

        fs = fold_summaries[k-1]
        print(f"fold {k}: train_days={fs['train_days']} test_day={fs['test_day']} "
              f"train_ticks={fs['train_ticks']} test_ticks={fs['test_ticks']} test_bars={fs['test_bars']}")

    # Pooled test meta
    y_t = y[pooled_idx]
    poly_mid_t = poly_mid[pooled_idx]
    poly_valid_t = poly_valid[pooled_idx]
    rem_t = rem[pooled_idx]
    cushion_t = cushion[pooled_idx]
    vol1m_t = vol1m[pooled_idx]
    absmove_t = absmove[pooled_idx]
    slug_t = slug_idx[pooled_idx]

    fold_id_t = np.empty(n_test, dtype=np.int32)
    pos = 0
    for k in range(1, len(days)):
        sz = int((day == days[k]).sum())
        fold_id_t[pos:pos+sz] = k
        pos += sz
    bar_keys = np.stack([fold_id_t, slug_t], axis=1)
    n_bars_test = int(np.unique(bar_keys, axis=0).shape[0])

    taus = [round(0.55 + 0.05*i, 2) for i in range(9)]  # 0.55..0.95
    bands = [(300,240),(240,180),(180,120),(120,60),(60,0)]

    def make_calls(p, tau):
        c = np.zeros(len(p), dtype=np.int8)
        c[p >= tau] = 1
        c[p <= 1 - tau] = -1
        return c

    def score_full(calls):
        return S.score_calls(calls, y_t, poly_mid_t, poly_valid_t, rem_t, cushion_t, vol1m_t,
                             lam=1.0, mu=0.25)

    frontier = {}
    print("\n=== THRESHOLD SWEEP (pooled test) ===")
    print(f"{'model':6} {'tau':5} {'value':>10} {'vpb':>9} {'acc':>7} {'cov':>6} {'wrong':>6} {'miss':>6}")
    best = None
    for name, p in [('hgb', p_hgb), ('logit', p_log)]:
        for tau in taus:
            calls = make_calls(p, tau)
            sc = score_full(calls)
            vpb = sc['value'] / n_bars_test if n_bars_test else 0.0
            row = {
                'value': float(sc['value']),
                'value_per_bar': float(vpb),
                'accuracy': float(sc['accuracy']),
                'coverage': float(sc['coverage']),
                'wrong_rate': float(sc['wrong_rate']),
                'missed_rate': float(sc['missed_rate']),
                'bands': {}
            }
            for (hi, lo) in bands:
                m = (rem_t <= hi) & (rem_t > lo)
                if m.sum() == 0:
                    row['bands'][f"{hi}-{lo}"] = {'value':0.0,'acc':0.0,'cov':0.0,'n':0}
                    continue
                sb = S.score_calls(calls[m], y_t[m], poly_mid_t[m], poly_valid_t[m],
                                   rem_t[m], cushion_t[m], vol1m_t[m], lam=1.0, mu=0.25)
                row['bands'][f"{hi}-{lo}"] = {
                    'value': float(sb['value']),
                    'acc': float(sb['accuracy']),
                    'cov': float(sb['coverage']),
                    'n': int(m.sum())
                }
            frontier[f"{name}_{tau}"] = row
            print(f"{name:6} {tau:5.2f} {row['value']:10.2f} {row['value_per_bar']:9.4f} "
                  f"{row['accuracy']:7.3f} {row['coverage']:6.3f} {row['wrong_rate']:6.3f} {row['missed_rate']:6.3f}")
            if best is None or row['value_per_bar'] > best['value_per_bar']:
                best = {'model': name, 'tau': tau, **row}

    print("\n=== BEST OPERATING POINT ===")
    print(f"BEST: model={best['model']} tau={best['tau']} value_per_bar={best['value_per_bar']:.4f} "
          f"value={best['value']:.2f} acc={best['accuracy']:.3f} cov={best['coverage']:.3f}")

    # Coin-flip sensitivity: exclude absmove < 10
    keep = absmove_t >= 10
    coinflip = {}
    if keep.sum() > 0:
        p_best = p_hgb if best['model'] == 'hgb' else p_log
        calls_b = make_calls(p_best, best['tau'])
        sc_k = S.score_calls(calls_b[keep], y_t[keep], poly_mid_t[keep], poly_valid_t[keep],
                             rem_t[keep], cushion_t[keep], vol1m_t[keep], lam=1.0, mu=0.25)
        kept_bars = np.unique(np.stack([fold_id_t[keep], slug_t[keep]], axis=1), axis=0)
        vpb_k = sc_k['value'] / max(1, kept_bars.shape[0])
        coinflip = {
            'n_kept': int(keep.sum()),
            'n_bars': int(kept_bars.shape[0]),
            'value': float(sc_k['value']),
            'value_per_bar': float(vpb_k),
            'accuracy': float(sc_k['accuracy']),
            'coverage': float(sc_k['coverage']),
        }
        print(f"COINFLIP (absmove>=10): n={coinflip['n_kept']} bars={coinflip['n_bars']} value={coinflip['value']:.2f} "
              f"vpb={coinflip['value_per_bar']:.4f} acc={coinflip['accuracy']:.3f} cov={coinflip['coverage']:.3f}")
    else:
        print("COINFLIP: no ticks with absmove>=10")

    # Baselines on pooled test
    print("\n=== BASELINES ON POOLED TEST ===")
    B = S.baselines(M)
    baselines_on_test = {}
    print(f"{'name':20} {'value':>10} {'vpb':>9} {'acc':>7} {'cov':>6} {'wrong':>6} {'miss':>6}")
    for name, calls in B.items():
        c = calls[pooled_idx]
        sc = score_full(c)
        vpb = sc['value'] / n_bars_test if n_bars_test else 0.0
        baselines_on_test[name] = {
            'value': float(sc['value']), 'value_per_bar': float(vpb),
            'accuracy': float(sc['accuracy']), 'coverage': float(sc['coverage']),
            'wrong_rate': float(sc['wrong_rate']), 'missed_rate': float(sc['missed_rate'])
        }
        print(f"{name:20} {sc['value']:10.2f} {vpb:9.4f} {sc['accuracy']:7.3f} "
              f"{sc['coverage']:6.3f} {sc['wrong_rate']:6.3f} {sc['missed_rate']:6.3f}")

    # Importances: fit hgb on all days except last, eval on last day
    print("\n=== PERMUTATION IMPORTANCE (hgb, last-day test) ===")
    last_day = days[-1]
    tr_mask = (day != last_day)
    te_mask = (day == last_day)
    Xtr, ytr = X[tr_mask], y[tr_mask]
    Xte, yte = X[te_mask], y[te_mask]
    hgb = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.08,
                                         max_leaf_nodes=31, early_stopping=True,
                                         random_state=SEED)
    hgb.fit(Xtr, ytr)
    perm = permutation_importance(hgb, Xte, yte, scoring='roc_auc', n_repeats=5,
                                  random_state=SEED, n_jobs=-1)
    imp_mean = perm.importances_mean
    order = np.argsort(imp_mean)[::-1][:20]
    top20 = []
    print(f"{'rank':4} {'feature':25} {'imp':>10}")
    for r, i in enumerate(order):
        print(f"{r+1:<4} {features[i]:25} {imp_mean[i]:10.5f}")
        top20.append({'feature': features[i], 'importance': float(imp_mean[i])})

    # Group importance
    print("\n=== GROUP IMPORTANCE (shuffle last-day test) ===")
    groups = {
        'AGG': [i for i,f in enumerate(features) if f.startswith('agg_')],
        'WHALE': [i for i,f in enumerate(features) if f.startswith('whale_')],
        'BASIS': [i for i,f in enumerate(features) if f.startswith('basis')],
        'BOOK': [features.index(n) for n in ['bid_pull_30','ask_pull_30','pull_skew','imb_vel_10','book_valid'] if n in features],
        'POLY': [features.index(n) for n in ['mid_vel_10','mid_vel_30','mid_accel','pimb_vel_10','mid_cush_gap','poly_valid'] if n in features],
        'VWAP': [features.index(n) for n in ['px_vs_vwap','vwap_conf','hollow'] if n in features],
        'TRAJ': [features.index(n) for n in ['cush_vel_10','cush_vel_30','cush_vel_60','cush_accel','cvd_slope_60','absorb_60','imb_whipsaw_60','cush_path_r2','range_pos','cush_norm'] if n in features],
        'CTX': [features.index(n) for n in ['rem_norm'] if n in features],
    }

    p_te = hgb.predict_proba(Xte)[:, 1]
    calls_te = make_calls(p_te, best['tau'])
    y_te = y[te_mask]; pm_te = poly_mid[te_mask]; pv_te = poly_valid[te_mask]
    rem_te = rem[te_mask]; cu_te = cushion[te_mask]; v1m_te = vol1m[te_mask]
    sc_base = S.score_calls(calls_te, y_te, pm_te, pv_te, rem_te, cu_te, v1m_te, lam=1.0, mu=0.25)
    base_val = float(sc_base['value'])
    print(f"unshuffled last-day value (tau={best['tau']}): {base_val:.2f}")

    rng = np.random.default_rng(SEED)
    group_imp = {}
    print(f"{'group':8} {'n_feat':>6} {'shuffled_val':>13} {'drop':>10}")
    for g, cols in groups.items():
        if len(cols) == 0:
            group_imp[g] = {'n_feat': 0, 'shuffled_value': 0.0, 'drop': 0.0}
            continue
        Xs = Xte.copy()
        perm_idx = rng.permutation(Xs.shape[0])
        Xs[:, cols] = Xs[perm_idx][:, cols]
        ps = hgb.predict_proba(Xs)[:, 1]
        cs = make_calls(ps, best['tau'])
        scs = S.score_calls(cs, y_te, pm_te, pv_te, rem_te, cu_te, v1m_te, lam=1.0, mu=0.25)
        drop = base_val - float(scs['value'])
        group_imp[g] = {'n_feat': len(cols), 'shuffled_value': float(scs['value']), 'drop': float(drop)}
        print(f"{g:8} {len(cols):>6} {float(scs['value']):>13.2f} {drop:>10.2f}")

    report = {
        'folds': fold_summaries,
        'frontier': frontier,
        'baselines_on_test': baselines_on_test,
        'best': best,
        'coinflip_sensitivity': coinflip,
        'top20_permutation': top20,
        'group_importance': group_imp,
        'n_test_ticks': int(n_test),
        'n_test_bars': int(n_bars_test),
        'days': days,
    }
    with open(args.out, 'w') as f:
        json.dump(report, f, indent=2)
    print(f"\nReport written to {args.out}")

if __name__ == '__main__':
    main()
