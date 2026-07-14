# V9 Corpus Replay Report

Generated: 2026-07-14T04:46:46Z
Corpus: 381 canonical BTC 5-minute markets / 111914 replayed ticks
Corpus verification: PASS (243 checks)

## V8 parity

- Compared outputs: decision, floor, early call, conviction, flip, momentum, flow, and inherited engine state.
- Compared ticks: 111516
- Mismatches: 0

## Strict occupancy tally

| calls | correct | accuracy | abstained |
|---:|---:|---:|---:|
| 306 | 280 | 91.5% | 75 |

This is reported for verification only. V9 does not use occupancy counts as a settlement forecast.

## Settlement Nowcast checkpoints

Checkpoint selection is causal: the closest available observation at or before the checkpoint (remaining seconds greater than or equal to the target).

| remaining | eligible | calls | MIXED abstentions | coverage | correct | accuracy |
|---:|---:|---:|---:|---:|---:|---:|
| 120s | 381 | 297 | 84 | 78.0% | 261 | 87.9% |
| 105s | 381 | 309 | 72 | 81.1% | 277 | 89.6% |
| 100s | 381 | 304 | 77 | 79.8% | 276 | 90.8% |
| 60s | 381 | 325 | 56 | 85.3% | 306 | 94.2% |
| 30s | 381 | 338 | 43 | 88.7% | 322 | 95.3% |
| 20s | 381 | 338 | 43 | 88.7% | 324 | 95.9% |
| 10s | 381 | 337 | 44 | 88.5% | 330 | 97.9% |
| 5s | 381 | 338 | 43 | 88.7% | 336 | 99.4% |
| 2s | 381 | 336 | 45 | 88.2% | 336 | 100.0% |

## Change diagnostics

- Nowcast transition events: 1779
- Markets with a nowcast transition: 291
- Direct UP↔DOWN directional reversals: 4
- Markets with a direct directional reversal: 3

## Outcome Shadow historical availability

- Early candidate calls: 97; correct: 93; accuracy: 95.9%.
- Confirmed-discounted branch: unavailable for 284 sessions without an early call because actual two-sided executable quotes were not logged.
- No DOWN midpoint was synthesized from `1 − UP midpoint`, and no combined Outcome Shadow accuracy is reported.

## Breakdowns

UTC-day and collection-block checkpoint statistics are included in `replay_report.json` under `breakdowns`.

## Guardrail

This is an untuned verification replay. It does not change V9 thresholds or behavior.
