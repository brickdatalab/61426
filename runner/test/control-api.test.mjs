import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../control-api.mjs';

// Minimal fake orchestrator — isolates the HTTP/auth/routing layer from Session
// and real feeds (those are covered by orchestrator.test.mjs).
function fakeOrch() {
  const runs = new Map();
  let n = 0;
  return {
    async start({ version, slug, continuous }) {
      const runId = `run${++n}`;
      runs.set(runId, { runId, version, slug, rem: 300, continuousRemaining: continuous ?? 0, lastTick: null });
      return runId;
    },
    stop(runId) {
      return runs.delete(runId);
    },
    list() {
      return [...runs.values()];
    },
    rows(runId, since) {
      if (!runs.has(runId)) return null;
      return [{ t: '00:00:01', since }];
    },
    logs() {
      return [{ version: 'v6', slug: 'btc-updown-5m-1', settled: true, n: 2, mtime: '2026-01-01T00:00:00.000Z' }];
    },
    readLog(slug) {
      return slug === 'btc-updown-5m-1_v6' ? { slug, rows: [] } : null;
    },
  };
}

test('unauthed request is 401; authed start->list->stop works', async () => {
  const app = createApp({ secret: 'S', orchestrator: fakeOrch() });

  assert.equal((await app.inject('GET', '/runs', {})).status, 401);
  assert.equal((await app.inject('GET', '/runs', { auth: 'wrong' })).status, 401);

  const r = await app.inject('POST', '/runs', {
    auth: 'S', body: { version: 'v6', slug: 'btc-updown-5m-1783348800', continuous: 0 },
  });
  assert.equal(r.status, 200);
  assert.ok(r.json.runId);

  const list = await app.inject('GET', '/runs', { auth: 'S' });
  assert.equal(list.status, 200);
  assert.equal(list.json.length, 1);
  assert.equal(list.json[0].runId, r.json.runId);

  const del = await app.inject('DELETE', `/runs/${r.json.runId}`, { auth: 'S' });
  assert.equal(del.status, 200);
  assert.equal((await app.inject('GET', '/runs', { auth: 'S' })).json.length, 0);
});

test('POST /runs missing version/slug is 400', async () => {
  const app = createApp({ secret: 'S', orchestrator: fakeOrch() });
  const r = await app.inject('POST', '/runs', { auth: 'S', body: { continuous: 0 } });
  assert.equal(r.status, 400);
});

test('DELETE /runs/:id for unknown id is 404', async () => {
  const app = createApp({ secret: 'S', orchestrator: fakeOrch() });
  const r = await app.inject('DELETE', '/runs/nope', { auth: 'S' });
  assert.equal(r.status, 404);
});

test('GET /runs/:id/rows?since=N passes since through', async () => {
  const app = createApp({ secret: 'S', orchestrator: fakeOrch() });
  const r = await app.inject('POST', '/runs', { auth: 'S', body: { version: 'v6', slug: 'x' } });
  const rows = await app.inject('GET', `/runs/${r.json.runId}/rows?since=5`, { auth: 'S' });
  assert.equal(rows.status, 200);
  assert.equal(rows.json[0].since, 5);
});

test('GET /logs and GET /logs/:slug', async () => {
  const app = createApp({ secret: 'S', orchestrator: fakeOrch() });
  const logs = await app.inject('GET', '/logs', { auth: 'S' });
  assert.equal(logs.status, 200);
  assert.equal(logs.json.length, 1);

  const one = await app.inject('GET', '/logs/btc-updown-5m-1_v6', { auth: 'S' });
  assert.equal(one.status, 200);

  const missing = await app.inject('GET', '/logs/nope', { auth: 'S' });
  assert.equal(missing.status, 404);
});

test('a throwing orchestrator method surfaces as a clean 500 (inject matches prod)', async () => {
  const throwingOrch = {
    ...fakeOrch(),
    list() { throw new Error('boom'); },
  };
  const app = createApp({ secret: 'S', orchestrator: throwingOrch });
  const r = await app.inject('GET', '/runs', { auth: 'S' });
  assert.equal(r.status, 500);
  assert.equal(r.json.error, 'boom');
});

test('a wrong-length secret does not throw and is rejected', async () => {
  const app = createApp({ secret: 'a-much-longer-secret-value', orchestrator: fakeOrch() });
  const r = await app.inject('GET', '/runs', { auth: 'short' });
  assert.equal(r.status, 401);
});

test('a longer-than-secret auth token does not throw and is rejected', async () => {
  const app = createApp({ secret: 'short', orchestrator: fakeOrch() });
  const r = await app.inject('GET', '/runs', { auth: 'a-much-longer-provided-token' });
  assert.equal(r.status, 401);
});
