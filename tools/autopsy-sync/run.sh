#!/usr/bin/env bash
# Cron wrapper for the autopsy log reconciler (runs on the VM).
# Invoked under flock every 5 min; see README.md.
set -euo pipefail
REPO=/home/vincent/autopsy-sync/repo
LOGDIR=/home/vincent/projects/61426/v5/logs
python3 "$REPO/tools/autopsy-sync/autopsy_sync.py" --log-dir "$LOGDIR" --repo "$REPO"
