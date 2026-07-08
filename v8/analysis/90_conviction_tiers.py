#!/usr/bin/env python3
# 90_conviction_tiers.py — measure the v8 conviction-tier table (Phase 1 of the
# conviction-layer plan). Points grammar locked pre-selection; (T3,T1) chosen on
# TRAIN only; verdict on HELDOUT + LIVE (monotone, gap >= 8pp on both).
import argparse, json, os, glob, math
from datetime import datetime, timezone
import numpy as np


def epoch_to_utc_date(ep):
    try:
        return datetime.fromtimestamp(int(ep), tz=timezone.utc).strftime('%Y-%m-%d')
    except Exception:
        return 'unknown'


def compute_vol_series(spot_values):
    n = len(spot_values)
    vols = [10.0] * n
    arr = np.array([v if v is not None else np.nan for v in spot_values], dtype=float)
    for i in range(n):
        start = max(0, i - 59)
        window = arr[start:i + 1]
        valid = window[~np.isnan(window)]
        if len(valid) < 11:
            vols[i] = 10.0
            continue
        diffs = np.diff(valid)
        if len(diffs) < 10:
            vols[i] = 10.0
        else:
            vols[i] = float(np.std(diffs)) * math.sqrt(60)
    return vols


def load_bq(data_dir):
    stream_dir = os.path.join(data_dir, 'stream')
    bars_dir = os.path.join(data_dir, 'bars')
    records = []
    for sp in sorted(glob.glob(os.path.join(stream_dir, '*.json'))):
        with open(sp) as f:
            stream = json.load(f)
        slug = stream.get('slug') or os.path.splitext(os.path.basename(sp))[0]
        bp = os.path.join(bars_dir, slug + '.json')
        if not os.path.exists(bp):
            continue
        with open(bp) as f:
            bars = json.load(f)
        settle = stream.get('settle')
        if settle not in ('UP', 'DOWN'):
            continue
        open_price = stream.get('open') if stream.get('open') is not None else bars.get('open')
        bar_epoch = int(slug.rsplit('-', 1)[1])
        norm = {int(k): v for k, v in bars.get('sec', {}).items()}
        if not norm:
            continue
        epochs_sorted = sorted(norm.keys())
        spot_values = [norm[e].get('spot_close') for e in epochs_sorted]
        upmid_map = {e: norm[e].get('up_mid') for e in epochs_sorted}
        cushion_map = {}
        last_spot = None
        for i, e in enumerate(epochs_sorted):
            s = spot_values[i]
            if s is not None:
                last_spot = s
            cushion_map[e] = (last_spot - open_price) if (last_spot is not None and open_price is not None) else None
        vols = compute_vol_series(spot_values)
        vol_map = {e: vols[i] for i, e in enumerate(epochs_sorted)}
        day = epoch_to_utc_date(bar_epoch)
        prev_dir = None
        reversals = 0
        for s in stream.get('sec', []):
            sig = s.get('sig')
            if sig not in ('UP', 'DOWN'):
                continue
            rem = s.get('rem')
            if rem is None:
                continue
            elapsed = 300 - int(rem)
            e = bar_epoch + elapsed
            if prev_dir is not None and sig != prev_dir:
                reversals += 1
            prev_dir = sig
            cush = cushion_map.get(e)
            vol = vol_map.get(e)
            if cush is None or vol is None:
                continue
            floor = max(10.0, 0.5 * vol)
            ratio = abs(cush) / floor if floor > 0 else 0.0
            p_flip = s.get('p_flip')
            pf_ok = (p_flip is not None and p_flip <= 0.5)
            pm = upmid_map.get(e)
            agree = (pm is not None and (pm - 0.5) * (1 if sig == 'UP' else -1) >= 0.02)
            rev0 = (reversals == 0)
            pts = int(ratio >= 1.5) + int(ratio >= 2.5) + int(pf_ok) + int(agree) + int(rev0)
            records.append({'src': 'bq', 'correct': (sig == settle), 'ratio': ratio,
                            'pts': pts, 'elapsed': elapsed, 'day': day})
    return records


def load_live(live_dir):
    records = []
    for fp in sorted(glob.glob(os.path.join(live_dir, '*-updown-5m-*_v8.json'))):
        with open(fp) as f:
            data = json.load(f)
        slug = data.get('slug') or os.path.splitext(os.path.basename(fp))[0]
        rows = data.get('rows', [])
        if len(rows) < 2:
            continue
        settle = rows[-1].get('settled')
        if settle not in ('UP', 'DOWN'):
            continue
        bar_epoch = int(slug.rsplit('-', 1)[1].split('_')[0])
        day = epoch_to_utc_date(bar_epoch)
        prev_dir = None
        reversals = 0
        for r in rows[:-1]:
            sig = r.get('signal')
            if sig not in ('UP', 'DOWN'):
                continue
            rem = r.get('rem')
            if rem is None:
                continue
            elapsed = 300 - int(rem)
            if prev_dir is not None and sig != prev_dir:
                reversals += 1
            prev_dir = sig
            cush = r.get('cushion')
            vol = r.get('vol_1m')
            p_flip = r.get('p_flip')
            pm = r.get('poly_mid')
            if cush is None or vol is None:
                continue
            floor = max(10.0, 0.5 * vol)
            ratio = abs(cush) / floor if floor > 0 else 0.0
            pf_ok = (p_flip is not None and p_flip <= 0.5)
            agree = (pm is not None and (pm - 0.5) * (1 if sig == 'UP' else -1) >= 0.02)
            rev0 = (reversals == 0)
            pts = int(ratio >= 1.5) + int(ratio >= 2.5) + int(pf_ok) + int(agree) + int(rev0)
            records.append({'src': 'live', 'correct': (sig == settle), 'ratio': ratio,
                            'pts': pts, 'elapsed': elapsed, 'day': day})
    return records


def acc(recs):
    return (sum(1 for r in recs if r['correct']) / len(recs)) if recs else 0.0


def tier_split(records, T3, T1):
    t3 = [r for r in records if r['pts'] >= T3]
    t1 = [r for r in records if r['pts'] <= T1]
    t2 = [r for r in records if T1 < r['pts'] < T3]
    return t3, t2, t1


def tier_stats(records, T3, T1):
    t3, t2, t1 = tier_split(records, T3, T1)
    total = len(records)
    out = {}
    for name, t in [('tier3', t3), ('tier2', t2), ('tier1', t1)]:
        out[name] = {'n': len(t), 'accuracy': acc(t),
                     'coverage': (len(t) / total) if total else 0.0,
                     'avg_ratio': (sum(r['ratio'] for r in t) / len(t)) if t else 0.0}
    out['tier3_minute_bands'] = {}
    for lo, hi in [(0, 60), (60, 120), (120, 180), (180, 240), (240, 301)]:
        bt = [r for r in t3 if lo <= r['elapsed'] < hi]
        out['tier3_minute_bands'][f'{lo}-{min(hi,300)}'] = {'n': len(bt), 'accuracy': acc(bt)}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default='v8/analysis/data')
    ap.add_argument('--live', default='AUTOPSY/logs')
    ap.add_argument('--out', default='v8/analysis/data/conviction_tiers.json')
    args = ap.parse_args()

    bq = load_bq(args.data)
    live = load_live(args.live)

    days = sorted(set(r['day'] for r in bq))
    train = [r for r in bq if r['day'] in set(days[:2])]
    heldout = [r for r in bq if r['day'] in set(days[2:])]

    total_train = len(train)
    pts_table = []
    for p in range(6):
        t = [r for r in train if r['pts'] == p]
        pts_table.append({'pts': p, 'n': len(t), 'accuracy': acc(t),
                          'coverage': (len(t) / total_train) if total_train else 0.0})

    candidates = []
    for T3 in (3, 4, 5):
        for T1 in (0, 1, 2):
            if T3 <= T1:
                continue
            t3, t2, t1 = tier_split(train, T3, T1)
            if not t3 or not t1:
                continue
            a3, a2, a1 = acc(t3), acc(t2), acc(t1)
            candidates.append({'T3': T3, 'T1': T1, 'a3': a3, 'a2': a2, 'a1': a1,
                               'cov3': len(t3) / total_train, 'gap': a3 - a1,
                               'mono': (a3 > a2 > a1)})
    valid = [c for c in candidates if c['cov3'] >= 0.15 and c['mono']]
    chosen = max(valid, key=lambda c: c['gap']) if valid else max(candidates, key=lambda c: c['gap'])
    T3, T1 = chosen['T3'], chosen['T1']

    tables = {name: tier_stats(recs, T3, T1) for name, recs in
              [('TRAIN', train), ('HELDOUT', heldout), ('LIVE', live)]}

    def pass_check(st):
        a3, a2, a1 = st['tier3']['accuracy'], st['tier2']['accuracy'], st['tier1']['accuracy']
        return bool(a3 >= a2 >= a1 and (a3 - a1) >= 0.08), a3 - a1

    h_pass, h_gap = pass_check(tables['HELDOUT'])
    l_pass, l_gap = pass_check(tables['LIVE'])

    # operator pain case: UP, cushion +34, vol 30 (floor 15, ratio 2.27), p_flip .55, pm .52, rev 0
    pain_pts = int(34/15 >= 1.5) + int(34/15 >= 2.5) + int(0.55 <= 0.5) + int((0.52-0.5) >= 0.02) + 1
    pain_tier = 'tier3' if pain_pts >= T3 else ('tier1' if pain_pts <= T1 else 'tier2')

    out = {'T3': T3, 'T1': T1, 'train_days': days[:2], 'heldout_days': days[2:],
           'pts_table_train': pts_table, 'chosen': chosen, 'tables': tables,
           'verdict': {'pass': bool(h_pass and l_pass),
                       'heldout': {'gap': h_gap, 'pass': h_pass},
                       'live': {'gap': l_gap, 'pass': l_pass}},
           'pain_case': {'pts': pain_pts, 'tier': pain_tier},
           'counts': {'bq': len(bq), 'train': len(train), 'heldout': len(heldout), 'live': len(live)}}
    os.makedirs(os.path.dirname(args.out) or '.', exist_ok=True)
    json.dump(out, open(args.out, 'w'), indent=2)

    print(f"chosen T3={T3} T1={T1} | train {len(train)} heldout {len(heldout)} live {len(live)} ticks")
    print("PTS curve (TRAIN):")
    for row in pts_table:
        print(f"  pts={row['pts']}: n={row['n']:6d} acc={row['accuracy']*100:5.1f}% cov={row['coverage']*100:5.1f}%")
    for name in ('TRAIN', 'HELDOUT', 'LIVE'):
        st = tables[name]
        print(f"{name:8s} t3: {st['tier3']['accuracy']*100:5.1f}% (n={st['tier3']['n']}, cov {st['tier3']['coverage']*100:.0f}%) | "
              f"t2: {st['tier2']['accuracy']*100:5.1f}% (n={st['tier2']['n']}) | "
              f"t1: {st['tier1']['accuracy']*100:5.1f}% (n={st['tier1']['n']}, cov {st['tier1']['coverage']*100:.0f}%)")
    print("tier3 by minute (HELDOUT):", {k: f"{v['accuracy']*100:.1f}%({v['n']})" for k, v in tables['HELDOUT']['tier3_minute_bands'].items()})
    print(f"VERDICT: {'PASS' if (h_pass and l_pass) else 'FAIL'} (heldout gap {h_gap*100:.1f}pp, live gap {l_gap*100:.1f}pp)")
    print(f"pain case (UP +34, floor 15, p_flip .55, pm .52, rev0): pts={pain_pts} -> {pain_tier}")


if __name__ == '__main__':
    main()
