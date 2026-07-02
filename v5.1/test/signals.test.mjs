import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newSession, tick, valAt, deltaAt } from '../src/signals.mjs';

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
