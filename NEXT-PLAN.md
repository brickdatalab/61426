# NEXT-PLAN.md — pending working-tree reorganization

*Written 2026-07-10. Status: planned, not yet executed. Nothing below has been run.*

## Immediate next step (approved, ready to execute on your word)

**Move `v1/`, `v2/`, `v3/` into a new `older-models/` directory.**

Verified safe: repo-wide grep for live-code references into `v1/v2/v3` found **zero** hits anywhere — not in v6, v7/v7s/v7c, v8, `runner/`, `web/`, or `tools/`. `testdata/v3-logs/` is already a separate top-level directory and is untouched by this move. `older-versions/` does not currently exist (clean start, no naming conflict) — using `older-models/` since that matches this repo's kebab-case convention and your instruction was descriptive, not a literal required path.

Steps:
1. `mkdir -p older-models`
2. `git mv v1 older-models/v1`, `git mv v2 older-models/v2`, `git mv v3 older-models/v3` (preserves git history via rename detection)
3. Re-run the repo-wide reference grep post-move to confirm zero breakage (expect identical zero-hit result)
4. Confirm `testdata/v3-logs/` still resolves (separate directory, unaffected)
5. Commit: `git commit -m "chore: archive v1/v2/v3 into older-models/ (zero live references, verified)"`
6. **Not doing:** no CLAUDE.md path rewrites, no v5.x moves (explicitly deferred — see finding below), no push unless requested

## Deferred: v5.x move (verified, but not yet decided)

If/when you want to go further than v1–v3:

- **v5, v5.1, v5.2** — zero external references, same as v1–v3. Free to move.
- **v5.3 and v5.4 are the real boundary.** `v6`'s own acceptance gate (`v6/analysis/replay-compare.mjs`) and half of v6's own test suite (`v6/test/replay.test.mjs`) import `v5.4/src/signals.mjs` directly (which itself imports v5.3's via its own internal gate). **v6's live dashboard is unaffected either way** (confirmed clean — same self-contained pattern as v8, imports only its own `./src/signals.mjs`). Only the two named v6 *scripts* would break, not the thing you actually watch in the browser.
- The internal v5-lineage cross-references (v5.3→v5.1, v5.4→v5.3) are relative-path and survive a group move together, as long as the whole v5 family moves as one unit.
- `collector/test/collector.test.mjs` also references v5.3/v5.4 directly, but `collector/` is the already-confirmed-dead `raw_d` BigQuery project (paused, never started) — negligible.
- **Net:** the entire v1–v5.4 block *can* move together without breaking anything currently in active use. The only cost, if you go that far, is updating two import-path lines inside v6's own gate/test files if you ever want to run `node v6/analysis/replay-compare.mjs` or `node --test v6/test/replay.test.mjs` again post-move.
- Options when you're ready: (a) move everything + fix v6's 2 lines (cleanest), (b) move v1–v5.2 only, leave v5.3/v5.4 in place (zero code changes, matches the "start easy" pattern), (c) move everything and leave v6's gate/tests broken until later.

## Separate, larger pending plan: reorganize working tree + finish conviction-layer ship

*(Context: you moved all frozen-version dirs to `older-versions/` earlier and then restored them — v1–v8 confirmed back, engines present, 977 BQ bars + gitignored caches intact. This left some loose ends.)*

### 0. Remove dead root artifacts (already confirmed by you)
- `git rm ENGINE_PROBLEMS.md` — v5.3/v5.4 problems, self-documented as fully resolved/absorbed into v6 back on 2026-07-05; two generations superseded by v8 now.
- `git rm rawddataset.md` — the paused `raw_d` BigQuery collector (project `strange-mason-474823-e0`), superseded by the live `bin` pipeline, confirmed dead, never started.
- `git rm -r logs/` — root-level dir, 3 stale pre-AUTOPSY `_v5_log.json` fixtures + `.DS_Store`, zero references anywhere in code/docs, fully superseded by the `AUTOPSY/logs/` autopsy-sync pipeline.
- Content preserved in git history either way. Leave stale cross-references inside `SUMMARY.md`'s old body untouched (same pattern as its other superseded sections).

### 1. Restore the 65 pending deletions
`git checkout -- testdata AUTOPSY` (fixtures + case files + incomplete stubs are the permanent record). Formalize the doc move: `git rm VERCEL_INTEGRATION.md` from root (content now lives at `web/VERCEL_INTEGRATION.md`) — verify byte-identical first, then `git add` the new location.

### 2. Reconcile untracked v8 logs
~28+ newer `_v8` logs sit untracked locally but exist on origin. Delete the local untracked copies, then `git pull --rebase --autostash` brings in the canonical ones (with today's newer bars too).

### 3. Make the autopsy-sync sums-tolerant
`tools/autopsy-sync/autopsy_sync.py`'s `_same_data()` compares whole documents — your new `signal_up_sum`/`signal_down_sum`/`signal_mixed_sum` fields (from `add-signal-sums.py`) would get silently stripped by the VM cron re-pushing un-augmented originals every cycle. Patch `_same_data()` to strip those three keys from both settle rows before comparing (~6 lines) + note it in the tool's README. Then confirm whether the VM's sync clone (`/home/vincent/autopsy-sync/repo`) self-updates via `run.sh` before each cron cycle — if not, you'll need to run one SSH pull manually (VM changes stay user-run unless you approve otherwise).

### 4. Organize the sums script
Move `scripts/add-signal-sums.py` → `tools/log-sums/add-signal-sums.py` (repo convention: standing utilities live under `tools/`). Fix its hardcoded `LOGDIR` if it still points at an old path. Remove the now-empty `scripts/`. Document the standing workflow in `CONTEXT.md`: pull → clean-logs → add-signal-sums.

### 5. Re-run the sums script + commit
Idempotent — safe to re-run over the newly pulled logs. Commit the ~380 mutated logs + the relocated script + the sync patch together: `"logs: per-bar signal sums + sums-tolerant sync"`.

### 6. Finish the conviction-tier ship
The conviction-layer engine + tests + dashboard work is done and verified (20/20 tests passing), but was never committed. Steps:
- Run `node v8/analysis/replay-compare.mjs v6/analysis/bqbars AUTOPSY/logs` — the gate must PASS (the stream itself is unchanged; `conv` is purely additive, so this should reproduce the existing PASS byte-for-byte).
- Re-run 20/20 tests + the runner adapter tests (should be 2/2 now that v6 is confirmed present).
- Update `v8/README.md` + the `CLAUDE.md` ladder + `CONTEXT.md` with the conviction layer: tier numbers (88%/94% held-out/live for tier 3, 81%/85% for tier 2, 57%/50% for tier 1), explicitly noting it's additive and display/logging-only.
- Commit, `git pull --rebase --autostash`, push.

### 7. General hygiene
- `.playwright-cli/` → add to `.gitignore`.
- `.env` stays untracked forever (secrets — never commit).
- `vm-pm.md` stays untracked (standing decision from earlier this session).
- Final `git status` should come back clean except that deliberate untracked set.

## Verification checklist (once executed)
- `git status` clean; `ls testdata/v3-logs | wc -l` = 19; AUTOPSY case files all present.
- Gate script prints `GATE PASS 5/5`; tests `20/20`; runner adapter `2/2`.
- After push + one autopsy-sync cron cycle: `git pull` shows the cron did **not** strip the sums fields from any log (spot-check one settle row still has all three keys).
- Dashboard serves with conviction-tier dots visible at `:7724` (`grep -c convictionOf` on the served file ≥ 1).
