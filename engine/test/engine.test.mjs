// engine/test/engine.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOnce } from '../src/engine.mjs';

test('runOnce: fans out to all venues and returns a tick object', async () => {
  const calls = [];
  const fakeFetchVenue = async (venue, asset) => {
    calls.push(venue);
    return { ok: true, raw: venue === 'okx'
      ? { book: { data: [{ bids: [['100','10','0','1']], asks: [['101','10','0','1']], ts: '1' }] }, trades: { data: [] } }
      : { book: { bids: [['100','1',0]], asks: [['101','1',0]] }, trades: [] } };
  };
  const tick = await runOnce({ asset: 'BTC', now: 1000, fetchVenueImpl: fakeFetchVenue });
  assert.deepEqual(calls.sort(), ['binance', 'coinbase', 'okx']);
  assert.equal(tick.asset, 'BTC');
  assert.equal(tick.blended.nFresh, 3);
});

test('runOnce: one venue failing still yields a tick (nFresh=2)', async () => {
  const fakeFetchVenue = async (venue) =>
    venue === 'binance'
      ? { ok: false, raw: null }
      : { ok: true, raw: venue === 'okx'
          ? { book: { data: [{ bids: [['100','10','0','1']], asks: [['101','10','0','1']], ts: '1' }] }, trades: { data: [] } }
          : { book: { bids: [['100','1',0]], asks: [['101','1',0]] }, trades: [] } };
  const tick = await runOnce({ asset: 'BTC', now: 1000, fetchVenueImpl: fakeFetchVenue });
  assert.equal(tick.health.binance, false);
  assert.equal(tick.blended.nFresh, 2);
});
