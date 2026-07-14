# vm-pm.md — VM `pm` (34.89.159.108) System Report

*Generated 2026-07-07 ~13:40 UTC via read-only SSH inspection. All secrets redacted.*

## SECTION 1 — Host & Environment

| Item | Value |
|---|---|
| OS | Debian GNU/Linux 13 (trixie) |
| Kernel | 6.12.95+deb13-cloud-amd64 (x86-64) |
| Platform | Google Compute Engine |
| vCPU | 4 |
| RAM | 31 GiB (2.4 Gi used, 28 Gi available, **no swap**) |
| Disk `/` | 99 G, 7.3 G used (**8%**) — no partition >80% |
| Disk `/boot/efi` | 124 M, 8.7 M used (8%) |
| Timezone | **Etc/UTC** (NTP synchronized, RTC in UTC) ✓ |
| Python | 3.13.5 |
| Node | v20.19.2 |
| CLIs present | `/usr/bin/bq` (2.1.32), `/usr/bin/gcloud`, `/usr/bin/gsutil` (5.37), `/usr/bin/stunnel` |
| User | `vincent` (uid 1000), groups: `google-sudoers`, `docker`, `lxd`, `adm` |
| Uptime | 17h 37m (last boot Jul 6 ~19:57 UTC) |

Everything is healthy at the host level. Plenty of headroom.

## SECTION 2 — Listening Ports & Running Processes

| Port | Process | Purpose |
|---|---|---|
| :22 | sshd | SSH (your access) |
| :25 | exim4 (localhost) | default MTA, unused |
| :53 / :5355 | systemd-resolved | DNS / LLMNR |
| **:80** | python (`ourWebSocket/server.py`, pid 977) | **the live BTC/ETH tape data service** |
| **:443** | **stunnel4 (pid 1059754)** | **TLS forwarder — currently `:443 → 127.0.0.1:22` (ssh-tls). PRESENT & ACTIVE** |
| :8088 | python3 `http.server` (tape-playground) | static viewer |
| **:8801** | python uvicorn `main:app` (pid 978) | **`payload_v6` — a separate BTC 15m FastAPI payload** |
| :8803 | python (`v5logd/server.py`, pid 618) | legacy V5 log receiver |
| :20201 / :20202 | otelopscol / fluent-bit | GCP Ops Agent (metrics + logs) |

**What "payload_v6" is:** a FastAPI app (`uvicorn main:app`) at `/home/vincent/projects/payload_v6/`, exposing `GET /payload/v6` (a rich BTC **15m** payload: candle_state, FLAA flow/liquidity asymmetry, ensemble, polymarket, prior) and `GET /health`. It is **a different, parallel 15-minute system** — not the 5m up/down dashboard. It is the most CPU-hungry process on the box (~57% CPU, ~940 MB RSS; systemd-capped at CPUQuota=175%, MemoryMax=1500M).

**stunnel4 / :443 status (you asked specifically):** **PRESENT and ACTIVE.** Its config is `/etc/stunnel/ssh-tls.conf` (not `stunnel.conf`) and defines one service `[ssh-tls] accept = 443, connect = 127.0.0.1:22` — i.e. SSH-over-TLS, **unrelated to the dashboard**. The dashboard's intended TLS front (`61426-tls`, which would proxy `:443 → 127.0.0.1:8790`) is **disabled**, and could not bind :443 anyway while stunnel4 holds it.

Top CPU: `payload_v6` (57%), transient `bq insert` subprocesses for the bin collectors (30–85% bursts), `bin-1s/poly_5m_1s` (~10%), `ourWebSocket` (~2%). Load average ≈ 4.0–4.3 on 4 cores (at saturation but not overloaded; 28 GB RAM free).

## SECTION 3 — Systemd Services Related to This Project

| Unit | Enabled | Active | Port | One-line purpose |
|---|---|---|---|---|
| `ourwebsocket` | yes | **running** | 80 | live BTC/ETH tape WS (no-auth, on-change ~0.1s) — **the data service** |
| `payload-v6` | yes | **running** | 8801 | BTC 15m live payload endpoint (FastAPI) |
| `v5logd` | yes | running | 8803 | legacy V5 log receiver → `v5/logs/` |
| `tape-playground` | yes | running | 8088 | static `python -m http.server` viewer |
| `bin-book-1s` | yes | **running** | — | Binance SPOT depth20 ±0.12% imbalance → `bin.book_imb_1s` |
| `bin-poly-1s` | yes | **running** | — | Polymarket BTC/ETH 5m book stats → `bin.poly_5m_1s` |
| `bin-trades-1s` | yes | **running** | — | Binance aggTrades 1s OHLCV (spot+perp) → `bin.trades_1s` |
| `stunnel4` | generated | running | 443 | TLS tunnel (`:443→:22`, ssh-tls) |
| `61426-runner` | **disabled** | **inactive** | (8790) | headless engine control API — **NOT running** |
| `61426-tls` | **disabled** | **inactive** | (443) | TLS front for runner — **NOT running** |
| `collector` | **not installed** | n/a | — | older raw_d collector (`.service` file exists in repo only) |

Key ExecStart lines (secrets redacted):
- `ourwebsocket`: `ExecStart=/home/vincent/ourWebSocket/.venv/bin/python /home/vincent/ourWebSocket/server.py` · `Environment=OWS_PORT=80 OWS_MIN_INTERVAL_S=0.1` · `Restart=always`
- `payload-v6`: `ExecStart=.../.venv/bin/python -m uvicorn main:app --host 0.0.0.0 --port 8801 --log-level info --no-access-log` · `CPUQuota=175% MemoryMax=1500M OOMPolicy=kill`
- `v5logd`: `ExecStart=.../logd/.venv/bin/python server.py` · `Environment=V5_LOG_DIR=/home/vincent/projects/61426/v5/logs V5_LOG_PORT=8803`
- `bin-*`: each runs `/home/vincent/bin-1s/.venv/bin/python /home/vincent/bin-1s/<name>/main.py`, logs to `/home/vincent/bin-1s/logs/<name>.log`, `LimitNOFILE=65536`
- `61426-runner`: `ExecStart=/usr/bin/node .../runner/server.mjs` · `EnvironmentFile=/home/vincent/61426-runner/env` · `CPUQuota=50% MemoryMax=512M`
- `61426-tls`: `ExecStart=/usr/bin/node .../runner/tls-proxy.mjs` · `AmbientCapabilities=CAP_NET_BIND_SERVICE`

Repo-side unit files (not the live ones, but the source copies): `/home/vincent/projects/61426/v5/logd/v5logd.service`, `/home/vincent/autopsy-sync/repo/collector/collector.service`, `/home/vincent/autopsy-sync/repo/runner/systemd/{61426-runner,61426-tls}.service`.

## SECTION 4 — Cron Jobs

Only `vincent`'s crontab (no root cron, no project files in `/etc/cron.d/`):

```
*/2 * * * * /home/vincent/tests/compare_v5_v6.sh >> /home/vincent/tests/cron.log 2>&1
*/5 * * * * /usr/bin/flock -n /tmp/autopsy_sync.lock /home/vincent/autopsy-sync/repo/tools/autopsy-sync/run.sh >> /home/vincent/autopsy-sync/sync.log 2>&1
```

- **compare_v5_v6 (every 2 min):** fetches the **v5** payload at `http://34.51.188.104:8800/payload/v5` (authed with `X-API-Key`, key file `tests/v5.key` [REDACTED]) and the **v6** payload at `http://34.89.159.108:8801/payload/v6` in parallel, saves to `tests/runs/<ts>/`, honors a `STOPPED` sentinel and a `MAX_RUNS=15` cap. Logs to `tests/cron.log`.
- **autopsy-sync (every 5 min, flock-guarded):** reconciles settled session logs against Polymarket and pushes to GitHub (see Section 7). Logs to `autopsy-sync/sync.log`.

## SECTION 5 — The WebSocket Data Service (`ourWebSocket`)

Location: `/home/vincent/ourWebSocket/`. Files: `server.py` (10 KB, mtime Jul 2), `feeds.py` (15 KB, Jun 22), `compute.py` (3.9 KB, Jul 2), `config.py` (1.6 KB, Jul 2), `CONNECT.md`, `requirements.txt` (aiohttp only), `.venv/`, `logs/`. Three `.bak` files: `compute.py.bak-pre-v51`, `config.py.bak-pre-harden`, `server.py.bak-pre-harden` (all Jul 2).

`CONNECT.md` is the protocol source of truth (full text wanted — summary): no-auth WS at `ws://<host>/ws/v5/tape?symbol=BTCUSDT|ETHUSDT&bar=5m|15m`, on-change delivery at ~10 ticks/sec (100 ms floor), no rate limit, no caps. `GET /health` for liveness. **Note:** CONNECT.md examples show port `:8802` but the systemd unit overrides `OWS_PORT=80` — minor doc staleness.

**`server.py`** — aiohttp app on `:80`. Routes:
- `GET /` — service info
- `GET /health` — per-symbol hub liveness (spot/perp age, sample counts, client count)
- `GET /ws/v5/tape` — the WS endpoint (`symbol` + `bar` query; heartbeat 90 s; rejects unsupported → HTTP 400)
- `POST /log` — **V5 log receiver, NO AUTH (open).** Accepts `{slug, rows}`, slug-sanitized, atomic write (`*.json.tmp` → rename) to `$V5_LOG_DIR/<slug>.json`. **Disk guard:** rejects NEW files when the dir is ≥ `LOG_DIR_MAX_BYTES` (500 MB) or ≥ `LOG_DIR_MAX_FILES` (5000); returns 507. CORS `*`.
- `POST /v51/log` — same body, **requires `X-V5-Secret` header** (constant-time compared; `LOG_SECRET` is **SET** in `config.py`).
- A `broadcast_loop` per hub polls every `MIN_INTERVAL_S` (0.1 s) and sends **only when a trade arrived since last send** (on-change). Boots both BTCUSDT & ETHUSDT hubs at startup (spot + perp + depth feeds + broadcaster each).

**`feeds.py`** — three feed classes, all auto-reconnect with exp backoff (cap 30 s), never crash the loop:
- `SpotFeed`: `wss://stream.binance.com:9443/ws/{sym}@aggTrade` (real-time aggTrades). One-shot REST backfill via `api.binance.com/api/v3/aggTrades` to `min(bar_open, now-5m)` so cvd windows are live immediately. ID-dedup watermark on reconnect.
- `PerpFeed`: `fapi.binance.com/fapi/v1/aggTrades` via **REST poll every `PERP_POLL_S`=1.0 s**, paging by `fromId` (seam-free). 5 m startup backfill. **429-aware** (honors `Retry-After`). Symbols staggered 0.5 s.
- `DepthFeed`: `wss://stream.binance.com:9443/ws/{sym}@depth20@100ms` (top-20 snapshot every 100 ms). Imbalance within **±0.12 %** of mid.
- CVD sign convention: `aggTrade.m == true` ⇒ taker is SELL ⇒ negative USD.

**`compute.py` `snapshot()`** — emits, per tick:
| Field | Window / formula |
|---|---|
| `tape.cvd_candle_usd` | `cum_cvd(now) − cum_cvd(bar_start)` — only bar-dependent field |
| `tape.cvd_delta_1m` / `_3m` | `cum_cvd(now) − cum_cvd(now−60s/180s)` |
| `tape.large_print_net_3m_usd` | Σ signed USD of spot prints ≥ **$100 000** over 3 m (0 if none) |
| `tape.efficiency_3m` | \|Δprice₃ₘ\| / \|net BTC traded₃ₘ\| (3 dp) |
| `tape.price` | last spot price |
| `tape.bar_open` | spot price at bar start |
| `tape.binance_imb` | depth imbalance ∈ [−1,+1] (±0.12 % band) |
| `tape.vol_1m_usd` | sd of 1 s price diffs over 60 s × √60 (realized 1-min vol) |
| `perp_spot_divergence.perp_cvd_minus_spot_cvd_5m_usd` | (perp Δ5m) − (spot Δ5m) |

**`config.py` knobs** (env `OWS_*`): `OWS_PORT` (8802 default → overridden to 80), `OWS_MIN_INTERVAL_S=0.1`, `OWS_PERP_POLL_S=1.0`, `OWS_LARGE_PRINT_USD=100000`, `OWS_HOST=0.0.0.0`. `ALLOWED_SYMBOLS={BTCUSDT,ETHUSDT}`, `ALLOWED_BARS={5m:300000, 15m:900000}`. `LOG_SECRET` **[present, redacted]**. `LOG_DIR_MAX_BYTES=500 MB`, `LOG_DIR_MAX_FILES=5000`.

**One live sample** (captured via `aiohttp` against `ws://127.0.0.1/ws/v5/tape?symbol=BTCUSDT&bar=5m`):

```json
{"ts":1783431503306,"symbol":"BTCUSDT","bar_ms":300000,
 "tape":{"cvd_candle_usd":332973,"cvd_delta_1m":1064540,"cvd_delta_3m":-59133,
         "efficiency_3m":25.831,"large_print_net_3m_usd":149330,"price":63160.27,
         "bar_open":63174.0,"binance_imb":0.1172225645260996,"vol_1m_usd":111.83},
 "perp_spot_divergence":{"perp_cvd_minus_spot_cvd_5m_usd":-63519}}
```

Field meanings: positive = net aggressive buying; `tape.*` are spot-derived; divergence mixes spot+perp.

## SECTION 6 — Session Log Store

`/home/vincent/projects/61426/v5/logs/` — **342 entries, 72 MB.**

| Version tag | Count |
|---|---|
| `_v53` | 168 |
| `_v6` | 122 |
| `_v51` | 22 |
| `_v54` | 14 |
| `_v52` | 6 |
| misc (`test.json`, `cors-test.json`) | 2 |

- **Newest:** `btc-updown-5m-1783431000_v6.json` (Jul 7 13:35 UTC — actively being written).
- **Oldest:** `test.json` (Jul 2 02:12).
- **`mirrors/` subdir (22 MB):** `*_v53m.json` counterfactual replay files (Jul 2–4). **Never live sessions** — reconstructed what-if runs.

**v6 log schema** (`{slug, rows[]}`; 296 rows in the sample). Row fields: `t, rem, btc_imb, poly_imb, comb, cushion, cvd, cvd_since_open, cvd_d5/d10/d60, cush_d10, mom_z, mom_dir, imb_ewma, large_prints, efficiency, perp_spot_div, cvd_d3m, vol_1m, poly_mid, p_flip, flip_alert, signal (MIXED/UP/DOWN), early_call, early_tier (strong/qualified/lean)`. The **last row** carries the settle: `{settled: "UP"|"DOWN", open, close}`.

**How logs arrive:** browsers `POST /log` (or `/v51/log`) to `ourWebSocket:80` — confirmed by 354 `v5-log saved` entries in `service.log`. `v5logd:8803` is a parallel legacy receiver writing to the same dir (CLAUDE.md calls it "retired"; rarely used now).

## SECTION 7 — Autopsy-Sync (logs → GitHub)

Location `/home/vincent/autopsy-sync/`: `repo/` (full clone of `brickdatalab/61426`), `sync.log` (703 KB).

- **Mechanism:** cron calls `tools/autopsy-sync/run.sh` → `autopsy_sync.py --log-dir <READ-ONLY> --repo <git tree>`. It scans the logs dir, **skips incomplete logs** (<50 rows), for due bars fetches Polymarket resolution via the **Gamma API** (`gamma-api.polymarket.com/events?slug=`), compares the log's settle row to Polymarket's resolution (`decide()`), stages a post-mortem markdown at `AUTOPSY/<slug>.md`, then `git commit` (`chore(autopsy): sync N settled log(s) [auto]`) + `git push`.
- **Remote:** `git@github-autopsy:brickdatalab/61426.git` (SSH host alias in `~/.ssh/config`). **Deploy key EXISTS:** `/home/vincent/.ssh/autopsy_deploy` (private) + `.pub` — purpose: authenticated push to GitHub. *(Contents never read.)*
- **Schedule:** every 5 min, flock-guarded against overlap.
- **Health: SUCCEEDING.** Recent cycles push 1–2 files each every 5 min (e.g. `13:35:10 pushed 1 file(s)`); `SKIP` for incomplete, `WAIT … Polymarket not resolved yet` for bars still open. Read-only on the logs dir confirmed (`--log-dir` is only read; writes go to the repo tree).

## SECTION 8 — The Runner (control API + orchestrator + TLS)

**Deployed on disk** at `/home/vincent/61426-runner/`:
- `repo/runner/` — `server.mjs`, `control-api.mjs`, `orchestrator.mjs`, `session.mjs`, `engine-adapter.mjs`, `tls-proxy.mjs`, `feeds/` (ows.mjs, poly.mjs), `lib/` (clock, slug, atomic), `test/`.
- `tls/` — self-signed CA + server cert. Cert: **subject `CN=34.89.159.108`, issuer `CN=61426-runner-CA`, valid Jul 6 2026 → Jul 3 2036.** Private keys present, not read.
- `env` — keys `VM_CONTROL_SECRET, OWS_BASE, CONTROL_HOST, CONTROL_PORT, RUNNER_STATE_DIR, RUNNER_LOG_DIR` (all values [REDACTED]).
- `state/` — 7 session JSONs (UUID-named, 12 KB–151 KB), dated Jul 6 19:09 → **Jul 7 00:40** (most recent).

**BUT: both `61426-runner.service` and `61426-tls.service` are DISABLED and INACTIVE.** Last systemd activity Jul 6 ~20:58. The runner is **NOT running now**; the hosted web app cannot reach it.

How it works (when enabled):
- `server.mjs` binds the control API to **`127.0.0.1:8790` only** (localhost). **Gates on NTP sync** (`timedatectl NTPSynchronized=yes`) before resuming sessions — wrong clock ⇒ wrong bar boundaries. On start it `resumeAll()`s prior sessions from `state/`.
- `control-api.mjs`: **Bearer-token authed** (`Authorization: Bearer <VM_CONTROL_SECRET>`, `crypto.timingSafeEqual`). Routes: `POST /runs`, `DELETE /runs/:id`, `GET /runs`, `GET /runs/:id/rows`, `GET /logs`, `GET /logs/:id`.
- `engine-adapter.mjs`: dynamically `import()`s `<version>/src/signals.mjs` (e.g. `v6/src/signals.mjs`), records its git hash, and `buildInp()` transforms the OWS tape into the **exact `inp`** shape the dashboard's `sigTick` expects (`cushion, bimb, pimb, largePrints, efficiency, perpSpotDiv, cvd3m, remS, vol1m`). **So the runner is a headless dashboard** — it replaces the browser, reads OWS's WS, runs the engine, writes session JSONs.
- `orchestrator.mjs` supports **parallel sessions**.
- `tls-proxy.mjs` presents the self-signed cert on `:443` → `127.0.0.1:8790`.

**To bring it back online:** stop `stunnel4` (frees `:443`), then `systemctl enable --now 61426-runner 61426-tls`.

## SECTION 9 — BigQuery / `bin` Data Pipeline

Active collectors in `/home/vincent/bin-1s/` (venv-isolated, systemd-managed, all enabled+running):

| Service | Table | Cadence | Content |
|---|---|---|---|
| `bin-book-1s` | `bin.book_imb_1s` | 1 s | Binance SPOT depth20 imbalance (±0.12 %) + bid/ask USD + best bid/ask |
| `bin-poly-1s` | `bin.poly_5m_1s` | 1 s | Polymarket BTC/ETH 5m up/down book stats |
| `bin-trades-1s` | `bin.trades_1s` | 1 s | Binance aggTrades OHLCV (spot+perp, BTC+ETH) |

All three tables live in **dataset `bin`, project `lithe-hallway-493420-r4`, hour-partitioned on `ts_second`**. Inserts via `bq insert --ignore_unknown_values` (NDJSON temp file, 60 s timeout) using the **GCE service account** — no key on disk. `common/bq.py` is the flush helper.

`common/formulas.py` is the **authoritative, byte-faithful port** of (a) `feeds.py DepthFeed._imbalance` (BAND 0.0012) and (b) the dashboard `bookStats()` (POLY_BAND 0.06), plus `LARGE_PRINT_USD=100k`. It is the shared formula source between the live WS and the collectors — keeping the offline evidence base consistent with the live tape.

**Older `collector` (raw_d):** `/home/vincent/collector/collector.mjs` (Node.js; "24/7 tick collector → BigQuery raw_d, dual engine v5.3+v5.4"). Its `.service` file sits in the repo but is **NOT installed** in systemd (`systemctl status collector` → "could not be found"). **Paused/inactive.** *(No credentials inspected.)*

Also in the BQ project (unrelated): dataset `ndbf_applications.submissions` — some business-filings data, not touched by this system.

## SECTION 10 — Data-Flow Narrative

**(a) LIVE path:**
```
Binance (spot aggTrade WS + perp aggTrades REST + depth20@100ms WS)
   →  ourWebSocket :80  (compute.py → tape + perp/spot divergence)
   →  WS /ws/v5/tape  →  browser dashboard (v6/updown-liquidity-overlap.html)
   →  on bar settle: POST /log (:80)  →  /home/vincent/projects/61426/v5/logs/<slug>_v6.json
   →  autopsy-sync cron */5  →  Polymarket Gamma-API verify  →  git push → GitHub AUTOPSY/
   →  hosted web app consumes the AUTOPSY reports
```

**(b) BIGQUERY path (offline evidence base):**
```
Binance (spot book + aggTrades) + Polymarket (5m book)
   →  bin-1s collectors ×3  →  bq insert
   →  BigQuery bin.{book_imb_1s, trades_1s, poly_5m_1s}  (1 s rows, hour-partitioned)
```

**Where the runner fits:** it would replace the browser as a **headless engine** — `server.mjs` reads the OWS WS, `engine-adapter` runs `signals.mjs`, session JSONs land in `state/`. The Vercel web app would drive it through the Bearer-authed control API at `127.0.0.1:8790`, fronted by `tls-proxy.mjs` on `:443` (CA-pinned self-signed cert). **Currently OFFLINE** — both units disabled, `:443` held by stunnel4.

## SECTION 11 — Clock, Health, Anomalies

**Health right now (`GET /health`):** `status: ok`. BTC: spot_age 0.6 s, perp_age 0.0 s, 4000 samples, 1 client. ETH: spot_age 0.7 s, perp_age 1.1 s, 4000 samples, 0 clients. Rings full, feeds live.

**Clock:** UTC, NTP-synced. ✓ No disk pressure (8 % on `/`). No reverse proxy (nginx/caddy absent).

⚠️ **Anomalies / things to flag:**

1. **Binance perp HTTP 429 rate-limiting — the biggest concern.** Both `ourWebSocket` (`feed.perp.BTCUSDT/ETHUSDT`) **and** `payload-v6` (logger `v5.perp_tape`) are hitting `429 Too many requests; current limit of IP(34.89.159.108) is 2400 requests per minute` from the **shared outbound IP**. `ourWebSocket` honors it (8–10 s backoffs; 56 485 cumulative 429s across the rotated `service.log`), but the `perp_cvd_minus_spot_cvd_5m_usd` divergence metric degrades during each backoff. CLAUDE.md notes browser REST polling once earned an **IP ban (HTTP 418)** — the combined `ourWebSocket + payload-v6` perp polling is the likely root cause and is approaching (not yet at) ban territory.
2. **Load average ≈ 4.0–4.3 on 4 cores** (at saturation), driven by `payload-v6` (capped 175 % CPU) and the bin collectors' `bq insert` subprocess bursts. Memory is fine (28 GB free, no swap).
3. **`v5logd:8803` is still running** despite CLAUDE.md calling it "retired". It has **no auth** and writes to the same logs dir as `ourWebSocket /log`. The active writer is OWS (354 saves); v5logd looks redundant.
4. **CONNECT.md port examples (`:8802`) are stale** vs the actual `:80`.
5. The active stunnel config is **`/etc/stunnel/ssh-tls.conf`** (not `stunnel.conf`) — it forwards `:443 → :22`, which blocks the dashboard TLS front from binding.

## SECTION 12 — Inventory Delta / Surprises

- **`/home/vincent/dboard-listener/`** — `listener.cjs` (985 KB bundled Node), `.env` [REDACTED], `listener.log` (last touched Jun 29). **Not running.** Appears to be an older/experimental dashboard listener (predecessor to the runner). Untouched for ~8 days.
- **`/home/vincent/payload_v6_backups/`** — backups of `payload_v6`.
- **`/home/vincent/tests/`** — the `compare_v5_v6` cron harness (`state.json`, `runs/`, `v5.key`).
- **`/home/vincent/projects/payload_v6/.env`** — contains `BTC_ANALYZER_API_KEY` but a comment says "V6 runs without auth; key kept empty for compatibility."
- **Two full clones of `brickdatalab/61426` on the box:** `/home/vincent/autopsy-sync/repo` (the sync working tree) and `/home/vincent/61426-runner/repo` (the runner's engine source), plus `/home/vincent/projects/61426` (the logs host). The live dashboard HTML is served from the user's **local** repo (HTTP server on the user's machine), not from the VM — the VM ships only data + logs.
- **GCP Ops Agent** (`otelopscol :20201`, `fluent-bit :20202`) — standard Google monitoring, not project-specific.
- **`payload_v6` is a *parallel 15-minute system***, easily confused with the "v6" up/down dashboard because of the name. It powers the `compare_v5_v6` cron and is unrelated to the 5m dashboard pipeline.
- **No `nginx`/`caddy`/`apache`** reverse proxy anywhere.

---

## TL;DR MAP

```
LIVE DATA:
  Binance (spot WS/REST + perp REST + depth20 WS)
     │
     ▼
  ourWebSocket :80  ──compute.py──▶  WS /ws/v5/tape  ──▶  browser dashboard (v6)
     │  POST /log (no-auth) or /v51/log (X-V5-Secret)
     ▼
  /home/vincent/projects/61426/v5/logs/*.json
     │  cron */5  (autopsy-sync, read-only on logs)
     ▼
  Polymarket Gamma verify  ──▶  git push → GitHub brickdatalab/61426 AUTOPSY/ → web app

OFFLINE EVIDENCE:
  Binance + Polymarket ──▶  bin-1s collectors ×3 (systemd) ──▶  bq insert
     └──▶  BigQuery bin.{book_imb_1s, trades_1s, poly_5m_1s}  (1 s, hour-partitioned)

HEADLESS ENGINE (OFFLINE):
  61426-runner :8790 (localhost, Bearer) ◀── tls-proxy :443 (self-signed CA)
     └──▶ reads OWS WS, runs v6/src/signals.mjs, writes state/*.json
     ⚠ DISABLED; :443 is held by stunnel4 (ssh-tls :443→:22)

AUXILIARY:
  payload_v6 :8801     — separate BTC 15m FastAPI payload (compared vs v5 by cron */2)
  v5logd :8803         — legacy log receiver (no auth; redundant with OWS /log)
  tape-playground :8088 — static viewer
  GCP Ops Agent :20201/:20202
```

**One-line summary:** The VM's *core* job is `ourWebSocket:80` (live tape WS) + the `bin-*` BigQuery collectors; logs flow `browser → POST /log → v5/logs → autopsy-sync → GitHub`. The **runner (headless engine) is deployed but switched off**, and `:443` is currently occupied by an unrelated `stunnel4` ssh-tls forwarder. The most pressing operational issue is **shared-IP Binance perp 429s** caused by `ourWebSocket` + `payload_v6` both polling `fapi` from 34.89.159.108.
