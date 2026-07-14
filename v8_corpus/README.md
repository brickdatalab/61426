# v8_corpus

Reproducible V8 log-ingestion & corpus-preparation package. **Corpus construction and
validation only — no signal-performance analysis, no entry-rule testing, no engine changes.**

## Reproduce

```
python3 tools/build-v8-corpus.py
```

The build runs in a staging directory, verifies everything in place, then atomically swaps
the result into `v8_corpus/`. An existing package is never overwritten before the new build
passes validation.

## Source

- Consumes ONLY `_v6`, `_v7s`, `_v8` session logs from `AUTOPSY/logs/`.
- V6/V7s payloads were already rewritten with current V8 engine logic; physical filenames
  are preserved as provenance.
- V5-and-earlier files are excluded by filename + filesystem stat only — their bytes are
  never opened or hashed.

## Layout

```
raw/v8_sessions_raw.jsonl.zst      395+ included sessions, one per line (verbatim payload text)
derived/v8_ticks.parquet           point-in-time observed ticks (no future/label leakage)
derived/v8_signal_runs.parquet     contiguous signal runs
derived/v8_market_labels.parquet   one row per market bar (outcome — join AFTER defining entry)
derived/v8_session_quality.parquet every supplied file incl. excluded
audit/                             manifests, exclusions, duplicates, schema, verification
```

## Leakage safeguards (enforced)

1. Original file order preserved (no timestamp sorting).
2. No interpolation or forward-fill — nulls stay null.
3. Causal forward-pass only for running counts / run age / reversals / lags.
4. Settlement labels live in a separate file, joined only after an entry is frozen.
5. Cushion used directly as a feature; tick price is never reconstructed from settlement.
6. Downstream signal summaries recomputed for validation only, never used as predictors.
7. Completed run length never defines a run-start entry (use `signal_run_age_ticks`).
8. Canonical duplicate selection is correctness-blind.
9. No losing/reversal bars dropped during ingestion.
10. No row classified from future Polymarket prices. No `next_poly_mid` in the tick table.

## Walk-forward discipline (for later analysis)

All ticks of one market stay in one fold. Splits are chronological by bar, never random by
tick. BTC/ETH and 5m/15m remain identifiable and must not be implicitly pooled. Aggregate
or cluster uncertainty by market.

## Raw payload byte fidelity

Each raw line stores the exact original UTF-8 file content in `raw_payload_text` plus
`source_sha256`. Regeneration = write `raw_payload_text`, verify sha256 equals
`source_sha256`. A parsed/reserialized object is deliberately NOT used as the canonical
payload because it would not be byte-identical to the source.

## Known limitations

- `poly_down_mid_proxy` is a complement proxy (1 - poly_up_mid), not a separately observed
  DOWN book. `signal_side_mid` measures how priced-in the direction appeared — not a
  guaranteed fill price.
- `early_call_validated_domain` is TRUE only for BTC 5-minute sessions; ETH / 15-minute
  logs remain in the corpus but must not be pooled into BTC-5m-calibrated claims.
- `near_flat_outcome` is intentionally NULL; store `settlement_abs_move_usd` and define any
  threshold only in later approved analysis.

See `audit/schema.json` for the full field/type/source map and `PREPARATION_REPORT.md` for
the runtime inventory and validation summary.
