#!/usr/bin/env python3
"""72_sequence_map.py — descriptive sequence/timing tables over fire episodes."""
import argparse
import json
import statistics
from collections import defaultdict, Counter


def load_episodes(path, K):
    eps = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            if obj.get('K') == K:
                eps.append(obj)
    return eps


def clamp_price(p):
    if p is None:
        return None
    return max(0.01, min(0.99, p))


def roi_of(ep):
    """Flat-$1 ROI at real price.  None if price_side is null."""
    p = ep.get('price_side')
    if p is None:
        return None
    p = clamp_price(p)
    return ((1.0 - p) / p) if ep.get('won') else -1.0


def safe_mean(vals):
    vals = [v for v in vals if v is not None]
    return statistics.mean(vals) if vals else None


def safe_median(vals):
    vals = [v for v in vals if v is not None]
    return statistics.median(vals) if vals else None


def acc_of(eps):
    if not eps:
        return None
    return sum(1 for e in eps if e.get('won')) / len(eps)


def fmt(x, w=8, d=2):
    if x is None:
        return f'{"-":>{w}}'
    if isinstance(x, bool):
        return f'{str(x):>{w}}'
    if isinstance(x, int):
        return f'{x:>{w}}'
    return f'{x:>{w}.{d}f}'


def pct(x, w=8):
    if x is None:
        return f'{"-":>{w}}'
    return f'{x * 100:>{w}.1f}%'


def build_tables(eps):
    result = {}

    bars = defaultdict(list)
    for ep in eps:
        bars[ep['slug']].append(ep)
    for slug in bars:
        bars[slug].sort(key=lambda e: e.get('idx', 0))

    null_price = sum(1 for e in eps if e.get('price_side') is None)

    # ---- 1. FIRE INDEX
    fire_rows = {}
    for label, predicate in [
        ('1',  lambda e: e.get('idx') == 1),
        ('2',  lambda e: e.get('idx') == 2),
        ('3',  lambda e: e.get('idx') == 3),
        ('4+', lambda e: e.get('idx', 0) >= 4),
    ]:
        subset = [e for e in eps if predicate(e)]
        rois = [r for r in (roi_of(e) for e in subset) if r is not None]
        prices = [p for p in (e.get('price_side') for e in subset) if p is not None]
        triggers = [e.get('trigger_elapsed') for e in subset]
        fire_rows[label] = {
            'n': len(subset),
            'acc': acc_of(subset),
            'avg_price': safe_mean(prices),
            'roi_per_bet': safe_mean(rois),
            'total_roi': sum(rois) if rois else 0.0,
            'median_trigger': safe_median(triggers),
        }
    result['fire_index'] = fire_rows

    # ---- 2. PATTERNS
    bars_ge2 = {s: b for s, b in bars.items() if len(b) >= 2}
    bars_ge3 = {s: b for s, b in bars.items() if len(b) >= 3}

    pat_a, pat_b, pat_c = [], [], []
    for s, b in bars_ge2.items():
        e1, e2 = b[0], b[1]
        if e1.get('dir') is not None and e2.get('dir') is not None and e1['dir'] != e2['dir']:
            pat_a.append((e1, e2))
    for s, b in bars_ge3.items():
        e1, e2, e3 = b[0], b[1], b[2]
        d1, d2, d3 = e1.get('dir'), e2.get('dir'), e3.get('dir')
        if d1 is not None and d2 is not None and d3 is not None and d1 != d2:
            if d3 == d1:
                pat_b.append((e1, e2, e3))
            elif d3 == d2:
                pat_c.append((e1, e2, e3))

    result['patterns'] = {
        'A_to_B': {
            'n': len(pat_a),
            'p_idx2_won': (sum(1 for _, e2 in pat_a if e2.get('won')) / len(pat_a)) if pat_a else None,
            'p_idx1_won': (sum(1 for e1, _ in pat_a if e1.get('won')) / len(pat_a)) if pat_a else None,
        },
        'A_to_B_to_A': {
            'n': len(pat_b),
            'p_idx3_won': (sum(1 for _, _, e3 in pat_b if e3.get('won')) / len(pat_b)) if pat_b else None,
        },
        'A_to_B_to_B': {
            'n': len(pat_c),
            'p_idx3_won': (sum(1 for _, _, e3 in pat_c if e3.get('won')) / len(pat_c)) if pat_c else None,
        },
    }

    # ---- 3. TYPE
    first_eps     = [e for e in eps if e.get('idx') == 1]
    reversal_eps  = [e for e in eps if e.get('prev') is not None and e.get('dir') != e['prev'].get('dir')]
    reaffirm_eps  = [e for e in eps if e.get('prev') is not None and e.get('dir') == e['prev'].get('dir')]

    def type_stats(subset):
        rois   = [r for r in (roi_of(e) for e in subset) if r is not None]
        prices = [p for p in (e.get('price_side') for e in subset) if p is not None]
        return {
            'n': len(subset),
            'acc': acc_of(subset),
            'avg_price': safe_mean(prices),
            'roi_per_bet': safe_mean(rois),
        }

    rev_decay = [e for e in reversal_eps if e.get('prev', {}).get('end') == 'decay']
    rev_snap  = [e for e in reversal_eps if e.get('prev', {}).get('end') == 'snap']
    result['type'] = {
        'first':          type_stats(first_eps),
        'reversal':       type_stats(reversal_eps),
        'reaffirm':       type_stats(reaffirm_eps),
        'reversal_decay': type_stats(rev_decay),
        'reversal_snap':  type_stats(rev_snap),
    }

    # ---- 4. TIME x TYPE
    bands = [(0, 60, False), (60, 120, False), (120, 180, False),
             (180, 240, False), (240, 300, True)]
    band_labels = ['[0,60)', '[60,120)', '[120,180)', '[180,240)', '[240,300]']
    type_map = {'first': first_eps, 'reversal': reversal_eps, 'reaffirm': reaffirm_eps}

    time_type = {}
    for bi, (lo, hi, inclusive) in enumerate(bands):
        blabel = band_labels[bi]
        time_type[blabel] = {}
        for tname, teps in type_map.items():
            subset = []
            for e in teps:
                te = e.get('trigger_elapsed')
                if te is None:
                    continue
                if inclusive:
                    if lo <= te <= hi:
                        subset.append(e)
                else:
                    if lo <= te < hi:
                        subset.append(e)
            rois = [r for r in (roi_of(e) for e in subset) if r is not None]
            time_type[blabel][tname] = {
                'n': len(subset),
                'acc': acc_of(subset),
                'roi_per_bet': safe_mean(rois),
            }
    result['time_x_type'] = time_type

    # ---- 5. WRONGNESS CONCENTRATION
    lost_eps = [e for e in eps if not e.get('won')]
    total_losses = len(lost_eps)

    losses_per_bar = Counter()
    for e in lost_eps:
        losses_per_bar[e['slug']] += 1
    sorted_bars = losses_per_bar.most_common()
    top5_losses  = sum(c for _, c in sorted_bars[:5])
    top10_losses = sum(c for _, c in sorted_bars[:10])

    losses_per_day = Counter()
    for e in lost_eps:
        losses_per_day[e.get('day', 'unknown')] += 1

    mixed_bars, single_dir_bars = [], []
    for slug, b in bars.items():
        has_w = any(e.get('won') for e in b)
        has_l = any(not e.get('won') for e in b)
        if has_w and has_l:
            mixed_bars.append(slug)
        else:
            single_dir_bars.append(slug)

    def bar_pnl(slug):
        return sum(r for r in (roi_of(e) for e in bars[slug]) if r is not None)

    mixed_pnl  = sum(bar_pnl(s) for s in mixed_bars)
    single_pnl = sum(bar_pnl(s) for s in single_dir_bars)

    result['wrongness'] = {
        'total_losses': total_losses,
        'top5_losses': top5_losses,
        'top10_losses': top10_losses,
        'top5_share': (top5_losses / total_losses) if total_losses else None,
        'top10_share': (top10_losses / total_losses) if total_losses else None,
        'losses_per_day': dict(sorted(losses_per_day.items(), key=lambda x: (-x[1], str(x[0])))),
        'losses_per_bar_top': [(b, c) for b, c in sorted_bars[:10]],
        'intra_bar_netting': {
            'mixed_bars_count': len(mixed_bars),
            'mixed_bars_pnl': mixed_pnl,
            'single_dir_bars_count': len(single_dir_bars),
            'single_dir_bars_pnl': single_pnl,
        },
    }

    # ---- 6. FIRST vs LAST
    first_won = last_won = n_bars = 0
    for slug, b in bars.items():
        if not b:
            continue
        n_bars += 1
        if b[0].get('won'):
            first_won += 1
        if b[-1].get('won'):
            last_won += 1
    result['first_vs_last'] = {
        'n_bars': n_bars,
        'p_first_won': (first_won / n_bars) if n_bars else None,
        'p_last_won': (last_won / n_bars) if n_bars else None,
    }

    # ---- 7. PRICE DRIFT
    won_eps  = [e for e in eps if e.get('won')]
    lost_eps_d = [e for e in eps if not e.get('won')]

    def drift_stats(subset):
        p30_diffs, p60_diffs = [], []
        for e in subset:
            p   = e.get('price_side')
            p30 = e.get('price_side_p30')
            p60 = e.get('price_side_p60')
            if p is not None and p30 is not None:
                p30_diffs.append(p30 - p)
            if p is not None and p60 is not None:
                p60_diffs.append(p60 - p)
        return {
            'mean_p30_drift': safe_mean(p30_diffs),
            'mean_p60_drift': safe_mean(p60_diffs),
            'n_p30': len(p30_diffs),
            'n_p60': len(p60_diffs),
        }

    result['price_drift'] = {
        'won':  drift_stats(won_eps),
        'lost': drift_stats(lost_eps_d),
    }

    # ---- 8. DISAGREEMENT PREVIEW
    disagree = [e for e in eps if e.get('price_side') is not None and e['price_side'] < 0.50]
    rois_d   = [r for r in (roi_of(e) for e in disagree) if r is not None]
    prices_d = [e.get('price_side') for e in disagree]
    result['disagreement'] = {
        'n': len(disagree),
        'acc': acc_of(disagree),
        'avg_price': safe_mean(prices_d),
        'roi_per_bet': safe_mean(rois_d),
    }

    result['null_price_excluded'] = null_price
    result['total_episodes'] = len(eps)
    return result


def print_tables(src, data):
    sep = '=' * 90
    print(f'\n{sep}')
    print(f'  SRC: {src.upper()}   episodes={data["total_episodes"]}   '
          f'null_price_excluded_from_roi={data["null_price_excluded"]}')
    print(sep)

    print('\n--- 1. FIRE INDEX ---')
    print(f'{"idx":>6} {"n":>6} {"acc":>8} {"avg_px":>8} {"roi/bet":>8} {"tot_roi":>10} {"med_trig":>10}')
    for label in ['1', '2', '3', '4+']:
        r = data['fire_index'][label]
        print(f'{label:>6} {r["n"]:>6} {pct(r["acc"])} {fmt(r["avg_price"])} '
              f'{fmt(r["roi_per_bet"])} {fmt(r["total_roi"], 10)} {fmt(r["median_trigger"], 10)}')

    print('\n--- 2. PATTERNS (bars with >=2 episodes) ---')
    p = data['patterns']
    print(f'{"pattern":>14} {"n":>6} {"P(idx2won)":>11} {"P(idx1won)":>11} {"P(idx3won)":>11}')
    print(f'{"A->B":>14} {p["A_to_B"]["n"]:>6} {pct(p["A_to_B"]["p_idx2_won"], 11)} '
          f'{pct(p["A_to_B"]["p_idx1_won"], 11)} {"-":>11}')
    print(f'{"A->B->A":>14} {p["A_to_B_to_A"]["n"]:>6} {"-":>11} {"-":>11} '
          f'{pct(p["A_to_B_to_A"]["p_idx3_won"], 11)}')
    print(f'{"A->B->B":>14} {p["A_to_B_to_B"]["n"]:>6} {"-":>11} {"-":>11} '
          f'{pct(p["A_to_B_to_B"]["p_idx3_won"], 11)}')

    print('\n--- 3. TYPE ---')
    t = data['type']
    print(f'{"type":>18} {"n":>6} {"acc":>8} {"avg_px":>8} {"roi/bet":>8}')
    for label, key in [('first', 'first'), ('reversal', 'reversal'), ('reaffirm', 'reaffirm'),
                       ('rev:decay', 'reversal_decay'), ('rev:snap', 'reversal_snap')]:
        r = t[key]
        print(f'{label:>18} {r["n"]:>6} {pct(r["acc"])} {fmt(r["avg_price"])} {fmt(r["roi_per_bet"])}')

    print('\n--- 4. TIME x TYPE ---')
    tt = data['time_x_type']
    print(f'{"band":>12} {"type":>10} {"n":>6} {"acc":>8} {"roi/bet":>8}')
    for blabel in ['[0,60)', '[60,120)', '[120,180)', '[180,240)', '[240,300]']:
        for tname in ['first', 'reversal', 'reaffirm']:
            r = tt[blabel][tname]
            print(f'{blabel:>12} {tname:>10} {r["n"]:>6} {pct(r["acc"])} {fmt(r["roi_per_bet"])}')

    print('\n--- 5. WRONGNESS CONCENTRATION ---')
    w = data['wrongness']
    print(f'  Total lost episodes : {w["total_losses"]}')
    print(f'  Top-5  bars losses  : {w["top5_losses"]}  ({pct(w["top5_share"])})')
    print(f'  Top-10 bars losses  : {w["top10_losses"]}  ({pct(w["top10_share"])})')
    print(f'\n  Losses per day:')
    for day, cnt in w['losses_per_day'].items():
        print(f'  {str(day):>22} {cnt:>8}')
    ibn = w['intra_bar_netting']
    print(f'\n  INTRA-BAR NETTING:')
    print(f'    Mixed bars (won+lost) : {ibn["mixed_bars_count"]:>5}   combined P&L: {fmt(ibn["mixed_bars_pnl"], 10)}')
    print(f'    Single-direction bars : {ibn["single_dir_bars_count"]:>5}   combined P&L: {fmt(ibn["single_dir_bars_pnl"], 10)}')

    print('\n--- 6. FIRST vs LAST ---')
    fvl = data['first_vs_last']
    print(f'  n_bars={fvl["n_bars"]}   P(idx1 won)={pct(fvl["p_first_won"])}   '
          f'P(last won)={pct(fvl["p_last_won"])}')

    print('\n--- 7. PRICE DRIFT ---')
    pd = data['price_drift']
    print(f'{"outcome":>8} {"n_p30":>6} {"mean_p30_drift":>16} {"n_p60":>6} {"mean_p60_drift":>16}')
    for label in ['won', 'lost']:
        r = pd[label]
        print(f'{label:>8} {r["n_p30"]:>6} {fmt(r["mean_p30_drift"], 16, 4)} '
              f'{r["n_p60"]:>6} {fmt(r["mean_p60_drift"], 16, 4)}')

    print('\n--- 8. DISAGREEMENT PREVIEW (price_side < 0.50) ---')
    d = data['disagreement']
    print(f'  n={d["n"]}  acc={pct(d["acc"])}  avg_px={fmt(d["avg_price"])}  roi/bet={fmt(d["roi_per_bet"])}')


def main():
    ap = argparse.ArgumentParser(description='Sequence/timing tables over fire episodes')
    ap.add_argument('--episodes', required=True)
    ap.add_argument('--K', type=int, required=True)
    ap.add_argument('--out', required=True)
    args = ap.parse_args()

    eps = load_episodes(args.episodes, args.K)

    by_src = defaultdict(list)
    for ep in eps:
        by_src[ep.get('src', 'unknown')].append(ep)

    all_tables = {'K': args.K, 'sources': {}}

    for src in ['bq', 'live']:
        if src not in by_src:
            continue
        data = build_tables(by_src[src])
        all_tables['sources'][src] = data
        print_tables(src, data)

    with open(args.out, 'w') as f:
        json.dump(all_tables, f, indent=2, default=str)

    print(f'\n[written] {args.out}')


if __name__ == '__main__':
    main()
