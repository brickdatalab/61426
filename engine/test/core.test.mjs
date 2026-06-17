import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imbalance } from '../src/core.mjs';

test('imbalance: bid-heavy book is positive', () => {
  // mid = (100+102)/2 = 101; band 0.0012 → window ±0.1212 around 101
  // use a wide band so both near levels count
  const book = { bids: [[100.95, 3000]], asks: [[101.05, 1000]] };
  const r = imbalance(book, 0.002);
  assert.ok(r > 0, `expected positive, got ${r}`);
  assert.equal(Number(r.toFixed(2)), 0.5); // (3000-1000)/4000
});

test('imbalance: empty side returns 0', () => {
  assert.equal(imbalance({ bids: [], asks: [[101, 1000]] }), 0);
  assert.equal(imbalance({ bids: [[100, 1000]], asks: [] }), 0);
});

test('imbalance: levels outside band are excluded', () => {
  // far ask (200) is way outside band, so only the near bid counts → +1
  const book = { bids: [[100.99, 1000]], asks: [[200, 5000]] };
  assert.equal(imbalance(book, 0.002), 1);
});
