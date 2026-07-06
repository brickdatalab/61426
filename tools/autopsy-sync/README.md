# autopsy-sync

Automatically syncs completed session logs (any version) into this repo's
`AUTOPSY/logs/` on `main`, after verifying the settle direction against
Polymarket.

## What it does

Runs on the VM `pm` via cron every 5 minutes under `flock`. Each cycle:

1. Scans the live log dir `/home/vincent/projects/61426/v5/logs/` (read-only —
   it does **not** touch the `ourwebsocket`/`v5logd` receivers).
2. For each `<slug>_v<tag>.json` whose bar closed **≥ 5 minutes ago** and that
   has a settle row:
   - Queries Polymarket Gamma for the market's resolution.
   - If Polymarket isn't resolved yet → `WAIT` (retried next cycle; never
     commits a premature settle).
   - If the log's `settled` disagrees with Polymarket → rewrites the `settled`
     field in place to Polymarket's resolution (`CORRECT`).
   - Copies the (corrected) log into the repo clone's `AUTOPSY/logs/`.
3. Commits any new/changed logs and pushes to `origin/main` via the deploy key
   (`git pull --rebase` + 3-attempt retry to survive push races).

Idempotent: a log already synced with matching content produces no commit.

## Files

- `autopsy_sync.py` — the reconciler (pure functions + orchestration).
- `test_autopsy_sync.py` — pytest for the pure logic (no network):
  `python3 -m pytest test_autopsy_sync.py -q`.
- `run.sh` — cron wrapper (paths are VM-specific).

## VM setup (one-time)

- Deploy key `~/.ssh/autopsy_deploy` on the VM, added to the GitHub repo's
  Deploy Keys **with write access**; SSH host alias `github-autopsy`.
- Repo clone at `/home/vincent/autopsy-sync/repo` (SSH remote).
- Crontab:
  ```
  */5 * * * * /usr/bin/flock -n /tmp/autopsy_sync.lock /home/vincent/autopsy-sync/repo/tools/autopsy-sync/run.sh >> /home/vincent/autopsy-sync/sync.log 2>&1
  ```

## Operating

- **Dry run** (no writes, no commits): `python3 autopsy_sync.py --log-dir <dir> --repo <clone> --dry-run`
- **Logs:** `/home/vincent/autopsy-sync/sync.log` (per-cycle `SYNC/CORRECT/WAIT/SKIP/pushed` lines).
- **Disable:** comment out the crontab line (`crontab -e`).
- **Local drift:** because the VM pushes log commits to `main`, your local
  `main` falls behind — run `git pull --rebase` to catch up. Log commits are
  new files, so they never conflict with local code work.
