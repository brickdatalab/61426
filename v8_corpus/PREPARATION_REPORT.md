# V8 Corpus Preparation Report

Generated: 2026-07-10T16:36:57Z
Corpus version: v8-1

## Inventory (runtime-derived, not hard-coded)

| metric | value |
|---|---|
| classified files | 532 |
| included sessions | 381 |
| canonical sessions (unique markets) | 381 |
| excluded files | 151 (V5-and-earlier 130 + settlement-conflict 21) |
| included tick rows | 111914 |
| signal runs | 2542 |
| market labels | 381 |
| session-quality rows | 532 |

### Exclusion breakdown

- V5-and-earlier (filename/stat only, never opened): 130
- Settlement conflict (logged `settled` disagrees with close>=open rule): 21

## Coverage

- assets: btc
- intervals: 5m
- first bar: 2026-07-05T19:20:00Z
- last bar: 2026-07-10T15:40:00Z

## Engine validation

- sessions engine-compatible: 381/381
- boundary-ambiguous ticks: 176
- non-boundary signal mismatches: 0

The V8 directional rule was replayed for every included session through the real
`v8/src/signals.mjs` engine (monotonic replay time). Boundary-ambiguous ticks
(cushion within 0.0075 of the floor) are never counted as mismatches.

## Verification

- result: PASS
- checks run: 243

This report contains corpus construction and validation only — no signal-performance analysis.
