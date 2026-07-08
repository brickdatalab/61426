# log-clean — session-log completeness cleaner (standing pull → clean workflow)

Hard-deletes analysis-corrupting session logs from `AUTOPSY/logs/`. Run it after every
pull, for v8 and every future version:

```bash
python3 tools/log-clean/clean-logs.py --pull            # dry-run: shows what would die
python3 tools/log-clean/clean-logs.py --pull --execute  # purge (repo + origin + VM)
```

## Why three places

`tools/autopsy-sync/autopsy_sync.py` re-syncs any log whose file is missing from the
repo (its idempotency check is just file-exists + same-data), and every original stays
in the VM logs dir (`/home/vincent/projects/61426/v5/logs/`). Deleting only from git
means resurrection within ~5 minutes. So `--execute` deletes: local clone → push to
origin → **the VM source file over SSH** (`--no-vm` to skip; then run the printed ssh
command manually). `tools/log-clean/purged-manifest.txt` records filename + reasons for
every purge (committed — the record of what died survives the data).

## Rules (locked 2026-07-08, operator directive)

| rule | condition (on deduped body-row `rem`) | action | why |
|---|---|---|---|
| gap-run | contiguous missing stretch > 10s | DELETE | stateful engines (EWMA/dwell/warmup) read a distorted world across holes — this exact failure invalidated the old v5.4 live A/B |
| early-end | last body rem > 10 | DELETE | truncates the highest-accuracy final stretch; settle row without closing tape poisons final-60s/flip studies |
| late-start | first body rem < 270 (>30 ticks late) | DELETE | breaks first-minute analyses + early-call comparability |
| late-start ≤30 ticks | 270 ≤ first rem < 285 | **KEEP** | early-call window opens at 45s (after the join); warmup is session-relative; only lowest-value opening ticks missing |
| density | <80% of covered span present (many small holes) | DELETE (`--no-density` to disable) | throttled-cadence era (~2.2s/tick): evades the gap-run rule, equally corrupting for replay |
| scattered 1–2s holes | — | KEEP | all engine deltas are timestamp-based; a missing second barely moves any window |

Never touched: `AUTOPSY/incomplete/` (the sync's own quarantine), `mirrors/`
counterfactuals (`_v53m`), `_bq.json` reconstructions, non-log files.

First purge (2026-07-08): 64 files — 1 v51, 34 v53, 7 v54, 15 v6, 3 v7s, 2 v8, 2 eth —
see the manifest for every filename + reason. 13 tolerated late-starts kept.
