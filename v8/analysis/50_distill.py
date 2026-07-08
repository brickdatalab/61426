#!/usr/bin/env python3
"""Distill the frontier winner: cushion-lead rule with hysteresis, swept via
stateful 1s replay (train days -> select params; test days -> confirm).

Rule (the v8 decideV8 candidate), per second:
  floor = max(10, 0.5 * vol_1m)
  side  = sign(cushion)
  ENTER: |cushion| >= ENTER_F * floor for ENTER_DWELL consecutive seconds -> sig = side
  HOLD:  while sig == side, stay until |cushion| < EXIT_F * floor OR cushion sign flips
  FLIP:  opposite side must satisfy ENTER on its own (dwell restarts)
Scored at the matrix tick marks (elapsed 5..295 step 5) with the value rule.

Usage: 50_distill.py --data v8/analysis/data --engine v8/analysis/data/engine --scoring v8/analysis/30_scoring.py
"""
import argparse, importlib.util, json, os, itertools, sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import feat_traj  # for _prepare_bar (cushion + vol_1m arrays, identical derivation)

ELAPSED = list(range(5, 300, 5))


def load_scoring(path):
    spec = importlib.util.spec_from_file_location('scoring', path)
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m


def replay_rule(cushion, floor_arr, enter_f, exit_f, enter_dwell):
    """Stateful 1s replay -> per-second sig array (1/-1/0)."""
    sig = 0
    dwell_side = 0
    dwell_n = 0
    out = np.zeros(len(cushion), dtype=np.int8)
    for t in range(len(cushion)):
        c = cushion[t]
        if np.isnan(c):
            out[t] = sig
            continue
        fl = floor_arr[t]
        side = 1 if c > 0 else (-1 if c < 0 else 0)
        strong = side != 0 and abs(c) >= enter_f * fl
        if sig != 0:
            # exit conditions
            if np.sign(c) != sig or abs(c) < exit_f * fl:
                sig = 0
                dwell_side = 0; dwell_n = 0
        if sig == 0:
            if strong:
                if side == dwell_side:
                    dwell_n += 1
                else:
                    dwell_side = side; dwell_n = 1
                if dwell_n >= enter_dwell:
                    sig = side
                    dwell_side = 0; dwell_n = 0
            else:
                dwell_side = 0; dwell_n = 0
        out[t] = sig
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default='v8/analysis/data')
    ap.add_argument('--engine', default='v8/analysis/data/engine')
    ap.add_argument('--scoring', default='v8/analysis/30_scoring.py')
    args = ap.parse_args()

    S = load_scoring(args.scoring)
    M = S.load_all(args.data, args.engine)
    slugs = M['slugs']
    day = M['day']
    days = sorted(np.unique(day).tolist())
    train_days = set(days[:2]); test_days = set(days[2:])

    # per-bar cushion/floor series (identical derivation to the feature layer)
    print('preparing per-bar series...')
    series = []
    for slug in slugs:
        bar = json.load(open(os.path.join(args.data, 'bars', f'{slug}.json')))
        p = feat_traj._prepare_bar(bar)
        series.append((p['cushion'], p['floor_arr']))

    tick_rows_per_bar = len(ELAPSED)
    n = len(M['y'])
    assert n == len(slugs) * tick_rows_per_bar

    def calls_for(enter_f, exit_f, enter_dwell):
        calls = np.zeros(n, dtype=np.int8)
        for bi, (cush, fl) in enumerate(series):
            sig_sec = replay_rule(cush, fl, enter_f, exit_f, enter_dwell)
            base = bi * tick_rows_per_bar
            for ti, t in enumerate(ELAPSED):
                calls[base + ti] = sig_sec[t]
        return calls

    def score_mask(calls, mask):
        sc = S.score_calls(calls[mask], M['y'][mask], M['poly_mid'][mask], M['poly_valid'][mask],
                           M['rem'][mask], M['cushion'][mask], M['vol1m'][mask])
        bars = int(np.unique(M['slug_idx'][mask]).size)
        return sc['value'] / bars, sc

    tr_mask = np.isin(day, list(train_days))
    te_mask = np.isin(day, list(test_days))

    grid = list(itertools.product([1.0, 1.1, 1.25], [0.7, 0.8, 0.9], [1, 2, 3]))
    results = []
    print(f"sweep {len(grid)} combos | train days {sorted(train_days)} | test days {sorted(test_days)}")
    for ef, xf, dw in grid:
        calls = calls_for(ef, xf, dw)
        vtr, _ = score_mask(calls, tr_mask)
        results.append((vtr, ef, xf, dw, calls))
    results.sort(key=lambda r: -r[0])

    print("\ntop 5 on TRAIN:")
    for vtr, ef, xf, dw, _ in results[:5]:
        print(f"  enter={ef} exit={xf} dwell={dw}  train vpb={vtr:.4f}")

    print("\nheld-out TEST for top 3 + static reference:")
    static = calls_for(1.0, 1.0, 1)
    vte_s, sc_s = score_mask(static, te_mask)
    print(f"  STATIC (enter=1.0 exit=1.0 dwell=1): test vpb={vte_s:.4f} acc={sc_s['accuracy']*100:.1f}% cov={sc_s['coverage']*100:.1f}% wrong={sc_s['wrong_rate']*100:.1f}% miss={sc_s['missed_rate']*100:.1f}%")
    best = None
    for vtr, ef, xf, dw, calls in results[:3]:
        vte, sc = score_mask(calls, te_mask)
        print(f"  enter={ef} exit={xf} dwell={dw}: test vpb={vte:.4f} acc={sc['accuracy']*100:.1f}% cov={sc['coverage']*100:.1f}% wrong={sc['wrong_rate']*100:.1f}% miss={sc['missed_rate']*100:.1f}%")
        if best is None: best = (ef, xf, dw, vte)

    # LOBO by day for the winner
    ef, xf, dw, _ = best
    calls = calls_for(ef, xf, dw)
    print(f"\nLOBO by day (winner enter={ef} exit={xf} dwell={dw}):")
    for d in days:
        m = day == d
        v, sc = score_mask(calls, m)
        print(f"  {d}: vpb={v:.4f} acc={sc['accuracy']*100:.1f}% cov={sc['coverage']*100:.1f}%")

    # full-set comparison vs baselines
    v_all, sc_all = score_mask(calls, np.ones(n, dtype=bool))
    print(f"\nWINNER full-set: vpb={v_all:.4f} acc={sc_all['accuracy']*100:.1f}% cov={sc_all['coverage']*100:.1f}% wrong={sc_all['wrong_rate']*100:.1f}% miss={sc_all['missed_rate']*100:.1f}%")
    for nm, bc in S.baselines(M).items():
        vb, scb = score_mask(bc, np.ones(n, dtype=bool))
        print(f"  {nm:20} vpb={vb:.4f} acc={scb['accuracy']*100:.1f}%")

    json.dump({'winner': {'ENTER_F': ef, 'EXIT_F': xf, 'ENTER_DWELL': dw},
               'winner_full_vpb': v_all,
               'winner_full_acc': sc_all['accuracy'], 'winner_full_cov': sc_all['coverage']},
              open(os.path.join(args.data, 'distill_winner.json'), 'w'), indent=1)
    print('\nwrote', os.path.join(args.data, 'distill_winner.json'))


if __name__ == '__main__':
    main()
