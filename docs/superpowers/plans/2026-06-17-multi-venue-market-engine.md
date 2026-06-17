# Multi-Venue Market Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a tested, dependency-free engine that blends Binance + OKX + Coinbase into one order-book imbalance and one 30s CVD per tick for BTC and ETH, never breaking when a venue is stale, then graft it into a new v4 dashboard without touching v1/v2/v3.

**Architecture:** A pure ES-module core (`core.mjs`) does all math and is the TDD target; thin network adapters (`adapters.mjs`) fetch each venue; a 1s loop (`engine.mjs`) wires them and emits a tick object. The core imports unchanged into both Node (tests) and the browser (v4).

**Tech Stack:** Vanilla JavaScript ES modules (`.mjs`), Node 18+ built-in `fetch`, Node built-in `node:test` + `node:assert`. Zero runtime/test dependencies.

## Global Constraints

- **Zero dependencies** — runtime and test. No `npm install`. Tests use `node:test` + `node:assert`; network uses built-in `fetch`.
- **`core.mjs` must be browser-importable** — standard JavaScript only, no Node-only APIs (no `process`, `fs`, etc.) in `core.mjs`.
- **ES modules only** — file extension `.mjs`, `import`/`export`.
- **Never modify `updown-playground.html` (v1), `updown-playground-CVDprob.html` (v2), or `updown-liquidity-overlap.html` (v3).** v4 is a new file copied from v3.
- **Imbalance band:** `0.0012` (±0.12%). **CVD window:** `30000` ms. **Fetch timeout:** `2500` ms. **Tick interval:** `1000` ms.
- **Common shapes (used by every task):**
  - `book = { bids: [[price, sizeUSD], …], asks: [[price, sizeUSD], …] }`
  - `trade = { ts: <epoch ms>, signedUSD: <+ buy aggressor / − sell aggressor> }`
  - `perVenue = { binance:{imb,cvd,fresh}, okx:{imb,cvd,fresh}, coinbase:{imb,cvd,fresh} }`
- **Node 18+** required (for global `fetch`).

---

### Task 1: Project scaffold + `imbalance()`

**Files:**
- Create: `engine/src/core.mjs`
- Test: `engine/test/core.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `imbalance(book, band = 0.0012) → number` in range −1..+1. `book` is `{bids:[[price,sizeUSD]], asks:[[price,sizeUSD]]}`. Computes mid from best bid/ask internally; sums bid USD within `[mid−mid*band, mid]` and ask USD within `[mid, mid+mid*band]`; returns `(bidUSD−askUSD)/(bidUSD+askUSD)`, or `0` if either side is empty.

- [ ] **Step 1: Write the failing test**

```js
// engine/test/core.test.mjs
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
  // tight spread: mid≈100.05, ±0.2% band ≈ [99.85, 100.25].
  // far bid at 99.0 is outside the band → excluded; in-band bid(100.0) and
  // ask(100.10) are equal → balanced → 0. Without exclusion the 99.0 bid
  // (5000) would dominate and make it strongly positive.
  const book = { bids: [[100.0, 1000], [99.0, 5000]], asks: [[100.10, 1000]] };
  assert.equal(imbalance(book, 0.002), 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test engine/test/core.test.mjs`
Expected: FAIL — `Cannot find module '../src/core.mjs'` (or `imbalance is not a function`).

- [ ] **Step 3: Write minimal implementation**

```js
// engine/src/core.mjs

export function imbalance(book, band = 0.0012) {
  const bids = book?.bids ?? [];
  const asks = book?.asks ?? [];
  if (bids.length === 0 || asks.length === 0) return 0;
  const bestBid = Math.max(...bids.map(([p]) => p));
  const bestAsk = Math.min(...asks.map(([p]) => p));
  const mid = (bestBid + bestAsk) / 2;
  const lo = mid - mid * band;
  const hi = mid + mid * band;
  let bidUSD = 0, askUSD = 0;
  for (const [p, usd] of bids) if (p >= lo) bidUSD += usd;
  for (const [p, usd] of asks) if (p <= hi) askUSD += usd;
  const tot = bidUSD + askUSD;
  return tot === 0 ? 0 : (bidUSD - askUSD) / tot;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test engine/test/core.test.mjs`
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add engine/src/core.mjs engine/test/core.test.mjs
git commit -m "feat(engine): imbalance() over a price band"
```

---

### Task 2: `cvd30s()`

**Files:**
- Modify: `engine/src/core.mjs`
- Test: `engine/test/core.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `cvd30s(trades, now, windowMs = 30000) → number`. `trades` is `[{ts, signedUSD}]`. Returns the sum of `signedUSD` for trades with `ts >= now − windowMs`. Empty → `0`.

- [ ] **Step 1: Write the failing test**

```js
// append to engine/test/core.test.mjs
import { cvd30s } from '../src/core.mjs';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test engine/test/core.test.mjs`
Expected: FAIL — `cvd30s is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
// append to engine/src/core.mjs

export function cvd30s(trades, now, windowMs = 30000) {
  const cutoff = now - windowMs;
  let sum = 0;
  for (const t of trades) if (t.ts >= cutoff) sum += t.signedUSD;
  return sum;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test engine/test/core.test.mjs`
Expected: PASS — all tests pass (6 total).

- [ ] **Step 5: Commit**

```bash
git add engine/src/core.mjs engine/test/core.test.mjs
git commit -m "feat(engine): cvd30s() rolling 30s signed flow"
```

---

### Task 3: Normalizers + fixtures (Binance, OKX, Coinbase)

**Files:**
- Modify: `engine/src/core.mjs`
- Create: `engine/test/fixtures/binance.json`, `engine/test/fixtures/okx.json`, `engine/test/fixtures/coinbase.json`
- Test: `engine/test/core.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `SYMBOLS = { binance:{BTC,ETH}, okx:{BTC,ETH}, coinbase:{BTC,ETH} }` and `OKX_CTVAL = { BTC:0.01, ETH:0.1 }`.
  - `normalizeBinance(raw, asset)`, `normalizeOkx(raw, asset)`, `normalizeCoinbase(raw, asset)` — each takes `raw = { book:<bookJSON>, trades:<tradesJSON> }` and returns the common `{ book, trades }` shape (USD notional, taker-aggressor sign).
  - `NORMALIZERS = { binance: normalizeBinance, okx: normalizeOkx, coinbase: normalizeCoinbase }`.

- [ ] **Step 1: Create the fixtures**

```json
// engine/test/fixtures/binance.json
{
  "book": {
    "bids": [["65000.0", "2.0"], ["64990.0", "1.0"]],
    "asks": [["65010.0", "3.0"], ["65020.0", "1.0"]]
  },
  "trades": [
    { "T": 1000000, "p": "65005", "q": "0.5", "m": false },
    { "T": 999000,  "p": "65001", "q": "1.0", "m": true }
  ]
}
```

```json
// engine/test/fixtures/okx.json
{
  "book": { "data": [ {
    "bids": [["65000.0", "200", "0", "5"], ["64990.0", "100", "0", "3"]],
    "asks": [["65010.0", "300", "0", "6"], ["65020.0", "100", "0", "2"]],
    "ts": "1000000"
  } ] },
  "trades": { "data": [
    { "px": "65005", "sz": "10", "side": "buy",  "ts": "1000000" },
    { "px": "65001", "sz": "5",  "side": "sell", "ts": "999000" }
  ] }
}
```

```json
// engine/test/fixtures/coinbase.json
{
  "book": {
    "bids": [["65000.00", "2.0", 3], ["64990.00", "1.0", 1]],
    "asks": [["65010.00", "3.0", 4], ["65020.00", "1.0", 1]]
  },
  "trades": [
    { "time": "2026-06-17T13:00:00.000Z", "price": "65005", "size": "0.5", "side": "sell" },
    { "time": "2026-06-17T12:59:59.000Z", "price": "65001", "size": "1.0", "side": "buy" }
  ]
}
```

- [ ] **Step 2: Write the failing test**

```js
// append to engine/test/core.test.mjs
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test engine/test/core.test.mjs`
Expected: FAIL — `normalizeBinance is not a function`.

- [ ] **Step 4: Write minimal implementation**

```js
// append to engine/src/core.mjs

export const SYMBOLS = {
  binance:  { BTC: 'BTCUSDT',       ETH: 'ETHUSDT' },
  okx:      { BTC: 'BTC-USDT-SWAP', ETH: 'ETH-USDT-SWAP' },
  coinbase: { BTC: 'BTC-USD',       ETH: 'ETH-USD' },
};
export const OKX_CTVAL = { BTC: 0.01, ETH: 0.1 };

export function normalizeBinance(raw) {
  const book = {
    bids: raw.book.bids.map(([p, q]) => [+p, +p * +q]),
    asks: raw.book.asks.map(([p, q]) => [+p, +p * +q]),
  };
  const trades = raw.trades.map((t) => ({
    ts: +t.T,
    signedUSD: (t.m ? -1 : 1) * +t.p * +t.q, // m=true: buyer is maker => sell aggressor
  }));
  return { book, trades };
}

export function normalizeOkx(raw, asset) {
  const ct = OKX_CTVAL[asset];
  const b = raw.book.data[0];
  const book = {
    bids: b.bids.map(([p, sz]) => [+p, +p * +sz * ct]),
    asks: b.asks.map(([p, sz]) => [+p, +p * +sz * ct]),
  };
  const trades = raw.trades.data.map((t) => ({
    ts: +t.ts,
    signedUSD: (t.side === 'buy' ? 1 : -1) * +t.px * +t.sz * ct,
  }));
  return { book, trades };
}

export function normalizeCoinbase(raw) {
  const book = {
    bids: raw.book.bids.map(([p, s]) => [+p, +p * +s]),
    asks: raw.book.asks.map(([p, s]) => [+p, +p * +s]),
  };
  // Coinbase Exchange trade `side` is the MAKER side; taker is the opposite.
  // side='sell' => maker sold => taker BOUGHT => +.  VERIFY live in smoke (Task 7).
  const trades = raw.trades.map((t) => ({
    ts: Date.parse(t.time),
    signedUSD: (t.side === 'sell' ? 1 : -1) * +t.price * +t.size,
  }));
  return { book, trades };
}

export const NORMALIZERS = {
  binance: normalizeBinance,
  okx: normalizeOkx,
  coinbase: normalizeCoinbase,
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test engine/test/core.test.mjs`
Expected: PASS — all tests pass (10 total).

- [ ] **Step 6: Commit**

```bash
git add engine/src/core.mjs engine/test/core.test.mjs engine/test/fixtures/
git commit -m "feat(engine): per-venue normalizers (USD notional + taker sign)"
```

---

### Task 4: `blend()`

**Files:**
- Modify: `engine/src/core.mjs`
- Test: `engine/test/core.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `blend(perVenue) → { imbalance, cvd, nFresh }`. `perVenue` is `{binance:{imb,cvd,fresh}, okx:{…}, coinbase:{…}}`. Over **fresh venues only**: `imbalance = mean(imb)` (equal weight), `cvd = sum(cvd)`, `nFresh = count`. Zero fresh → `{ imbalance:null, cvd:null, nFresh:0 }`.

- [ ] **Step 1: Write the failing test**

```js
// append to engine/test/core.test.mjs
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test engine/test/core.test.mjs`
Expected: FAIL — `blend is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
// append to engine/src/core.mjs

export function blend(perVenue) {
  const fresh = Object.values(perVenue).filter((v) => v.fresh);
  if (fresh.length === 0) return { imbalance: null, cvd: null, nFresh: 0 };
  const imbalance = fresh.reduce((s, v) => s + v.imb, 0) / fresh.length;
  const cvd = fresh.reduce((s, v) => s + v.cvd, 0);
  return { imbalance, cvd, nFresh: fresh.length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test engine/test/core.test.mjs`
Expected: PASS — all tests pass (13 total).

- [ ] **Step 5: Commit**

```bash
git add engine/src/core.mjs engine/test/core.test.mjs
git commit -m "feat(engine): blend() equal-weight imbalance + summed cvd over fresh venues"
```

---

### Task 5: `buildTick()` — orchestration logic (pure)

**Files:**
- Modify: `engine/src/core.mjs`
- Test: `engine/test/core.test.mjs`

**Interfaces:**
- Consumes: `NORMALIZERS`, `imbalance`, `cvd30s`, `blend`.
- Produces: `buildTick({ asset, now, results }) → tickObject`. `results = { binance:{ok,raw}, okx:{ok,raw}, coinbase:{ok,raw} }`. For each venue: if `ok`, normalize → `{imb: imbalance(book), cvd: cvd30s(trades, now), fresh:true}`; if `!ok` **or normalize throws**, `{imb:null,cvd:null,fresh:false}`. Output matches spec §8: `{ asset, ts, venues, blended, health }`.

- [ ] **Step 1: Write the failing test**

```js
// append to engine/test/core.test.mjs
import { buildTick } from '../src/core.mjs';

const NOW = 1000000;
const okxRaw = fx('okx');

test('buildTick: all venues ok → blended + health all true', () => {
  const t = buildTick({
    asset: 'BTC', now: NOW,
    results: {
      binance:  { ok: true, raw: fx('binance') },
      okx:      { ok: true, raw: okxRaw },
      coinbase: { ok: true, raw: fx('coinbase') },
    },
  });
  assert.equal(t.asset, 'BTC');
  assert.equal(t.ts, NOW);
  assert.equal(t.blended.nFresh, 3);
  assert.deepEqual(t.health, { binance: true, okx: true, coinbase: true });
  assert.equal(typeof t.blended.imbalance, 'number');
});

test('buildTick: a venue with ok:false is excluded, others still produce a value', () => {
  const t = buildTick({
    asset: 'BTC', now: NOW,
    results: {
      binance:  { ok: false, raw: null },     // simulated 451
      okx:      { ok: true,  raw: okxRaw },
      coinbase: { ok: true,  raw: fx('coinbase') },
    },
  });
  assert.equal(t.health.binance, false);
  assert.equal(t.blended.nFresh, 2);
  assert.ok(t.blended.imbalance !== null);
});

test('buildTick: malformed raw is caught → fresh:false, never throws', () => {
  const t = buildTick({
    asset: 'BTC', now: NOW,
    results: {
      binance:  { ok: true, raw: { book: {}, trades: [] } }, // missing bids/asks
      okx:      { ok: true, raw: okxRaw },
      coinbase: { ok: false, raw: null },
    },
  });
  assert.equal(t.health.binance, false); // normalize threw → excluded
  assert.equal(t.blended.nFresh, 1);     // only okx
});

test('buildTick: all stale → blended nulls', () => {
  const t = buildTick({
    asset: 'BTC', now: NOW,
    results: {
      binance:  { ok: false, raw: null },
      okx:      { ok: false, raw: null },
      coinbase: { ok: false, raw: null },
    },
  });
  assert.equal(t.blended.imbalance, null);
  assert.equal(t.blended.cvd, null);
  assert.equal(t.blended.nFresh, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test engine/test/core.test.mjs`
Expected: FAIL — `buildTick is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
// append to engine/src/core.mjs

const VENUES = ['binance', 'okx', 'coinbase'];

export function buildTick({ asset, now, results }) {
  const venues = {};
  for (const name of VENUES) {
    const r = results[name];
    let entry = { imb: null, cvd: null, fresh: false };
    if (r && r.ok) {
      try {
        const norm = NORMALIZERS[name](r.raw, asset);
        if (!norm.book.bids.length && !norm.book.asks.length && !norm.trades.length) {
          throw new Error('empty');
        }
        entry = { imb: imbalance(norm.book), cvd: cvd30s(norm.trades, now), fresh: true };
      } catch {
        entry = { imb: null, cvd: null, fresh: false };
      }
    }
    venues[name] = entry;
  }
  const blended = blend(venues);
  const health = {
    binance: venues.binance.fresh,
    okx: venues.okx.fresh,
    coinbase: venues.coinbase.fresh,
  };
  return { asset, ts: now, venues, blended, health };
}
```

Note: the malformed-Binance test (`{book:{}, trades:[]}`) throws inside `normalizeBinance` because `raw.book.bids` is `undefined` → `.map` throws → caught → `fresh:false`. The empty-guard also covers normalizers that return all-empty without throwing.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test engine/test/core.test.mjs`
Expected: PASS — all tests pass (17 total).

- [ ] **Step 5: Commit**

```bash
git add engine/src/core.mjs engine/test/core.test.mjs
git commit -m "feat(engine): buildTick() pure orchestration with per-venue freshness"
```

---

### Task 6: Network adapters (`adapters.mjs`)

**Files:**
- Create: `engine/src/adapters.mjs`
- Test: `engine/test/adapters.test.mjs`

**Interfaces:**
- Consumes: `SYMBOLS` from `core.mjs`.
- Produces:
  - `venueUrls(venue, asset) → { book: <url>, trades: <url> }`.
  - `fetchVenue(venue, asset, { timeoutMs = 2500, fetchImpl = fetch } ) → { ok, raw, fetchedAt }`. Fetches book + trades in parallel with an AbortController timeout; on any error/timeout/non-OK status returns `{ ok:false, raw:null, fetchedAt:Date.now() }`; on success `{ ok:true, raw:{book,trades}, fetchedAt:Date.now() }`.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test engine/test/adapters.test.mjs`
Expected: FAIL — `Cannot find module '../src/adapters.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// engine/src/adapters.mjs
import { SYMBOLS } from './core.mjs';

export function venueUrls(venue, asset) {
  const s = SYMBOLS[venue][asset];
  switch (venue) {
    case 'binance':
      return {
        book:   `https://fapi.binance.com/fapi/v1/depth?symbol=${s}&limit=100`,
        trades: `https://fapi.binance.com/fapi/v1/aggTrades?symbol=${s}&limit=1000`,
      };
    case 'okx':
      return {
        book:   `https://www.okx.com/api/v5/market/books?instId=${s}&sz=50`,
        trades: `https://www.okx.com/api/v5/market/trades?instId=${s}&limit=500`,
      };
    case 'coinbase':
      return {
        book:   `https://api.exchange.coinbase.com/products/${s}/book?level=2`,
        trades: `https://api.exchange.coinbase.com/products/${s}/trades?limit=200`,
      };
    default:
      throw new Error(`unknown venue ${venue}`);
  }
}

export async function fetchVenue(venue, asset, { timeoutMs = 2500, fetchImpl = fetch } = {}) {
  const fetchedAt = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const { book: bUrl, trades: tUrl } = venueUrls(venue, asset);
    const [bRes, tRes] = await Promise.all([
      fetchImpl(bUrl, { signal: ctrl.signal }),
      fetchImpl(tUrl, { signal: ctrl.signal }),
    ]);
    if (!bRes.ok || !tRes.ok) return { ok: false, raw: null, fetchedAt };
    const [book, trades] = await Promise.all([bRes.json(), tRes.json()]);
    return { ok: true, raw: { book, trades }, fetchedAt };
  } catch {
    return { ok: false, raw: null, fetchedAt };
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test engine/test/adapters.test.mjs`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add engine/src/adapters.mjs engine/test/adapters.test.mjs
git commit -m "feat(engine): network adapters with timeout + graceful failure"
```

---

### Task 7: Tick loop (`engine.mjs`) + live smoke check + README

**Files:**
- Create: `engine/src/engine.mjs`
- Create: `engine/smoke.mjs`
- Create: `engine/README.md`
- Test: `engine/test/engine.test.mjs`

**Interfaces:**
- Consumes: `fetchVenue` (`adapters.mjs`), `buildTick` (`core.mjs`).
- Produces: `runEngine({ asset, onTick, intervalMs = 1000, fetchVenueImpl = fetchVenue }) → stopFn`. Every `intervalMs`, fetch all three venues in parallel, call `buildTick`, invoke `onTick(tick)`. Returns a function that stops the loop.

- [ ] **Step 1: Write the failing test (uses injected fake fetchVenue + fake timer via one immediate tick)**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test engine/test/engine.test.mjs`
Expected: FAIL — `Cannot find module '../src/engine.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// engine/src/engine.mjs
import { fetchVenue } from './adapters.mjs';
import { buildTick } from './core.mjs';

const VENUES = ['binance', 'okx', 'coinbase'];

export async function runOnce({ asset, now = Date.now(), fetchVenueImpl = fetchVenue }) {
  const settled = await Promise.all(VENUES.map((v) => fetchVenueImpl(v, asset)));
  const results = {};
  VENUES.forEach((v, i) => { results[v] = settled[i]; });
  return buildTick({ asset, now, results });
}

export function runEngine({ asset, onTick, intervalMs = 1000, fetchVenueImpl = fetchVenue }) {
  let stopped = false;
  const loop = async () => {
    if (stopped) return;
    try { onTick(await runOnce({ asset, fetchVenueImpl })); } catch { /* never break the loop */ }
  };
  loop();
  const id = setInterval(loop, intervalMs);
  return () => { stopped = true; clearInterval(id); };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test engine/test/engine.test.mjs`
Expected: PASS — 2 tests pass.

- [ ] **Step 5: Run the FULL suite**

Run: `node --test engine/test/`
Expected: PASS — all suites green (core 17 + adapters 4 + engine 2).

- [ ] **Step 6: Write the live smoke check**

```js
// engine/smoke.mjs
// Live network. Run: node engine/smoke.mjs BTC   (or ETH)
import { runOnce } from './src/engine.mjs';

const asset = (process.argv[2] || 'BTC').toUpperCase();
console.log(`Live smoke: ${asset} — 8 ticks, ~1s apart\n`);
let prevMidNote = '';
for (let i = 0; i < 8; i++) {
  const t = await runOnce({ asset });
  const h = t.health;
  const dots = `B:${h.binance ? 'OK' : '--'} O:${h.okx ? 'OK' : '--'} C:${h.coinbase ? 'OK' : '--'}`;
  const imb = t.blended.imbalance == null ? '—' : t.blended.imbalance.toFixed(3);
  const cvd = t.blended.cvd == null ? '—' : Math.round(t.blended.cvd).toLocaleString();
  console.log(`#${i + 1} [${dots}] imbalance=${imb}  cvd30s=$${cvd}  (nFresh=${t.blended.nFresh})`);
  // Coinbase sign sanity: print its raw imbalance vs cvd direction for manual review
  if (t.venues.coinbase.fresh) {
    console.log(`     coinbase cvd=$${Math.round(t.venues.coinbase.cvd).toLocaleString()}  imb=${t.venues.coinbase.imb.toFixed(3)}`);
  }
  await new Promise((r) => setTimeout(r, 1000));
}
console.log('\nCoinbase sign check: over a stretch where price rises, coinbase cvd should trend POSITIVE.');
console.log('If it trends opposite to price, flip the sign in normalizeCoinbase (core.mjs) and re-run tests.');
```

- [ ] **Step 7: Run the smoke check on BTC and ETH (manual validation gate)**

Run: `node engine/smoke.mjs BTC` then `node engine/smoke.mjs ETH`
Expected: at least one venue OK each tick; `imbalance` in −1..+1; `cvd30s` a plausible dollar figure. **Manually confirm** Coinbase CVD sign tracks price direction. If inverted, flip the sign in `normalizeCoinbase`, update the Task 3 test expectation, re-run `node --test engine/test/`, and re-smoke.

- [ ] **Step 8: Write the README**

```markdown
<!-- engine/README.md -->
# Multi-Venue Market Engine

Blends Binance + OKX + Coinbase into one imbalance (equal-weight avg) and one
30s CVD (sum) per tick for BTC/ETH. Never breaks when a venue is stale.

## Run tests
    node --test engine/test/

## Live smoke check
    node engine/smoke.mjs BTC
    node engine/smoke.mjs ETH

## Use
    import { runEngine } from './engine/src/engine.mjs';
    const stop = runEngine({ asset: 'BTC', onTick: (t) => console.log(t.blended) });
    // ... stop();

Tick shape: { asset, ts, venues, blended:{imbalance,cvd,nFresh}, health }.
`core.mjs` is dependency-free and imports in both Node and the browser.
```

- [ ] **Step 9: Commit**

```bash
git add engine/src/engine.mjs engine/smoke.mjs engine/README.md engine/test/engine.test.mjs
git commit -m "feat(engine): 1s tick loop, live smoke check, README"
```

---

### Task 8: Integrate into v4 dashboard (ONLY after Tasks 1-7 green + smoke validated)

**Files:**
- Create: `updown-liquidity-overlap-v4.html` (copied byte-for-byte from `updown-liquidity-overlap.html`, then modified)
- Verify-unchanged: `updown-playground.html`, `updown-playground-CVDprob.html`, `updown-liquidity-overlap.html`

**Interfaces:**
- Consumes: `runEngine` / `runOnce` from `engine/src/engine.mjs`, which depend on `core.mjs` + `adapters.mjs`. v4 reads `tick.blended.imbalance`, `tick.blended.cvd`, and `tick.health`.

- [ ] **Step 1: Duplicate v3 → v4 (no edits yet)**

```bash
cp updown-liquidity-overlap.html updown-liquidity-overlap-v4.html
git add updown-liquidity-overlap-v4.html
git commit -m "chore(v4): byte-for-byte copy of v3 as v4 starting point"
```

- [ ] **Step 2: Confirm the copy is identical to v3**

Run: `diff updown-liquidity-overlap.html updown-liquidity-overlap-v4.html`
Expected: no output (identical).

- [ ] **Step 3: In v4 ONLY — replace the inline Binance BTC-imbalance + CVD with the engine**

In `updown-liquidity-overlap-v4.html`, inside the existing `tick()` function, the v3 code computes `bStat`/`bimb` from a single Binance depth fetch and `st.cvd` from Binance aggTrades. Replace **only** the BTC-side computation (leave the Polymarket `pStat`/`pimb` and the depth-ladder drawing exactly as-is) with a call into the engine. Add this module import near the top of the `<script>` (change the script tag to `type="module"` if it is not already, or add a separate module script):

```html
<script type="module">
  import { runOnce } from './engine/src/engine.mjs';
  window.__engineRunOnce = runOnce; // expose to the existing tick() code
</script>
```

Then, inside the existing `tick()` where `bimb` and `st.cvd` are currently set from Binance, replace those assignments with:

```js
  // v4: blended BTC imbalance (equal-weight avg) + CVD (sum) across Binance+OKX+Coinbase
  const eng = await window.__engineRunOnce({ asset: 'BTC' });
  const bimb = eng.blended.imbalance;     // was: bStat ? bStat.imb : null
  st.cvd    = eng.blended.cvd ?? 0;        // was: Binance aggTrades sum
  window.__engineHealth = eng.health;      // for the health dots (Step 4)
```

Leave `pimb` (Polymarket), `comb = (bimb+pimb)/2`, the PRIMED `sig` logic, and `drawDepth*` untouched — the blended `bimb` flows straight into the existing `comb`/signal math.

- [ ] **Step 4: In v4 ONLY — add a 3-dot venue health row**

Add to the markup (near the existing feed dots), and update it each tick from `window.__engineHealth`:

```html
<div class="feed">
  <span id="hvB" class="dot"></span>Binance
  <span id="hvO" class="dot" style="margin-left:10px"></span>OKX
  <span id="hvC" class="dot" style="margin-left:10px"></span>Coinbase
</div>
```

```js
  // in tick(), after eng is fetched:
  const H = window.__engineHealth || {};
  $('#hvB').className = 'dot ' + (H.binance ? 'ok' : 'bad');
  $('#hvO').className = 'dot ' + (H.okx ? 'ok' : 'bad');
  $('#hvC').className = 'dot ' + (H.coinbase ? 'ok' : 'bad');
```

- [ ] **Step 5: Verify v1/v2/v3 are byte-for-byte unchanged**

Run: `git status --porcelain updown-playground.html updown-playground-CVDprob.html updown-liquidity-overlap.html`
Expected: **no output** (none of the three previous versions changed). If any appears, STOP and revert it — this violates the never-break rule.

- [ ] **Step 6: Manually run v4 in the browser**

Serve the folder (so the ES module import works under `http://`, not `file://`):
Run: `cd /Users/vitolo/Desktop/61426 && python3 -m http.server 5173`
Open: `http://localhost:5173/updown-liquidity-overlap-v4.html`
Expected: BTC imbalance + CVD populate and tick every second; the 3 health dots reflect which venues are live; with a venue down, the number keeps updating from the others.

- [ ] **Step 7: Commit**

```bash
git add updown-liquidity-overlap-v4.html
git commit -m "feat(v4): blended Binance+OKX+Coinbase imbalance/CVD via engine, health dots; v1-v3 untouched"
```

---

## Self-Review

**1. Spec coverage:**
- Venues Binance/OKX/Coinbase → Tasks 3,6. ✓
- All-REST 1s → Tasks 6,7. ✓
- Equal-weight imbalance + summed CVD → Task 4. ✓
- Partial-source (blend fresh, exclude stale, health) → Tasks 5,7,8. ✓
- ±0.12% band / 30s window → Tasks 1,2 (defaults) + Global Constraints. ✓
- BTC + ETH → Task 3 (SYMBOLS/ctVal), Task 7 (smoke both). ✓
- node:test, zero deps → all tasks. ✓
- Coinbase sign risk → Task 3 test + Task 7 live gate. ✓
- Output interface §8 → Task 5. ✓
- Integration into v4, v1-v3 untouched → Task 8 (Steps 2,5 enforce). ✓
- File layout §12 → matches Tasks. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output. ✓

**3. Type consistency:** `book`/`trade` shapes, `perVenue`, tick object, and function names (`imbalance`, `cvd30s`, `normalizeBinance/Okx/Coinbase`, `NORMALIZERS`, `blend`, `buildTick`, `venueUrls`, `fetchVenue`, `runOnce`, `runEngine`) are consistent across Tasks 1-8. ✓

One fix applied inline during review: the `blend` 1-stale test asserts `(0.2+0.4)/2` to avoid floating-point brittleness; the malformed-raw path in `buildTick` is covered by both a throw and an empty-guard.
