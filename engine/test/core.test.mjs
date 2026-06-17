import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imbalance } from '../src/core.mjs';
import { cvd30s } from '../src/core.mjs';

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
  // tight spread: mid≈100.05, ±0.2% band ≈ [99.85, 100.25].
  // the far bid at 99.0 is outside the band → excluded; in-band bid(100.0)
  // and ask(100.10) are equal size → balanced → 0. Without band exclusion
  // the 99.0 bid (5000) would dominate and make it strongly positive.
  const book = { bids: [[100.0, 1000], [99.0, 5000]], asks: [[100.10, 1000]] };
  assert.equal(imbalance(book, 0.002), 0);
});

test('cvd30s: sums only trades inside the 30s window', () => {
  const now = 1_000_000;
  const trades = [
    { ts: now,         signedUSD: 500 },   // in
    { ts: now - 29_000, signedUSD: 300 },  // in
    { ts: now - 31_000, signedUSD: 999 },  // OUT (older than 30s)
  ];
  assert.equal(cvd30s(trades, now), 800);
});

test('cvd30s: empty trades returns 0', () => {
  assert.equal(cvd30s([], 1_000_000), 0);
});

test('cvd30s: window boundary is inclusive', () => {
  const now = 1_000_000;
  assert.equal(cvd30s([{ ts: now - 30_000, signedUSD: 42 }], now), 42);
});
