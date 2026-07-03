#!/usr/bin/env bash
# Idempotent BigQuery setup for the 24/7 tick collector.
# Run from a machine authed to strange-mason-474823-e0 (e.g. teams@clearscrub.io).
# Tick columns mirror the dashboard's session-log row JSON exactly
# (v5.3/updown-liquidity-overlap.html tick() row); engine-specific fields are
# paired _v53/_v54 because the collector runs both engines on every tick.
set -euo pipefail
PROJECT=strange-mason-474823-e0

bq query --use_legacy_sql=false --project_id=$PROJECT <<'SQL'
CREATE TABLE IF NOT EXISTS `strange-mason-474823-e0.raw_d.ticks` (
  ts TIMESTAMP NOT NULL,            -- wall clock of tick
  symbol STRING NOT NULL,           -- 'BTC' | 'ETH'
  bar_interval STRING NOT NULL,     -- '5m' | '15m'
  slug STRING NOT NULL,
  -- dashboard row fields (same names, same rounding)
  t STRING, rem INT64,
  btc_imb FLOAT64, poly_imb FLOAT64, comb FLOAT64,
  cushion FLOAT64, cvd FLOAT64,
  cvd_since_open FLOAT64, cvd_d5 FLOAT64, cvd_d10 FLOAT64, cvd_d60 FLOAT64,
  cush_d10 FLOAT64,
  mom_z FLOAT64, mom_dir STRING, mom_slope FLOAT64,
  large_prints FLOAT64, efficiency FLOAT64, perp_spot_div FLOAT64,
  cvd_d3m FLOAT64, vol_1m FLOAT64, poly_mid FLOAT64,
  -- extra raw context (not in the JSON row but free to carry)
  price FLOAT64, bar_open FLOAT64,
  -- engine-paired outputs (both engines run on the identical inputs)
  imb_ewma_v53 FLOAT64, signal_v53 STRING, note_v53 STRING, run_v53 INT64, pending_v53 STRING,
  p_flip_v53 FLOAT64, flip_alert_v53 STRING,
  imb_ewma_v54 FLOAT64, signal_v54 STRING, note_v54 STRING, run_v54 INT64, pending_v54 STRING,
  p_flip_v54 FLOAT64, flip_alert_v54 STRING
) PARTITION BY DATE(ts) CLUSTER BY symbol, bar_interval, slug;

CREATE TABLE IF NOT EXISTS `strange-mason-474823-e0.raw_d.bars` (
  slug STRING NOT NULL, symbol STRING NOT NULL, bar_interval STRING NOT NULL,
  bar_start TIMESTAMP NOT NULL, bar_end TIMESTAMP NOT NULL,
  open FLOAT64, close FLOAT64,
  settled STRING,                   -- 'UP' | 'DOWN' from Polymarket official resolution ONLY
  resolved_at TIMESTAMP, resolution_attempts INT64,
  tick_count INT64
) PARTITION BY DATE(bar_start) CLUSTER BY symbol, bar_interval;
SQL

echo "tables:"
bq ls $PROJECT:raw_d
