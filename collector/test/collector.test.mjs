// Collector unit tests. Run: node --test collector/test/collector.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  STREAMS, slugFor, polyStats, buildInp, buildRow, resolveOutcome, Batcher,
} from '../collector.mjs';
import * as v53 from '../engines/v53-signals.mjs';
import * as v54 from '../engines/v54-signals.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

// ---- engine copies must be byte-identical to their repo sources ----
test('engine copies are byte-identical to v5.3/v5.4 sources', (t) => {
  const pairs = [
    ['../engines/v53-signals.mjs', '../../v5.3/src/signals.mjs'],
    ['../engines/v54-signals.mjs', '../../v5.4/src/signals.mjs'],
  ];
  for (const [copy, src] of pairs) {
    if (!existsSync(here(src))) { t.skip('repo sources not present (VM deploy)'); return; }
    assert.equal(readFileSync(here(copy), 'utf8'), readFileSync(here(src), 'utf8'), `${copy} drifted from ${src}`);
  }
});

// ---- stream config + slug math ----
test('4 streams with correct slug pattern and bar seconds', () => {
  assert.equal(STREAMS.length, 4);
  const btc5 = STREAMS.find(s => s.asset === 'btc' && s.interval === '5m');
  assert.equal(btc5.symbol, 'BTCUSDT'); assert.equal(btc5.barSec, 300);
  const eth15 = STREAMS.find(s => s.asset === 'eth' && s.interval === '15m');
  assert.equal(eth15.symbol, 'ETHUSDT'); assert.equal(eth15.barSec, 900);
  assert.equal(slugFor(btc5, 1783003500), 'btc-updown-5m-1783003500');
  assert.equal(slugFor(eth15, 1783003500), 'eth-updown-15m-1783003500');
});

// ---- Polymarket book math must match the dashboard's bookStats exactly ----
test('polyStats reproduces dashboard pmid/pimb math', () => {
  // dashboard: pmid=(max bid + min ask)/2; band ±6c; bid value = price*size below mid, ask above
  const book = {
    bids: [{ price: '0.50', size: '100' }, { price: '0.40', size: '999' }],   // 0.40 outside band
    asks: [{ price: '0.54', size: '50' }, { price: '0.70', size: '999' }],    // 0.70 outside band
  };
  const { pmid, pimb } = polyStats(book);
  assert.equal(pmid, 0.52);
  const bd = 0.50 * 100, ad = 0.54 * 50;
  assert.ok(Math.abs(pimb - (bd - ad) / (bd + ad)) < 1e-12);
});

test('polyStats handles empty/missing book like the dashboard (nulls)', () => {
  assert.deepEqual(polyStats(null), { pmid: null, pimb: null });
  assert.deepEqual(polyStats({ bids: [], asks: [{ price: '0.5', size: '1' }] }), { pmid: null, pimb: null });
});

// ---- input assembly: identical object shape/values to the dashboard's sigTick call ----
test('buildInp mirrors the dashboard input object including null handling', () => {
  const sv = {
    owsImb: 0.12, last: 61500, open: 61480, owsSinceOpen: 250000,
    owsLargePrints: 120000, owsEfficiency: 0.8, owsPerpSpotDiv: -50000,
    owsCvd3m: 900000, owsVol1m: 42.5,
  };
  const inp = buildInp(sv, 1783003500123, 284, 0.05);
  assert.deepEqual(inp, {
    now: 1783003500123,
    sinceOpen: 250000, price: 61500,
    bimb: 0.12, pimb: 0.05,
    largePrints: 120000, efficiency: 0.8,
    perpSpotDiv: -50000, cvd3m: 900000,
    cushion: 20, remS: 284, vol1m: 42.5,
  });
  // nulls: no feed yet -> nulls, cushion null when either side missing (dashboard: last-open only if both != null)
  const empty = buildInp({ owsImb: null, last: null, open: null, owsSinceOpen: null, owsLargePrints: null, owsEfficiency: null, owsPerpSpotDiv: null, owsCvd3m: null, owsVol1m: null }, 1, 300, null);
  assert.equal(empty.cushion, null); assert.equal(empty.vol1m, null); assert.equal(empty.pimb, null);
});

// ---- both engines run on identical input; states independent; row carries both ----
test('dual engines: independent sessions, BAFO can diverge v54 from v53', () => {
  const s53 = v53.newSession(), s54 = v54.newSession();
  // book firmly against a fat positive cushion, flow agreeing with cushion -> v5.4 BAFO fires UP, v5.3 stays put
  const mkInp = (i) => ({
    now: 1783003400000 + i * 1000, sinceOpen: 800000 + i * 20000,   // rising CVD -> d60 > 0
    price: 61630, bimb: -0.3, pimb: -0.3,
    largePrints: 0, efficiency: 0.8, perpSpotDiv: 0, cvd3m: 800000,
    cushion: 150, remS: 200, vol1m: 20,
  });
  let g53, g54;
  for (let i = 0; i < 90; i++) {
    const inp = mkInp(i);
    g53 = v53.tick(s53, inp); g54 = v54.tick(s54, { ...inp });
  }
  assert.equal(g54.decision.sig, 'UP', 'v5.4 BAFO should fire toward the cushion');
  assert.notEqual(g53.decision.sig, 'UP', 'v5.3 has no BAFO — must not fire UP here');
  assert.notEqual(s53, s54);
});

// ---- row building: dashboard rounding, both engine outputs ----
test('buildRow uses dashboard rounding and carries paired engine fields', () => {
  const sv = {
    asset: 'btc', symbol: 'BTCUSDT', interval: '5m', slug: 'btc-updown-5m-1783003500',
    owsImb: 0.123456, last: 61500.5, open: 61480.25, owsSinceOpen: 250000.7,
    owsLargePrints: 120000.4, owsEfficiency: 0.87654, owsPerpSpotDiv: -50000.6,
    owsCvd3m: 900000.4, owsVol1m: 42.567, owsCvd1m: 33333.4,
    run53: 5, run54: 9,
  };
  const sg53 = { decision: { sig: 'MIXED', note: '', imbEwma: 0.111111, pendingSig: null }, flip: { p: 0.1234, alert: null }, momentum: { z: 1.234, dir: 'FLAT', slope: 1500.6 }, flow: { d5: 100.4, d10: 200.6, d60: 300.4 }, cush_d10: 1.26 };
  const sg54 = { decision: { sig: 'UP', note: 'bafo', imbEwma: 0.222222, pendingSig: 'UP' }, flip: { p: 0.5678, alert: 'FLIP→UP' }, momentum: sg53.momentum, flow: sg53.flow, cush_d10: 1.26 };
  const row = buildRow(sv, new Date('2026-07-02T15:00:15.500Z'), 284.4, 0.054321, 0.523456, sg53, sg54);
  assert.equal(row.symbol, 'BTC'); assert.equal(row.bar_interval, '5m');
  assert.equal(row.t, '15:00:15'); assert.equal(row.rem, 284);
  assert.equal(row.btc_imb, 0.123); assert.equal(row.poly_imb, 0.054);
  assert.equal(row.comb, +(((0.123456 + 0.054321) / 2).toFixed(3)));
  assert.equal(row.cushion, +((61500.5 - 61480.25).toFixed(2)));
  assert.equal(row.cvd, 33333);                       // Math.round(owsCvd1m), dashboard st.cvd
  assert.equal(row.cvd_since_open, 250001);
  assert.equal(row.cvd_d5, 100); assert.equal(row.cvd_d10, 201); assert.equal(row.cvd_d60, 300);
  assert.equal(row.cush_d10, 1.3);                    // +toFixed(1)
  assert.equal(row.mom_z, 1.23); assert.equal(row.mom_dir, 'FLAT');
  assert.equal(row.large_prints, 120000); assert.equal(row.efficiency, 0.877);
  assert.equal(row.perp_spot_div, -50001); assert.equal(row.cvd_d3m, 900000);
  assert.equal(row.vol_1m, 42.57); assert.equal(row.poly_mid, 0.523);
  assert.equal(row.imb_ewma_v53, 0.111); assert.equal(row.imb_ewma_v54, 0.222);
  assert.equal(row.signal_v53, 'MIXED'); assert.equal(row.signal_v54, 'UP');
  assert.equal(row.note_v54, 'bafo'); assert.equal(row.p_flip_v53, 0.123);
  assert.equal(row.p_flip_v54, 0.568); assert.equal(row.flip_alert_v54, 'FLIP→UP');
  assert.equal(row.run_v53, 5); assert.equal(row.run_v54, 9);
});

// ---- Polymarket resolution parsing ----
test('resolveOutcome parses a resolved gamma market; null while live', () => {
  const resolved = { markets: [{ outcomes: '["Up","Down"]', outcomePrices: '["0","1"]', umaResolutionStatus: 'resolved' }] };
  assert.equal(resolveOutcome(resolved), 'DOWN');
  const up = { markets: [{ outcomes: '["Up","Down"]', outcomePrices: '["1","0"]', umaResolutionStatus: 'resolved' }] };
  assert.equal(resolveOutcome(up), 'UP');
  const live = { markets: [{ outcomes: '["Up","Down"]', outcomePrices: '["0.55","0.45"]', umaResolutionStatus: '' }] };
  assert.equal(resolveOutcome(live), null);
  assert.equal(resolveOutcome(null), null);
  assert.equal(resolveOutcome({ markets: [] }), null);
});

// ---- batcher: flush on success, spool + retry on failure ----
test('Batcher flushes buffered rows; failures spool to disk and retry next flush', async () => {
  const spool = here('./tmp-spool-test.ndjson');
  rmSync(spool, { force: true });
  const inserted = [];
  let fail = true;
  const b = new Batcher({
    spoolPath: spool,
    insert: async (rows) => { if (fail) throw new Error('bq down'); inserted.push(...rows); },
  });
  b.push({ a: 1 }); b.push({ a: 2 });
  await b.flush();                                   // fails -> spooled
  assert.equal(inserted.length, 0);
  assert.ok(existsSync(spool), 'rows spooled on failure');
  fail = false;
  b.push({ a: 3 });
  await b.flush();                                   // retries spool + new row
  assert.equal(inserted.length, 3);
  assert.ok(!existsSync(spool), 'spool drained after successful flush');
  rmSync(spool, { force: true });
});
