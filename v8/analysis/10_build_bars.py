#!/usr/bin/env python3
import argparse
import json
import os
import glob
from collections import defaultdict
from datetime import datetime, timezone


def parse_num(v):
    if v is None or v == '':
        return None
    try:
        return float(v)
    except (ValueError, TypeError):
        return None


def parse_ts(ts):
    if not ts:
        return None
    dt = datetime.strptime(ts, '%Y-%m-%d %H:%M:%S').replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


def is_bad_quality(flag):
    if flag is None or flag == '' or flag == 'OK' or flag == 'ok' or flag == 'NO_TRADES':
        return False
    return True


def ffill(raw, max_gap=3):
    result = [None] * len(raw)
    last = None
    gap = 0
    for i, v in enumerate(raw):
        if v is not None:
            result[i] = v
            last = v
            gap = 0
        else:
            gap += 1
            if gap <= max_gap and last is not None:
                result[i] = last
            else:
                result[i] = None
    return result


def load_trades(path):
    with open(path) as f:
        rows = json.load(f)
    dedup = {}
    qflags = set()
    for r in rows:
        ts = r.get('ts_second')
        if not ts:
            continue
        epoch = parse_ts(ts)
        if epoch is None:
            continue
        venue = r.get('venue')
        qf = r.get('quality_flag')
        qflags.add(qf)
        dedup[(epoch, venue)] = r
    bad_counts = defaultdict(int)
    index = {}
    for k, r in dedup.items():
        qf = r.get('quality_flag')
        if is_bad_quality(qf):
            bad_counts[qf] += 1
            continue
        index[k] = r
    return index, qflags, bad_counts


def load_book(path):
    with open(path) as f:
        rows = json.load(f)
    dedup = {}
    qflags = set()
    for r in rows:
        ts = r.get('ts_second')
        if not ts:
            continue
        epoch = parse_ts(ts)
        if epoch is None:
            continue
        qf = r.get('quality_flag')
        qflags.add(qf)
        dedup[epoch] = r
    bad_counts = defaultdict(int)
    index = {}
    for k, r in dedup.items():
        qf = r.get('quality_flag')
        if is_bad_quality(qf):
            bad_counts[qf] += 1
            continue
        index[k] = r
    return index, qflags, bad_counts


def load_poly(path):
    with open(path) as f:
        rows = json.load(f)
    dedup = {}
    qflags = set()
    for r in rows:
        ts = r.get('ts_second')
        if not ts:
            continue
        epoch = parse_ts(ts)
        if epoch is None:
            continue
        slug = r.get('slug')
        qf = r.get('quality_flag')
        qflags.add(qf)
        dedup[(epoch, slug)] = r
    bad_counts = defaultdict(int)
    index = {}
    for k, r in dedup.items():
        qf = r.get('quality_flag')
        if is_bad_quality(qf):
            bad_counts[qf] += 1
            continue
        index[k] = r
    return index, qflags, bad_counts


def load_bq_dir(bq_dir):
    settles = {}
    for fp in glob.glob(os.path.join(bq_dir, '*_bq.json')):
        try:
            with open(fp) as f:
                obj = json.load(f)
        except Exception:
            continue
        slug = obj.get('slug')
        if not slug:
            continue
        if slug.endswith('_bq'):
            slug = slug[:-3]
        rows = obj.get('rows', [])
        settle_row = None
        for r in rows:
            if isinstance(r, dict) and 'settled' in r:
                settle_row = r
                break
        if settle_row is None:
            continue
        settles[slug] = settle_row
    return settles


def process_bar(slug, settle_row, trades_index, book_index, poly_index):
    bar_epoch = int(slug.rsplit('-', 1)[-1])
    seconds = list(range(bar_epoch, bar_epoch + 300))

    spot_present = 0
    perp_present = 0

    spot_close_raw = [None] * 300
    perp_close_raw = [None] * 300
    buy_usd = [0.0] * 300
    sell_usd = [0.0] * 300
    buy_base = [0.0] * 300
    sell_base = [0.0] * 300
    lg_buy = [0.0] * 300
    lg_sell = [0.0] * 300
    p_buy_usd = [0.0] * 300
    p_sell_usd = [0.0] * 300

    imb_raw = [None] * 300
    bid_usd_raw = [None] * 300
    ask_usd_raw = [None] * 300
    up_mid_raw = [None] * 300
    poly_imb_raw = [None] * 300

    for i, s in enumerate(seconds):
        spot = trades_index.get((s, 'spot'))
        perp = trades_index.get((s, 'perp'))
        if spot is not None:
            spot_present += 1
            spot_close_raw[i] = parse_num(spot.get('close'))
            buy_usd[i] = parse_num(spot.get('buy_vol_usd')) or 0.0
            sell_usd[i] = parse_num(spot.get('sell_vol_usd')) or 0.0
            buy_base[i] = parse_num(spot.get('buy_vol_base')) or 0.0
            sell_base[i] = parse_num(spot.get('sell_vol_base')) or 0.0
            lg_buy[i] = parse_num(spot.get('large_buy_usd')) or 0.0
            lg_sell[i] = parse_num(spot.get('large_sell_usd')) or 0.0
        if perp is not None:
            perp_present += 1
            perp_close_raw[i] = parse_num(perp.get('close'))
            p_buy_usd[i] = parse_num(perp.get('buy_vol_usd')) or 0.0
            p_sell_usd[i] = parse_num(perp.get('sell_vol_usd')) or 0.0

        book = book_index.get(s)
        if book is not None:
            imb_raw[i] = parse_num(book.get('imb'))
            bid_usd_raw[i] = parse_num(book.get('bid_usd'))
            ask_usd_raw[i] = parse_num(book.get('ask_usd'))

        poly = poly_index.get((s, slug))
        if poly is not None:
            up_mid_raw[i] = parse_num(poly.get('up_mid'))
            poly_imb_raw[i] = parse_num(poly.get('imb'))

    # carry-forward for closes (unlimited)
    spot_close = [None] * 300
    perp_close = [None] * 300
    last_spot = None
    last_perp = None
    carried = 0
    for i in range(300):
        if spot_close_raw[i] is not None:
            spot_close[i] = spot_close_raw[i]
            last_spot = spot_close_raw[i]
        else:
            if last_spot is not None:
                spot_close[i] = last_spot
                carried += 1
        if perp_close_raw[i] is not None:
            perp_close[i] = perp_close_raw[i]
            last_perp = perp_close_raw[i]
        else:
            if last_perp is not None:
                perp_close[i] = last_perp

    imb = ffill(imb_raw, 3)
    bid_usd_s = ffill(bid_usd_raw, 3)
    ask_usd_s = ffill(ask_usd_raw, 3)
    up_mid = ffill(up_mid_raw, 3)
    poly_imb = ffill(poly_imb_raw, 3)

    up_mid_valid = sum(1 for v in up_mid if v is not None)

    settle = settle_row.get('settled')
    open_p = parse_num(settle_row.get('open'))
    close_p = parse_num(settle_row.get('close'))
    if open_p is not None and close_p is not None:
        abs_move = abs(close_p - open_p)
    else:
        abs_move = None

    mismatch = False
    if open_p is not None and close_p is not None and settle in ('UP', 'DOWN'):
        if close_p > open_p:
            sign = 1
        elif close_p < open_p:
            sign = -1
        else:
            sign = 0
        expected = 1 if settle == 'UP' else -1
        if sign != expected:
            mismatch = True

    sec = {}
    for i, s in enumerate(seconds):
        sec[str(s)] = {
            'spot_close': spot_close[i],
            'perp_close': perp_close[i],
            'buy_usd': buy_usd[i],
            'sell_usd': sell_usd[i],
            'buy_base': buy_base[i],
            'sell_base': sell_base[i],
            'lg_buy': lg_buy[i],
            'lg_sell': lg_sell[i],
            'imb': imb[i],
            'up_mid': up_mid[i],
            'poly_imb': poly_imb[i],
            'bid_usd': bid_usd_s[i],
            'ask_usd': ask_usd_s[i],
            'p_buy_usd': p_buy_usd[i],
            'p_sell_usd': p_sell_usd[i],
        }

    return {
        'slug': slug,
        'bar_epoch': bar_epoch,
        'settle': settle,
        'open': open_p,
        'close': close_p,
        'abs_move': abs_move,
        'spot_present': spot_present,
        'perp_present': perp_present,
        'up_mid_valid': up_mid_valid,
        'carried': carried,
        'mismatch': mismatch,
        'out': {
            'slug': slug,
            'settle': settle,
            'open': open_p,
            'close': close_p,
            'abs_move': abs_move,
            'sec': sec,
        },
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--raw', required=True)
    ap.add_argument('--bq', required=True)
    ap.add_argument('--out', required=True)
    args = ap.parse_args()

    trades_path = os.path.join(args.raw, 'trades_1s.json')
    book_path = os.path.join(args.raw, 'book_imb_1s.json')
    poly_path = os.path.join(args.raw, 'poly_5m_1s.json')

    print('Loading trades_1s.json ...')
    trades_index, trades_qflags, trades_bad = load_trades(trades_path)
    print('  distinct quality_flag:', sorted([str(x) for x in trades_qflags]))
    print('  bad flag counts:', dict(trades_bad))

    print('Loading book_imb_1s.json ...')
    book_index, book_qflags, book_bad = load_book(book_path)
    print('  distinct quality_flag:', sorted([str(x) for x in book_qflags]))
    print('  bad flag counts:', dict(book_bad))

    print('Loading poly_5m_1s.json ...')
    poly_index, poly_qflags, poly_bad = load_poly(poly_path)
    print('  distinct quality_flag:', sorted([str(x) for x in poly_qflags]))
    print('  bad flag counts:', dict(poly_bad))

    print('Loading bq settle files ...')
    settles = load_bq_dir(args.bq)
    print('  total settle slugs:', len(settles))

    btc_slugs = [s for s in settles.keys() if s.startswith('btc-updown-5m-')]
    print('  btc slugs:', len(btc_slugs))

    bars_dir = os.path.join(args.out, 'bars')
    os.makedirs(bars_dir, exist_ok=True)

    drop_reasons = defaultdict(int)
    kept = 0
    mismatch_count = 0
    total_carried = 0
    index_list = []

    for slug in btc_slugs:
        settle_row = settles[slug]
        try:
            bar_epoch = int(slug.rsplit('-', 1)[-1])
        except ValueError:
            drop_reasons['bad_slug_epoch'] += 1
            continue

        rec = process_bar(slug, settle_row, trades_index, book_index, poly_index)

        if rec['settle'] not in ('UP', 'DOWN'):
            drop_reasons['no_settle'] += 1
            continue
        if rec['spot_present'] < 270:
            drop_reasons['spot_present_lt_270'] += 1
            continue
        # poly feed is leaky (NO_BOOK/WS_GAP); require only half-bar coverage here —
        # per-tick poly validity is enforced downstream (zero unpricedness credit when invalid)
        if rec['up_mid_valid'] < 150:
            drop_reasons['up_mid_valid_lt_150'] += 1
            continue
        if rec['perp_present'] < 270:
            drop_reasons['perp_present_lt_270'] += 1
            continue

        kept += 1
        total_carried += rec['carried']
        if rec['mismatch']:
            mismatch_count += 1

        with open(os.path.join(bars_dir, slug + '.json'), 'w') as f:
            json.dump(rec['out'], f)

        day_utc = datetime.fromtimestamp(bar_epoch, tz=timezone.utc).strftime('%Y-%m-%d')
        index_list.append({
            'slug': slug,
            'day_utc': day_utc,
            'n_sec_valid': rec['spot_present'],
            'settle': rec['settle'],
            'abs_move': rec['abs_move'],
        })

    index_list.sort(key=lambda x: int(x['slug'].rsplit('-', 1)[-1]))
    with open(os.path.join(args.out, 'bars_index.json'), 'w') as f:
        json.dump(index_list, f, indent=2)

    print('========================================')
    print('bars kept:', kept)
    print('bars dropped by reason:', dict(drop_reasons))
    print('settle mismatch count:', mismatch_count)
    print('distinct quality flags:')
    print('  trades:', sorted([str(x) for x in trades_qflags]))
    print('  book:', sorted([str(x) for x in book_qflags]))
    print('  poly:', sorted([str(x) for x in poly_qflags]))
    print('total carried-forward seconds:', total_carried)


if __name__ == '__main__':
    main()
