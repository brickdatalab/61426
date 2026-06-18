import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  newSession, startBar, addTrade, tick,
  deltaAt, valAt, momentumOf, decide,
} from '../src/signals.mjs';

// ---------- helpers ----------
function series(values, stepMs = 1000, startMs = 1700000000000) {
  return values.map((v, i) => ({ t: startMs + i * stepMs, v }));
}
const T0 = 1700000000000;

// ============================================================
// 1. valAt / deltaAt — the core window lookup
// ============================================================
test('valAt: returns the value at-or-before the target time', () => {
  const h = series([10, 20, 30]);           // t = T0, T0+1s, T0+2s
  assert.equal(valAt(h, T0), 10);
  assert.equal(valAt(h, T0 + 1500), 20);    // between t1 and t2 -> t1's value
  assert.equal(valAt(h, T0 - 1), null);     // before first sample
});

test('deltaAt: current minus value ~window ago', () => {
  const h = series([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);  // 11 samples, 1s apart
  const now = T0 + 10_000;                  // last sample
  assert.equal(deltaAt(h, now, 5000), 10 - 5);   // 5s ago = index 5 -> 5
  assert.equal(deltaAt(h, now, 10000), 10 - 0);  // 10s ago = index 0 -> 0
});

test('deltaAt: null when window predates history', () => {
  const h = series([0, 1, 2]);              // only 3s of data
  assert.equal(deltaAt(h, T0 + 2000, 5000), null);  // asks for 5s ago -> none
});

// ============================================================
// 2. CVD-since-bar-open accumulator (P1.2)
// ============================================================
test('cvdSinceOpen: accumulates signed trades, resets + seeds on startBar', () => {
  const s = newSession();
  startBar(s, T0);
  addTrade(s, +500);
  addTrade(s, -200);
  addTrade(s, +300);
  assert.equal(s.cvdSinceOpen, 600);
  // new bar resets and seeds (mid-bar connect case)
  startBar(s, T0 + 300_000, 1234);
  assert.equal(s.cvdSinceOpen, 1234);
  addTrade(s, +10);
  assert.equal(s.cvdSinceOpen, 1244);
});

// ============================================================
// 3. tick() emits the full delta block + prunes history
// ============================================================
test('tick: returns deltas + momentum; cvd_d5 == cvd[i]-cvd[i-5]', () => {
  const s = newSession(); startBar(s, T0);
  const cvd = [100, 110, 120, 130, 140, 150, 160];
  let out;
  cvd.forEach((c, i) => {
    out = tick(s, { now: T0 + i * 1000, cvd30: c, price: 65000 + i });
  });
  // last tick i=6 -> cvd_d5 = cvd[6]-cvd[1] = 160-110 = 50
  assert.equal(out.cvd_d5, 50);
  assert.equal(out.cvd_d10, null);          // not enough history for 10s
  assert.equal(out.cush_d10, null);
  assert.equal(out.momentum.dir, 'FLAT');   // perfectly linear -> sd 0 -> z 0 -> FLAT
  assert.ok(out.momentum);
});

// ============================================================
// 4. momentumOf — continuation only when steep AND price-aligned
//    (the validation lesson: unaligned steep flow must NOT fire)
// ============================================================
test('momentum: UP when cvd rises steeply AND price rises', () => {
  // 30s of flat cvd (low slope dispersion), then a steep sustained rise
  const flat = Array.from({ length: 30 }, (_, i) => ({ t: T0 + i * 1000, v: 1000 + (Math.sin(i) * 5) }));
  const rise = Array.from({ length: 8 }, (_, i) => ({ t: T0 + (30 + i) * 1000, v: 1000 + i * 400 }));
  const cvdHist = [...flat, ...rise];
  const priceHist = series(Array.from({ length: 38 }, (_, i) => 65000 + i * 3), 1000, T0); // rising
  const m = momentumOf(cvdHist, priceHist, T0 + 37 * 1000);
  assert.equal(m.dir, 'UP');
  assert.ok(m.z > 1.4);
});

test('momentum: FLAT when cvd rises steeply but price does NOT confirm (unaligned)', () => {
  const flat = Array.from({ length: 30 }, (_, i) => ({ t: T0 + i * 1000, v: 1000 + (Math.sin(i) * 5) }));
  const rise = Array.from({ length: 8 }, (_, i) => ({ t: T0 + (30 + i) * 1000, v: 1000 + i * 400 }));
  const cvdHist = [...flat, ...rise];
  const priceHist = series(Array.from({ length: 38 }, (_, i) => 65000), 1000, T0); // flat price
  const m = momentumOf(cvdHist, priceHist, T0 + 37 * 1000);
  assert.equal(m.dir, 'FLAT');   // validation: do NOT predict from flow alone
});

test('momentum: DOWN when cvd falls steeply AND price falls', () => {
  const flat = Array.from({ length: 30 }, (_, i) => ({ t: T0 + i * 1000, v: 1000 }));
  const fall = Array.from({ length: 8 }, (_, i) => ({ t: T0 + (30 + i) * 1000, v: 1000 - i * 400 }));
  const cvdHist = [...flat, ...fall];
  const priceHist = series(Array.from({ length: 38 }, (_, i) => 65000 - i * 3), 1000, T0);
  const m = momentumOf(cvdHist, priceHist, T0 + 37 * 1000);
  assert.equal(m.dir, 'DOWN');
});

// ============================================================
// 5. decide() — fold momentum into the imbalance call (P1.5)
// ============================================================
test('decide: imbalance-only when momentum flat', () => {
  const r = decide({ bimb: 0.5, pimb: 0.5, comb: 0.5, momentum: { dir: 'FLAT' } });
  assert.equal(r.sig, 'UP'); assert.equal(r.note, '');
});
test('decide: momentum breaks a MIXED tie (flow-led)', () => {
  const r = decide({ bimb: 0.5, pimb: -0.5, comb: 0, momentum: { dir: 'DOWN' } });
  assert.equal(r.sig, 'DOWN'); assert.equal(r.note, 'flow-led');
});
test('decide: aligned momentum confirms', () => {
  const r = decide({ bimb: 0.5, pimb: 0.5, comb: 0.5, momentum: { dir: 'UP' } });
  assert.equal(r.sig, 'UP'); assert.equal(r.note, 'flow-confirm');
});
test('decide: opposing momentum -> MIXED (flow-vs-book)', () => {
  const r = decide({ bimb: 0.5, pimb: 0.5, comb: 0.5, momentum: { dir: 'DOWN' } });
  assert.equal(r.sig, 'MIXED'); assert.equal(r.note, 'flow-vs-book');
});

// ============================================================
// 6. Fixture replay — the canonical flip bar (P1.6)
//    cvd_d5 must reproduce fixture.cvd[i] - fixture.cvd[i-5]
// ============================================================
test('fixture replay: flip bar deltas match raw fixture series', () => {
  const fx = JSON.parse(readFileSync(new URL('../../testdata/v3-logs/btc-updown-5m-1781724300_liquidity_log.json', import.meta.url)));
  const rows = fx.rows.filter(r => 'signal' in r && r.cvd != null && r.cushion != null);
  const s = newSession(); startBar(s, T0);
  const outs = [];
  rows.forEach((r, i) => {
    const out = tick(s, { now: T0 + i * 1000, cvd30: r.cvd, price: r.cushion });
    outs.push({ i, ...out });
  });
  // pick an index deep enough for all windows
  const k = 70;
  const o = outs[k];
  // cvd_d5 == fixture cvd[k] - cvd[k-5] (1s tick spacing)
  assert.equal(o.cvd_d5, rows[k].cvd - rows[k - 5].cvd);
  assert.equal(o.cvd_d10, rows[k].cvd - rows[k - 10].cvd);
  // cush_d10 == cushion[k] - cushion[k-10]
  assert.equal(o.cush_d10, rows[k].cushion - rows[k - 10].cushion);
  // momentum dir is always a valid state
  assert.ok(['UP', 'DOWN', 'FLAT'].includes(o.momentum.dir));
  // cvd_d60 must be non-null once we have >=60s of history
  assert.notEqual(o.cvd_d60, null);
});
