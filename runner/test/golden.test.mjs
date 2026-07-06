// Golden fixtures: real captured API responses (Gamma events, CLOB book, ourWebSocket
// tape). These lock the parsing/mapping against the SHAPES the live APIs actually return
// — the class of drift that let the PolyFeed Gamma-array bug ship past the hand-written
// unit fixtures. Captured 2026-07-06 from the live BTC 5m market.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PolyFeed } from '../feeds/poly.mjs';
import { OwsFeed } from '../feeds/ows.mjs';
import { buildInp } from '../engine-adapter.mjs';

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = (f) => JSON.parse(readFileSync(path.join(FX, f), 'utf8'));

test('golden: PolyFeed resolves the token from the REAL array-wrapped Gamma response', async () => {
  const gamma = load('gamma_events.json');
  assert.ok(Array.isArray(gamma), 'fixture is array-shaped (the real Gamma shape)');
  let ids = gamma[0].markets[0].clobTokenIds;
  if (typeof ids === 'string') ids = JSON.parse(ids);
  const expected = ids[0];
  const f = new PolyFeed('btc-updown-5m-1', { fetchImpl: async () => ({ ok: true, json: async () => gamma }) });
  await f._resolveToken();
  assert.equal(f._token, expected); // would be null under the old j.markets (non-unwrapped) code
});

test('golden: PolyFeed handles a REAL one-sided book (empty bids) gracefully → null, no throw', async () => {
  const book = load('clob_book.json'); // captured with bids:[] (near-resolved market)
  const f = new PolyFeed('btc-updown-5m-1', { fetchImpl: async () => ({ ok: true, json: async () => book }) });
  f._token = 'TOK';
  await assert.doesNotReject(() => f._pollBook());
  assert.equal(f._pimb, null);
  assert.equal(f._polyMid, null);
});

test('golden: OwsFeed maps the REAL tape message + merges perp divergence; buildInp is faithful', () => {
  const msg = load('ows_tape.json');
  let handlers = {};
  const f = new OwsFeed('BTCUSDT', '5m', { wsFactory: () => ({ on: (e, cb) => { handlers[e] = cb; }, close() {}, terminate() {} }), now: () => 1000 });
  f.start();
  handlers.message(JSON.stringify(msg));
  const { tape } = f.latest();
  assert.equal(tape.cvd_candle_usd, msg.tape.cvd_candle_usd);
  assert.equal(tape.binance_imb, msg.tape.binance_imb);
  // perp_spot_divergence.perp_cvd_minus_spot_cvd_5m_usd is merged up into tape
  assert.equal(tape.perp_cvd_minus_spot_cvd_5m_usd, msg.perp_spot_divergence.perp_cvd_minus_spot_cvd_5m_usd);
  const inp = buildInp({ now: 1000, tape, book: { pimb: null, poly_mid: null }, barOpen: tape.bar_open, remS: 100 });
  assert.equal(inp.sinceOpen, msg.tape.cvd_candle_usd);
  assert.equal(inp.bimb, msg.tape.binance_imb);
  assert.equal(inp.perpSpotDiv, msg.perp_spot_divergence.perp_cvd_minus_spot_cvd_5m_usd);
  assert.ok(Math.abs(inp.cushion - (msg.tape.price - msg.tape.bar_open)) < 1e-9);
});
