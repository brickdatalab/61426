#!/usr/bin/env python3
#
# add-signal-sums.py
# ---------------------------------------------------------------------------
# Post-hoc summary for Polymarket 5m-bar session log files (AUTOPSY/logs/).
#
# Every tick row in these logs has a "signal" key whose value is one of
# "UP", "DOWN", or "MIXED" — the output of the v8 per-tick decideV8() rule
# (or its predecessor versions).  The settlement row (the last element in
# the "rows" array) records the bar's final outcome ("settled": "UP"/"DOWN")
# plus open/close price.  This script augments that settlement row with
# three new keys:
#
#   "signal_mixed_sum"  — count of ticks where signal == "MIXED"
#   "signal_up_sum"     — count of ticks where signal == "UP"
#   "signal_down_sum"   — count of ticks where signal == "DOWN"
#
# These give a per-bar signal-distribution summary without requiring the
# consumer to re-read and recount every tick row.
#
# Idempotent: files whose settlement row already contains
# "signal_mixed_sum" are skipped.  Only new or unprocessed log files are
# touched.  This means the script can be run repeatedly — e.g. as a cron
# job or post-pull hook — and it will only process incremental additions.
#
# Portability: LOGDIR is an absolute path hardcoded below.  The script
# always targets that exact directory, regardless of where the script
# itself is stored or invoked from.  Move this file anywhere; it will
# still find and operate on LOGDIR.
#
# Speed: uses orjson (3–5x faster than stdlib json) with a transparent
# fallback to the standard library.  File processing is parallelised
# across all CPU cores via multiprocessing.Pool.
#
# Safety: writes go to a <filename>.tmp file first, then os.replace()
# atomically swaps it into place.  A crash or SIGKILL during a write
# leaves the .tmp behind (cleaned on the next run) but never corrupts the
# original file.  Stale .tmp files from prior interrupted runs are
# cleaned before any writes begin.
# ---------------------------------------------------------------------------

LOGDIR = "/Users/vitolo/Desktop/61426/AUTOPSY/logs"

import argparse
import os, glob, time
from multiprocessing import Pool
from pathlib import Path

# Prefer orjson for speed (3–5x faster parse/serialize).  Fall back to
# stdlib json if orjson isn't installed on the machine running this script.
# Both paths produce identical on-disk JSON — the indentation is cosmetic
# (2-space) and does not affect consumers.
try:
    import orjson as _json
    def _load(fp):
        with open(fp, 'rb') as fh:
            return _json.loads(fh.read())
    def _dump(obj, fp):
        with open(fp, 'wb') as fh:
            fh.write(_json.dumps(obj, option=_json.OPT_INDENT_2))
except ImportError:
    import json
    def _load(fp):
        with open(fp, 'r', encoding='utf-8') as fh:
            return json.load(fh)
    def _dump(obj, fp):
        with open(fp, 'w', encoding='utf-8') as fh:
            json.dump(obj, fh, indent=2, ensure_ascii=False)


def _process(args):
    """(path, verbose) -> (basename, status_line)

    The per-file worker.  Designed to be called by multiprocessing.Pool.map(),
    so it receives a tuple (filepath, verbose) to keep the serialised arguments
    minimal.

    Steps:
      1. Parse the JSON.
      2. Locate the settlement row (last element of "rows").
      3. If already annotated ("signal_mixed_sum" present), stop.
      4. Count "UP" / "DOWN" / "MIXED" across all tick rows (rows[:-1]).
      5. Inject the three sum keys (as strings) into the settlement row.
      6. Atomic write: serialize to .tmp, then os.replace() into place.
    """
    fp, verbose = args
    bn = os.path.basename(fp)
    try:
        data = _load(fp)
    except Exception as e:
        return (bn, f"ERROR read: {e}")

    rows = data.get("rows")
    if not rows:
        return (bn, "skip: no rows")

    # The last row is always the settlement row (has "settled" key).
    # Tick rows precede it; we count signals only on those.
    last = rows[-1]
    if "settled" not in last:
        return (bn, "skip: no settlement row")

    # Idempotency gate — if any of the three sum keys exists we assume
    # the file was already processed and leave it alone.
    if "signal_mixed_sum" in last:
        return (bn, "skip: already done")

    # Tally of per-tick signal values.  Rows that lack a "signal" key
    # (e.g. warm-up ticks before the engine activates) are silently ignored.
    mixed = up = down = 0
    for r in rows[:-1]:
        s = r.get("signal")
        if s == "MIXED":   mixed += 1
        elif s == "UP":    up += 1
        elif s == "DOWN":  down += 1

    # Values are stored as strings to match the convention already used
    # in the btc-updown-5m-1783551000_v8.json reference file.
    last["signal_mixed_sum"] = str(mixed)
    last["signal_up_sum"]    = str(up)
    last["signal_down_sum"]  = str(down)

    # Atomic write: serialize the entire object to a temporary sibling file,
    # then atomically rename it over the original.  If the process is killed
    # between the write and the rename, the .tmp is cleaned on next run.
    # os.replace() is atomic on POSIX (rename) and on Windows (MoveFileEx
    # with MOVEFILE_REPLACE_EXISTING), so a consumer never sees a half-written file.
    tmp = fp + ".tmp"
    try:
        _dump(data, tmp)
        os.replace(tmp, fp)
    except Exception as e:
        try:
            os.unlink(tmp)
        except Exception:
            pass
        return (bn, f"ERROR write: {e}")
    return (bn, f"MIXED={mixed} UP={up} DOWN={down}")


def select_files(log_dir: Path, files_from: Path | None = None) -> list[Path]:
    """Return every log, or only the safe explicit names in a manifest."""
    if files_from is None:
        return [Path(path) for path in sorted(glob.glob(str(log_dir / "*.json")))]

    try:
        names = files_from.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise ValueError(f"could not read file list {files_from}: {exc}") from exc

    selected: list[Path] = []
    seen: set[str] = set()
    for raw_name in names:
        name = raw_name.strip()
        if not name:
            continue
        if Path(name).name != name or not name.endswith(".json"):
            raise ValueError(f"invalid log filename in file list: {raw_name!r}")
        if name in seen:
            raise ValueError(f"duplicate log filename in file list: {name}")
        path = log_dir / name
        if not path.is_file():
            raise ValueError(f"listed log file does not exist: {path}")
        seen.add(name)
        selected.append(path)
    return selected


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Add signal sums to all logs or an explicit filename list."
    )
    parser.add_argument(
        "--files-from",
        type=Path,
        help="newline-delimited log basenames to process; limits changes to that set",
    )
    args = parser.parse_args(argv)

    # Normalise the LOGDIR constant (strip trailing slash if present).
    logdir = Path(LOGDIR[:-1] if LOGDIR.endswith(os.sep) else LOGDIR)

    # Clean up any orphaned .tmp files from a prior crash or SIGKILL.
    # These are harmless but accumulate disk space over many interrupted runs.
    for sf in glob.glob(str(logdir / "*.json.tmp")):
        try:
            os.unlink(sf)
        except Exception:
            pass

    # The explicit manifest mode limits mutation to a caller-supplied set.
    try:
        files = select_files(logdir, args.files_from)
    except ValueError as exc:
        parser.error(str(exc))
    if not files:
        print("No matching .json files found.")
        return

    print(f"Dir:  {logdir}")
    print(f"Processing {len(files)} log files with {os.cpu_count()} workers...\n")
    t0 = time.perf_counter()

    # Multiprocessing pool uses all available cores.  Each worker calls
    # _process() on a single file — the work is embarrassingly parallel
    # (files are independent, no shared state).
    worker_args = [(str(fp), True) for fp in files]
    with Pool() as pool:
        results = pool.map(_process, worker_args)

    # Partition results by outcome.
    updated = []
    skipped = []
    errors = []
    for bn, status in sorted(results):
        if status.startswith("ERROR"):
            errors.append((bn, status))
        elif status.startswith("skip"):
            skipped.append((bn, status))
        else:
            updated.append((bn, status))

    print(f"updated  {len(updated):>5}")
    print(f"skipped  {len(skipped):>5}")
    print(f"errors   {len(errors):>5}")
    if errors:
        print()
        for bn, s in errors:
            print(f"  {bn}: {s}")

    # For small runs (< 40 files) print every file's status for easy scanning.
    # For large runs the summary counts above are enough.
    if len(files) < 40:
        for bn, s in updated + skipped + errors:
            print(f"  {bn}: {s}")

    elapsed = time.perf_counter() - t0
    print(f"\nDone in {elapsed:.3f}s")


# The LOGDIR constant above is the absolute path this script always targets,
# regardless of where the script is moved or invoked from.
if __name__ == "__main__":
    LOGBASE = os.path.basename(LOGDIR)
    main()
