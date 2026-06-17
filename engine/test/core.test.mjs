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

import { readFileSync } from 'node:fs';
import { normalizeBinance, normalizeOkx, normalizeCoinbase, OKX_CTVAL } from '../src/core.mjs';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url)));

test('normalizeBinance: USD notional + taker sign', () => {
  const out = normalizeBinance(fx('binance'), 'BTC');
  assert.equal(out.book.bids[0][0], 65000);
  assert.equal(out.book.bids[0][1], 65000 * 2.0);           // p*q USD
  // m:false => buy aggressor => +
  assert.equal(out.trades[0].signedUSD, 65005 * 0.5);
  // m:true  => sell aggressor => −
  assert.equal(out.trades[1].signedUSD, -65001 * 1.0);
});

test('normalizeOkx: contracts→USD via ctVal, side sign', () => {
  const out = normalizeOkx(fx('okx'), 'BTC');
  assert.equal(OKX_CTVAL.BTC, 0.01);
  assert.equal(out.book.bids[0][1], 65000 * 200 * 0.01);    // p*contracts*ctVal
  assert.equal(out.trades[0].signedUSD, 65005 * 10 * 0.01); // side buy => +
  assert.equal(out.trades[1].signedUSD, -65001 * 5 * 0.01); // side sell => −
});

test('normalizeOkx: ETH uses ctVal 0.1', () => {
  assert.equal(OKX_CTVAL.ETH, 0.1);
  const out = normalizeOkx(fx('okx'), 'ETH');
  assert.equal(out.book.bids[0][1], 65000 * 200 * 0.1);
});

test('normalizeCoinbase: USD notional + INVERTED maker side', () => {
  const out = normalizeCoinbase(fx('coinbase'), 'BTC');
  assert.equal(out.book.asks[0][1], 65010 * 3.0);
  // Coinbase Exchange `side` is the MAKER side: side:'sell' => taker BOUGHT => +
  assert.equal(out.trades[0].signedUSD, 65005 * 0.5);
  // side:'buy' => taker SOLD => −
  assert.equal(out.trades[1].signedUSD, -65001 * 1.0);
  assert.equal(out.trades[0].ts, Date.parse('2026-06-17T13:00:00.000Z'));
});

import { blend } from '../src/core.mjs';

test('blend: 3 fresh → equal-weight avg imbalance, summed cvd', () => {
  const r = blend({
    binance:  { imb: 0.2, cvd: 100, fresh: true },
    okx:      { imb: -0.4, cvd: 200, fresh: true },
    coinbase: { imb: 0.5, cvd: -50, fresh: true },
  });
  assert.equal(Number(r.imbalance.toFixed(6)), Number(((0.2 - 0.4 + 0.5) / 3).toFixed(6)));
  assert.equal(r.cvd, 250);
  assert.equal(r.nFresh, 3);
});

test('blend: 1 stale venue is excluded from avg and sum', () => {
  const r = blend({
    binance:  { imb: 0.2,  cvd: 100, fresh: true },
    okx:      { imb: null, cvd: null, fresh: false }, // blocked
    coinbase: { imb: 0.4,  cvd: 200, fresh: true },
  });
  assert.equal(r.imbalance, (0.2 + 0.4) / 2); // okx excluded; avg of the 2 fresh
  assert.equal(r.cvd, 300);
  assert.equal(r.nFresh, 2);
});

test('blend: zero fresh → nulls', () => {
  const r = blend({
    binance:  { imb: null, cvd: null, fresh: false },
    okx:      { imb: null, cvd: null, fresh: false },
    coinbase: { imb: null, cvd: null, fresh: false },
  });
  assert.equal(r.imbalance, null);
  assert.equal(r.cvd, null);
  assert.equal(r.nFresh, 0);
});
