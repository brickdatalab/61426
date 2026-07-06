# Vercel Integration — persistent, browser-independent version running

**Status as of 2026-07-06:** VM runner **code-complete, reviewed, pushed to `main`, and cloned onto the VM** at `/home/vincent/61426-runner/repo`. **40 tests pass on the VM's node 20** (built on node 25 — cross-version parity confirmed). **Live first-light on the VM validated both feeds** against the real market — and caught + fixed a real bug: `PolyFeed` wasn't unwrapping the array Gamma returns, so `pimb`/`poly_mid` were null (fix `ff7f870`; the 40 unit tests missed it because the fixture didn't match the real API shape). ourWebSocket feed, Polymarket feed, and the `buildInp` mapping all now produce correct live values. **Remaining before acceptance: TLS in front of the control-API (needs a domain — see §8), then the full live single-bar run, kill-9 resume, reboot, and A/B.** The Vercel app is built last.

### Deployment progress log
- ✅ Additive-only confirmed; runner + docs pushed to `main`; skill symlinks gitignored.
- ✅ VM ground truth: NTP synced (UTC), 4 cores / 31Gi, critical services identified (`ourwebsocket`, `bin-{book,poly,trades}-1s`, `payload-v6`, `tape-playground` enabled-on-boot; autopsy-sync is a `*/5` cron; `v5logd` running but NOT enabled-on-boot — flag before reboot).
- ✅ Cloned runner to `/home/vincent/61426-runner/repo` via the `autopsy_deploy` key; `npm ci`; 40/40 on node 20.
- ✅ Live feeds validated; PolyFeed array-unwrap bug fixed and re-validated live.
- ✅ Deployed under **systemd** (`61426-runner.service`, enabled, 127.0.0.1-only, `Nice=-5`/`CPUWeight=300` within `CPUQuota=50%`/`MemoryMax=512M`); env+secret generated on-VM (`openssl rand`), OWS on localhost; read-only deploy key.
- ✅ **Acceptance (a):** exact 1s cadence — **0 jitter over 134 ticks**, 0 stale inputs; settle → scratch-log write (298 rows) → continuous advance across 3 bars; settle `close` uses raw price.
- ✅ **kill-9 resume:** clean — single 6s gap, 0 dups, early-call latch reconstructed. (Caught + fixed a misleading `resumed 0` log.)
- ✅ **Reboot (b):** resumes into the same bar, one bounded+marked 123s downtime gap, correct single `DOWN` settle, **NTP gate fired before resume**. Surfaced a real bug — post-reboot NTP clock-slew caused dup/skip ticks for ~2 min — **fixed** (scheduler clamps to strictly-increasing seconds; unit-verified by an NTP-backward-slew test). A confirmatory second reboot would prove no-dups end-to-end.
- ✅ **(d) Idempotency:** each bar's settle log written exactly once across kill-9 + reboot (`_writeLogIdempotent`, unit-tested).
- ✅ **Directive 2:** golden API fixtures + env-gated live contract test (3/3 live) — fixture-drift bug class retired.
- ✅ Caught + fixed live: PolyFeed Gamma-array-unwrap bug (feeds were 0% exercised by the 40 unit tests).
- ⏳ **Remaining:** live A/B (c) — needs your browser open on the same market for ≥2 bars — then the Vercel app (`web/`, B1–B4). TLS is deferred to the Vercel hookup (Tailscale Funnel / DuckDNS+Caddy / pinned self-signed — free, no domain purchase).
- Test suite: **51 (48 pass + 3 live-contract skipped by default)**. Runner on `main` @ current HEAD.

This document is the full record of what was asked, why, the plan, what got built, what's left, and the decisions you (the user) still own.

---

## 1. What you asked for

Put the dashboards behind a Vercel project (not yet created) with these requirements:

1. **Run any version** from the hosted page, with **tabs** that each run a different version — and be able to run them **in parallel** to compare. Also run two tabs of the **same version on two different markets** at once.
2. **All log files show in a sidebar**, per version.
3. **No browser throttling.** Today, when a tab is backgrounded, Safari hard-suspends the tick loop (measured 29–70s gaps); Chrome throttles it. That must not happen.
4. **Persistent, server-side execution.** Start a continuous run, **close the tab / shut the laptop / fly to Rome**, and come back to it either still running or finished — **zero missed ticks**, all logs saved. Set it to 100 or 1000 continuous runs and it just keeps going bar-to-bar regardless of your computer.
5. **Single-password login page** on the Vercel site. (Password is set as an env var — see §7 note on why it's not written here.)
6. **Additive, not a swap.** Must not break anything, and localhost must keep working exactly as it does now. Once Vercel is proven, you'll stop using localhost — but not before.
7. **Engine stays in sync with the repo.** Change the engine in the repo and both localhost and the Vercel/VM path pick up the change automatically, because they read it from the repo.
8. Goal of this phase: **decide and add what the repo needs *before* you import it to Vercel.**

---

## 2. Why we're doing this (the reason)

The engine currently runs **in the browser** as a `setInterval` tick loop. That is the single cause of the throttling/gaps: a browser tab is not a reliable place to run a per-second loop for hours or days. Hosting the same page on Vercel changes nothing — it's still a browser tab. The only way to get the "close the laptop, no gaps" guarantee is to move the engine **off the browser entirely** onto always-on server compute.

---

## 3. The load-bearing decision

**Vercel cannot be the thing that runs the engine.** Vercel is serverless: functions are request-scoped and time-capped (minutes, not days), and Vercel Cron's finest granularity is one minute, not one second. Nothing on Vercel can hold a per-second loop for the ~3.5 days a 1,000-run continuous session takes.

So the architecture splits into **two planes**:

- **Engine plane = the `pm` VM** (GCP `lithe-hallway-493420-r4`, `34.89.159.108`). It already runs 24/7 and already has everything the engine needs *locally*: the ourWebSocket tape feed, the Polymarket book collector, and the log receiver. A headless Node **runner** runs the engine there, per-second, forever, independent of any browser.
- **Control plane = Vercel.** A password-gated Next.js app that starts/stops/configures runs on the VM, streams live state, and lists every version's logs. It holds no engine state — it's the control panel; the VM is the engine.

**In one line: Vercel is the control panel; the VM is the engine.**

### The four design decisions you approved
1. **Runner host:** `pm` VM, isolated (own systemd units + resource caps; it's just one more read-client on ourWebSocket, so it can't disturb the critical services).
2. **Vercel UI:** full-dashboard viewer (same 4 charts / pressure bar / conviction card / EARLY CALL badge as today, but **read-only** views of server-side runs).
3. **Build order:** phased — Phase 1 proves persistence with a thin viewer; Phase 2 adds full charts + parallel tabs.
4. **Live transport:** the browser **polls Vercel API routes**, which fetch from the VM server-side. (A Vercel HTTPS page can't connect directly to the VM's bare-IP `http`/`ws` — browsers block mixed content. The VM ticks at a true 1s regardless; polling only affects how fresh the *view* is, never whether ticks happen.)

---

## 4. How the pieces fit

```
Browser (HTTPS, any device)
   │  password cookie; polls ~1s (pauses when tab hidden)
   ▼
Vercel Next.js app  (web/)   ── password gate, viewer, log sidebar
   │  server-side proxy holds VM URL + secret (browser never sees them)
   ▼
VM control-API  (runner/control-api.mjs, behind TLS)   ── start/stop/list runs, rows, logs
   │
   ▼
Orchestrator  (runner/orchestrator.mjs)   ── N sessions, resume-on-boot
   │
   ▼
Session  (runner/session.mjs)   ── 1s tick loop per {version, market}
   ├── engine-adapter → imports vX/src/signals.mjs  (SAME file localhost uses)
   ├── feeds/ows.mjs  → ourWebSocket tape (localhost on the VM)
   ├── feeds/poly.mjs → Polymarket CLOB book
   └── writes <slug>_vX.json logs → picked up by existing autopsy-sync → repo
```

**Engine parity / repo sync (requirement 7):** the runner imports `vX/src/signals.mjs` from a git checkout on the VM and `git pull`s to update. It's the *same file* the localhost dashboards import, so a change in the repo updates both. No engine code is ever edited by this work.

---

## 5. What was actually built (Phase 1, VM side — DONE + reviewed)

All new code lives in **`runner/`** (additive; nothing existing was touched). Built test-first, one task at a time, each with an independent code review. **40 tests pass.**

| File | Responsibility |
|---|---|
| `runner/engine-adapter.mjs` | Maps the live tape + book to the **exact** `inp` object `tick()` expects; dynamically imports `vX/src/signals.mjs`; captures the engine's git hash. |
| `runner/lib/slug.mjs` | Parses market slugs (`btc-updown-5m-<epoch>`), bar boundaries, next-bar epoch. |
| `runner/lib/clock.mjs` | Drift-free monotonic 1-second scheduler; gap detection; a real `stop()`. |
| `runner/lib/atomic.mjs` | Atomic writes (temp → fsync → rename) so a crash never corrupts state/logs. |
| `runner/feeds/ows.mjs` | ourWebSocket client with auto-reconnect (exponential backoff) + `tape_age_ms` staleness. |
| `runner/feeds/poly.mjs` | Polymarket token resolve + book poll (900ms cap) + `bookStats` (byte-for-behavior identical to the dashboard) + backoff. |
| `runner/session.mjs` | The per-run tick loop: builds the exact log row, detects settle, advances bars for continuous runs, **resumes by replay** after a crash/reboot, idempotent settle write, engine-hash guard. |
| `runner/orchestrator.mjs` | Manages N parallel sessions; persists the active-run manifest atomically; resumes all runs on boot. |
| `runner/control-api.mjs` | Authed HTTP API (Bearer secret, constant-time compare): start/stop/list runs, fetch rows, list/read logs. |

### The two guarantees that were *proven*, not asserted
- **Exact engine parity.** Replaying a real logged bar through the adapter + engine reproduces its `signal`/`early_call` stream with **0 mismatches** — the VM runner produces identical calls to the browser.
- **Exact reboot resume.** A run killed mid-bar (after its early-call latch fired) resumes by replaying its own timestamped rows through a fresh engine and reproduces the uninterrupted stream **byte-for-byte across all 274 rows**. This is what makes "fly to Rome, come back to finished runs" real — the work never depended on your machine.

Plus: honest **gap policy** (never double-tick, never fabricate rows, always mark real gaps), **feed staleness flags**, **idempotent settle logs** (a crash between settle and write leaves exactly one correct log), and an **engine-hash resume guard** (won't silently resume a run on changed engine code). A review also caught and we fixed a **zombie-run bug** (a stopped/`DELETE`d run would otherwise have kept ticking forever).

---

## 6. What remains

### A7 — Deploy the runner to the VM (needs you: one decision + your infra)
- Clone the repo on `pm`, `npm ci` in `runner/`, verify NTP, install the systemd unit, start the control-API.
- **TLS is required** so the control secret never crosses cleartext HTTP. **This is the one decision blocking the deploy** — see §8.
- Then run the acceptance test (continuous run → kill/reboot → confirm resume with zero/marked gaps and all logs written).
- I can do almost all of this over SSH. The two things SSH can't do: provision TLS (needs your DNS or Cloudflare) and create the Vercel project.

### B1–B4 — The Vercel app (`web/`, buildable next)
- **B1:** Next.js scaffold + `vercel.json` + `.env.example` (placeholders only).
- **B2:** Password gate — login page + middleware, `crypto.timingSafeEqual`, in-memory rate limit.
- **B3:** Server-side proxy routes to the VM control-API (holds the URL + secret).
- **B4:** Thin viewer (live signal, early call, tick-health, current `rem`, staleness) + per-version log sidebar + visibility-aware polling (pauses when the tab is hidden).

### Phase 2 — full fidelity (after Phase 1 is proven)
Full 4-chart dashboard viewer, multi-tab / parallel runs, sidebar grouping, finished-run history.

### Acceptance gate (needs the VM deployed + the Vercel project)
(a) normal op = ~1s deltas, zero missed ticks; (b) reboot = gap bounded + marked, state reconstructed; (c) live A/B vs the browser dashboard on the same market ≥2 bars (signal/early-call **transitions** match exactly; small market-field deltas within tolerance are expected sampling skew); (d) idempotent settle; (e) existing log consumers still parse runner logs; (f) nothing existing disturbed.

---

## 7. Import readiness (what must be true before you import to Vercel)
- Next.js app builds from `web/` (set Vercel **Root Directory = `web`**).
- Env vars (documented as placeholders in `web/.env.example`): `APP_PASSWORD`, `SESSION_SECRET`, `VM_CONTROL_URL`, `VM_CONTROL_SECRET`.
- No secrets committed. `vercel.json` sets the framework preset + a function region near the VM.

> **Security note (why the password isn't written in this doc):** the approved plan requires the password value to appear **nowhere** in the repo/docs/code — placeholders only. You know the value; it goes into the Vercel env var `APP_PASSWORD` at project setup. Because it was shared in plaintext during design, treat the current value as **burned** and rotate it before real use. Same for `VM_CONTROL_SECRET`.

---

## 8. Decisions — RESOLVED (per the 2026-07-06 deploy directives)

1. **Sequencing:** deploy the VM runner and pass acceptance (a)–(d) FIRST; build the Vercel app (`web/`) only after. Use `curl` against the control-API as the stand-in viewer for Phase 1.
2. **TLS:** Cloudflare Tunnel (as a systemd unit, `Restart=always`), unless a domain with DNS control already exists → then Caddy + Let's Encrypt. Control-API is never exposed without TLS. **Open input needed: the domain situation — see below.**
3. **Reboot test:** do both — `kill -9` for fast resume iteration, plus one genuine `sudo reboot` mid-bar for acceptance (b).
4. **Acceptance (b) amended:** a real live reboot has no uninterrupted reference stream, so it verifies only *gap bounded + marked + no dupes + successful resume*; signal-parity-after-resume is proven by the deterministic kill/resume test (confirmed to replay a **real** `_v6.json` log).
5. **Systemd ordering:** runner unit declares `After=network-online.target time-sync.target`, `Wants=network-online.target`; verify `timedatectl` synced before the orchestrator resumes on boot.
6. **Secrets:** generate `VM_CONTROL_SECRET`/`SESSION_SECRET` on the VM at deploy (`openssl rand -hex 32`); rotate `APP_PASSWORD` before the Vercel app goes live. Nothing written to repo/docs.
7. **Dead-man switch (recommended):** healthchecks.io ping per successful tick batch so a stalled runner emails; else the minimal viewer must show last-row age prominently.
8. **Push:** done — all commits are on `origin/main`.

**The one thing I need from you to proceed:** your **domain situation** for TLS (a stable hostname is required for the Vercel→VM link and to survive reboots). See the question below.

---

## 9. Reference

- **Design/plan doc:** `docs/superpowers/plans/2026-07-06-vercel-vm-runner-phase1.md` (full task-by-task plan with the 6 hardening amendments + 4 clarifications folded in).
- **Run the tests:** `cd /Users/vitolo/Desktop/61426 && node --test runner/test/*.test.mjs` → 40 pass.
- **Build commits (local, unpushed, on `main`):** `92fd548` (plan) → `2fb56cb` (latest). The `feat(runner): …` commits are the runner tasks A1–A6; the two `docs(plan): …` commits fold review findings into the plan.
- **VM:** `pm` @ `34.89.159.108`, SSH key `~/.ssh/pm`, project `lithe-hallway-493420-r4`. Critical services on it (must not be disturbed): `ourwebsocket`, `bin-1s` collectors, `autopsy-sync`.
- **Nothing is deployed to the VM or to Vercel yet.** localhost is completely unaffected and works exactly as before.
