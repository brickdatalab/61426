import test from 'node:test';
import assert from 'node:assert/strict';

import { rewriteSession, targetFromFilename } from './rewrite-v6-v7s-as-v8.mjs';

const base = (rem, cushion, polyMid = 0.85) => ({
  t: '12:00:00', rem,
  btc_imb: 0.1, poly_imb: 0.1, comb: 0.1,
  cushion, cvd: 100, cvd_since_open: 100,
  cvd_d5: 0, cvd_d10: 0, cvd_d60: 0, cush_d10: 0,
  mom_z: 0, mom_dir: null, imb_ewma: 0,
  large_prints: 0, efficiency: 1, perp_spot_div: 0, cvd_d3m: 0,
  vol_1m: 20, poly_mid: polyMid,
  p_flip: null, flip_alert: null, signal: 'MIXED',
  early_call: null, early_tier: null,
});

test('rewrites a V6 payload as current V8 while retaining its physical filename target', () => {
  const source = {
    slug: 'btc-updown-5m-1783347000_v6',
    rows: [
      base(250, 20),
      base(249, 5),
      base(248, 20),
      base(247, -20),
      { t: '12:05:00', settled: 'UP', open: 100000, close: 100010 },
    ],
  };

  const result = rewriteSession(source, 'btc-updown-5m-1783347000_v6.json');
  const [up, mixed, secondUp, down, settlement] = result.rows;

  assert.equal(targetFromFilename('btc-updown-5m-1783347000_v6.json').version, 'v6');
  assert.equal(result.slug, 'btc-updown-5m-1783347000_v8');
  assert.equal(up.signal, 'UP');
  assert.equal(mixed.signal, 'MIXED');
  assert.equal(secondUp.signal, 'UP');
  assert.equal(down.signal, 'DOWN');
  assert.ok('conv' in up);
  assert.equal(mixed.conv, null);
  assert.equal(secondUp.early_call, 'UP');
  assert.equal(secondUp.early_tier, 'standard');
  assert.equal(settlement.signal_up_sum, '2');
  assert.equal(settlement.signal_mixed_sum, '1');
  assert.equal(settlement.signal_down_sum, '1');
});

test('rejects filenames outside the V6 and V7s rewrite scope', () => {
  assert.throws(() => targetFromFilename('btc-updown-5m-1783347000_v8.json'));
  assert.throws(() => targetFromFilename('btc-updown-5m-1783347000_v53.json'));
});
