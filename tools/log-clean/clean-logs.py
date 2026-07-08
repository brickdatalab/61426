#!/usr/bin/env python3
# tools/log-clean/clean-logs.py — session-log completeness cleaner (standing pull->clean tool).
#
# Hard-deletes analysis-corrupting session logs from AUTOPSY/logs/, in THREE places
# (local clone -> origin/main -> the VM source dir), because the autopsy-sync cron
# re-pushes any log missing from the repo (idempotency = file-exists; see
# tools/autopsy-sync/autopsy_sync.py). Rules (locked 2026-07-08, user directive):
#   gap-run  : contiguous missing stretch > 10s inside the covered span  -> DELETE
#   early-end: last body rem > 10 (missing the final stretch)            -> DELETE
#   late-start: first body rem < 270 (>30 ticks late)                    -> DELETE
#              (<=30 ticks late is tolerated and KEPT)
#   density  : <80% of the covered span present via many small holes     -> DELETE
#              (throttled-cadence era; disable with --no-density)
# Scattered 1-2s holes never count. Mirrors (_v53m), AUTOPSY/incomplete/, _bq.json
# are never touched. Dry-run by default; --execute performs the deletion.
# Usage (standing workflow): python3 tools/log-clean/clean-logs.py --pull --execute
import argparse
import json
import os
import re
import shlex
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


def run(cmd, **kw):
    check = kw.pop('check', True)
    r = subprocess.run(cmd, **kw)
    if check and r.returncode != 0:
        sys.exit(1)
    return r


def git(repo, *args, **kw):
    return run(['git', '-C', str(repo), *args], **kw)


def main():
    ap = argparse.ArgumentParser(description='session-log completeness cleaner')
    ap.add_argument('--repo', default='.')
    ap.add_argument('--pull', action='store_true')
    ap.add_argument('--execute', action='store_true')
    ap.add_argument('--no-density', action='store_true')
    ap.add_argument('--no-vm', action='store_true')
    ap.add_argument('--vm-host', default='vincent@34.89.159.108')
    ap.add_argument('--vm-key', default='~/.ssh/pm')
    ap.add_argument('--vm-dir', default='/home/vincent/projects/61426/v5/logs')
    args = ap.parse_args()

    repo = Path(args.repo).resolve()
    logs_dir = repo / 'AUTOPSY' / 'logs'
    if not logs_dir.is_dir():
        print(f'ERROR: {logs_dir} not found', file=sys.stderr)
        sys.exit(1)

    if args.pull:
        git(repo, 'pull', '--rebase', '--autostash', 'origin', 'main')

    ver_re = re.compile(r'^(.*)_v([A-Za-z0-9]+)\.json$')
    files = []
    for p in sorted(logs_dir.glob('*-updown-5m-*_v*.json')):
        if not p.is_file():
            continue
        m = ver_re.match(p.name)
        if not m:
            continue
        slug, ver = m.group(1), m.group(2)
        if 'm' in ver:          # counterfactual mirrors (_v53m etc.) — never touch
            continue
        files.append((p, slug, ver))

    results = []  # (path, slug, ver, action, reasons, first_rem, last_rem)
    for p, slug, ver in files:
        try:
            data = json.loads(p.read_text())
        except Exception as e:
            print(f'WARN: unreadable JSON {p.name}: {e}', file=sys.stderr)
            results.append((p, slug, ver, 'SKIP', ['unreadable'], None, None))
            continue
        rows = data.get('rows', []) if isinstance(data, dict) else []
        has_settle = any(isinstance(r, dict) and 'settled' in r for r in rows)
        body_rems = sorted({
            int(round(r['rem'])) for r in rows
            if isinstance(r, dict) and 'settled' not in r
            and isinstance(r.get('rem'), (int, float))
        }, reverse=True)
        if not has_settle:
            print(f'WARN: no settle row {p.name}', file=sys.stderr)
            results.append((p, slug, ver, 'SKIP', ['no-settle'], None, None))
            continue
        if len(body_rems) < 2:
            print(f'WARN: <2 body rows {p.name}', file=sys.stderr)
            results.append((p, slug, ver, 'SKIP', ['too-few'], None, None))
            continue
        reasons = []
        first_rem = body_rems[0]
        last_rem = body_rems[-1]
        if first_rem < 270:
            reasons.append(f'late-start(first rem={first_rem})')
        if last_rem > 10:
            reasons.append(f'early-end(last rem={last_rem})')
        maxgap = 0
        for i in range(len(body_rems) - 1):
            g = body_rems[i] - body_rems[i + 1]
            if g > maxgap:
                maxgap = g
        if maxgap > 10:
            reasons.append(f'gap-run(maxgap={maxgap}s)')
        if not args.no_density:
            span = first_rem - last_rem + 1
            cov = len(body_rems) / span if span > 0 else 0
            if cov < 0.80:
                reasons.append(f'density(cov={cov * 100:.1f}%)')
        action = 'DELETE' if reasons else 'KEEP'
        results.append((p, slug, ver, action, reasons, first_rem, last_rem))

    versions = {}
    for p, slug, ver, action, reasons, fr, lr in results:
        v = versions.setdefault(ver, {'total': 0, 'keep': 0, 'delete': 0, 'skip': 0})
        v['total'] += 1
        if action == 'DELETE':
            v['delete'] += 1
        elif action == 'KEEP':
            v['keep'] += 1
        else:
            v['skip'] += 1

    print(f"{'ver':<10} {'total':>6} {'keep':>6} {'delete':>7}")
    for ver in sorted(versions):
        v = versions[ver]
        print(f"{ver:<10} {v['total']:>6} {v['keep']:>6} {v['delete']:>7}")

    deletes = [(p, reasons) for p, slug, ver, action, reasons, fr, lr in results
               if action == 'DELETE']
    print()
    for p, reasons in deletes:
        print(f"  DELETE {p.name}  {';'.join(reasons)}")

    if not args.execute:
        print()
        keep_late = [(p, fr) for p, slug, ver, action, reasons, fr, lr in results
                     if action == 'KEEP' and fr is not None and 270 <= fr <= 284]
        for p, fr in keep_late:
            print(f"  KEEP-late {p.name} (first rem={fr})")
        print(f"\nDRY-RUN: {len(deletes)} would be deleted. Re-run with --execute to purge.")
        return

    if not deletes:
        print('Nothing to delete.')
        return

    rel_files = [str(p.relative_to(repo)) for p, _ in deletes]

    # 1. remove from the git index + working tree
    git(repo, 'rm', '-q', '--', *rel_files)

    # 2. manifest (filenames + reasons only — the record of what died and why)
    manifest_dir = repo / 'tools' / 'log-clean'
    manifest_dir.mkdir(parents=True, exist_ok=True)
    manifest = manifest_dir / 'purged-manifest.txt'
    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    with open(manifest, 'a') as f:
        for p, reasons in deletes:
            f.write(f"{now} {p.name} {';'.join(reasons)}\n")
    git(repo, 'add', str(manifest.relative_to(repo)))

    # 3. commit + sync with origin
    git(repo, 'commit', '-q', '-m',
        f'chore(logs): purge {len(deletes)} incomplete logs [log-clean]')
    git(repo, 'pull', '--rebase', '--autostash', '-q', 'origin', 'main')
    git(repo, 'push', '-q', 'origin', 'main')

    # 4. VM-side deletion (else the autopsy-sync cron resurrects them)
    vm_deleted = 0
    if not args.no_vm:
        key = os.path.expanduser(args.vm_key)
        names = [p.name for p, _ in deletes]
        for i in range(0, len(names), 100):
            batch = names[i:i + 100]
            remote = f"cd {shlex.quote(args.vm_dir)} && rm -f -- " + \
                     ' '.join(shlex.quote(n) for n in batch)
            full_cmd = (f"ssh -i {shlex.quote(key)} -o ConnectTimeout=15 "
                        f"{shlex.quote(args.vm_host)} {shlex.quote(remote)}")
            print(full_cmd)
            r = subprocess.run(full_cmd, shell=True)
            if r.returncode != 0:
                sys.exit(1)
            vm_deleted += len(batch)

    vm_note = 'skipped' if args.no_vm else vm_deleted
    print(f"deleted {len(deletes)} locally+repo, deleted {vm_note} on VM, "
          f"manifest {manifest}")


if __name__ == '__main__':
    main()
