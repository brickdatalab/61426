import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookStats, PolyFeed, _backoffMs } from '../feeds/poly.mjs';

test('bookStats: ±0.06 band around mid, normalized imbalance', () => {
  const bids = [[0.52, 100], [0.40, 100]];
  const asks = [[0.54, 100], [0.70, 100]];
  const mid = (0.52 + 0.54) / 2; // 0.53
  const { imb } = bookStats(bids, asks, mid, 0.06);
  // in-band: bid 0.52 (bd=0.52*100), ask 0.54 (ad=0.54*100); 0.40 & 0.70 out of band
  assert.ok(Math.abs(imb - ((52 - 54) / (52 + 54))) < 1e-9);
});

test('backoff grows then caps at 30s', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((n) => _backoffMs(n)), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
});

test('token resolve parses clobTokenIds JSON string via Gamma', async () => {
  const fetchImpl = async (url) => {
    assert.ok(url.startsWith('https://gamma-api.polymarket.com/events?slug=btc-updown-5m-1'));
    return { ok: true, json: async () => ({ markets: [{ clobTokenIds: '["TOK1","TOK2"]' }] }) };
  };
  const timers = [];
  const f = new PolyFeed('btc-updown-5m-1', { fetchImpl, setTimer: (fn, ms) => timers.push({ fn, ms }) });
  await f.start();
  assert.equal(f._token, 'TOK1');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 1000); // token resolved -> normal poll cadence, not backoff
});

test('poll computes pimb/poly_mid from the book and sets ageMs', async () => {
  const book = {
    bids: [{ price: '0.52', size: '100' }, { price: '0.40', size: '100' }],
    asks: [{ price: '0.54', size: '100' }, { price: '0.70', size: '100' }],
  };
  const fetchImpl = async (url) => {
    if (url.includes('gamma-api')) return { ok: true, json: async () => ({ markets: [{ clobTokenIds: ['TOK1'] }] }) };
    assert.ok(url === 'https://clob.polymarket.com/book?token_id=TOK1');
    return { ok: true, json: async () => book };
  };
  const timers = [];
  const f = new PolyFeed('btc-updown-5m-1', { fetchImpl, now: () => 5000, setTimer: (fn, ms) => timers.push({ fn, ms }) });
  await f.start();
  assert.equal(timers.length, 1);
  await timers.shift().fn(); // fire the scheduled tick -> polls the book
  const l = f.latest();
  assert.ok(Math.abs(l.pimb - ((52 - 54) / (52 + 54))) < 1e-9);
  assert.equal(l.poly_mid, 0.53);
  assert.equal(l.ageMs, 0);
});

test('429/error never throws; latest stays stale; backoff advances', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('gamma-api')) return { ok: true, json: async () => ({ markets: [{ clobTokenIds: ['TOK1'] }] }) };
    return { ok: false, status: 429, json: async () => ({}) };
  };
  const timers = [];
  const f = new PolyFeed('btc-updown-5m-1', { fetchImpl, now: () => 1000, setTimer: (fn, ms) => timers.push({ fn, ms }) });
  await f.start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 1000); // token resolved fine -> first poll scheduled at normal cadence

  await assert.doesNotReject(timers.shift().fn());
  assert.equal(f.latest().pimb, null);
  assert.equal(f.latest().poly_mid, null);
  assert.equal(f.latest().ageMs, null);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 2000); // backoffN=1 -> 2000ms

  await assert.doesNotReject(timers.shift().fn());
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 4000); // backoffN=2 -> 4000ms
});

test('token-resolve failure never throws and backs off', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const timers = [];
  const f = new PolyFeed('btc-updown-5m-1', { fetchImpl, setTimer: (fn, ms) => timers.push({ fn, ms }) });
  await assert.doesNotReject(f.start());
  assert.equal(f._token, null);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 2000); // backoffN=1 after the failed resolve -> _backoffMs(1)
});
