#!/usr/bin/env python3
"""Safely copy new AUTOPSY session logs from origin/main.

The worktree and index are never updated.  Files are read directly from the
fetched remote-tracking tree and atomically published without overwriting an
existing destination.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Callable, Iterable, Sequence


REMOTE_REF = "origin/main"
REMOTE_LOG_DIR = PurePosixPath("AUTOPSY/logs")
VERSION_RE = re.compile(r"^v[0-9]+s?$")
LOG_NAME_RE = re.compile(
    r"^(?P<asset>[a-z0-9]+)-updown-"
    r"(?P<interval>[1-9][0-9]*[smhdw])-"
    r"(?P<epoch>[0-9]{10})_"
    r"(?P<version>v[0-9]+s?)\.json$"
)


class PrerequisiteError(RuntimeError):
    """A repository, directory, or Git prerequisite is unavailable."""


class GitCommandError(RuntimeError):
    """A Git subprocess failed."""


class PayloadValidationError(ValueError):
    """A prospective log payload is not a valid session-log JSON object."""


@dataclass(frozen=True)
class LogEntry:
    filename: str
    asset: str
    interval: str
    epoch: int
    version: str


@dataclass(frozen=True)
class LocalState:
    logs: tuple[LogEntry, ...]
    existing_names: frozenset[str]


@dataclass(frozen=True)
class Selection:
    candidates: tuple[LogEntry, ...]
    skipped_existing: tuple[LogEntry, ...]
    historical_gaps: tuple[LogEntry, ...]


@dataclass(frozen=True)
class ProcessResult:
    copied: tuple[str, ...]
    skipped_existing: tuple[str, ...]
    failures: tuple[tuple[str, str], ...]
    validated: tuple[str, ...]


def parse_log_filename(filename: str) -> LogEntry | None:
    """Parse one established session-log basename, or return None."""
    match = LOG_NAME_RE.fullmatch(filename)
    if match is None:
        return None
    fields = match.groupdict()
    return LogEntry(
        filename=filename,
        asset=fields["asset"],
        interval=fields["interval"],
        epoch=int(fields["epoch"]),
        version=fields["version"],
    )


def parse_requested_version(value: str) -> str:
    """Argparse validator for exact engine version tags."""
    if VERSION_RE.fullmatch(value) is None:
        raise argparse.ArgumentTypeError(
            "version must look like v8, v7s, v6, or v54"
        )
    return value


def run_git(repo: Path, arguments: Sequence[str]) -> subprocess.CompletedProcess[bytes]:
    """Run Git without a shell and capture both output streams."""
    command = ["git", "-C", str(repo), *arguments]
    try:
        result = subprocess.run(
            command,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError as exc:
        raise GitCommandError(f"could not execute git: {exc}") from exc

    if result.returncode != 0:
        stderr = result.stderr.decode("utf-8", errors="replace").strip()
        detail = stderr or f"exit code {result.returncode}"
        raise GitCommandError(f"{' '.join(command)} failed: {detail}")
    return result


def validate_prerequisites(repo: Path) -> Path:
    """Validate required repository paths and return the log directory."""
    if not repo.is_dir():
        raise PrerequisiteError(f"repository directory does not exist: {repo}")
    git_path = repo / ".git"
    if not git_path.exists():
        raise PrerequisiteError(f"Git metadata does not exist: {git_path}")
    log_dir = repo / REMOTE_LOG_DIR
    if not log_dir.is_dir():
        raise PrerequisiteError(f"log directory does not exist: {log_dir}")
    return log_dir


def fetch_origin_main(repo: Path) -> None:
    """Refresh only origin/main; this does not update the worktree or index."""
    run_git(repo, ["fetch", "--quiet", "origin", "main"])


def get_origin_commit(repo: Path) -> str:
    """Return the fetched origin/main commit hash."""
    result = run_git(repo, ["rev-parse", "--verify", REMOTE_REF])
    return result.stdout.decode("ascii", errors="strict").strip()


def list_remote_logs(repo: Path, version: str) -> list[LogEntry]:
    """List matching direct children from AUTOPSY/logs in origin/main."""
    result = run_git(
        repo,
        [
            "ls-tree",
            "-r",
            "--name-only",
            REMOTE_REF,
            "--",
            str(REMOTE_LOG_DIR),
        ],
    )
    try:
        output = result.stdout.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise GitCommandError("git ls-tree returned non-UTF-8 path data") from exc

    entries: list[LogEntry] = []
    for line in output.splitlines():
        remote_path = PurePosixPath(line)
        # Nested paths and paths elsewhere in the repository are not logs.
        if remote_path.parent != REMOTE_LOG_DIR:
            continue
        parsed = parse_log_filename(remote_path.name)
        if parsed is not None and parsed.version == version:
            entries.append(parsed)
    return sorted(entries, key=lambda entry: (entry.epoch, entry.filename))


def scan_local_logs(log_dir: Path, version: str) -> LocalState:
    """Parse local logs and retain every basename for no-overwrite checks."""
    logs: list[LogEntry] = []
    names: set[str] = set()
    for path in log_dir.iterdir():
        names.add(path.name)
        parsed = parse_log_filename(path.name)
        if parsed is not None and parsed.version == version:
            logs.append(parsed)
    logs.sort(key=lambda entry: (entry.epoch, entry.filename))
    return LocalState(tuple(logs), frozenset(names))


def find_high_water(logs: Iterable[LogEntry]) -> LogEntry | None:
    """Return the deterministic newest local entry."""
    return max(logs, key=lambda entry: (entry.epoch, entry.filename), default=None)


def select_candidates(
    remote_logs: Iterable[LogEntry],
    existing_names: Iterable[str],
    high_water_epoch: int | None,
) -> Selection:
    """Classify remote logs without ever backfilling below the high-water mark."""
    existing = set(existing_names)
    candidates: list[LogEntry] = []
    skipped: list[LogEntry] = []
    gaps: list[LogEntry] = []

    for entry in sorted(remote_logs, key=lambda item: (item.epoch, item.filename)):
        if entry.filename in existing:
            skipped.append(entry)
        elif high_water_epoch is not None and entry.epoch < high_water_epoch:
            gaps.append(entry)
        else:
            # This includes a missing sibling exactly at the high-water epoch.
            candidates.append(entry)

    return Selection(tuple(candidates), tuple(skipped), tuple(gaps))


def validate_payload(payload: bytes) -> dict:
    """Decode and validate the required top-level log payload shape."""
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise PayloadValidationError("payload is not valid UTF-8") from exc
    try:
        value = json.loads(text)
    except json.JSONDecodeError as exc:
        raise PayloadValidationError(
            f"payload is not valid JSON: line {exc.lineno}, column {exc.colno}"
        ) from exc
    if not isinstance(value, dict):
        raise PayloadValidationError("top-level JSON value is not an object")
    if not isinstance(value.get("rows"), list):
        raise PayloadValidationError("top-level 'rows' value is not a list")
    return value


def path_lexists(path: Path) -> bool:
    """Like Path.exists(), but also treats a broken symlink as occupied."""
    return os.path.lexists(os.fspath(path))


def atomic_write_new(destination: Path, payload: bytes) -> None:
    """Atomically publish payload while guaranteeing no existing file is replaced.

    A same-directory hard link is used as the atomic publication operation.
    Unlike os.replace()/os.rename(), link creation fails if the destination
    already exists.  Removing the temporary name afterward gives move-like
    semantics while preserving the strict no-overwrite guarantee.
    """
    if path_lexists(destination):
        raise FileExistsError(f"destination already exists: {destination}")

    fd = -1
    temp_path: Path | None = None
    try:
        fd, temp_name = tempfile.mkstemp(
            prefix=f".{destination.name}.",
            suffix=".tmp",
            dir=destination.parent,
        )
        temp_path = Path(temp_name)
        with os.fdopen(fd, "wb") as stream:
            fd = -1  # fdopen owns it from this point onward.
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())

        # os.link is an atomic create-if-absent publication on this filesystem.
        os.link(temp_path, destination)
    finally:
        if fd >= 0:
            os.close(fd)
        if temp_path is not None:
            try:
                temp_path.unlink()
            except FileNotFoundError:
                pass


def read_remote_payload(repo: Path, entry: LogEntry) -> bytes:
    """Read one blob directly from the fetched remote tree."""
    object_name = f"{REMOTE_REF}:{REMOTE_LOG_DIR}/{entry.filename}"
    return run_git(repo, ["show", object_name]).stdout


def install_payload(destination: Path, payload: bytes) -> None:
    """Validate a payload before atomically publishing it."""
    validate_payload(payload)
    atomic_write_new(destination, payload)


def process_candidates(
    repo: Path,
    log_dir: Path,
    candidates: Iterable[LogEntry],
    *,
    dry_run: bool,
    payload_reader: Callable[[Path, LogEntry], bytes] = read_remote_payload,
) -> ProcessResult:
    """Validate and, unless dry-running, install candidates independently."""
    copied: list[str] = []
    skipped: list[str] = []
    failures: list[tuple[str, str]] = []
    validated: list[str] = []

    for entry in sorted(candidates, key=lambda item: (item.epoch, item.filename)):
        destination = log_dir / entry.filename

        # Repeat the exact-name check immediately before reading/installing.
        if path_lexists(destination):
            skipped.append(entry.filename)
            continue

        try:
            payload = payload_reader(repo, entry)
            validate_payload(payload)
            validated.append(entry.filename)
            if not dry_run:
                atomic_write_new(destination, payload)
                copied.append(entry.filename)
        except FileExistsError:
            # A concurrent creator won; its file is never replaced.
            skipped.append(entry.filename)
        except (GitCommandError, PayloadValidationError, OSError) as exc:
            failures.append((entry.filename, str(exc)))

    return ProcessResult(
        tuple(copied),
        tuple(skipped),
        tuple(failures),
        tuple(validated),
    )


def utc_iso(epoch: int) -> str:
    """Format Unix seconds as an unambiguous UTC ISO-8601 timestamp."""
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat().replace("+00:00", "Z")


def build_parser() -> argparse.ArgumentParser:
    default_repo = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(
        description=(
            "Fetch origin/main and safely copy only new AUTOPSY session-log "
            "JSON files. The worktree, index, branch, and existing logs are "
            "never changed."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""examples:
  # Preview new V8 logs without writing
  python3 tools/pull-new-autopsy-logs.py --version v8 --dry-run

  # Copy only V8 logs newer than the local V8 high-water mark
  python3 tools/pull-new-autopsy-logs.py --version v8

  # Pull a different engine version
  python3 tools/pull-new-autopsy-logs.py --version v7s
""",
    )
    parser.add_argument(
        "--repo",
        type=Path,
        default=default_repo,
        help=f"repository root (default: {default_repo})",
    )
    parser.add_argument(
        "--version",
        required=True,
        type=parse_requested_version,
        help="exact log version suffix, for example v8 or v7s",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="fetch, discover, and validate candidates without writing logs",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="list candidates and exact-name skips",
    )
    return parser


def print_summary(
    *,
    version: str,
    commit: str,
    high_water: LogEntry | None,
    remote_count: int,
    selection: Selection,
    process_result: ProcessResult,
    initial_skipped: Iterable[str],
    dry_run: bool,
    verbose: bool,
    exit_status: int,
) -> None:
    skipped_names = sorted(set(initial_skipped) | set(process_result.skipped_existing))

    print(f"requested version: {version}")
    print(f"origin/main commit: {commit}")
    if high_water is None:
        print("local high-water: none")
    else:
        print(
            "local high-water: "
            f"{high_water.filename}; epoch={high_water.epoch}; "
            f"UTC={utc_iso(high_water.epoch)}"
        )
    print(f"remote matching-log count: {remote_count}")
    print(f"eligible newer/same-epoch candidates: {len(selection.candidates)}")
    print(f"copied: {len(process_result.copied)}")
    if dry_run:
        print(f"dry-run validated: {len(process_result.validated)}")
    print(f"skipped because filename already exists: {len(skipped_names)}")
    print(
        "historical gaps detected but intentionally not pulled: "
        f"{len(selection.historical_gaps)}"
    )
    for entry in selection.historical_gaps:
        print(f"  historical gap: {entry.filename}")

    if verbose:
        for entry in selection.candidates:
            print(f"  candidate: {entry.filename}")
        for name in skipped_names:
            print(f"  existing, skipped: {name}")
        for name in process_result.copied:
            print(f"  copied file: {name}")

    print(f"validation/copy failures: {len(process_result.failures)}")
    for filename, reason in process_result.failures:
        print(f"  failure: {filename}: {reason}")
    print(f"final exit status: {exit_status}")


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    repo = args.repo.expanduser().resolve()

    try:
        log_dir = validate_prerequisites(repo)
        fetch_origin_main(repo)
        commit = get_origin_commit(repo)
        remote_logs = list_remote_logs(repo, args.version)
        local_state = scan_local_logs(log_dir, args.version)
    except (PrerequisiteError, GitCommandError, OSError, UnicodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        print("final exit status: 2", file=sys.stderr)
        return 2

    high_water = find_high_water(local_state.logs)
    selection = select_candidates(
        remote_logs,
        local_state.existing_names,
        None if high_water is None else high_water.epoch,
    )

    process_result = process_candidates(
        repo,
        log_dir,
        selection.candidates,
        dry_run=args.dry_run,
    )
    status = 1 if process_result.failures else 0
    print_summary(
        version=args.version,
        commit=commit,
        high_water=high_water,
        remote_count=len(remote_logs),
        selection=selection,
        process_result=process_result,
        initial_skipped=(entry.filename for entry in selection.skipped_existing),
        dry_run=args.dry_run,
        verbose=args.verbose,
        exit_status=status,
    )
    return status


if __name__ == "__main__":
    raise SystemExit(main())
