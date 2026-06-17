# Multi-Venue Market Engine — Design Spec

**Date:** 2026-06-17
**Status:** Approved design, pending spec review → writing-plans
**Owner:** brickdatalab / 61426

---

## 1. Context & Problem

The up/down dashboards compute two BTC/ETH metrics: **order-book imbalance** and **CVD** (cumulative volume delta / signed taker flow). Today (v3, `updown-liquidity-overlap.html`) both come from **Binance only**. That means:

- When Binance is geoblocked (HTTP 451 from a US IP with no VPN), both metrics go blank — the dashboard is dead.
- A single-venue order book is trivially **spoofable** — a fake wall on one exchange swings the imbalance.
- The reading reflects one venue, not the market.

This spec defines a **standalone, test-driven data engine** that blends **Binance + OKX + Coinbase** into one imbalance number and one CVD number, accurately, on every 1-second tick, for **BTC and ETH**, that never breaks if a venue hiccups.

The engine is built and proven **in isolation first**, then integrated into a new **v4** dashboard (a duplicate of v3). v1/v2/v3 are never touched.

## 2. Goals

- One blended **imbalance** (equal-weight average) and one blended **CVD** (sum) from Binance + OKX + Coinbase.
- **Accurate on every tick, no matter what:** if a venue is stale/down/blocked this tick, blend the venues that *are* fresh and exclude the rest — never emit stale numbers, never blank out unless all three are down.
- Works identically for **BTC and ETH**.
- A pure, deterministic core that is **unit-tested with TDD** before any UI work.
- Inherent resilience: a failed read on one tick simply retries next tick (no persistent state to corrupt).

## 3. Non-Goals (explicitly out of scope)

- WebSocket transport (REST is chosen; the engine interface is transport-agnostic so WS can be swapped behind adapters later).
- Meshing the **liquidity depth ladder** across venues — v4 keeps v3's Binance-only ladder visual; only the *numbers* blend.
- Changing the **PRIMED** signal logic — the blended numbers flow into the existing slots; the decision rule is unchanged.
- Funding rate, open interest, liquidations — not part of this engine (imbalance + CVD only).
- Polymarket — unchanged; v4 keeps v3's separate Polymarket fetch.
- Touching v1/v2/v3 in any way.

## 4. Locked Decisions

| Decision | Choice |
|---|---|
| Venues | Binance perp, OKX perp, Coinbase spot |
| Transport | All-REST, 1-second poll (uniform across venues) |
| Imbalance blend | **Equal-weight average** over fresh venues |
| CVD blend | **Sum** over fresh venues |
| Partial-source rule | Blend fresh venues only; exclude stale; surface per-venue health |
| Imbalance band | ±0.12% of mid (same as v3) |
| CVD window | Rolling 30 seconds (identical definition across all venues) |
| Assets | BTC, ETH |
| Test framework | Node built-in `node:test` + `node:assert` (zero dependencies) |

## 5. Architecture

Three layers, isolated by clear interfaces:

```
                ┌─────────────────────────────────────────┐
   1s timer ──▶ │  engine.mjs   (tick loop / orchestration) │
                └───────────────┬─────────────────────────-┘
                                │ calls in parallel
            ┌───────────────────┼───────────────────┐
            ▼                   ▼                   ▼
      adapters.mjs        adapters.mjs        adapters.mjs
      fetch Binance       fetch OKX           fetch Coinbase   ← network only, no logic
            └───────────────────┼───────────────────┘
                                ▼ raw JSON + fetch timestamp
                ┌─────────────────────────────────────────┐
                │  core.mjs  (PURE — no network, no DOM)    │
                │  normalize · imbalance · cvd30s · blend   │  ← 100% deterministic = TDD target
                └─────────────────────────────────────────┘
                                │
                                ▼ one tick object  (§8)
```

- **`core.mjs`** is a dependency-free ES module using only standard JavaScript. It imports into **Node** (for tests) and into the **browser** (for v4) unchanged. This is where all logic lives and where TDD happens.
- **`adapters.mjs`** does network I/O only (uses `fetch`, available in Node 18+ and browsers). No business logic — given (venue, asset) it returns `{ raw, ok, fetchedAt }`.
- **`engine.mjs`** runs the 1s loop: fire all three adapters in parallel with a per-fetch timeout, mark freshness, hand results to `core.blend`, emit the tick object.

## 6. Pure Core — Component Specs (`core.mjs`)

All functions are pure (same input → same output, no side effects).

### 6.1 Symbol & contract map
```
SYMBOLS = {
  binance:  { BTC: 'BTCUSDT',        ETH: 'ETHUSDT' },
  okx:      { BTC: 'BTC-USDT-SWAP',  ETH: 'ETH-USDT-SWAP' },
  coinbase: { BTC: 'BTC-USD',        ETH: 'ETH-USD' },
}
OKX_CTVAL = { BTC: 0.01, ETH: 0.1 }   // contracts → base-coin units
```

### 6.2 Normalizers (raw venue JSON → common shape)
`normalizeBinance(raw)`, `normalizeOkx(raw, asset)`, `normalizeCoinbase(raw)` each return:
```
{ book:  { bids: [[price, sizeUSD], …], asks: [[price, sizeUSD], …] },
  trades:[ { ts, signedUSD }, … ] }        // signedUSD: +buy aggressor, −sell aggressor
```
Per-venue rules (USD notional, taker-aggressor sign):
- **Binance** depth `bids/asks = [[p, qtyCoin]]` → `sizeUSD = p*qty`. aggTrades `{T, p, q, m}` → `signedUSD = (m ? −1 : +1) * p*q` (m=true ⇒ buyer is maker ⇒ sell-aggressor).
- **OKX** books `[[p, contracts, …]]` → `sizeUSD = p*contracts*OKX_CTVAL[asset]`. trades `{px, sz, side, ts}` → `signedUSD = (side==='buy' ? +1 : −1) * px*sz*OKX_CTVAL[asset]`.
- **Coinbase** book level2 `[[p, sizeCoin, …]]` → `sizeUSD = p*sizeCoin`. trades `{price, size, side, time}` → `sizeUSD = price*size`.
  - ⚠️ **RISK — Coinbase trade `side` semantics.** The Coinbase **Exchange** REST trade `side` is the **maker** side (taker is the opposite), which is inverted vs Binance/OKX. So `signedUSD = (side==='sell' ? +1 : −1) * price*size` (maker sold ⇒ taker bought ⇒ +). This **must be verified against live data during TDD** (a live cross-check: when price is rising, Coinbase CVD should trend positive). If verification shows the opposite, flip the sign. This is the single most likely correctness bug and gets an explicit test + live gate.

### 6.3 `imbalance(book, mid, band = 0.0012) → number`
Sum `sizeUSD` of bids within `[mid−mid*band, mid]` and asks within `[mid, mid+mid*band]`; return `(bidUSD − askUSD)/(bidUSD + askUSD)`, range −1..+1; `0` if both sides empty.

### 6.4 `cvd30s(trades, now, windowMs = 30000) → number`
Sum `signedUSD` of trades with `ts >= now − windowMs`. Empty → `0`.

### 6.5 `blend(perVenue, opts) → blended`
Input: `{ binance:{imb,cvd,fresh}, okx:{…}, coinbase:{…} }`.
- `fresh` venues only.
- `imbalance = mean(fresh.imb)` (equal weight); `null` if zero fresh.
- `cvd = sum(fresh.cvd)`; `null` if zero fresh.
- Returns `{ imbalance, cvd, nFresh }`.

## 7. Freshness Rule (`engine.mjs`)
Per tick, each adapter is called with a **2.5s timeout**. A venue is **fresh** iff its fetch resolved successfully within the timeout *and* parsed to valid data. Timeout, network error, HTTP error (e.g., Binance 451), or malformed body ⇒ **not fresh** ⇒ excluded from the blend, health dot red. No retries within a tick; the next tick re-attempts (statelessness = resilience).

## 8. Engine Output (the interface)
Each tick emits exactly:
```js
{
  asset: 'BTC' | 'ETH',
  ts: <epoch ms>,
  venues: {
    binance:  { imb: number|null, cvd: number|null, fresh: boolean },
    okx:      { imb: number|null, cvd: number|null, fresh: boolean },
    coinbase: { imb: number|null, cvd: number|null, fresh: boolean },
  },
  blended: { imbalance: number|null, cvd: number|null, nFresh: 0..3 },
  health:  { binance: boolean, okx: boolean, coinbase: boolean },
}
```
Consumers (v4) read `blended.imbalance`, `blended.cvd`, and `health` for the 3-dot indicator.

## 9. Error Handling & Non-Breakable Guarantees
- One venue failing never throws out of the tick — it is caught in the adapter and reported as `fresh:false`.
- All-three failing yields `blended.imbalance = null`, `cvd = null`, `nFresh = 0` (UI shows "—"); the loop keeps running and recovers automatically when any venue returns.
- No shared mutable state between ticks beyond the trade buffers; a corrupt tick cannot poison the next.
- The engine never blocks: each tick is bounded by the 2.5s timeout.

## 10. Testing Strategy (TDD — write tests first)
Framework: `node:test` + `node:assert`, run with `node --test`. Fixtures are real captured JSON snapshots from each venue (BTC and ETH) saved under `engine/test/fixtures/`.

Test list (each written red → green):
1. **imbalance** — known synthetic book → exact expected ratio; one-sided book → ±1; empty → 0; band filter excludes far levels.
2. **cvd30s** — trades straddling the 30s boundary → only in-window summed; empty → 0; sign handling.
3. **normalizeBinance / Okx / Coinbase** — fixture JSON → correct common shape; **notional conversion** correct (Binance p*q; OKX p*sz*ctVal for BTC=0.01 *and* ETH=0.1; Coinbase p*size); **Coinbase side inversion** verified.
4. **blend** — 3 fresh → equal-weight avg imb + summed cvd; **2 fresh / 1 stale → avg & sum over the 2, nFresh=2**; 1 fresh → passthrough; 0 fresh → `null`/`null`, nFresh=0.
5. **asset coverage** — BTC vs ETH select correct symbols and OKX contract value.
6. **freshness** — a venue marked stale is excluded from blend and health.

Plus a **live smoke check** (`smoke.mjs`, not a unit test): run ~10 real ticks on BTC then ETH, print per-venue + blended + health; used to (a) confirm endpoints, and (b) **validate the Coinbase CVD sign** against price direction before integration.

## 11. Integration Phase (separate; only after all tests green)
1. Duplicate `updown-liquidity-overlap.html` → `updown-liquidity-overlap-v4.html` **byte-for-byte** (v3 untouched).
2. In v4 only: import `engine` (`core.mjs` + `adapters.mjs`), replace the inline Binance-only imbalance/CVD computation with `blended.imbalance` / `blended.cvd`.
3. Add a 3-dot **venue health** row (Binance/OKX/Coinbase) driven by `health`.
4. Leave the liquidity ladder visual and the PRIMED decision rule structurally unchanged.
5. Verify v1/v2/v3 files are unchanged (diff) and still run.

## 12. File Layout (new; nothing else modified until §11)
```
61426/
  engine/
    src/
      core.mjs         # pure: symbols, normalizers, imbalance, cvd30s, blend
      adapters.mjs     # fetch per venue (network only)
      engine.mjs       # 1s tick loop + freshness + emit
    test/
      core.test.mjs    # node:test unit tests
      fixtures/        # real venue JSON (btc/eth × binance/okx/coinbase)
    smoke.mjs          # live multi-tick sanity + Coinbase-sign validation
    README.md          # how to run tests + smoke
  docs/superpowers/specs/2026-06-17-multi-venue-market-engine-design.md
```

## 13. Tunable Parameters (defaults)
- Imbalance band: `0.0012` (±0.12%)
- CVD window: `30000` ms
- Per-fetch timeout: `2500` ms
- Tick interval: `1000` ms
- OKX trades fetch limit: `500` (≈ covers 30s on liquid BTC/ETH; verified in smoke)

## 14. Open Risks
- **Coinbase CVD sign** (maker-vs-taker side) — mitigated by explicit test + live validation gate (§6.2, §10).
- **OKX trade depth** — `limit=500` must cover ≥30s; smoke check confirms, else raise/paginate.
- **Spot vs perp** — Coinbase is BTC-USD spot; Binance/OKX are USDT perp. Accepted as "total market flow"; ~1:1 USD≈USDT. Documented, not corrected.
