# Automated Run Notes

## Current state

Continuous VM collection is active for every BTC five-minute market using both V8 and V10.

- Started: July 22, 2026 at 10:35 PM EDT (`2026-07-23T02:35:00Z`)
- Cutoff: July 25, 2026 at 8:00 PM EDT (`2026-07-26T00:00:00Z`)
- First market: `btc-updown-5m-1784774100`
- Final market: `btc-updown-5m-1785023700`
- Expected markets: 833 per version
- Repository: `brickdatalab/61426`
- Repository destination: `AUTOPSY/logs`

The first 25-minute soak completed successfully: five consecutive markets were captured by both V8 workers, both workers had zero restarts, V10 raw logs were present, and verified V8/V10 files reached `origin/main`.

## What is running

### V8

V8 runs through two isolated headless Chromium workers on the VM. They execute an immutable copy of the existing V8 dashboard and signal engine, preserving browser behavior.

- Primary: `continuous-v8-primary.service`
- Standby: `continuous-v8-standby.service`
- Static page server: `continuous-v8-static.service`

Each worker creates its own candidate. The publisher uses the primary when valid and the standby only as recovery. Partial markets are rejected rather than published.

### V10

V10 continues through its existing authoritative VM runtime:

- Runtime: `v10-research.service`
- Spool drainer: `v10-spool-drainer.service`
- GCS backup: `v10-log-backup.timer`

Locked safety state:

- Mode: `RESEARCH_ONLY`
- Model: `AWAITING_DATA`
- Policy: `DISABLED`
- Trade intent: `ABSTAIN`
- No wallet or order-posting capability is enabled

V10 raw JSONL remains immutable in GCS. Git receives one compact `_v10.json` file per finalized market only after Gamma settlement and GCS SHA-256 provenance are available.

## Publication and monitoring

- Git publisher: `continuous-log-publisher.timer`
- Health monitor: `continuous-collection-monitor.timer`
- Automatic cutoff: `continuous-collection-cutoff.timer`

The publisher runs every five minutes under the existing repository lock. It pulls/rebases `origin/main`, stages only new files in `AUTOPSY/logs`, commits, and pushes. GitHub outages leave files queued locally for retry; existing filenames are never overwritten.

V8 logs can publish as soon as the market and Gamma validation are complete. V10 normally trails because its raw stream must first pass the immutable GCS backup grace period.

The monitor checks worker heartbeats, row growth, missing slugs, V10 source state, Chainlink rejection counters, spool backlog, Gamma finalization, Git publication, and safety mode.

## Known V10 quality warning

Some V10 sessions have Binance coverage below the locked 98% training-quality threshold. Those sessions are still captured and published, but they are correctly marked unqualified for model training. This is a quality flag, not a dropped market or stopped collector.

Do not weaken the threshold or label these sessions model-ready without a separate evidence-backed change.

## Saturday cutoff behavior

At 8:00 PM EDT:

1. No new market may begin.
2. The 7:55–8:00 PM market finishes.
3. V8 workers stop.
4. V10 may remain alive briefly to receive authoritative Gamma settlement for the final market.
5. The V10 spool must be observably empty before its runtime and drainer stop.
6. GCS backup and Git publication drain.
7. Collection services and timers are stopped and disabled.
8. A final cutoff report is written.

## How to inspect the run

SSH:

```bash
ssh -i /Users/vitolo/.ssh/pm vincent@34.89.159.108
```

Check all services:

```bash
systemctl is-active \
  continuous-v8-primary.service \
  continuous-v8-standby.service \
  continuous-log-publisher.timer \
  continuous-collection-monitor.timer \
  continuous-collection-cutoff.timer \
  v10-research.service \
  v10-spool-drainer.service \
  v10-log-backup.timer
```

Check worker progress:

```bash
curl -fsS http://127.0.0.1:8792/health
curl -fsS http://127.0.0.1:8793/health
```

Check collection reports:

```bash
cat /home/vincent/continuous-collection/run/state/health-report.json
cat /home/vincent/continuous-collection/run/state/publisher-report.json
```

Check timers and recent publication:

```bash
systemctl list-timers \
  continuous-log-publisher.timer \
  continuous-collection-monitor.timer \
  continuous-collection-cutoff.timer \
  v10-log-backup.timer

journalctl -u continuous-log-publisher.service -n 100 --no-pager
git -C /home/vincent/autopsy-sync/repo log -10 --oneline
```

## Implementation location and verification

The VM deployment is under:

```text
/home/vincent/continuous-collection
```

The local implementation worktree is:

```text
/Users/vitolo/Desktop/61426/.worktrees/continuous-v8-v10
```

The implementation branch is:

```text
codex/continuous-v8-v10
```

That branch has not yet been merged into `main`.

Verification completed before handoff:

- 15 Python collection/monitor/cutoff tests passed
- 5 V8 controller tests passed
- 20 existing V8 signal tests passed
- Five consecutive live markets completed during the soak
- Both V8 workers had zero restarts
- Deployed source hashes matched the launch manifest
- Local V8, V8.2, V9, and V10 engine trees remained unchanged
- Publisher repository `HEAD` matched `origin/main`
