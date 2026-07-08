#!/usr/bin/env python3
"""71_build_episodes.py — extract FIRE EPISODES from per-second v8 signal streams.

An episode = a directional run of the v8 tag, triggered at the K-th consecutive
same-direction tick. All fields outside `outcome` are computable at trigger time
(anti-hindsight, asserted). GLM-5.2 drafted to the locked spec; integrated as-is."""
import argparse
import json
import os
import glob
import sys
import numpy as np
from datetime import datetime, timezone


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument('--stream', required=True)
    p.add_argument('--live', required=True)
    p.add_argument('--bars', required=True)
    p.add_argument('--matrix', required=True)
    p.add_argument('--manifest', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--expect-live-k5', type=int, required=True)
    return p.parse_args()


def bar_epoch_from_slug(slug):
    tail = slug.rsplit('-', 1)[1]
    return int(tail.split('_')[0])   # live slugs carry a _v8-style suffix


def day_from_epoch(epoch):
    return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime('%Y-%m-%d')


def build_bq_bar_arrays(bar_data, bar_epoch):
    sec = bar_data['sec']
    open_price = bar_data.get('open')
    spot = [None] * 300
    up_mid_arr = [None] * 300
    for k, v in sec.items():
        e = int(k) - bar_epoch
        if 0 <= e < 300:
            spot[e] = v.get('spot_close')
            up_mid_arr[e] = v.get('up_mid')
    cushion = [None] * 300
    last = None
    for e in range(300):
        if spot[e] is not None and open_price is not None:
            last = spot[e] - open_price
        cushion[e] = last
    vol_1m = [10.0] * 300
    for e in range(300):
        start = max(0, e - 59)
        vals = [spot[i] for i in range(start, e + 1) if spot[i] is not None]
        if len(vals) >= 11:
            diffs = np.diff(np.array(vals, dtype=float))
            if len(diffs) >= 10:
                vol_1m[e] = float(np.std(diffs) * np.sqrt(60))
    return up_mid_arr, cushion, vol_1m


def identify_runs(ticks):
    runs = []
    n = len(ticks)
    i = 0
    while i < n:
        sig = ticks[i]['sig']
        if sig in ('UP', 'DOWN'):
            j = i
            while j < n and ticks[j]['sig'] == sig:
                j += 1
            runs.append((sig, i, j - 1))
            i = j
        else:
            i += 1
    return runs


def compute_max_ratio(ticks, open_indices):
    max_ratio = 0.0
    for oi in open_indices:
        cush = ticks[oi]['cushion']
        v1m = ticks[oi]['vol_1m']
        if cush is not None and v1m is not None:
            floor = max(10.0, 0.5 * v1m)
            if floor > 0:
                ratio = abs(cush) / floor
                if ratio > max_ratio:
                    max_ratio = ratio
    return max_ratio


def get_price_side(tick, direction, src):
    if src == 'bq':
        um = tick.get('up_mid')
        if um is None:
            return None
        return float(um) if direction == 'UP' else 1.0 - float(um)
    else:
        pm = tick.get('poly_mid')
        if pm is None:
            return None
        return float(pm) if direction == 'UP' else 1.0 - float(pm)


def get_feat(slug, trigger_elapsed, manifest_features, manifest_slug_idx, X):
    if trigger_elapsed < 5:
        return None
    tick_mark = (trigger_elapsed // 5) * 5
    if trigger_elapsed - tick_mark > 4:
        return None
    tick_index = tick_mark // 5 - 1
    if tick_index < 0 or tick_index >= 59:
        return None
    if slug not in manifest_slug_idx:
        return None
    slug_idx = manifest_slug_idx[slug]
    row = slug_idx * 59 + tick_index
    if row >= X.shape[0]:
        return None
    return {name: float(X[row, fi]) for fi, name in enumerate(manifest_features)}


def process_bar(ticks, slug, src, settle, bar_epoch, K_values,
                manifest_features, manifest_slug_idx, X):
    results = []
    n = len(ticks)
    runs = identify_runs(ticks)

    for K in K_values:
        eps = []
        for (direction, start, end) in runs:
            run_len = end - start + 1
            if run_len < K:
                continue
            trigger_idx = start + K - 1
            if end == n - 1:
                end_type = 'ran-to-settle'
                end_tick_idx = end
            else:
                next_sig = ticks[end + 1]['sig']
                if next_sig in ('UP', 'DOWN') and next_sig != direction:
                    end_type = 'snap'
                else:
                    end_type = 'decay'
                end_tick_idx = end + 1
            open_indices = list(range(start, end + 1))
            dur = len(open_indices)
            max_ratio = compute_max_ratio(ticks, open_indices)
            eps.append({
                'dir': direction, 'trigger_idx': trigger_idx,
                'end_tick_idx': end_tick_idx, 'end_type': end_type,
                'dur': dur, 'max_ratio': max_ratio,
            })

        first_dir = eps[0]['dir'] if eps else None

        for idx, ep in enumerate(eps, 1):
            trigger_tick = ticks[ep['trigger_idx']]
            trigger_rem = trigger_tick['rem']
            trigger_elapsed = trigger_tick['elapsed']

            price_side = get_price_side(trigger_tick, ep['dir'], src)

            # time-based (not index-based) forward prices: first tick at or past
            # trigger_rem-30/-60 — robust to occasional missing seconds
            def price_at_rem(target_rem):
                if target_rem < 0:
                    return None
                for j in range(ep['trigger_idx'] + 1, n):
                    if ticks[j]['rem'] is not None and ticks[j]['rem'] <= target_rem:
                        return get_price_side(ticks[j], ep['dir'], src)
                return None
            price_side_p30 = price_at_rem(trigger_rem - 30)
            price_side_p60 = price_at_rem(trigger_rem - 60)

            won = (ep['dir'] == settle)

            prev = None
            if idx > 1:
                prev_ep = eps[idx - 2]
                assert prev_ep['end_tick_idx'] < ep['trigger_idx'], \
                    f"prev end tick {prev_ep['end_tick_idx']} not strictly before trigger {ep['trigger_idx']}"
                gap_s = trigger_elapsed - ticks[prev_ep['end_tick_idx']]['elapsed']
                prev = {
                    'dir': prev_ep['dir'],
                    'dur': prev_ep['dur'],
                    'max_ratio': prev_ep['max_ratio'],
                    'end': prev_ep['end_type'],
                    'gap_s': gap_s,
                }

            reaffirms_first = False if idx == 1 else (ep['dir'] == first_dir)

            cush = trigger_tick.get('cushion')
            v1m = trigger_tick.get('vol_1m')
            cushion_ratio = None
            if cush is not None and v1m is not None:
                floor = max(10.0, 0.5 * v1m)
                if floor > 0:
                    cushion_ratio = abs(cush) / floor

            feat = None
            if src == 'bq':
                feat = get_feat(slug, trigger_elapsed, manifest_features, manifest_slug_idx, X)

            day = day_from_epoch(bar_epoch)

            rec = {
                'slug': slug,
                'src': src,
                'day': day,
                'K': K,
                'dir': ep['dir'],
                'idx': idx,
                'trigger_rem': trigger_rem,
                'trigger_elapsed': trigger_elapsed,
                'price_side': price_side,
                'price_side_p30': price_side_p30,
                'price_side_p60': price_side_p60,
                'won': won,
                'prev': prev,
                'reaffirms_first': reaffirms_first,
                'cushion_ratio': cushion_ratio,
                'p_flip': trigger_tick.get('p_flip'),
                'imb_ewma': trigger_tick.get('imb_ewma'),
                'feat': feat,
                'outcome': {
                    'dur': ep['dur'],
                    'end': ep['end_type'],
                    'max_ratio': ep['max_ratio'],
                },
            }
            results.append(rec)

    return results


def load_bq_ticks(stream_data, bar_data, bar_epoch):
    up_mid_arr, cushion, vol_1m = build_bq_bar_arrays(bar_data, bar_epoch)
    ticks = []
    for s in stream_data['sec']:
        rem = s['rem']
        elapsed = 300 - rem
        e = elapsed
        cush = cushion[e] if 0 <= e < 300 else None
        v1m = vol_1m[e] if 0 <= e < 300 else 10.0
        um = up_mid_arr[e] if 0 <= e < 300 else None
        ticks.append({
            'rem': rem,
            'elapsed': elapsed,
            'sig': s.get('sig'),
            'p_flip': s.get('p_flip'),
            'imb_ewma': s.get('imb_ewma'),
            'cushion': cush,
            'vol_1m': v1m,
            'up_mid': um,
        })
    return ticks


def load_live_ticks(live_data):
    rows = live_data['rows']
    settle = None
    ticks = []
    for r in rows:
        if 'settled' in r:
            settle = r['settled']
        else:
            if r.get('rem') is None:
                continue
            rem = r['rem']
            elapsed = 300 - rem
            ticks.append({
                'rem': rem,
                'elapsed': elapsed,
                'sig': r.get('signal'),
                'p_flip': r.get('p_flip'),
                'imb_ewma': r.get('imb_ewma'),
                'cushion': r.get('cushion'),
                'vol_1m': r.get('vol_1m'),
                'poly_mid': r.get('poly_mid'),
            })
    return ticks, settle


def main():
    args = parse_args()

    with open(args.manifest) as f:
        manifest = json.load(f)
    manifest_features = manifest['features']
    manifest_slugs = manifest['slugs']
    manifest_slug_idx = {s: i for i, s in enumerate(manifest_slugs)}

    matrix_data = np.load(args.matrix, allow_pickle=True)
    X = matrix_data['X']

    K_values = [3, 5, 10]

    out_dir = os.path.dirname(os.path.abspath(args.out))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    bq_bars = set()
    live_bars = set()
    episode_counts = {}
    win_counts = {}

    with open(args.out, 'w') as fout:
        stream_files = sorted(glob.glob(os.path.join(args.stream, '*.json')))
        for sf in stream_files:
            with open(sf) as f:
                stream_data = json.load(f)
            slug = stream_data['slug']
            bar_path = os.path.join(args.bars, f'{slug}.json')
            if not os.path.exists(bar_path):
                continue
            with open(bar_path) as f:
                bar_data = json.load(f)
            bar_epoch = bar_epoch_from_slug(slug)
            ticks = load_bq_ticks(stream_data, bar_data, bar_epoch)
            settle = stream_data.get('settle')
            episodes = process_bar(ticks, slug, 'bq', settle, bar_epoch, K_values,
                                   manifest_features, manifest_slug_idx, X)
            bq_bars.add(slug)
            for ep in episodes:
                fout.write(json.dumps(ep) + '\n')
                key = ('bq', ep['K'])
                episode_counts[key] = episode_counts.get(key, 0) + 1
                if ep['won']:
                    win_counts[key] = win_counts.get(key, 0) + 1

        live_files = sorted(glob.glob(os.path.join(args.live, '*-updown-5m-*_v8.json')))
        for lf in live_files:
            with open(lf) as f:
                live_data = json.load(f)
            slug = live_data['slug']
            bar_epoch = bar_epoch_from_slug(slug)
            ticks, settle = load_live_ticks(live_data)
            if settle is None:
                continue
            episodes = process_bar(ticks, slug, 'live', settle, bar_epoch, K_values,
                                   manifest_features, manifest_slug_idx, X)
            live_bars.add(slug)
            for ep in episodes:
                fout.write(json.dumps(ep) + '\n')
                key = ('live', ep['K'])
                episode_counts[key] = episode_counts.get(key, 0) + 1
                if ep['won']:
                    win_counts[key] = win_counts.get(key, 0) + 1

    for src in ['bq', 'live']:
        bars = len(bq_bars) if src == 'bq' else len(live_bars)
        for K in K_values:
            eps = episode_counts.get((src, K), 0)
            wins = win_counts.get((src, K), 0)
            acc = wins / eps if eps > 0 else 0.0
            print(f"src={src} K={K}: bars={bars} episodes={eps} wins={wins} acc={acc:.4f}")

    live_k5 = episode_counts.get(('live', 5), 0)
    if live_k5 != args.expect_live_k5:
        print(f"ERROR: live K=5 episode count {live_k5} != expected {args.expect_live_k5}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
