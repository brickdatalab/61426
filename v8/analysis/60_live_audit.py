#!/usr/bin/env python3
"""60_live_audit.py — per-tick audit of live v8 session logs (goal 2026-07-08).

Grades the engine against its own live logs the way it was built: value scoring,
split-half discipline, taxonomy of every wrong tick, counterfactual veto sweeps.
GLM-5.2 drafted; tail sections (E-result collection, F verdict, dump) completed
on integration."""
import json, glob, math, argparse, os
from collections import defaultdict

BANDS = [(300, 240), (240, 180), (180, 120), (120, 60), (60, 0)]
PREDICTED = {(300,240):67.4, (240,180):72.8, (180,120):78.8, (120,60):85.9, (60,0):92.3}


def floor_vol(vol_1m):
    return max(10.0, 0.5 * (vol_1m or 0.0))

def lead_side(cushion):
    if cushion is None:
        return None
    return 'UP' if cushion >= 0 else 'DOWN'

def u_val(poly_mid):
    if poly_mid is None:
        return 0.0
    return max(0.0, 1.0 - 2.0 * abs(poly_mid - 0.5))

def classify(sig, settled, cushion, poly_mid, rem, floor_v):
    e = rem / 300.0
    ls = lead_side(cushion)
    fire_worthy = (ls == settled) and (cushion is not None and abs(cushion) >= floor_v)
    if sig in ('UP', 'DOWN'):
        if sig == settled:
            return 'correct', u_val(poly_mid) * e
        return 'wrong', -1.0
    if sig == 'MIXED':
        if fire_worthy:
            return 'missed', -0.25
        return 'ok-mixed', 0.0
    return 'strict-missed', 0.0

def band_for(rem):
    if rem == 0:
        return (60, 0)
    for hi, lo in BANDS:
        if lo < rem <= hi:
            return (hi, lo)
    return None


def load_bars(logs_dir):
    pattern = os.path.join(logs_dir, '*-updown-5m-*_v8.json')
    bars = []
    for fpath in sorted(glob.glob(pattern)):
        try:
            with open(fpath) as f:
                data = json.load(f)
        except (json.JSONDecodeError, IOError, OSError):
            continue
        slug = data.get('slug', os.path.basename(fpath).replace('_v8.json',''))
        rows = data.get('rows', [])
        if not rows:
            continue
        settle_row = rows[-1]
        settled = settle_row.get('settled')
        if settled not in ('UP', 'DOWN'):
            continue
        ticks = []
        for i, r in enumerate(rows):
            if i == len(rows) - 1:
                continue
            if 'rem' not in r or r['rem'] is None:
                continue
            ticks.append({
                'rem': r['rem'],
                'cushion': r.get('cushion'),
                'vol_1m': r.get('vol_1m'),
                'poly_mid': r.get('poly_mid'),
                'signal': r.get('signal'),
                'imb_ewma': r.get('imb_ewma'),
                'p_flip': r.get('p_flip'),
                'floor_v': floor_vol(r.get('vol_1m')),
            })
        if ticks:
            bars.append({'slug': slug, 'settled': settled, 'ticks': ticks})
    return bars


def compute_ledger(bars, signal_fn=None):
    counts = defaultdict(int)
    value_total = 0.0
    per_bar_value = {}
    band_stats = defaultdict(lambda: {'correct':0,'wrong':0,'all':0,'value':0.0})
    for bar in bars:
        settled = bar['settled']
        bar_value = 0.0
        for t in bar['ticks']:
            sig = signal_fn(t, bar) if signal_fn else t['signal']
            bucket, val = classify(sig, settled, t['cushion'], t['poly_mid'],
                                   t['rem'], t['floor_v'])
            counts[bucket] += 1
            value_total += val
            bar_value += val
            b = band_for(t['rem'])
            if b:
                band_stats[b]['all'] += 1
                band_stats[b]['value'] += val
                if bucket in ('correct','wrong'):
                    band_stats[b][bucket] += 1
        per_bar_value[bar['slug']] = bar_value
    all_ticks = sum(counts.values())
    correct = counts['correct']
    wrong = counts['wrong']
    return {
        'counts': dict(counts),
        'value_total': value_total,
        'per_bar_value': per_bar_value,
        'band_stats': dict(band_stats),
        'all': all_ticks,
        'correct': correct,
        'wrong': wrong,
        'accuracy': correct/(correct+wrong) if (correct+wrong)>0 else 0.0,
        'coverage': (correct+wrong)/all_ticks if all_ticks>0 else 0.0,
    }


def make_veto_flip(thr):
    def fn(tick, bar):
        sig = tick['signal']
        if sig in ('UP','DOWN') and tick['p_flip'] is not None and tick['p_flip'] > thr:
            return 'MIXED'
        return sig
    return fn

def veto_imb(tick, bar):
    sig = tick['signal']
    if sig in ('UP','DOWN') and tick['imb_ewma'] is not None:
        imb = tick['imb_ewma']
        if sig == 'UP' and imb < 0 and abs(imb) > 0.2:
            return 'MIXED'
        if sig == 'DOWN' and imb > 0 and abs(imb) > 0.2:
            return 'MIXED'
    return sig


def wrong_taxonomy(bars):
    results = []
    for bar in bars:
        settled = bar['settled']
        wrong_ticks = []
        tick_buckets = []
        for t in bar['ticks']:
            bucket, _ = classify(t['signal'], settled, t['cushion'],
                                 t['poly_mid'], t['rem'], t['floor_v'])
            tick_buckets.append(bucket)
            if bucket == 'wrong':
                fv = t['floor_v']
                ratio = abs(t['cushion'])/fv if (t['cushion'] is not None and fv>0) else 0.0
                wrong_ticks.append({'rem':t['rem'],'cushion':t['cushion'],'ratio':ratio})
        if not wrong_ticks:
            continue
        max_ratio = max(wt['ratio'] for wt in wrong_ticks)
        max_run = cur = 0
        for b in tick_buckets:
            if b == 'wrong':
                cur += 1
                max_run = max(max_run, cur)
            else:
                cur = 0
        all_below_13 = all(wt['ratio'] < 1.3 for wt in wrong_ticks)
        if max_ratio >= 2.0:
            cls = 'true-flip'
        elif all_below_13 and max_run <= 30:
            cls = 'chatter'
        else:
            cls = 'boundary'
        cushions = [wt['cushion'] for wt in wrong_ticks if wt['cushion'] is not None]
        results.append({
            'slug': bar['slug'], 'settled': settled,
            'n_wrong': len(wrong_ticks), 'class': cls,
            'max_ratio': max_ratio,
            'min_cushion': min(cushions) if cushions else 0.0,
            'max_cushion': max(cushions) if cushions else 0.0,
        })
    return results


def missed_autopsy(bars):
    strict_missed = []
    near_miss = 0
    total_mixed = 0
    for bar in bars:
        settled = bar['settled']
        for t in bar['ticks']:
            sig = t['signal']
            if sig not in ('UP','DOWN','MIXED'):
                strict_missed.append({'slug': bar['slug'], 'rem': t['rem']})
            if sig == 'MIXED':
                total_mixed += 1
                ls = lead_side(t['cushion'])
                fv = t['floor_v']
                ratio = abs(t['cushion'])/fv if (t['cushion'] is not None and fv>0) else float('inf')
                if ls == settled and 0.8 <= ratio < 1.0:
                    near_miss += 1
        # strict missed (deterministic engine should never emit MIXED on fire-worthy):
    return {'strict_missed': strict_missed, 'near_miss': near_miss, 'total_mixed': total_mixed}


def split_halves(bars):
    sb = sorted(bars, key=lambda b: b['slug'])
    mid = len(sb) // 2
    return sb[:mid], sb[mid:]

def pct(x):
    return f"{x*100:.1f}%"


def main():
    ap = argparse.ArgumentParser(description='Per-tick audit of live v8 logs')
    ap.add_argument('--logs', default='AUTOPSY/logs')
    ap.add_argument('--out', default='v8/analysis/data/live_audit.json')
    args = ap.parse_args()

    bars = load_bars(args.logs)
    print(f"Loaded {len(bars)} bars from {args.logs}")
    if not bars:
        return

    base = compute_ledger(bars)
    output = {}

    print("\n=== A. LEDGER ===")
    c = base['counts']
    correct, wrong = c.get('correct',0), c.get('wrong',0)
    missed, ok_mixed = c.get('missed',0), c.get('ok-mixed',0)
    print(f"  correct {correct} | wrong {wrong} | missed {missed} | ok-mixed {ok_mixed} | total {base['all']}")
    print(f"  accuracy {pct(base['accuracy'])} | coverage {pct(base['coverage'])} | value {base['value_total']:.2f} ({base['value_total']/len(bars):.3f}/bar)")
    band_out = {}
    print(f"  {'band':>10} {'acc':>7} {'cov':>7} {'n':>6}")
    for hi, lo in BANDS:
        bs = base['band_stats'].get((hi,lo), {'correct':0,'wrong':0,'all':0,'value':0.0})
        cc, ww, nn = bs['correct'], bs['wrong'], bs['all']
        acc = cc/(cc+ww) if (cc+ww)>0 else 0.0
        cov = (cc+ww)/nn if nn>0 else 0.0
        band_out[f"{hi}-{lo}"] = {'accuracy':acc,'coverage':cov,'n':nn}
        print(f"  {hi:>4}-{lo:<4} {pct(acc):>7} {pct(cov):>7} {nn:>6}")
    output['ledger'] = {'correct':correct,'wrong':wrong,'missed':missed,'ok_mixed':ok_mixed,
                        'total':base['all'],'accuracy':base['accuracy'],'coverage':base['coverage'],
                        'value_total':base['value_total'],'bands':band_out}

    print("\n=== B. CALIBRATION vs 823-bar backtest ===")
    calib_out = {}
    for hi, lo in BANDS:
        bs = base['band_stats'].get((hi,lo), {'correct':0,'wrong':0,'all':0})
        cc, ww = bs['correct'], bs['wrong']
        actual = cc/(cc+ww)*100 if (cc+ww)>0 else 0.0
        pred = PREDICTED[(hi,lo)]
        diff = actual - pred
        flag = 'DIVERGENT' if abs(diff) > 10 else 'ok'
        calib_out[f"{hi}-{lo}"] = {'actual':actual,'predicted':pred,'diff':diff,'flag':flag}
        print(f"  {hi:>4}-{lo:<4} actual {actual:5.1f}% vs predicted {pred:5.1f}%  ({diff:+5.1f}pp) {flag}")
    output['calibration'] = calib_out

    print("\n=== C. WRONG-TICK TAXONOMY ===")
    wt = wrong_taxonomy(bars)
    class_ticks = defaultdict(int); class_bars = defaultdict(int)
    for b in wt:
        class_ticks[b['class']] += b['n_wrong']; class_bars[b['class']] += 1
    total_wt = sum(class_ticks.values())
    for cls in ('true-flip','chatter','boundary'):
        n = class_ticks.get(cls,0)
        print(f"  {cls:>10}: {n:>5} wrong ticks ({(n/total_wt*100 if total_wt else 0):.1f}%) across {class_bars.get(cls,0)} bars")
    worst = sorted(wt, key=lambda x: x['n_wrong'], reverse=True)[:5]
    print("  worst 5 bars:")
    for b in worst:
        print(f"    {b['slug']} settle={b['settled']} n_wrong={b['n_wrong']} class={b['class']} maxR={b['max_ratio']:.2f} cushion[{b['min_cushion']:.1f},{b['max_cushion']:.1f}]")
    output['wrong_taxonomy'] = {'class_ticks':dict(class_ticks),'class_bars':dict(class_bars),
                                'total_wrong_ticks':total_wt,'worst_bars':worst}

    print("\n=== D. MISSED AUTOPSY ===")
    ma = missed_autopsy(bars)
    print(f"  strict missed (should be ~0): {missed}  |  near-miss mass (lead==settle, 0.8<=ratio<1.0): {ma['near_miss']} of {ma['total_mixed']} MIXED ticks")
    if missed > 0:
        by_bar = defaultdict(int)
        for bar in bars:
            for t in bar['ticks']:
                b2, _ = classify(t['signal'], bar['settled'], t['cushion'], t['poly_mid'], t['rem'], t['floor_v'])
                if b2 == 'missed':
                    by_bar[bar['slug']] += 1
        for slug, n in sorted(by_bar.items(), key=lambda x: -x[1])[:8]:
            print(f"    {slug}: {n} missed ticks (investigate: vol/cushion mismatch vs live floor)")
    output['missed_autopsy'] = {'strict_missed_ticks':missed,'near_miss':ma['near_miss'],'total_mixed':ma['total_mixed']}

    print("\n=== E. VETO SWEEPS (counterfactual; split-half) ===")
    first_half, second_half = split_halves(bars)
    bf, bs_ = compute_ledger(first_half), compute_ledger(second_half)
    print(f"  split: {len(first_half)} + {len(second_half)} bars")
    print(f"  base 1st: acc={pct(bf['accuracy'])} val={bf['value_total']:.2f} | base 2nd: acc={pct(bs_['accuracy'])} val={bs_['value_total']:.2f}")
    veto_results = []
    print("  E1 flipRisk veto (tag->MIXED when p_flip > thr):")
    for thr in (0.55, 0.60, 0.65, 0.70, 0.75):
        fn = make_veto_flip(thr)
        l1, l2 = compute_ledger(first_half, fn), compute_ledger(second_half, fn)
        row = {'type':'flip','thr':thr,
               'h1':{'d_wrong':l1['wrong']-bf['wrong'],'d_correct':l1['correct']-bf['correct'],'d_value':l1['value_total']-bf['value_total'],'acc':l1['accuracy']},
               'h2':{'d_wrong':l2['wrong']-bs_['wrong'],'d_correct':l2['correct']-bs_['correct'],'d_value':l2['value_total']-bs_['value_total'],'acc':l2['accuracy']}}
        veto_results.append(row)
        print(f"    thr={thr:.2f} | 1st: dW={row['h1']['d_wrong']:+d} dC={row['h1']['d_correct']:+d} dV={row['h1']['d_value']:+.2f} acc={pct(row['h1']['acc'])} | 2nd: dW={row['h2']['d_wrong']:+d} dC={row['h2']['d_correct']:+d} dV={row['h2']['d_value']:+.2f} acc={pct(row['h2']['acc'])}")
    print("  E2 imb_ewma-against veto (tag->MIXED when book EWMA >0.2 against the side):")
    l1, l2 = compute_ledger(first_half, veto_imb), compute_ledger(second_half, veto_imb)
    row = {'type':'imb','thr':0.2,
           'h1':{'d_wrong':l1['wrong']-bf['wrong'],'d_correct':l1['correct']-bf['correct'],'d_value':l1['value_total']-bf['value_total'],'acc':l1['accuracy']},
           'h2':{'d_wrong':l2['wrong']-bs_['wrong'],'d_correct':l2['correct']-bs_['correct'],'d_value':l2['value_total']-bs_['value_total'],'acc':l2['accuracy']}}
    veto_results.append(row)
    print(f"    imb>0.2 | 1st: dW={row['h1']['d_wrong']:+d} dC={row['h1']['d_correct']:+d} dV={row['h1']['d_value']:+.2f} acc={pct(row['h1']['acc'])} | 2nd: dW={row['h2']['d_wrong']:+d} dC={row['h2']['d_correct']:+d} dV={row['h2']['d_value']:+.2f} acc={pct(row['h2']['acc'])}")
    output['veto_sweeps'] = veto_results

    print("\n=== F. VERDICT ===")
    flags = [v['flag'] for v in calib_out.values()]
    calib = 'ok' if all(f == 'ok' for f in flags) else 'DIVERGENT'
    mix = {cls: (class_ticks.get(cls,0)/total_wt*100 if total_wt else 0) for cls in ('true-flip','chatter','boundary')}
    best = max(veto_results, key=lambda r: r['h1']['d_value'])
    print(f"  CALIBRATION: {calib}; WRONG MIX: flip {mix['true-flip']:.0f}% / chatter {mix['chatter']:.0f}% / boundary {mix['boundary']:.0f}%; "
          f"NEAR-MISS: {ma['near_miss']} ticks; best veto (1st-half value): {best['type']}@{best['thr']} dV1={best['h1']['d_value']:+.2f}, dV2={best['h2']['d_value']:+.2f}")
    output['verdict'] = {'calibration':calib,'wrong_mix':mix,'near_miss':ma['near_miss'],
                         'best_veto':{'type':best['type'],'thr':best['thr'],'d_value_h1':best['h1']['d_value'],'d_value_h2':best['h2']['d_value']}}

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, 'w') as f:
        json.dump(output, f, indent=1)
    print(f"\nwrote {args.out}")


if __name__ == '__main__':
    main()
