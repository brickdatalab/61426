import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newSession, tick, valAt, deltaAt, decideDebounced } from '../src/signals.mjs';

const T0 = 1700000000000;
// feed a session one sample per second from arrays of sinceOpen/price values
function feed(s, sinceOpens, prices, extra = {}) {
  let out = null;
  for (let i = 0; i < sinceOpens.length; i++) {
    out = tick(s, { now: T0 + i * 1000, sinceOpen: sinceOpens[i],
                    price: prices[i] ?? 60000, ...extra });
  }
  return out;
}

test('flow deltas come from the sinceOpen accumulator — exact, no window-exit contamination', () => {
  const s = newSession();
  // +10k flow per second for 20s -> d5 = 50k, d10 = 100k
  const so = Array.from({ length: 20 }, (_, i) => (i + 1) * 10_000);
  const r = feed(s, so, so.map(() => 60000));
  assert.equal(r.flow.d5, 50_000);
  assert.equal(r.flow.d10, 100_000);
});

test('a burst 60s ago does NOT create a phantom negative d5 now (the v5 bug)', () => {
  const s = newSession();
  // big buy burst in seconds 0-5, then perfectly flat flow
  const so = [];
  for (let i = 0; i < 5; i++) so.push((i + 1) * 200_000);   // burst to 1M
  for (let i = 0; i < 70; i++) so.push(1_000_000);           // flat for 70s
  const r = feed(s, so, so.map(() => 60000));
  assert.equal(r.flow.d5, 0);   // v5's rolling-window delta would read ~-1M here
});

test('tick returns null before data arrives (connect gate)', () => {
  const s = newSession();
  assert.equal(tick(s, { now: T0, sinceOpen: null, price: 60000 }), null);
  assert.equal(tick(s, { now: T0, sinceOpen: 5000, price: null }), null);
  // and the null ticks left no history behind
  const r = tick(s, { now: T0 + 1000, sinceOpen: 5000, price: 60000 });
  assert.equal(r.flow.d5, null);   // only one sample -> no 5s-old sample yet
});

test('cush_d10 is the 10s price change', () => {
  const s = newSession();
  const prices = Array.from({ length: 15 }, (_, i) => 60000 + i * 2); // +$2/s
  const so = prices.map((_, i) => i * 1000);
  const r = feed(s, so, prices);
  assert.equal(r.cush_d10, 20);
});

test('momentum is FLAT during warmup no matter how steep the flow', () => {
  const s = newSession();
  // 30s of violent flow + rising price — inside the 60s warmup
  const so = Array.from({ length: 30 }, (_, i) => (i + 1) * 500_000);
  const prices = Array.from({ length: 30 }, (_, i) => 60000 + i * 10);
  const r = feed(s, so, prices);
  assert.equal(r.momentum.warm, false);
  assert.equal(r.momentum.dir, 'FLAT');
  assert.equal(r.momentum.z, 0);
});

test('after warmup, sustained steep flow + aligned price fires UP', () => {
  const s = newSession();
  const so = [], prices = [];
  for (let i = 0; i < 70; i++) { so.push(i * 5_000); prices.push(60000); }        // quiet baseline past warmup
  for (let i = 0; i < 15; i++) { so.push(350_000 + (i + 1) * 100_000); prices.push(60000 + (i + 1) * 4); } // surge, price follows
  const r = feed(s, so, prices);
  assert.equal(r.momentum.warm, true);
  assert.equal(r.momentum.dir, 'UP');
  assert.ok(r.momentum.z > 2, `z=${r.momentum.z}`);
});

test('steep flow WITHOUT a real price move does not fire (adaptive gate)', () => {
  const s = newSession();
  const so = [], prices = [];
  for (let i = 0; i < 70; i++) { so.push(i * 5_000); prices.push(60000 + (i % 2)); } // $1 jitter baseline
  for (let i = 0; i < 15; i++) { so.push(350_000 + (i + 1) * 100_000); prices.push(60000 + (i % 2)); } // surge, price flat
  const r = feed(s, so, prices);
  assert.equal(r.momentum.dir, 'FLAT');
});

test('sd floor prevents z explosion in dead-quiet tape', () => {
  const s = newSession();
  // 70s of ZERO flow (sd would be 0), then one modest 5s print of $8k
  const so = [], prices = [];
  for (let i = 0; i < 70; i++) { so.push(0); prices.push(60000); }
  for (let i = 0; i < 5; i++) { so.push((i + 1) * 1600); prices.push(60000 + i * 3); }
  const r = feed(s, so, prices);
  // slope=8k, floor=5k -> z=1.6 < Z_FIRE(2.0): must not fire
  assert.equal(r.momentum.dir, 'FLAT');
  assert.ok(Math.abs(r.momentum.z) < 2, `z=${r.momentum.z}`);
});

const FLAT_MOM = { dir: 'FLAT' };

test('raw 1s imbalance jitter around the threshold does NOT flip the signal', () => {
  const s = newSession();
  // comb oscillates 0.10 <-> 0.14 every tick (the v5 killer): EWMA ~0.12 stays
  // inside the hysteresis band -> signal must stay MIXED throughout
  const sigs = new Set();
  for (let i = 0; i < 60; i++) {
    const v = i % 2 ? 0.14 : 0.10;
    sigs.add(decideDebounced(s, { bimb: v, pimb: v }, FLAT_MOM).sig);
  }
  assert.deepEqual([...sigs], ['MIXED']);
});

test('sustained strong imbalance enters UP only after EWMA>ENTER plus DWELL ticks', () => {
  const s = newSession();
  let firstUp = null;
  for (let i = 0; i < 60; i++) {
    const r = decideDebounced(s, { bimb: 0.5, pimb: 0.5 }, FLAT_MOM);
    if (r.sig === 'UP' && firstUp == null) firstUp = i;
  }
  assert.ok(firstUp != null, 'never entered UP');
  assert.ok(firstUp >= 6, `entered too fast: tick ${firstUp}`);   // 7th consecutive tick, 0-indexed
});

test('once UP, drifting back inside the band holds UP; only a real exit clears it', () => {
  const s = newSession();
  for (let i = 0; i < 60; i++) decideDebounced(s, { bimb: 0.5, pimb: 0.5 }, FLAT_MOM);
  // drift to 0.12 — between EXIT(0.08) and ENTER(0.20): must hold UP
  let r;
  for (let i = 0; i < 40; i++) r = decideDebounced(s, { bimb: 0.12, pimb: 0.12 }, FLAT_MOM);
  assert.equal(r.sig, 'UP');
  // collapse to 0 — inside EXIT: clears to MIXED (after dwell)
  for (let i = 0; i < 60; i++) r = decideDebounced(s, { bimb: 0, pimb: 0 }, FLAT_MOM);
  assert.equal(r.sig, 'MIXED');
});

test('momentum folds in: breaks MIXED ties, conflicts stand down — both through the dwell', () => {
  const s = newSession();
  // neutral book, momentum UP long enough to pass dwell -> flow-led UP
  let r;
  for (let i = 0; i < 10; i++) r = decideDebounced(s, { bimb: 0, pimb: 0 }, { dir: 'UP' });
  assert.equal(r.sig, 'UP');
  // now book goes hard DOWN while momentum still UP -> conflict -> MIXED
  for (let i = 0; i < 60; i++) r = decideDebounced(s, { bimb: -0.6, pimb: -0.6 }, { dir: 'UP' });
  assert.equal(r.sig, 'MIXED');
});
