import numpy as np

eps = 1.0

FEATURES = [
    ('flow_decel', 'T1'),
    ('imb_freshness', 'T1'),
    ('vacuum_ratio', 'T1'),
    ('eth_beta_resid', 'T1'),
    ('multi_ts_disagree', 'T1'),
    ('away_build', 'T1'),
    ('run_commit', 'T1'),
    ('poly_reprice_gap', 'T1'),
    ('whale_chase', 'T1'),
    ('whale_conflict', 'T1'),
]

def compute(bar, trig, pre):
    cushion = bar['cushion']
    floor = bar['floor']

    tb = trig
    for i in range(trig + 1):
        if np.isfinite(cushion[i]) and np.isfinite(floor[i]) and np.abs(cushion[i]) >= floor[i]:
            tb = i
            break

    d = np.sign(cushion[trig])
    if not np.isfinite(d) or d == 0:
        d = np.sign(cushion[tb])
        if not np.isfinite(d) or d == 0:
            d = 1.0

    res = {}

    # 1. flow_decel — taker-flow deceleration into the threshold (A1)
    if trig < 15:
        res['flow_decel'] = np.nan
    else:
        net = np.nan_to_num(bar['buy_usd']) - np.nan_to_num(bar['sell_usd'])
        CNT = np.array([np.sum(net[max(0, t - 4):t + 1]) for t in range(trig + 1)])
        A = CNT[trig] - CNT[trig - 5]
        B = CNT[trig - 5] - CNT[trig - 10]
        diffs = np.array([CNT[t] - CNT[t - 5] for t in range(10, trig + 1)])
        res['flow_decel'] = d * (A - B) / (np.nanstd(diffs) + eps)

    # 2. imb_freshness — recent vs long book-skew persistence toward the fire side (A3)
    imb_pre = pre['imb']
    recent = imb_pre[-60:]
    long_ = imb_pre[:-60]
    rf = recent[np.isfinite(recent)]
    lf = long_[np.isfinite(long_)]
    if len(rf) == 0 or len(lf) == 0:
        res['imb_freshness'] = np.nan
    else:
        res['imb_freshness'] = float(np.mean(np.sign(rf) == d) - np.mean(np.sign(lf) == d))

    # 3. vacuum_ratio — fire-side taker $ vs consumed-side pre-break depth (A4/B9)
    if d > 0:
        fire_side = np.nan_to_num(bar['buy_usd'])
        consumed = bar['ask_usd']
    else:
        fire_side = np.nan_to_num(bar['sell_usd'])
        consumed = bar['bid_usd']
    start = max(0, tb - 15)
    fire_sum = np.sum(fire_side[max(0, tb - 14):tb + 1])
    depth = consumed[start]
    if not np.isfinite(depth):
        res['vacuum_ratio'] = np.nan
    else:
        res['vacuum_ratio'] = float(np.log10(fire_sum / (depth + eps) + 1e-6))

    # 4. eth_beta_resid — ETH non-confirmation residual (A6)
    pre_spot = pre['spot']
    pre_eth = pre['eth_spot_pre']
    with np.errstate(all='ignore'):
        ret_spot = pre_spot[60::60] / pre_spot[:-60:60] - 1
        ret_eth = pre_eth[60::60] / pre_eth[:-60:60] - 1
    valid = np.isfinite(ret_spot) & np.isfinite(ret_eth)
    if np.sum(valid) < 2:
        res['eth_beta_resid'] = np.nan
    else:
        rs, re_ = ret_spot[valid], ret_eth[valid]
        var_spot = np.var(rs)
        if var_spot == 0:
            res['eth_beta_resid'] = np.nan
        else:
            beta = np.cov(rs, re_)[0, 1] / var_spot
            sb = max(0, tb - 30)
            spot_bar = bar['spot']; eth_bar = bar['eth_spot_bar']
            ok = (np.isfinite(spot_bar[sb]) and np.isfinite(spot_bar[trig]) and spot_bar[sb] != 0
                  and np.isfinite(eth_bar[sb]) and np.isfinite(eth_bar[trig]) and eth_bar[sb] != 0)
            if not ok:
                res['eth_beta_resid'] = np.nan
            else:
                resid = (eth_bar[trig] / eth_bar[sb] - 1) - beta * (spot_bar[trig] / spot_bar[sb] - 1)
                with np.errstate(all='ignore'):
                    p30 = pre_eth[30::30] / pre_eth[:-30:30] - 1
                p30 = p30[np.isfinite(p30)]
                res['eth_beta_resid'] = float(np.abs(resid) / (np.nanstd(p30) + 1e-6)) if p30.size else np.nan

    # 5. multi_ts_disagree — 8s vs bar-so-far taker imbalance disagreement (A8)
    net = np.nan_to_num(bar['buy_usd']) - np.nan_to_num(bar['sell_usd'])
    gross = np.nan_to_num(bar['buy_usd']) + np.nan_to_num(bar['sell_usd'])
    sS = max(0, trig - 7)
    ImbS = np.sum(net[sS:trig + 1]) / (np.sum(gross[sS:trig + 1]) + eps)
    ImbM = np.sum(net[0:trig + 1]) / (np.sum(gross[0:trig + 1]) + eps)
    res['multi_ts_disagree'] = float(d * (ImbS - ImbM))

    # 6. away_build — contra-liquidity building on the away side during the break (B1)
    if tb < 3:
        res['away_build'] = np.nan
    else:
        away = bar['bid_usd'] if d > 0 else bar['ask_usd']
        s1 = max(0, tb - 15)
        mp = np.nanmean(away[s1:tb]) if np.isfinite(away[s1:tb]).any() else np.nan
        mq = np.nanmean(away[tb:trig + 1]) if np.isfinite(away[tb:trig + 1]).any() else np.nan
        res['away_build'] = float((mq - mp) / (mp + eps)) if np.isfinite(mp) and np.isfinite(mq) else np.nan

    # 7. run_commit — current same-sign flow run vs pre-break alternation rhythm (B3)
    start = max(0, tb - 30)
    window = net[start:tb]
    signs = np.sign(window[window != 0])
    if len(signs) < 10:
        res['run_commit'] = np.nan
    else:
        runs, cur_run = [], 1
        for i in range(1, len(signs)):
            if signs[i] == signs[i - 1]:
                cur_run += 1
            else:
                runs.append(cur_run); cur_run = 1
        runs.append(cur_run)
        base = float(np.mean(runs))
        cur = 0
        for k in range(trig, -1, -1):
            s = np.sign(net[k])
            if s == 0:
                continue
            if s == d:
                cur += 1
            else:
                break
        res['run_commit'] = float((cur - base) / (base + eps))

    # 8. poly_reprice_gap — market cents conceded per unit of vol-normalized shock (B6)
    if not np.isfinite(cushion[trig]) or not np.isfinite(floor[trig]):
        res['poly_reprice_gap'] = np.nan
    else:
        break_z = np.abs(cushion[trig]) / (floor[trig] + eps)
        s0 = max(0, tb - 5)
        um = bar['up_mid']
        if not np.isfinite(um[trig]) or not np.isfinite(um[s0]):
            res['poly_reprice_gap'] = np.nan
        else:
            res['poly_reprice_gap'] = float(np.abs(um[trig] - um[s0]) / (break_z + 0.01))

    # 9. whale_chase — whale flow pre-break (positioned) vs post-break (chasing) (B7)
    lg_buy = np.nan_to_num(bar['lg_buy']); lg_sell = np.nan_to_num(bar['lg_sell'])
    w = d * (lg_buy - lg_sell)
    s0 = max(0, tb - 30)
    pre_w = np.sum(w[s0:tb]); post_w = np.sum(w[tb:trig + 1])
    res['whale_chase'] = float(post_w / (np.abs(pre_w) + np.abs(post_w) + eps))

    # 10. whale_conflict — two-sided whale gross vs net (informed disagreement) (B10)
    s0 = max(0, tb - 10)
    g = np.sum(lg_buy[s0:trig + 1] + lg_sell[s0:trig + 1])
    nn = np.abs(np.sum(lg_buy[s0:trig + 1] - lg_sell[s0:trig + 1]))
    res['whale_conflict'] = float(1 - nn / (g + eps)) if g >= 200000 else np.nan

    return res


if __name__ == '__main__':
    np.random.seed(0)
    n = 300
    bar = {k: np.random.rand(n) * 100 for k in
           ('spot', 'cushion', 'floor', 'up_mid', 'imb', 'bid_usd', 'ask_usd', 'buy_usd', 'sell_usd',
            'lg_buy', 'lg_sell', 'perp_close', 'p_buy_usd', 'p_sell_usd', 'eth_spot_bar', 'eth_mid_bar')}
    bar['cushion'] = np.random.randn(n)
    bar['floor'] = np.ones(n) * 0.5
    pre = {'spot': np.random.rand(1800) * 100, 'imb': np.random.randn(1800), 'eth_spot_pre': np.random.rand(1800) * 100}
    out = compute(bar, 50, pre)
    assert set(out.keys()) == {f[0] for f in FEATURES}
    print('SELFTEST OK')
