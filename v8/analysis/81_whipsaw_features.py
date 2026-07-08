#!/usr/bin/env python3
"""81_whipsaw_features.py — assemble the whipsaw feature matrix at FIRST-fire time.

One row per bar-with-fires (K=5, BQ): features from the 7 wfeat modules evaluated
at the FIRST fire's trigger second, plus episode-level fields. Target:
y = 1 iff the bar's grade is 'whipsaw' (it later fires the opposite direction).
Causality: T1 features see bar arrays only <= trigger; T0 features see only the
trailing 30-min pre-open window. The assembler is the single place that builds
those inputs, so the boundary is enforced here, once."""
import json, os, sys, glob, importlib.util
from datetime import datetime, timezone
import numpy as np

sys.path.insert(0, 'v8/analysis')
import feat_traj

DATA = 'v8/analysis/data'
WF = 'v8/analysis/wfeat'
MODULES = ['w1_pathgeom', 'w2_prebar', 'w3_tapebattle', 'w4_bookregime', 'w5_polyregime', 'w6_volstruct', 'w7_eth', 'w8_novel']


def load_mod(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(WF, name + '.py'))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m


def parse_ts(ts):
    return int(datetime.strptime(ts, '%Y-%m-%d %H:%M:%S').replace(tzinfo=timezone.utc).timestamp())


def main():
    mods = [load_mod(n) for n in MODULES]
    names, tiers = [], []
    for m in mods:
        for n, t in m.FEATURES:
            names.append(n); tiers.append(t)
    names += ['hour_utc', 'trigger_elapsed', 'price_side', 'p_flip_trig', 'imb_ewma_align']
    tiers += ['T0', 'T1', 'T1', 'T1', 'T1']

    labels = json.load(open(os.path.join(DATA, 'whipsaw_labels.json')))
    cont = np.load(os.path.join(DATA, 'continuous.npz'))
    c_e0 = int(cont['e0']); c_spot = cont['spot']; c_bid = cont['bid_usd']; c_ask = cont['ask_usd']; c_imb = cont['imb']

    # ETH continuous spot + per-slug mids
    eth_rows_a = json.load(open(os.path.join(DATA, 'eth', 'spot_a.json')))
    eth_rows_b = json.load(open(os.path.join(DATA, 'eth', 'spot_b.json')))
    eth_ep = {}
    for r in eth_rows_a + eth_rows_b:
        if r.get('close') is not None:
            eth_ep[parse_ts(r['ts_second'])] = float(r['close'])
    eth_poly = {}
    for r in json.load(open(os.path.join(DATA, 'eth', 'poly.json'))):
        if r.get('up_mid') is None:
            continue
        slug = r['slug']
        eth_poly.setdefault(slug, {})[parse_ts(r['ts_second'])] = float(r['up_mid'])

    def eth_series(e_from, e_to):
        out = np.full(e_to - e_from, np.nan)
        for i, ep in enumerate(range(e_from, e_to)):
            v = eth_ep.get(ep)
            if v is not None:
                out[i] = v
        return out

    # first fires per bar
    first = {}
    for line in open(os.path.join(DATA, 'episodes.jsonl')):
        e = json.loads(line)
        if e['K'] == 5 and e['src'] == 'bq' and e['idx'] == 1:
            first[e['slug']] = e

    prev_poly_var_cache = {}
    def prev_poly_var(epoch):
        if epoch in prev_poly_var_cache:
            return prev_poly_var_cache[epoch]
        pslug = None
        for s, l in labels.items():
            if l['epoch'] == epoch - 300:
                pslug = s; break
        v = np.nan
        if pslug:
            bp = os.path.join(DATA, 'bars', pslug + '.json')
            if os.path.exists(bp):
                b = json.load(open(bp))
                base = epoch - 300
                um = np.full(300, np.nan)
                for k, sv in b['sec'].items():
                    i = int(k) - base
                    if 0 <= i < 300 and sv.get('up_mid') is not None:
                        um[i] = float(sv['up_mid'])
                tail = um[-60:]; tail = tail[np.isfinite(tail)]
                if tail.size >= 10:
                    v = float(np.std(tail))
        prev_poly_var_cache[epoch] = v
        return v

    X, meta = [], []
    for slug, ep in sorted(first.items()):
        bp = os.path.join(DATA, 'bars', slug + '.json')
        if not os.path.exists(bp) or slug not in labels:
            continue
        bar_doc = json.load(open(bp))
        p = feat_traj._prepare_bar(bar_doc)
        base = labels[slug]['epoch']
        arrs = {k: np.full(300, np.nan) for k in
                ('spot', 'up_mid', 'pimb', 'imb', 'bid_usd', 'ask_usd', 'buy_usd', 'sell_usd', 'lg_buy', 'lg_sell', 'perp_close', 'p_buy_usd', 'p_sell_usd')}
        keymap = {'spot': 'spot_close', 'up_mid': 'up_mid', 'pimb': 'poly_imb', 'imb': 'imb', 'bid_usd': 'bid_usd',
                  'ask_usd': 'ask_usd', 'buy_usd': 'buy_usd', 'sell_usd': 'sell_usd', 'lg_buy': 'lg_buy',
                  'lg_sell': 'lg_sell', 'perp_close': 'perp_close', 'p_buy_usd': 'p_buy_usd', 'p_sell_usd': 'p_sell_usd'}
        for k, sv in bar_doc['sec'].items():
            i = int(k) - base
            if 0 <= i < 300:
                for a, src in keymap.items():
                    v = sv.get(src)
                    if v is not None:
                        arrs[a][i] = float(v)
        bar = dict(arrs)
        bar['cushion'] = p['cushion']
        bar['vol_1m'] = p['vol_1m']
        bar['floor'] = np.maximum(10.0, 0.5 * p['vol_1m'])
        # ETH in-bar
        bar['eth_spot_bar'] = eth_series(base, base + 300)
        em = np.full(300, np.nan)
        ep_slug = f'eth-updown-5m-{base}'
        for sec_ep, v in eth_poly.get(ep_slug, {}).items():
            i = sec_ep - base
            if 0 <= i < 300:
                em[i] = v
        bar['eth_mid_bar'] = em

        # pre window
        lo = base - 1800 - c_e0
        hi = base - c_e0
        def sl(a):
            out = np.full(1800, np.nan)
            s0, s1 = max(0, lo), min(len(a), hi)
            if s1 > s0:
                out[s0 - lo:s1 - lo] = a[s0:s1]
            return out
        prior = None
        for s, l in labels.items():
            if l['epoch'] == base - 300:
                prior = l; break
        pre = {'spot': sl(c_spot), 'bid_usd': sl(c_bid), 'ask_usd': sl(c_ask), 'imb': sl(c_imb),
               'prior_crossings': float(prior['crossings']) if prior else np.nan,
               'prior_whipsaw': (1.0 if prior['grade'] == 'whipsaw' else 0.0) if prior else np.nan,
               'prev_poly_var': prev_poly_var(base),
               'eth_spot_pre': eth_series(base - 1800, base)}

        trig = ep['trigger_elapsed']
        row = []
        for m in mods:
            out = m.compute(bar, trig, pre)
            for n, _ in m.FEATURES:
                row.append(out.get(n, np.nan))
        hour = datetime.fromtimestamp(base, tz=timezone.utc).hour
        dsign = 1 if ep['dir'] == 'UP' else -1
        imb_al = (np.sign(ep['imb_ewma']) * dsign) if ep.get('imb_ewma') is not None else np.nan
        row += [float(hour), float(trig), ep.get('price_side') if ep.get('price_side') is not None else np.nan,
                ep.get('p_flip') if ep.get('p_flip') is not None else np.nan, imb_al]
        X.append(row)
        meta.append({'slug': slug, 'day': labels[slug]['day'], 'y': 1 if labels[slug]['grade'] == 'whipsaw' else 0,
                     'fire_pnl': labels[slug]['fire_pnl'], 'dir': ep['dir'],
                     'price_side': ep.get('price_side'), 'won': ep['won']})

    X = np.array(X, dtype=np.float64)
    json.dump({'names': names, 'tiers': tiers, 'meta': meta}, open(os.path.join(DATA, 'whipsaw_feat_meta.json'), 'w'))
    np.save(os.path.join(DATA, 'whipsaw_X.npy'), X)
    nan_rate = np.isnan(X).mean(axis=0)
    print(f"rows={len(meta)} features={len(names)} y-rate={np.mean([m['y'] for m in meta]):.3f}")
    worst = sorted(zip(names, nan_rate), key=lambda x: -x[1])[:8]
    print('highest nan rates:', [(n, round(r, 2)) for n, r in worst])


if __name__ == '__main__':
    main()
