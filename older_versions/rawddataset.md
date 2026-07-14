# rawddataset.md — 24/7 BigQuery Collector: state + resume point

**Written 2026-07-02. Status: PAUSED at T3 (live soak), blocked only on one user-run IAM command.**

## What this is

Automation of the manual dashboard runs into a continuous 24/7 collection pipeline — four streams (**BTC-5m, BTC-15m, ETH-5m, ETH-15m**), market after market, every tick into BigQuery. Approved plan: `~/.claude/plans/quiet-hopping-chipmunk.md`. Hard rule honored: **World 1 (manual dashboards, JSON logs, ourWebSocket, engines) untouched** — the collector is a standalone additive service that connects to the feed as just another WS client.

## Decisions locked (user-approved)

- **One `ticks` table** for all four streams (partitioned by `DATE(ts)`, clustered `symbol, bar_interval, slug`) + companion **`bars`** table (one row per settled bar). Dataset: `strange-mason-474823-e0:raw_d` (US).
- **Both engines per tick**: v5.3 AND v5.4 run side-by-side on identical inputs → paired columns (`signal_v53`/`signal_v54`, `imb_ewma_*`, `p_flip_*`, `flip_alert_*`, `note_*`, `run_*`, `pending_*`). This doubles as the fair v5.4-trust A/B (headless = no tab throttling).
- **Settle verdict = Polymarket official resolution ONLY** (Gamma API; poller starts 15s after bar end, retries 10s × 18; `bars.settled` null if never resolved).
- **BigQuery-only output** — collector never writes JSON session logs; those come only from manual dashboard runs.
- Tick columns mirror the dashboard's session-log row JSON **exactly** (same names, same rounding: `t, rem, btc_imb, poly_imb, comb, cushion, cvd, cvd_since_open, cvd_d5/d10/d60, cush_d10, mom_z, mom_dir, large_prints, efficiency, perp_spot_div, cvd_d3m, vol_1m, poly_mid`) + `ts/symbol/bar_interval/slug/price/bar_open/mom_slope` + the engine pairs.

## What's DONE

1. **Tables created** (final schema, verified): `raw_d.ticks` + `raw_d.bars`. Setup script: `collector/setup-bq.sh` (idempotent).
2. **Collector built TDD, 9/9 tests green** (`collector/`, commit `0b029bb`):
   - `collector.mjs` — 4 stream loops, WS client (5s staleness watchdog, reconnect), Polymarket book poll (900ms timeout, no tick stacking), dual-engine tick, dashboard-exact row building, 30s batched inserts with **NDJSON spool + retry** on BQ failure, bar rollover (fresh engine sessions per bar, immediate roll), Polymarket resolution poller, SIGTERM flush.
   - `engines/v53-signals.mjs`, `engines/v54-signals.mjs` — **verbatim copies**, byte-identity enforced by test.
   - Tests: engine-hash, slug math, polyStats == dashboard bookStats, buildInp == dashboard sigTick input (incl. nulls), dual-engine independence (BAFO divergence case), buildRow rounding fidelity, resolution parsing, batcher spool/flush.
   - `collector.service` — systemd unit (Restart=always, RestartSec=5, MemoryMax=1G, After=ourwebsocket).
3. **Deployed to VM** `/home/vincent/collector/` (rsync, `npm install` done, module load-checked: 4 streams). NOT started.
4. Verified all four Polymarket markets exist (`btc/eth-updown-5m/15m-<epoch>`; 15m = 900s boundaries). VM headroom confirmed (~15% CPU, 29GB free after killing dboard-listener; budget for collector ≈ half a core worst case).

## THE BLOCKER (resume here)

VM service account `764035945070-compute@developer.gserviceaccount.com` has **no write access** to `raw_d`. The permission classifier requires the user to run the grant personally. ACL file already prepared (current ACL + one WRITER entry, dataset-scoped only):

```
! bq update --source /private/tmp/claude-501/-Users-vitolo-Desktop-61426-v5/4e6cab93-68ae-4d51-b7b2-8354d003ccc2/scratchpad/raw_d_acl.json strange-mason-474823-e0:raw_d
```

(If that scratchpad file is gone after a restart: `bq show --format=prettyjson strange-mason-474823-e0:raw_d` → append `{"role":"WRITER","userByEmail":"764035945070-compute@developer.gserviceaccount.com"}` to `.access` → `bq update --source <file> strange-mason-474823-e0:raw_d`.)

## Remaining tasks (in order, after the grant)

- **T3:** smoke-insert from VM → run collector foreground for one BTC-5m bar → verify ~300 `ticks` rows + resolved `bars` row in BQ.
- **T4:** `systemctl enable --now collector` (all 4 streams), kill -9 restart test, 1-hour soak (row counts per stream, no intra-bar gaps >2s, CPU delta ≤ budget).
- **T5:** CONTEXT.md + SUMMARY.md entries, memory update, final commit.

## Analysis notes for the 7–10-day readout

- Query pattern: `WHERE symbol='BTC' AND bar_interval='5m' AND DATE(ts) BETWEEN ...` (partition + cluster pruning; never `SELECT *` over the full table).
- v5.4-vs-v5.3 grading comes straight off the paired signal columns joined to `bars.settled` (Polymarket ground truth built in).
- Volume expectation: ~345K rows/day (4 × ~86,400s... 5m streams ~1 row/s; 15m same cadence), ~2–4M rows for the window — trivial scan costs with partition filters.
