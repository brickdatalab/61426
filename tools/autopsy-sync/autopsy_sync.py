#!/usr/bin/env python3
"""Reconciler: sync completed session logs (any version) into the repo's
AUTOPSY/logs, correcting the settled field against Polymarket first.

Runs on the VM via cron every 5 min under flock. Read-only on the live log
dir; commits/pushes into a dedicated repo clone. See README.md.
"""
import argparse
import json
import os
import pathlib
import re
import subprocess
import time
import urllib.request

SLUG_RE = re.compile(r'^([a-z]+)-updown-(\d+)([mh])-(\d+)$')
FNAME_RE = re.compile(r'^(.+?)_v[0-9a-z.]+\.json$')

GAMMA = "https://gamma-api.polymarket.com/events?slug="
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}


# ---- pure logic ----

def slug_from_filename(fname):
    m = FNAME_RE.match(fname)
    if not m:
        return None
    slug = m.group(1)
    return slug if SLUG_RE.match(slug) else None


def interval_seconds(slug):
    m = SLUG_RE.match(slug)
    n = int(m.group(2))
    u = m.group(3)
    return n * (3600 if u == 'h' else 60)


def bar_end_epoch(slug):
    return int(SLUG_RE.match(slug).group(4)) + interval_seconds(slug)


def is_due(slug, now_epoch):
    return now_epoch >= bar_end_epoch(slug) + 300


def settle_from_log(doc):
    for r in doc.get("rows", []):
        if "settled" in r:
            return r["settled"]
    return None


def resolution_from_gamma(payload):
    if not payload:
        return {"resolved": False, "direction": None}
    mkts = (payload[0].get("markets") or [])
    if not mkts:
        return {"resolved": False, "direction": None}
    m = mkts[0]
    if not m.get("closed"):
        return {"resolved": False, "direction": None}
    outs = m.get("outcomes")
    prices = m.get("outcomePrices")
    if isinstance(outs, str):
        outs = json.loads(outs)
    if isinstance(prices, str):
        prices = json.loads(prices)
    winner = None
    for o, p in zip(outs or [], prices or []):
        if float(p) >= 0.99:
            winner = o
    if winner is None:
        return {"resolved": True, "direction": None}
    return {"resolved": True, "direction": "UP" if winner.strip().lower() == "up" else "DOWN"}


def decide(log_settle, gamma):
    if log_settle is None:
        return ("nosettle", None)
    if not gamma["resolved"]:
        return ("wait", None)
    if gamma["direction"] is None:
        return ("ambiguous", None)
    if log_settle == gamma["direction"]:
        return ("keep", log_settle)
    return ("correct", gamma["direction"])


# ---- orchestration ----

def fetch_gamma(slug):
    req = urllib.request.Request(GAMMA + slug, headers=UA)
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.load(r)


def load_log(path):
    with open(path) as f:
        return json.load(f)


def _same_data(path, doc):
    """True iff the file at path parses to JSON equal to doc (formatting-agnostic)."""
    try:
        with open(path) as f:
            return json.load(f) == doc
    except Exception:
        return False


def write_settle(doc, new_settle):
    for r in doc.get("rows", []):
        if "settled" in r:
            r["settled"] = new_settle
    return doc


def git(repo, *args, check=True):
    return subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, check=check)


def log(msg):
    print(f"[{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}] {msg}", flush=True)


def process(log_dir, repo, dry_run, min_rows=50):
    now = int(time.time())
    dest_dir = pathlib.Path(repo) / "AUTOPSY" / "logs"
    staged = []
    for fname in sorted(os.listdir(log_dir)):
        slug = slug_from_filename(fname)
        if not slug or not is_due(slug, now):
            continue
        src = pathlib.Path(log_dir) / fname
        try:
            doc = load_log(src)
        except Exception as e:
            log(f"SKIP {fname}: unreadable ({e})")
            continue
        body = sum(1 for r in doc.get("rows", []) if "settled" not in r)
        if body < min_rows:
            log(f"SKIP {fname}: incomplete ({body} rows < {min_rows})")
            continue
        ls = settle_from_log(doc)
        if ls is None:
            continue  # not settled yet
        dest = dest_dir / fname
        # Cheap idempotency FIRST (no network): if the repo already holds this
        # bar with identical data, it was verified on a prior cycle -> skip.
        if dest.exists() and _same_data(dest, doc):
            continue
        # New or differing -> consult Polymarket to verify/correct.
        try:
            gamma = resolution_from_gamma(fetch_gamma(slug))
        except Exception as e:
            log(f"WAIT {slug}: gamma error ({e})")
            continue
        time.sleep(1)  # be polite
        action, new = decide(ls, gamma)
        if action == "wait":
            log(f"WAIT {slug}: Polymarket not resolved yet")
            continue
        if action in ("ambiguous", "nosettle"):
            log(f"SKIP {slug}: {action}")
            continue
        if action == "correct":
            log(f"CORRECT {slug}: log={ls} -> polymarket={new}")
            write_settle(doc, new)
            if not dry_run:
                with open(src, "w") as f:  # fix the VM source in place too
                    json.dump(doc, f, indent=2, ensure_ascii=False)
        # After a possible correction, the repo may already match (e.g. it was
        # pre-corrected) -> nothing to sync.
        if dest.exists() and _same_data(dest, doc):
            continue
        log(f"SYNC {fname} ({action})")
        staged.append(fname)
        if not dry_run:
            dest.write_text(json.dumps(doc, indent=2, ensure_ascii=False))
    return staged


def commit_push(repo, staged, dry_run):
    if not staged:
        log("nothing to commit")
        return
    if dry_run:
        log(f"DRY-RUN would commit+push {len(staged)} file(s)")
        return
    for attempt in range(3):
        git(repo, "add", "AUTOPSY/logs")
        st = git(repo, "status", "--porcelain", "AUTOPSY/logs")
        if not st.stdout.strip():
            log("nothing staged after add")
            return
        git(repo, "commit", "-m", f"chore(autopsy): sync {len(staged)} settled log(s) [auto]")
        push = git(repo, "push", "origin", "main", check=False)
        if push.returncode == 0:
            log(f"pushed {len(staged)} file(s)")
            return
        log(f"push rejected (attempt {attempt + 1}), rebasing")
        git(repo, "pull", "--rebase", "origin", "main", check=False)
    log("ERROR: push failed after 3 attempts")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--log-dir", required=True)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--min-rows", type=int, default=50)
    args = ap.parse_args()
    if not args.dry_run:
        git(args.repo, "pull", "--rebase", "origin", "main", check=False)
    staged = process(args.log_dir, args.repo, args.dry_run, args.min_rows)
    commit_push(args.repo, staged, args.dry_run)


if __name__ == "__main__":
    main()
