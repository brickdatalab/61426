// engine/test/adapters.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { venueUrls, fetchVenue } from '../src/adapters.mjs';

test('venueUrls: builds correct hosts and symbols per venue', () => {
  assert.match(venueUrls('binance', 'BTC').book, /fapi\.binance\.com.*BTCUSDT/);
  assert.match(venueUrls('okx', 'ETH').trades, /okx\.com.*ETH-USDT-SWAP/);
  assert.match(venueUrls('coinbase', 'BTC').book, /exchange\.coinbase\.com.*BTC-USD/);
});

test('fetchVenue: ok=true bundles book+trades from injected fetch', async () => {
  const fake = async (url) =>
    ({ ok: true, json: async () => (String(url).includes('depth') || String(url).includes('book') ? { B: 1 } : { T: 2 }) });
  const r = await fetchVenue('binance', 'BTC', { fetchImpl: fake });
  assert.equal(r.ok, true);
  assert.ok(r.raw.book && r.raw.trades);
});

test('fetchVenue: any failure → ok=false, never throws', async () => {
  const boom = async () => { throw new Error('network'); };
  const r = await fetchVenue('okx', 'BTC', { fetchImpl: boom });
  assert.equal(r.ok, false);
  assert.equal(r.raw, null);
});

test('fetchVenue: non-OK HTTP status → ok=false', async () => {
  const blocked = async () => ({ ok: false, status: 451, json: async () => ({}) });
  const r = await fetchVenue('binance', 'BTC', { fetchImpl: blocked });
  assert.equal(r.ok, false);
});
