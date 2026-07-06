import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../engine-adapter.mjs';

test('buildInp maps tape+book to the exact inp keys the engine consumes', () => {
  const tape = { cvd_candle_usd: 1000, cvd_delta_3m: -2000, large_print_net_3m_usd: 50000,
    efficiency_3m: 3.2, price: 62050, bar_open: 62000, binance_imb: 0.14, vol_1m_usd: 20,
    perp_cvd_minus_spot_cvd_5m_usd: -60000 };
  const book = { pimb: 0.2, poly_mid: 0.55 };
  const inp = A.buildInp({ now: 1700000000000, tape, book, barOpen: 62000, remS: 210 });
  assert.equal(inp.sinceOpen, 1000);
  assert.equal(inp.price, 62050);
  assert.equal(inp.bimb, 0.14);
  assert.equal(inp.pimb, 0.2);
  assert.equal(inp.largePrints, 50000);
  assert.equal(inp.efficiency, 3.2);
  assert.equal(inp.perpSpotDiv, -60000);
  assert.equal(inp.cvd3m, -2000);
  assert.equal(inp.cushion, 50);      // price - barOpen
  assert.equal(inp.remS, 210);
  assert.equal(inp.vol1m, 20);
  assert.equal(inp.now, 1700000000000);
});

import { readFileSync, readdirSync } from 'node:fs';
test('replaying a real _v6 log through adapter+engine reproduces its signal/early_call stream', async () => {
  const dir = new URL('../../AUTOPSY/logs/', import.meta.url);
  const f = readdirSync(dir).find(x=>x.endsWith('_v6.json'));
  const doc = JSON.parse(readFileSync(new URL(f, dir)));
  const settle = doc.rows.find(r=>r.settled);
  const rows = doc.rows.filter(r=>!r.settled);
  const { mod } = await A.loadEngine('v6');
  const s = mod.newSession(); let now = 1700000000000; let mism = 0;
  for(const r of rows){
    now += 1000;
    const tape = { cvd_candle_usd:r.cvd_since_open, price:(r.cushion!=null?settle.open+r.cushion:null),
      binance_imb:r.btc_imb, large_print_net_3m_usd:r.large_prints, efficiency_3m:r.efficiency,
      perp_cvd_minus_spot_cvd_5m_usd:r.perp_spot_div, cvd_delta_3m:r.cvd_d3m, vol_1m_usd:r.vol_1m, bar_open:settle.open };
    const inp = A.buildInp({ now, tape, book:{pimb:r.poly_imb, poly_mid:r.poly_mid}, barOpen:settle.open, remS:r.rem });
    const out = mod.tick(s, inp);
    const sig = out?.decision?.sig ?? 'MIXED';
    const ec = out?.early ? out.early.side : null;
    if(sig !== r.signal || ec !== (r.early_call ?? null)) mism++;
  }
  assert.equal(mism, 0, `${mism} rows diverged from the logged stream`);
});
