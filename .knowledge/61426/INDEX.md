# 61426 Knowledge Index

## Source metadata

- Local source: `/Users/vitolo/Desktop/61426`
- GitHub source: https://github.com/brickdatalab/61426
- Source type: mixed local checkout + GitHub repository
- Ingest depth: deep, focused on current engine, relay/runtime, tests, deployment docs, and Git history
- Snapshot date: 2026-07-09
- Local checkout: branch `main`, commit `f44b039`
- Configured remote: `https://github.com/brickdatalab/61426.git`
- Fetched remote `origin/main`: `5f97993912f8d910cd89b6050a2f9b2a0b8a8bbd`
- Divergence at ingestion: local is 1 commit ahead and 101 commits behind remote; the remote-only commits are automated `chore(autopsy): sync ...` log commits. The local working tree also contains pre-existing log edits/deletions.

## Project overview

61426 is a version-isolated BTC/ETH Polymarket up/down signal system. It combines Binance spot/perpetual trade and order-book data with Polymarket book data, runs versioned JavaScript signal engines in browser dashboards and a headless VM runner, stores session/autopsy logs, and uses offline replay research to validate strategy changes.

`v8` is the current engine. Its emitted per-tick signal is a calibrated cushion-lead rule; its early-call channel is inherited from `v7s`; its legacy book/flow stream remains active for diagnostics and display.

## Architecture summary

```text
Binance spot/perp + depth
          │
          ├── v5.x/ourWebSocket (Python aiohttp service)
          │       └── WS tape snapshots: CVD, price, bar open, imbalance, flow, vol
          │
          ├── collector/ (Node)
          │       └── v5.3/v5.4 engines → BigQuery raw_d + spool-on-failure
          │
          └── runner/ (Node VM process)
                  ├── OwsFeed → ourWebSocket
                  ├── PolyFeed → Gamma event + CLOB book
                  ├── engine-adapter → vX/src/signals.mjs
                  ├── Session → 1-second tick, state, resume, settle logs
                  └── control-api → TLS → web/ Next.js proxy/viewer

Browser dashboards import the same pure engine modules directly and write legacy logs to the VM log receiver. AUTOPSY synchronization verifies settlement and commits logs back to GitHub.
```

## Module map

- `v8/`: current engine, browser dashboard, fixtures, replay comparisons, and research pipeline.
- `runner/`: production headless execution plane. Dynamic engine loading, live feeds, scheduling, persistence, resume, control API, and tests.
- `collector/`: older/current dual v5.3/v5.4 BigQuery collector with exact dashboard input/row mapping.
- `v5/` through `v7s/` and `v7c/`: isolated engine generations; predecessors are frozen, `v7c` is parked.
- `web/`: Vercel-hosted password-gated control panel; it never runs signal logic.
- `AUTOPSY/`: settled live logs and analysis reports.
- `tools/`: log synchronization, cleanup, and maintenance utilities.

Detailed notes:

- [Engine logic](modules/engine.md)
- [Live relay and persistence](modules/relay.md)
- [Web control plane](modules/web.md)
- [Git, deployment, and data workflow](modules/git-data.md)

## Engine API surface

| Symbol | Location | Role |
|---|---|---|
| `newSession()` | `v8/src/signals.mjs:81` | Per-bar mutable engine state |
| `tick(s, inp)` | `v8/src/signals.mjs:319` | Single canonical engine evaluation path |
| `decideV8(s, inp)` | `v8/src/signals.mjs:200` | Current emitted per-tick signal |
| `convictionOf(s, inp, sig, flipP)` | `v8/src/signals.mjs:214` | Display/logging reliability tier; does not gate signal |
| `earlyCallOf(s, inp)` | `v8/src/signals.mjs:261` | Selective one-shot early-call latch |
| `decideDebounced(...)` | `v8/src/signals.mjs:133` | Legacy book/flow stream kept for diagnostics |
| `momentumOf(s, now)` | `v8/src/signals.mjs:115` | Flow/price continuation detector |
| `flipRisk(s, inp, flow)` | `v8/src/signals.mjs:291` | Cushion-side flip probability/readout |
| `buildInp(...)` | `runner/engine-adapter.mjs:16` | Exact runner-to-engine input mapping |

## Key data contract

The runner maps the live tape/book into `now`, `sinceOpen`, `price`, `bimb`, `pimb`, `largePrints`, `efficiency`, `perpSpotDiv`, `cvd3m`, `cushion`, `remS`, `vol1m`, and `polyMid`. `cushion` is `price - barOpen`; `sinceOpen` is the CVD accumulator from the tape service. The runner then emits public rows with the dashboard-compatible field names and strips operational state fields before writing the final log.

## Primary runtime protections

- Engine hash is persisted with each run and checked on resume (`runner/session.mjs:146-153`).
- State and logs use atomic writes (`runner/session.mjs:208-216`, `runner/lib/atomic.mjs`).
- Resume rebuilds engine state by replaying recorded rows using their original timestamps (`runner/session.mjs:160-167`).
- The control API requires a bearer secret and uses constant-time comparison (`runner/control-api.mjs:12-23`).
- The web app authenticates at the edge with an HMAC session cookie, then proxies only an allowlisted VM API surface (`web/middleware.ts`, `web/app/api/vm/[...path]/route.ts`).

## Known gaps / cautions

- The local checkout is not synchronized with the GitHub remote because autopsy automation continuously adds remote log commits.
- Runtime deployment state is described in `web/VERCEL_INTEGRATION.md` and `vm-pm.md`; local source alone cannot prove the VM process is currently running.
- Python WebSocket server tests require `aiohttp`, which is absent from the current local Python environment.
- `v8` signal tests, runner tests, collector tests, and the web production build were run during analysis; live integration tests are intentionally skipped unless external services are available.
