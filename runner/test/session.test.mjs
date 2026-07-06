import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Session } from '../session.mjs';
import { makeFakeFeeds, loadCapturedBar, runToEnd } from './helpers.mjs';

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'runner-session-'));
}
function writeState(dir, runId, obj) {
  fs.writeFileSync(path.join(dir, `${runId}.json`), JSON.stringify(obj));
}
function countSettleRows(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8')).rows.filter((r) => r.settled).length;
}

// 1. Resume-by-replay parity (the whole point): a session killed mid-bar and resumed
//    in a fresh Session reproduces the uninterrupted reference EXACTLY per row.
test('resume-by-replay matches the uninterrupted reference per row', async () => {
  const bar = loadCapturedBar('v6');
  const ref = await runToEnd(bar);
  const dir = mkTmp();
  const mid = Math.floor(bar.rows.length / 2);

  // Keep this test load-bearing if fixtures change: the mid-bar kill must land
  // strictly after the first early-call latch row, or resuming before any
  // latch happened would trivially "match" without exercising the latch state.
  const firstLatchIdx = ref.findIndex((r) => r.early_call != null);
  assert.ok(firstLatchIdx >= 0, 'fixture must contain an early-call latch');
  assert.ok(mid > firstLatchIdx, 'mid-kill index must be after the first early-call latch');

  const s1 = new Session({
    runId: 't1', version: 'v6', slug: bar.slug, continuousRemaining: 0,
    stateDir: dir, feeds: makeFakeFeeds(bar),
  });
  await s1.playUntilRow(mid); // persists state at row `mid`

  const s2 = new Session({ // fresh process, same state dir
    runId: 't1', version: 'v6', slug: bar.slug, continuousRemaining: 0,
    stateDir: dir, feeds: makeFakeFeeds(bar),
  });
  const resumed = await s2.playToEnd();

  assert.equal(resumed.length, ref.length);
  assert.deepEqual(
    resumed.map((r) => [r.signal, r.early_call]),
    ref.map((r) => [r.signal, r.early_call]),
  );
});

// 2. Engine-hash guard.
test('resume refuses when engine git hash changed (no override)', async () => {
  const dir = mkTmp();
  writeState(dir, 't1', { engineGitHash: 'OLD', slug: 'btc-updown-5m-1783348800', version: 'v6', continuousRemaining: 0, rows: [] });
  const s = new Session({ runId: 't1', version: 'v6', slug: 'btc-updown-5m-1783348800', stateDir: dir, feeds: makeFakeFeeds() });
  await assert.rejects(() => s.start(), /engine .*changed/i);
});

test("resume refuses when current git hash is 'unknown'", async () => {
  const dir = mkTmp();
  const { mod } = await (await import('../engine-adapter.mjs')).loadEngine('v6');
  writeState(dir, 't1', { engineGitHash: 'unknown', slug: 'btc-updown-5m-1783348800', version: 'v6', continuousRemaining: 0, rows: [] });
  const s = new Session({
    runId: 't1', version: 'v6', slug: 'btc-updown-5m-1783348800', stateDir: dir, feeds: makeFakeFeeds(),
    loadEngineImpl: async () => ({ mod, gitHash: 'unknown' }),
  });
  await assert.rejects(() => s.start(), /engine .*changed/i);
});

test('resume proceeds with overrideEngineChange', async () => {
  const dir = mkTmp();
  writeState(dir, 't1', { engineGitHash: 'OLD', slug: 'btc-updown-5m-1783348800', version: 'v6', continuousRemaining: 0, rows: [] });
  const s = new Session({
    runId: 't1', version: 'v6', slug: 'btc-updown-5m-1783348800', stateDir: dir,
    feeds: makeFakeFeeds(), overrideEngineChange: true, setTimer: () => {},
  });
  await s.start(); // must not throw
  s.stop();
});

// 3. Idempotent settle write.
test('writing the same settled log twice produces exactly one settle row', async () => {
  const dir = mkTmp();
  const logDir = mkTmp();
  const w = new Session({ runId: 't1', version: 'v6', slug: 'btc-updown-5m-1783348800', stateDir: dir, feeds: makeFakeFeeds(), logDir });
  const slug = 'btc-updown-5m-1783348800';
  const rows = [
    { t: '00:00:01', rem: 1, signal: 'UP', now_ms: 1, tape_age_ms: 0, book_age_ms: 0 },
    { t: '00:00:02', settled: 'UP', open: 100, close: 101 },
  ];
  const p = await w._writeLogIdempotent(slug, rows);
  const again = await w._writeLogIdempotent(slug, rows);
  assert.equal(p, again);
  assert.equal(countSettleRows(p), 1);
});

// 4. Gap marking: a live gap of 5s produces exactly ONE row marked gap:true, and no
//    fabricated intermediate rows.
test('a live gap marks exactly one row and fabricates none', async () => {
  const dir = mkTmp();
  const baseSec = 1783348800; // slug ts -> bar end baseSec+300, so remS stays > 0
  const slug = `btc-updown-5m-${baseSec}`;
  const s = new Session({ runId: 'g1', version: 'v6', slug, stateDir: dir, feeds: makeFakeFeeds() });
  await s._init();

  s._onSecond(baseSec + 10, 1); // normal tick
  s._onSecond(baseSec + 15, 5); // 5s gap (4 missed seconds)

  assert.equal(s._rows.length, 2, 'exactly two rows — no fabricated intermediates');
  const gapRows = s._rows.filter((r) => r.gap);
  assert.equal(gapRows.length, 1);
  assert.equal(gapRows[0].gap, true);
});

// 4b. After .stop() the scheduler is cancelled: a stale already-armed timer
//     callback fires NO further tick — no new state write, no settle log.
test('after Session.stop() no further ticks write state or settle logs', async () => {
  const dir = mkTmp();
  const logDir = mkTmp();
  const baseSec = 1783348800; // bar end = baseSec+300, so remS stays > 0
  const slug = `btc-updown-5m-${baseSec}`;

  const timers = [];
  const cleared = [];
  let nowMs = (baseSec + 10) * 1000;
  const setTimer = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  const clearTimer = (h) => cleared.push(h);
  const now = () => nowMs;

  const s = new Session({
    runId: 'stop1', version: 'v6', slug, stateDir: dir, logDir,
    feeds: makeFakeFeeds(), now, setTimer, clearTimer,
  });
  await s.start();

  // Fire the first armed tick -> one row.
  nowMs = (baseSec + 11) * 1000;
  timers[timers.length - 1].fn();
  assert.equal(s._rows.length, 1);
  const armedAfterTick = timers[timers.length - 1]; // re-armed by _fire

  s.stop();
  assert.ok(cleared.length >= 1, 'stop() cleared the pending timer');

  // Fire the stale callback that was already armed before stop — must be a no-op.
  nowMs = (baseSec + 12) * 1000;
  armedAfterTick.fn();
  assert.equal(s._rows.length, 1, 'no further state rows after stop');

  // No settle log was written (bar never reached rem<=0).
  assert.ok(!fs.existsSync(path.join(logDir, `${slug}_v6.json`)), 'no settle log after stop');
});

// 4c. Settle close uses the RAW last tape price, not barOpen + 2dp-rounded cushion.
//     Fixture: price=100.004 -> cushion rounds to 0.00 (old close=open=100 => DOWN),
//     but the raw price 100.004 > open => UP. Close must equal the raw price.
test('settle close uses the raw last price (near-flat bar does not flip on rounding)', async () => {
  const dir = mkTmp();
  const logDir = mkTmp();
  const slug = 'btc-updown-5m-1783348800';
  const s = new Session({ runId: 'sc1', version: 'v6', slug, stateDir: dir, logDir, feeds: makeFakeFeeds() });
  await s._init();
  s._barOpen = 100;

  const tape = { price: 100.004, bar_open: 100, cvd_candle_usd: 0, binance_imb: 0 };
  s._tickWith((1783348800 + 120) * 1000, tape, { pimb: null, poly_mid: null }, 120, {});
  // The public row's cushion rounds to 0.00 — the old formula would settle DOWN.
  assert.equal(s._rows[s._rows.length - 1].cushion, 0);

  s._settleAndAdvance((1783348800 + 300) * 1000);
  const doc = JSON.parse(fs.readFileSync(path.join(logDir, `${slug}_v6.json`), 'utf8'));
  const settle = doc.rows.find((r) => r.settled);
  assert.equal(settle.close, 100.004, 'close is the raw last price, full precision');
  assert.equal(settle.settled, 'UP', 'raw price 100.004 > open 100 => UP (no rounding flip)');
});

// 4d. Fallback: when NO tape price was ever seen this bar, close falls back to
//     barOpen + the last row's cushion.
test('settle close falls back to barOpen + cushion when no price was seen', async () => {
  const dir = mkTmp();
  const logDir = mkTmp();
  const slug = 'btc-updown-5m-1783348800';
  const s = new Session({ runId: 'sc2', version: 'v6', slug, stateDir: dir, logDir, feeds: makeFakeFeeds() });
  s._barOpen = 100;
  s._lastPrice = null; // no price ever seen
  s._rows.push({ t: '00:00:01', rem: 5, cushion: 0.5, now_ms: 1, tape_age_ms: null, book_age_ms: null });

  s._settleAndAdvance((1783348800 + 300) * 1000);
  const doc = JSON.parse(fs.readFileSync(path.join(logDir, `${slug}_v6.json`), 'utf8'));
  const settle = doc.rows.find((r) => r.settled);
  assert.equal(settle.close, 100.5, 'close = barOpen + last cushion when no raw price seen');
});

// 5. now_ms / staleness live in state only, never in the public log.
test('state rows carry now_ms/tape_age_ms; the written log rows do not', async () => {
  const bar = loadCapturedBar('v6');
  const dir = mkTmp();
  const logDir = mkTmp();
  const s = new Session({
    runId: 's5', version: 'v6', slug: bar.slug, continuousRemaining: 0,
    stateDir: dir, logDir, feeds: makeFakeFeeds(bar),
  });
  await s.playUntilRow(5);
  const stateRow = s._rows[5];
  assert.ok('now_ms' in stateRow && 'tape_age_ms' in stateRow && 'book_age_ms' in stateRow);

  // write the log via the idempotent settle writer and inspect the file
  const p = s._writeLogIdempotent(bar.slug, s._rows.map((r) => r).concat({ t: 'x', settled: 'UP', open: bar.open, close: bar.open + 1 }));
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const r of doc.rows) {
    if (r.settled) continue;
    assert.ok(!('now_ms' in r), 'now_ms must not be in the public log');
    assert.ok(!('tape_age_ms' in r), 'tape_age_ms must not be in the public log');
    assert.ok(!('book_age_ms' in r), 'book_age_ms must not be in the public log');
    assert.ok(!('gap' in r), 'gap must not be in the public log');
  }
});
