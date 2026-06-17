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
