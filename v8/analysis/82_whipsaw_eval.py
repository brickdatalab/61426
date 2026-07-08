#!/usr/bin/env python3
"""82_whipsaw_eval.py — the whipsaw-veto evaluator. THE metric is held-out dollars:
does skipping all bets in bars the model flags as chop-at-first-fire raise total
flat-$ fire ROI? AUC is diagnostic only. τ selected on TRAIN, verdict on HELDOUT,
bootstrap CI over bars."""
import json, os
import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.impute import SimpleImputer
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline
from sklearn.metrics import roc_auc_score
from sklearn.inspection import permutation_importance

SEED = 0
DATA = 'v8/analysis/data'


def roi(e):
    p = e.get('price_side')
    if p is None:
        return None
    p = max(0.01, min(0.99, p))
    return (1 - p) / p if e['won'] else -1.0


def main():
    X = np.load(os.path.join(DATA, 'whipsaw_X.npy'))
    mj = json.load(open(os.path.join(DATA, 'whipsaw_feat_meta.json')))
    names, tiers, meta = mj['names'], mj['tiers'], mj['meta']
    y = np.array([m['y'] for m in meta])
    days = np.array([m['day'] for m in meta])
    slugs = [m['slug'] for m in meta]
    uniq_days = sorted(set(days))
    tr = np.isin(days, uniq_days[:2]); hd = ~tr
    print(f"rows={len(y)} | train days {uniq_days[:2]} n={tr.sum()} (y={y[tr].mean():.3f}) | heldout n={hd.sum()} (y={y[hd].mean():.3f})")

    # all fires per bar (for the money metric)
    fires = {}
    for line in open(os.path.join(DATA, 'episodes.jsonl')):
        e = json.loads(line)
        if e['K'] == 5 and e['src'] == 'bq':
            fires.setdefault(e['slug'], []).append(e)

    # ---- models ----
    hgb = HistGradientBoostingClassifier(max_iter=200, learning_rate=0.08, max_leaf_nodes=15,
                                         early_stopping=True, random_state=SEED)
    hgb.fit(X[tr], y[tr])
    p_hgb_tr = hgb.predict_proba(X[tr])[:, 1]; p_hgb_hd = hgb.predict_proba(X[hd])[:, 1]

    logit = Pipeline([('imp', SimpleImputer(strategy='median')), ('sc', StandardScaler()),
                      ('lr', LogisticRegression(max_iter=2000, C=0.5, random_state=SEED))])
    logit.fit(X[tr], y[tr])
    p_log_tr = logit.predict_proba(X[tr])[:, 1]; p_log_hd = logit.predict_proba(X[hd])[:, 1]

    # persistence baseline (prior_whipsaw feature alone)
    pw = X[:, names.index('prior_whipsaw')]
    pw_hd = np.nan_to_num(pw[hd], nan=0.5)

    print('\n--- AUC (diagnostic) ---')
    print(f"HGB    : train {roc_auc_score(y[tr], p_hgb_tr):.3f}  heldout {roc_auc_score(y[hd], p_hgb_hd):.3f}")
    print(f"logit  : train {roc_auc_score(y[tr], p_log_tr):.3f}  heldout {roc_auc_score(y[hd], p_log_hd):.3f}")
    print(f"persistence-only baseline heldout AUC: {roc_auc_score(y[hd], pw_hd):.3f}")

    # ---- money metric ----
    def bar_pnl(slug, policy):
        eps = fires.get(slug, [])
        if policy == 'first':
            eps = eps[:1]
        vals = [roi(e) for e in eps]
        return sum(v for v in vals if v is not None)

    def total(mask, scores, tau, policy):
        t = 0.0; nbet = 0; nskip = 0
        for i in np.where(mask)[0]:
            if scores is not None and scores_for(i, scores, mask) > tau:
                nskip += 1
                continue
            t += bar_pnl(slugs[i], policy)
            nbet += 1
        return t, nbet, nskip

    def scores_for(i, scores, mask):
        # scores array is aligned to mask-True order
        idx = np.where(mask)[0]
        return scores[np.searchsorted(idx, i)]

    for model_name, p_tr, p_hd in [('HGB', p_hgb_tr, p_hgb_hd), ('logit', p_log_tr, p_log_hd)]:
        print(f"\n--- MONEY METRIC ({model_name}) ---")
        for policy in ('first', 'all'):
            base_tr, nb_tr, _ = total(tr, None, None, policy)
            # τ selection on TRAIN: maximize vetoed total
            taus = np.quantile(p_tr, np.linspace(0.3, 0.95, 14))
            best_tau, best_val = None, -1e18
            for tau in taus:
                v, _, _ = total(tr, p_tr, tau, policy)
                if v > best_val:
                    best_val, best_tau = v, tau
            base_hd, nb_hd, _ = total(hd, None, None, policy)
            veto_hd, nbet_hd, nskip_hd = total(hd, p_hd, best_tau, policy)
            delta = veto_hd - base_hd
            # bootstrap CI over heldout bars
            rng = np.random.default_rng(SEED)
            idx_hd = np.where(hd)[0]
            deltas = []
            for _ in range(1000):
                samp = rng.choice(len(idx_hd), len(idx_hd), replace=True)
                d = 0.0
                for j in samp:
                    i = idx_hd[j]
                    pnl = bar_pnl(slugs[i], policy)
                    flagged = p_hd[j] > best_tau
                    d += (0.0 if flagged else pnl) - pnl
                deltas.append(d)
            lo, hi = np.percentile(deltas, [5, 95])
            # classification at tau
            flag = p_hd > best_tau
            recall = (flag & (y[hd] == 1)).sum() / max(1, (y[hd] == 1).sum())
            fpr = (flag & (y[hd] == 0)).sum() / max(1, (y[hd] == 0).sum())
            print(f"policy={policy:5s} tau={best_tau:.3f} | TRAIN base {base_tr:+.1f} -> veto {best_val:+.1f} | "
                  f"HELDOUT base {base_hd:+.1f} -> veto {veto_hd:+.1f} (Δ {delta:+.1f}, 90% CI [{lo:+.1f},{hi:+.1f}]) | "
                  f"bars bet {nbet_hd}/{nb_hd}, skipped {nskip_hd} | whipsaw recall {recall*100:.0f}%, false-veto {fpr*100:.0f}%")

    # ---- importances (HGB, heldout AUC) ----
    print('\n--- permutation importance (HGB, heldout AUC), top 15 ---')
    imp = permutation_importance(hgb, X[hd], y[hd], scoring='roc_auc', n_repeats=5, random_state=SEED, n_jobs=-1)
    order = np.argsort(imp.importances_mean)[::-1][:15]
    for i in order:
        print(f"  {names[i]:24s} {tiers[i]}  {imp.importances_mean[i]:+.4f}")

    # ---- single-feature heldout AUCs for the pre-registered novel set ----
    print('\n--- single-feature heldout AUC (novel + key ideas) ---')
    for n in ('flow_decel', 'imb_freshness', 'vacuum_ratio', 'eth_beta_resid', 'multi_ts_disagree',
              'away_build', 'run_commit', 'poly_reprice_gap', 'whale_chase', 'crossings_sofar',
              'opp_excursion_ratio', 'unbacked', 'battle_ratio', 'poly_hug', 'floor_energy',
              'cushion_floor_time', 'trigger_elapsed', 'p_flip_trig', 'price_side'):
        col = X[hd][:, names.index(n)]
        m = np.isfinite(col)
        if m.sum() < 60 or len(set(y[hd][m])) < 2:
            print(f"  {n:24s} n/a (n={m.sum()})")
            continue
        auc = roc_auc_score(y[hd][m], col[m])
        print(f"  {n:24s} AUC {auc:.3f} (n={m.sum()})  {'[inverts]' if auc < 0.5 else ''}")


if __name__ == '__main__':
    main()
