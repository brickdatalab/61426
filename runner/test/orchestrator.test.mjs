import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOrchestrator } from '../orchestrator.mjs';
import { writeAtomic } from '../lib/atomic.mjs';

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'runner-orch-'));
}

// Fake feeds: no data, no network — just enough shape for Session to construct.
// setTimer is a no-op so no real 1s scheduler runs during tests.
function fakeMakeFeeds() {
  return async () => ({
    ows: { start() {}, stop() {}, latest: () => ({ tape: null, ageMs: null }) },
    poly: { start() {}, stop() {}, setSlug() {}, latest: () => ({ pimb: null, poly_mid: null, ageMs: null }) },
  });
}

const SLUG = 'btc-updown-5m-1783348800';

test('start -> list -> stop lifecycle with injected fake feeds', async () => {
  const stateDir = mkTmp();
  const logDir = mkTmp();
  const orch = createOrchestrator({ stateDir, logDir, makeFeeds: fakeMakeFeeds(), setTimer: () => {} });

  const runId = await orch.start({ version: 'v6', slug: SLUG, continuous: 0 });
  assert.ok(runId);

  const list = orch.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].runId, runId);
  assert.equal(list[0].version, 'v6');
  assert.equal(list[0].slug, SLUG);

  const manifest = JSON.parse(fs.readFileSync(path.join(stateDir, 'sessions.json'), 'utf8'));
  assert.equal(manifest.active.length, 1);
  assert.equal(manifest.active[0].runId, runId);

  assert.equal(orch.stop(runId), true);
  assert.equal(orch.list().length, 0);
  const manifestAfter = JSON.parse(fs.readFileSync(path.join(stateDir, 'sessions.json'), 'utf8'));
  assert.equal(manifestAfter.active.length, 0);

  assert.equal(orch.stop('nonexistent'), false);
});

test('resumeAll() re-creates sessions from a written sessions.json', async () => {
  const stateDir = mkTmp();
  const logDir = mkTmp();
  writeAtomic(path.join(stateDir, 'sessions.json'), JSON.stringify({
    active: [{ runId: 'r1', version: 'v6', slug: SLUG, continuous: 0 }],
  }));

  const orch = createOrchestrator({ stateDir, logDir, makeFeeds: fakeMakeFeeds(), setTimer: () => {} });
  const n = await orch.resumeAll();
  assert.equal(n, 1);

  const list = orch.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].runId, 'r1');
  assert.equal(list[0].slug, SLUG);
});

test('manifest write is atomic (temp+rename, no partial file left behind)', async () => {
  const stateDir = mkTmp();
  const logDir = mkTmp();
  const orch = createOrchestrator({ stateDir, logDir, makeFeeds: fakeMakeFeeds(), setTimer: () => {} });

  await orch.start({ version: 'v6', slug: SLUG, continuous: 0 });

  const entries = fs.readdirSync(stateDir);
  assert.ok(entries.includes('sessions.json'));
  assert.ok(!entries.some((f) => f.endsWith('.tmp')), 'no leftover temp file');
});

test('logs() groups log files by version suffix', async () => {
  const stateDir = mkTmp();
  const logDir = mkTmp();
  writeAtomic(path.join(logDir, `${SLUG}_v6.json`), JSON.stringify({
    slug: `${SLUG}_v6`, rows: [{ t: '00:00:01', signal: 'UP' }, { t: '00:00:02', settled: 'UP', open: 1, close: 2 }],
  }));
  const orch = createOrchestrator({ stateDir, logDir, makeFeeds: fakeMakeFeeds(), setTimer: () => {} });

  const logs = orch.logs();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].version, 'v6');
  assert.equal(logs[0].slug, SLUG);
  assert.equal(logs[0].settled, true);
  assert.equal(logs[0].n, 2);

  const read = orch.readLog(`${SLUG}_v6`);
  assert.equal(read.slug, `${SLUG}_v6`);
});
