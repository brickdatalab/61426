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
