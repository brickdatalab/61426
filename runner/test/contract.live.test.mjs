// Live API contract test — SKIPPED by default. Run on the VM before a deploy:
//   RUN_LIVE_CONTRACT=1 OWS_BASE=ws://127.0.0.1 node --test test/contract.live.test.mjs
// It hits the real Gamma / CLOB / ourWebSocket endpoints and asserts the SHAPES the
// parsers depend on. If an upstream API drifts (as Gamma's array-wrapping did), this
// fails loudly at deploy time instead of silently nulling a feed mid-run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const LIVE = process.env.RUN_LIVE_CONTRACT === '1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const ep = Math.floor(Date.now() / 300000) * 300;
const slug = `btc-updown-5m-${ep}`;

test('LIVE Gamma /events?slug= returns an ARRAY with markets[0].clobTokenIds', { skip: !LIVE }, async () => {
  const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`, { headers: { 'User-Agent': UA } });
  assert.ok(r.ok, `gamma HTTP ${r.status}`);
  const j = await r.json();
  assert.ok(Array.isArray(j), 'Gamma must return a top-level ARRAY');
  let ids = j[0]?.markets?.[0]?.clobTokenIds;
  assert.ok(ids != null, 'markets[0].clobTokenIds present');
  if (typeof ids === 'string') ids = JSON.parse(ids);
  assert.ok(Array.isArray(ids) && ids.length >= 1, 'clobTokenIds parses to a non-empty array');
});

test('LIVE CLOB /book returns bids/asks arrays of {price,size}', { skip: !LIVE }, async () => {
  const g = await (await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`, { headers: { 'User-Agent': UA } })).json();
  let ids = g[0].markets[0].clobTokenIds; if (typeof ids === 'string') ids = JSON.parse(ids);
  const book = await (await fetch(`https://clob.polymarket.com/book?token_id=${ids[0]}`)).json();
  assert.ok(Array.isArray(book.bids) && Array.isArray(book.asks), 'bids and asks are arrays');
  const sample = [...book.bids, ...book.asks][0];
  if (sample) { assert.ok('price' in sample && 'size' in sample, 'levels have price+size'); }
});

test('LIVE ourWebSocket tape message has the expected keys', { skip: !LIVE }, async () => {
  const base = process.env.OWS_BASE || 'ws://34.89.159.108';
  const msg = await new Promise((res, rej) => {
    const ws = new WebSocket(`${base}/ws/v5/tape?symbol=BTCUSDT&bar=5m`);
    const t = setTimeout(() => { ws.close(); rej(new Error('no tape message in 8s')); }, 8000);
    ws.on('message', (d) => { clearTimeout(t); ws.close(); res(JSON.parse(d.toString())); });
    ws.on('error', rej);
  });
  for (const k of ['cvd_candle_usd', 'cvd_delta_3m', 'price', 'bar_open', 'binance_imb', 'vol_1m_usd']) {
    assert.ok(k in msg.tape, `tape.${k} present`);
  }
  assert.ok(msg.perp_spot_divergence && 'perp_cvd_minus_spot_cvd_5m_usd' in msg.perp_spot_divergence, 'perp divergence present');
});
