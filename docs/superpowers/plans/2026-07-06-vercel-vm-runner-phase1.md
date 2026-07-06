# Persistent VM Runner + Vercel Control Plane — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Prove that a chosen version can run **continuously and server-side on the pm VM** — surviving tab close, laptop off, and VM reboot with a bounded/marked gap and correctly reconstructed engine state — controlled and viewed through a password-gated Vercel app, with zero changes to the existing engine, dashboards, or VM services.

**Architecture:** Two planes. **VM (engine):** a Node runner imports `vX/src/signals.mjs` from the repo checkout, subscribes to the local ourWebSocket tape, polls the Polymarket book, ticks `tick()` every wall-clock second, writes the existing `<slug>_vX.json` log format at settle, advances bars for continuous runs, and persists run state atomically for reboot resume-by-replay. A TLS-fronted, secret-authed control API exposes start/stop/status/rows/logs. **Vercel (control):** a Next.js app, single-password gated, whose server-side API routes proxy the VM (browser never touches the VM — mixed content); a thin viewer polls run state (visibility-aware).

**Tech Stack:** Node 20+ (VM runner, `ws` + stdlib), the repo's existing `vX/src/signals.mjs` (unchanged), Next.js (Vercel, App Router), Caddy+Let's Encrypt (or Cloudflare Tunnel) for control-API TLS, systemd + `systemd-timesyncd`.

## Global Constraints

- **Additive only.** Never edit `vX/src/signals.mjs`, any `vX/updown-liquidity-overlap.html`, `ourWebSocket/`, `bin-1s/`, or `autopsy-sync/`. New code lives in `runner/` and `web/` only.
- **Engine is deterministic given `inp`** (verified: no `Date.now`/`performance.now`/`Math.random`/`new Date` in any `signals.mjs`; `tick(s, inp)` takes `inp.now`). Replay parity and resume-by-replay depend on this — do not introduce nondeterminism in the adapter.
- **Log format is the existing one, byte-compatible for existing consumers.** Per-tick rows must carry the exact keys the browser writes (list in Task A5). Staleness fields (`tape_age_ms`, `book_age_ms`) are added; before shipping, verify all consumers (autopsy-sync, `v6/analysis/replay-compare.mjs`, `~/.claude/skills/autopsy/scripts/autopsy_data.py`) access fields **by name** and ignore unknowns; if any validates strictly, move staleness to a sidecar state file (not the log rows).
- **Gap policy:** never double-tick, never fabricate/backfill rows, always record real gaps. Normal op = ~1s inter-row deltas, zero missed ticks.
- **Resume guard:** record the engine file's git commit hash in run state + log; on resume refuse if the current hash differs unless `--override-engine-change` is passed.
- **Atomic writes:** temp → fsync → rename for all state + log writes; settle/log write idempotent.
- **Secrets:** the password value appears NOWHERE in repo/docs/code/`.env.example` — placeholders only; README notes the current value is burned, rotate before production. Login uses `crypto.timingSafeEqual` + best-effort in-memory per-IP attempt cap + unconditional small delay on failure (no Redis/KV; note cross-instance limitation in a comment). Control-API secret must travel over TLS only.
- **VM control-api on a NEW port**, behind TLS + shared secret; Vercel holds `VM_CONTROL_URL` + `VM_CONTROL_SECRET`.
- Slug grammar (verbatim from dashboard `parseSlug`): `^([a-z]+)-updown-(\d+)([mh])-(\d+)$`; `barSec = num*(unit==='h'?3600:60)`; `symbol = {btc:BTCUSDT, eth:ETHUSDT,...}`; `end = ts + barSec`.
- ourWebSocket URL: `ws://34.89.159.108/ws/v5/tape?symbol=<SYM>&bar=<interval>`. Log POST target: `http://34.89.159.108/log` body `{slug: "<slug>_v6", rows}`.

---

## File Structure

**VM runner (`runner/`, Node ESM):**
- `runner/lib/slug.mjs` — parse/format slugs, bar boundaries, next-bar epoch.
- `runner/lib/atomic.mjs` — `writeAtomic(path, str)` (temp+fsync+rename), `readJson`.
- `runner/lib/clock.mjs` — monotonic wall-clock 1s scheduler (`onSecond(cb)`).
- `runner/engine-adapter.mjs` — dynamic import of `../<version>/src/signals.mjs`; `buildInp(state)`; `buildRow(sg, state)` (exact log-row shape); engine git-hash.
- `runner/feeds/ows.mjs` — ourWebSocket client, reconnect/backoff, latest tape + `tape_age_ms`.
- `runner/feeds/poly.mjs` — Gamma token resolve + CLOB book poll + `bookStats` (POLY_BAND=0.06) → `{pimb, poly_mid, book_age_ms}`; backoff on error/429; shared per market.
- `runner/session.mjs` — one run: scheduler → adapter → row; settle; continuous advance; resume-by-replay; atomic log write; engine-hash guard.
- `runner/orchestrator.mjs` — N sessions; atomic state persist to `runner/state/`; resume-on-boot.
- `runner/control-api.mjs` — authed HTTP API.
- `runner/systemd/*.service`, `runner/deploy/Caddyfile`, `runner/README.md`.
- `runner/test/*.test.mjs` — node:test.

**Vercel app (`web/`, Next.js App Router):**
- `web/middleware.ts` — cookie gate.
- `web/app/login/page.tsx` + `web/app/api/login/route.ts` — password login.
- `web/app/api/vm/[...path]/route.ts` — server-side proxy to VM control-api.
- `web/app/page.tsx` + components — thin viewer + sidebar + visibility-aware polling hook.
- `web/vercel.json`, `web/.env.example`, `web/README.md`.
- Root `.gitignore` additions: `runner/state/`, `runner/node_modules/`, `web/node_modules/`, `web/.next/`, `.env*` (keep `.env.example`).

---

## Task A1: Engine adapter + input mapping + replay parity (the parity core)

**Files:**
- Create: `runner/engine-adapter.mjs`, `runner/lib/slug.mjs`
- Test: `runner/test/engine-adapter.test.mjs`

**Interfaces produced:**
- `parseSlug(slug) -> {asset,symbol,interval,barSec,ts,end,label} | null`
- `barEndEpoch(slug) -> number`, `nextSlug(slug) -> string`
- `loadEngine(version) -> {mod, gitHash}` (dynamic `import('../<version>/src/signals.mjs')`)
- `buildInp({now, tape, book, barOpen}) -> inp` — the exact object `tick()` consumes
- `buildRow({t, rem, sg, tape, book, cush, comb, cvd, tapeAgeMs, bookAgeMs}) -> row`

- [ ] **Step 1: Failing test — `buildInp` maps tape+book to the exact `inp` keys**

```javascript
// runner/test/engine-adapter.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../engine-adapter.mjs';

test('buildInp maps tape+book to the exact inp keys the engine consumes', () => {
  const tape = { cvd_candle_usd: 1000, cvd_delta_3m: -2000, large_print_net_3m_usd: 50000,
    efficiency_3m: 3.2, price: 62050, bar_open: 62000, binance_imb: 0.14, vol_1m_usd: 20,
    perp_cvd_minus_spot_cvd_5m_usd: -60000 };
  const book = { pimb: 0.2, poly_mid: 0.55 };
  const inp = A.buildInp({ now: 1700000000000, tape, book, barOpen: 62000, remS: 210 });
  assert.equal(inp.sinceOpen, 1000);
  assert.equal(inp.price, 62050);
  assert.equal(inp.bimb, 0.14);
  assert.equal(inp.pimb, 0.2);
  assert.equal(inp.largePrints, 50000);
  assert.equal(inp.efficiency, 3.2);
  assert.equal(inp.perpSpotDiv, -60000);
  assert.equal(inp.cvd3m, -2000);
  assert.equal(inp.cushion, 50);      // price - barOpen
  assert.equal(inp.remS, 210);
  assert.equal(inp.vol1m, 20);
  assert.equal(inp.now, 1700000000000);
});
```

- [ ] **Step 2: Run — expect FAIL** `node --test runner/test/engine-adapter.test.mjs` → "buildInp is not a function".

- [ ] **Step 3: Implement `slug.mjs` + `engine-adapter.mjs` mapping**

```javascript
// runner/lib/slug.mjs
const SYM = { btc:'BTCUSDT', eth:'ETHUSDT', sol:'SOLUSDT', xrp:'XRPUSDT', doge:'DOGEUSDT' };
const RE = /^([a-z]+)-updown-(\d+)([mh])-(\d+)$/;
export function parseSlug(slug){
  const m = String(slug).trim().toLowerCase().match(RE);
  if(!m) return null;
  const [,asset,n,unit,ts]=m, num=+n, barSec=num*(unit==='h'?3600:60);
  return { asset, symbol: SYM[asset]||asset.toUpperCase()+'USDT', interval:num+unit, barSec, ts:+ts, end:+ts+barSec, label:`${asset.toUpperCase()} ${num}${unit}` };
}
export function barEndEpoch(slug){ const p=parseSlug(slug); return p.end; }
export function nextSlug(slug){ const p=parseSlug(slug); return `${p.asset}-updown-${p.interval}-${p.ts+p.barSec}`; }
```

```javascript
// runner/engine-adapter.mjs
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
export { parseSlug, barEndEpoch, nextSlug } from './lib/slug.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function loadEngine(version){
  const rel = `${version}/src/signals.mjs`;
  const mod = await import(path.join(REPO, rel));
  let gitHash = 'unknown';
  try { gitHash = execFileSync('git', ['-C', REPO, 'log','-1','--format=%H','--', rel], {encoding:'utf8'}).trim(); } catch {}
  return { mod, gitHash };
}

// EXACT inp the dashboard feeds V5.sigTick (v6 dashboard lines 404-410)
export function buildInp({ now, tape, book, barOpen, remS }){
  const price = tape?.price ?? null;
  const open = barOpen ?? tape?.bar_open ?? null;
  return {
    now,
    sinceOpen: tape?.cvd_candle_usd ?? null,
    price,
    bimb: tape?.binance_imb ?? null,
    pimb: book?.pimb ?? null,
    largePrints: tape?.large_print_net_3m_usd ?? null,
    efficiency: tape?.efficiency_3m ?? null,
    perpSpotDiv: tape?.perp_cvd_minus_spot_cvd_5m_usd ?? null,
    cvd3m: tape?.cvd_delta_3m ?? null,
    cushion: (price!=null && open!=null) ? price-open : null,
    remS,
    vol1m: tape?.vol_1m_usd ?? null,
  };
}
```

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Failing test — engine-path replay parity against a real log**

```javascript
// append to engine-adapter.test.mjs
import { readFileSync, readdirSync } from 'node:fs';
test('replaying a real _v6 log through adapter+engine reproduces its signal/early_call stream', async () => {
  const dir = new URL('../../AUTOPSY/logs/', import.meta.url);
  const f = readdirSync(dir).find(x=>x.endsWith('_v6.json'));
  const doc = JSON.parse(readFileSync(new URL(f, dir)));
  const settle = doc.rows.find(r=>r.settled);
  const rows = doc.rows.filter(r=>!r.settled);
  const { mod } = await A.loadEngine('v6');
  const s = mod.newSession(); let now = 1700000000000; let mism = 0;
  for(const r of rows){
    now += 1000;
    const tape = { cvd_candle_usd:r.cvd_since_open, price:(r.cushion!=null?settle.open+r.cushion:null),
      binance_imb:r.btc_imb, large_print_net_3m_usd:r.large_prints, efficiency_3m:r.efficiency,
      perp_cvd_minus_spot_cvd_5m_usd:r.perp_spot_div, cvd_delta_3m:r.cvd_d3m, vol_1m_usd:r.vol_1m, bar_open:settle.open };
    const inp = A.buildInp({ now, tape, book:{pimb:r.poly_imb, poly_mid:r.poly_mid}, barOpen:settle.open, remS:r.rem });
    const out = mod.tick(s, inp);
    const sig = out?.decision?.sig ?? 'MIXED';
    const ec = out?.early ? out.early.side : null;
    if(sig !== r.signal || ec !== (r.early_call ?? null)) mism++;
  }
  assert.equal(mism, 0, `${mism} rows diverged from the logged stream`);
});
```

- [ ] **Step 6: Run — expect PASS** (mirrors `v6/analysis/replay-compare.mjs`, which already reproduces the stream at 100%). If it fails, the mapping is wrong — fix `buildInp` before proceeding.

- [ ] **Step 7: Commit** `git add runner/engine-adapter.mjs runner/lib/slug.mjs runner/test/engine-adapter.test.mjs && git commit -m "feat(runner): engine adapter + inp mapping + replay parity"`.

---

## Task A2: Monotonic scheduler + gap policy

**Files:** Create `runner/lib/clock.mjs`; Test `runner/test/clock.test.mjs`
**Interfaces produced:** `remFor(nowMs, barEndEpochSec) -> number` (seconds, floored, ≥0); `gapSeconds(prevSec, nowSec) -> number`; `Scheduler` with `onSecond(cb)` firing once per UTC second boundary, `cb({sec, gapSec})` where `gapSec>1` means missed ticks (never fires cb for the missed seconds — records the gap).

- [ ] **Step 1: Failing test**

```javascript
// runner/test/clock.test.mjs
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { remFor, gapSeconds } from '../lib/clock.mjs';
test('remFor computes seconds to bar end, floored at 0', () => {
  const end = 1783348800 + 300;                 // bar end epoch (sec)
  assert.equal(remFor((end-90)*1000, end), 90);
  assert.equal(remFor((end+5)*1000, end), 0);
});
test('gapSeconds detects missed ticks without fabricating them', () => {
  assert.equal(gapSeconds(100, 101), 1);        // normal
  assert.equal(gapSeconds(100, 130), 30);       // 29 missed
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement `clock.mjs`** — `remFor = (nowMs,end)=>Math.max(0, end - Math.floor(nowMs/1000))`; `gapSeconds = (a,b)=>b-a`; `Scheduler` uses `setTimeout` re-armed to the next `Math.floor(Date.now()/1000)+1` boundary (drift-free), passes `gapSec` computed from the last fired second; on `gapSec>1` it does NOT emit the intermediate seconds.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit.**

---

## Task A3: ourWebSocket feed client (reconnect + staleness)

**Files:** Create `runner/feeds/ows.mjs`, `runner/lib/atomic.mjs`; Test `runner/test/ows.test.mjs`
**Interfaces produced:** `atomic.writeAtomic(path, str)`, `atomic.readJson(path)`; `OwsFeed(symbol, interval)` with `.start()`, `.latest() -> {tape, ageMs}` (ageMs = now − last message time; null tape until first message), exponential-backoff reconnect (1s→2s→…→30s cap).

- [ ] **Step 1: Failing test — staleness + reconnect state machine** (inject a fake WebSocket factory)

```javascript
// runner/test/ows.test.mjs
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { OwsFeed } from '../feeds/ows.mjs';
test('latest() reports null before first message and ageMs after', () => {
  let handlers={}; const fakeWS=()=>({ on:(e,f)=>handlers[e]=f, close(){}, terminate(){} });
  const f = new OwsFeed('BTCUSDT','5m',{ wsFactory:fakeWS, now:()=>1000 });
  f.start();
  assert.equal(f.latest().tape, null);
  handlers.message(JSON.stringify({ tape:{ price: 62000 } }));
  f._now = ()=>1300;
  const l = f.latest(); assert.equal(l.tape.price, 62000); assert.equal(l.ageMs, 300);
});
test('backoff grows then caps at 30s', () => {
  const f = new OwsFeed('BTCUSDT','5m',{});
  assert.deepEqual([0,1,2,3,4,5,6].map(n=>f._backoffMs(n)), [1000,2000,4000,8000,16000,30000,30000]);
});
```

- [ ] **Step 2–4:** Implement `atomic.mjs` (temp file `path+'.tmp'`, `fs.writeFileSync`, `fs.fsyncSync` on fd, `fs.renameSync`) and `ows.mjs` (real `ws` in prod via `wsFactory` default; `_backoffMs(n)=Math.min(1000*2**n, 30000)`; stores last message + timestamp; `latest()` returns `{tape, ageMs}`). Run → PASS.
- [ ] **Step 5: Commit.**

---

## Task A4: Polymarket book feed (`bookStats` parity + backoff)

**Files:** Create `runner/feeds/poly.mjs`; Test `runner/test/poly.test.mjs`
**Interfaces produced:** `bookStats(bids, asks, mid, band=0.06) -> {imb, bd, ad}` (verbatim port of dashboard `bookStats`); `PolyFeed(slug)` with `.start()` (resolve token via Gamma `events?slug=`, parse `markets[0].clobTokenIds[0]`), `.latest() -> {pimb, poly_mid, ageMs}`; 900ms fetch cap; backoff on error/429; shared instance per slug.

- [ ] **Step 1: Failing test — bookStats matches the dashboard formula**

```javascript
// runner/test/poly.test.mjs
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { bookStats } from '../feeds/poly.mjs';
test('bookStats: ±0.06 band around mid, normalized imbalance', () => {
  const bids=[[0.52,100],[0.40,100]]; const asks=[[0.54,100],[0.70,100]];
  const mid=(0.52+0.54)/2;                       // 0.53
  const { imb } = bookStats(bids, asks, mid, 0.06);
  // in-band: bid 0.52 (bd=0.52*100), ask 0.54 (ad=0.54*100); 0.40 & 0.70 out of band
  assert.ok(Math.abs(imb - ((52-54)/(52+54))) < 1e-9);
});
```

- [ ] **Step 2–4:** Implement `bookStats` verbatim (dashboard lines 253-262: in-band `|p-mid|<=mid*band || |p-mid|<=band`, bd sums bids `p<=mid`, ad sums asks `p>=mid`, `imb=(bd-ad)/(bd+ad)||0`); `PolyFeed` fetches `https://gamma-api.polymarket.com/events?slug=<slug>` (browser UA) → token, then polls `https://clob.polymarket.com/book?token_id=<t>` with an `AbortController` 900ms cap; `poly_mid=(max bid+min ask)/2`; backoff on failure; `ageMs` from last success. Run → PASS.
- [ ] **Step 5: Commit.**

---

## Task A5: Session — tick loop, row build, settle, continuous advance, resume-by-replay

**Files:** Create `runner/session.mjs`; Test `runner/test/session.test.mjs`
**Interfaces consumed:** A1 (`loadEngine`, `buildInp`, `parseSlug`, `nextSlug`, `barEndEpoch`), A2 (`Scheduler`, `remFor`, `gapSeconds`), A3 (`OwsFeed`, `writeAtomic`), A4 (`PolyFeed`).
**Interfaces produced:** `Session({runId, version, slug, continuousRemaining, stateDir, feeds})` with `.start()`, `.stop()`, `.status()`, `.rowsSince(n)`; on start, if a state file exists, **resume-by-replay** (reload in-progress-bar rows, replay through a fresh `newSession()` to reconstruct engine state, then resume live). Row schema (exact keys, matching v6 dashboard row + two additions):

```
t, rem, btc_imb, poly_imb, comb, cushion, cvd, cvd_since_open, cvd_d5, cvd_d10, cvd_d60,
cush_d10, mom_z, mom_dir, imb_ewma, large_prints, efficiency, perp_spot_div, cvd_d3m,
vol_1m, poly_mid, p_flip, flip_alert, signal, early_call, early_tier,
tape_age_ms, book_age_ms      // ADDED (staleness); gap rows also set gap:true
```

- [ ] **Step 1: Failing test — resume-by-replay reproduces the uninterrupted stream**

```javascript
// runner/test/session.test.mjs (uses fake feeds replaying a captured bar)
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { Session } from '../session.mjs';
import { makeFakeFeeds, loadCapturedBar } from './helpers.mjs';
test('a session killed mid-bar and resumed matches an uninterrupted reference', async () => {
  const bar = loadCapturedBar('v6');                 // {version, slug, open, rows}
  const ref = await runToEnd(bar);                    // helper: uninterrupted signal/early_call per row
  const dir = mkTmp();
  const s1 = new Session({ runId:'t1', version:'v6', slug:bar.slug, continuousRemaining:0,
    stateDir:dir, feeds:makeFakeFeeds(bar) });
  await s1.playUntilRow(Math.floor(bar.rows.length/2));  // deterministic partial run, persists state
  const s2 = new Session({ runId:'t1', version:'v6', slug:bar.slug, continuousRemaining:0,
    stateDir:dir, feeds:makeFakeFeeds(bar) });          // fresh process, same state dir
  const resumed = await s2.playToEnd();
  assert.deepEqual(resumed.map(r=>[r.signal, r.early_call]), ref.map(r=>[r.signal, r.early_call]));
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement `session.mjs`** — deterministic `playUntilRow`/`playToEnd`/`playFromFeeds` share one internal `_tickWith(now, tape, book, remS)` that: builds `inp` (A1), calls `tick()`, builds the row (round/`toFixed` exactly as the dashboard), records `tape_age_ms`/`book_age_ms`, appends to the in-bar buffer, and `writeAtomic`s state every tick. Resume path: read state; if `engineGitHash` differs and no override → throw; else replay buffered in-bar rows through a fresh `newSession()` (reconstructing `s`) before continuing. At `rem<=0`: build settle row `{t, settled: close>open?'UP':'DOWN', open, close}`, write the log **idempotently** (skip if the target log already contains this slug's settle), and if `continuousRemaining>0` advance to `nextSlug`, reset engine session, decrement.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Failing test — engine-hash guard + idempotent settle write**

```javascript
test('resume refuses when engine git hash changed (no override)', async () => {
  const dir=mkTmp(); writeState(dir,'t1',{ engineGitHash:'OLD', slug:'btc-updown-5m-1', version:'v6', rows:[] });
  const s = new Session({ runId:'t1', version:'v6', slug:'btc-updown-5m-1', stateDir:dir, feeds:makeFakeFeeds() });
  await assert.rejects(() => s.start(), /engine .*changed/i);
});
test('writing the same settled log twice produces one log', async () => {
  const w = new Session({ /* ... */ });
  const p = await w._writeLogIdempotent(slug, rows);   // returns path
  const again = await w._writeLogIdempotent(slug, rows);
  assert.equal(p, again); assert.equal(countSettleRows(p), 1);
});
```

- [ ] **Step 6: Run — expect PASS. Step 7: Commit.**

---

## Task A6: Orchestrator + control API

**Files:** Create `runner/orchestrator.mjs`, `runner/control-api.mjs`; Test `runner/test/control-api.test.mjs`
**Interfaces produced (HTTP, all require `Authorization: Bearer <VM_CONTROL_SECRET>`):**
`POST /runs {version, slug, continuous}` → `{runId}`; `DELETE /runs/:id`; `GET /runs` → active list + status; `GET /runs/:id/rows?since=N` → rows; `GET /logs` → `[{version, slug, settled, n, mtime}]` from the VM log dir grouped by version; `GET /logs/:slug` → the log JSON. Orchestrator persists `runner/state/sessions.json` (active `{runId,version,slug,continuous}`) atomically and, on boot, resumes each via `Session`.

- [ ] **Step 1: Failing test — auth + run lifecycle** (in-process, fake feeds injected via orchestrator options)

```javascript
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { createApp } from '../control-api.mjs';
test('unauthed request is 401; authed start→list→stop works', async () => {
  const app = createApp({ secret:'S', orchestrator: fakeOrch() });
  assert.equal((await app.inject('GET','/runs',{})).status, 401);
  const r = await app.inject('POST','/runs',{ auth:'S', body:{version:'v6',slug:'btc-updown-5m-1783348800',continuous:0} });
  assert.equal(r.status, 200); assert.ok(r.json.runId);
  const list = await app.inject('GET','/runs',{ auth:'S' });
  assert.equal(list.json.length, 1);
  assert.equal((await app.inject('DELETE',`/runs/${r.json.runId}`,{ auth:'S' })).status, 200);
});
```

- [ ] **Step 2–4:** Implement with Node `http` (no framework needed) + a tiny `inject` test seam; constant-time bearer compare; orchestrator persists/resumes atomically. Run → PASS.
- [ ] **Step 5: Commit.**

---

## Task A7: VM deploy — systemd, TLS, NTP, README (infra; verify-based)

**Files:** Create `runner/systemd/runner-control.service`, `runner/deploy/Caddyfile`, `runner/README.md`
- [ ] **Step 1:** Write `runner-control.service` (Type=simple, `ExecStart=/usr/bin/node /home/vincent/61426-runner/repo/runner/control-api.mjs`, `Restart=on-failure`, `MemoryMax=`/`CPUQuota=` caps, `EnvironmentFile=` for `VM_CONTROL_SECRET` + `RUNNER_LOG_DIR=/home/vincent/projects/61426/v5/logs`), and a Caddyfile terminating TLS on a subdomain → `localhost:<port>` (or document the Cloudflare Tunnel alternative). README: burned-password note, rotation, env vars, disable instructions.
- [ ] **Step 2 (verify on VM, no repo change):** `ssh pm` → `timedatectl` shows `System clock synchronized: yes` (enable `systemd-timesyncd` if not); clone repo to `/home/vincent/61426-runner/repo` (reuse the autopsy deploy-key pattern); `npm ci` in `runner/`; start the service; `curl https://<subdomain>/runs` with the bearer returns `[]` over TLS; plain-HTTP request to the port is refused/closed.
- [ ] **Step 3: Commit** the systemd/Caddy/README files.

---

## Task B1: Next.js scaffold + config

**Files:** Create `web/` (Next.js App Router, TypeScript), `web/vercel.json`, `web/.env.example`, root `.gitignore` additions.
- [ ] **Step 1:** Scaffold minimal App Router app in `web/` (no telemetry; `web/app/layout.tsx`, `web/app/page.tsx` placeholder). `web/.env.example` with **placeholders only**: `APP_PASSWORD=CHANGE_ME`, `SESSION_SECRET=CHANGE_ME`, `VM_CONTROL_URL=https://CHANGE_ME`, `VM_CONTROL_SECRET=CHANGE_ME`. `web/vercel.json`: framework `nextjs`, `regions` set to the region nearest the VM.
- [ ] **Step 2 (verify):** `cd web && npm run build` succeeds. **Step 3: Commit.**

## Task B2: Auth (login + middleware, constant-time + rate limit)

**Files:** Create `web/middleware.ts`, `web/app/login/page.tsx`, `web/app/api/login/route.ts`, `web/lib/auth.ts`; Test `web/test/auth.test.ts`
- [ ] **Step 1: Failing test** — `verifyPassword(input, expected)` uses length-safe `timingSafeEqual` and returns boolean; `signSession`/`verifySession` round-trip with `SESSION_SECRET` (HMAC).
- [ ] **Step 2–4:** Implement `lib/auth.ts` (`crypto.timingSafeEqual` on SHA-256 digests to avoid length leak; HMAC-signed cookie value). `route.ts`: best-effort in-memory `Map<ip,{count,ts}>` cap + unconditional `await sleep(300)` on failure, comment noting cross-instance limitation; set httpOnly+secure+sameSite cookie on success. `middleware.ts`: allow `/login` + `/api/login` + static; else require valid cookie or redirect. Run tests → PASS. **Step 5: Commit.**

## Task B3: VM proxy routes

**Files:** Create `web/app/api/vm/[...path]/route.ts`, `web/lib/vm.ts`
- [ ] **Step 1:** Implement a server-side proxy: forwards `GET/POST/DELETE` under `/api/vm/*` to `${VM_CONTROL_URL}/*` with the `Authorization: Bearer ${VM_CONTROL_SECRET}` header injected server-side; never exposes the secret to the client; requires the session cookie (via middleware). Small allowlist of forwardable paths (`runs`, `runs/*`, `logs`, `logs/*`).
- [ ] **Step 2 (verify):** unit-test the path allowlist + header injection with a mocked fetch. **Step 3: Commit.**

## Task B4: Thin viewer + sidebar + visibility-aware polling

**Files:** Create `web/app/page.tsx`, `web/components/RunControls.tsx`, `web/components/RunView.tsx`, `web/components/LogSidebar.tsx`, `web/lib/usePoll.ts`
- [ ] **Step 1:** `usePoll(fn, ms)` — polls on an interval, **pauses when `document.hidden`**, resumes on visibility. `RunControls`: version dropdown (v1–v6), market slug input, continuous count, start/stop (calls `/api/vm/runs`). `RunView`: shows live `signal`, `early_call`/tier, current `rem`, tick-health (last row `t` + gap flag + `tape_age_ms`/`book_age_ms`), via `usePoll('/api/vm/runs/:id/rows?since=N')`. `LogSidebar`: `usePoll('/api/vm/logs')`, grouped by version, click loads a log.
- [ ] **Step 2 (verify):** `npm run build`; component render test for `usePoll` pausing on hidden. **Step 3: Commit.**

---

## Phase 1 Acceptance (the gate before Phase 2)

Run on the VM + a Vercel preview deploy:
- [ ] **(a) Normal op:** start `v6 btc-updown-5m` continuous=3 via the Vercel UI; close the browser; after 3 bars, inspect the logs — inter-row `t` deltas all ~1s, **zero missed ticks**, 3 settled logs written.
- [ ] **(b) Downtime/reboot:** start a continuous run; mid-bar `sudo reboot` the VM; on boot the service resumes the session; the row stream shows a **single gap == actual downtime, marked (`gap:true`)**, no backfill/dupes; the resumed bar's `signal`/`early_call` stream matches an uninterrupted reference replay of the same captured inputs.
- [ ] **(c) Live A/B (methodology per clarification 1):** run the browser v6 dashboard and the VM runner on the **same market ≥2 bars**; align rows by second; market fields compared with tolerance **±0.5% (relative) or ±1 unit (absolute), whichever larger** (document final tolerance in README); **`signal` and `early_call` TRANSITIONS must match exactly**. Transition divergence = bug to fix before Phase 2; sub-tolerance field deltas = expected sampling skew, pass.
- [ ] **(d) Idempotency:** kill the process between settle detection and log write; on restart exactly one correct log exists.
- [ ] **(e) Log-format compatibility (clarification 2):** confirm autopsy-sync, `v6/analysis/replay-compare.mjs`, and `autopsy_data.py` still parse a runner-produced log (extra `tape_age_ms`/`book_age_ms`/`gap` fields ignored). If any parses strictly, move staleness to a sidecar state file and re-verify.
- [ ] **(f) Non-interference:** `ourwebsocket`, `bin-*`, `autopsy-sync` all still `active`; local dashboards unchanged; `git status` shows only `runner/`, `web/`, `docs/`, `.gitignore`, `.env.example`.

---

## Self-review notes
- **Spec coverage:** every amendment (1 engine-state rehydration → A5; 2 gap policy → A2/A5; 4 feed degradation → A3/A4 + row fields; 5 security → B2 + A7 TLS; 6 durability/NTP/hash → A3 atomic, A5 idempotent+hash-guard, A7 NTP; poll visibility → B4) and clarification (1 A/B tolerance → acceptance c; 2 log-format → acceptance e; 3a/3b preconditions → resolved above; 4 rate-limit in-memory → B2) maps to a task.
- **Determinism precondition** confirmed; `now`/`price` reconstruction is the proven `replay-compare.mjs` method.
- Phase 2 (full 4-chart viewer, multi-tab/parallel, sidebar grouping polish) is a separate plan after this gate passes.
