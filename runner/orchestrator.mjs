// Orchestrator: manages N Sessions keyed by runId, persists the active-session
// manifest atomically, and resumes all of them on boot (Session itself does
// resume-by-replay from its own state file — this just re-constructs the Session
// objects and calls .start() on each).
//
// Additive only — consumes Session/feeds, never edits them.

import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { Session } from './session.mjs';
import { writeAtomic, readJson } from './lib/atomic.mjs';
import { parseSlug } from './lib/slug.mjs';

// Real production feeds (OwsFeed/PolyFeed), used unless a test injects fakes.
export async function makeProdFeeds(version, slug) {
  const { OwsFeed } = await import('./feeds/ows.mjs');
  const { PolyFeed } = await import('./feeds/poly.mjs');
  const p = parseSlug(slug);
  const ows = new OwsFeed(p.symbol, p.interval);
  const poly = new PolyFeed(slug);
  return { ows, poly };
}

export function createOrchestrator({
  stateDir, logDir, abLogDir = process.env.RUNNER_AB_LOG_DIR || path.join(stateDir, 'ab-logs'),
  makeFeeds = makeProdFeeds, now = Date.now, setTimer = setTimeout,
}) {
  const sessions = new Map(); // runId -> Session

  function manifestFile() {
    return path.join(stateDir, 'sessions.json');
  }

  function persistManifest() {
    const active = [...sessions.values()].map((s) => ({
      runId: s.runId, version: s.version, slug: s.slug, continuous: s.continuousRemaining, ab: !!s.ab,
    }));
    writeAtomic(manifestFile(), JSON.stringify({ active }));
  }

  async function start({ version, slug, continuous = 0, ab = false }) {
    const runId = crypto.randomUUID();
    const feeds = await makeFeeds(version, slug);
    const session = new Session({
      runId, version, slug, continuousRemaining: continuous,
      stateDir, logDir: ab ? abLogDir : logDir, feeds, now, setTimer,
    });
    session.ab = ab; // routing marker; persisted so resume keeps the ab dir
    await session.start();
    sessions.set(runId, session);
    persistManifest();
    return runId;
  }

  function stop(runId) {
    const s = sessions.get(runId);
    if (!s) return false;
    s.stop();
    sessions.delete(runId);
    persistManifest();
    return true;
  }

  function list() {
    return [...sessions.values()].map((s) => s.status());
  }

  function rows(runId, since = 0) {
    const s = sessions.get(runId);
    if (!s) return null;
    return s.rowsSince(since);
  }

  function logs() {
    let files;
    try {
      files = fs.readdirSync(logDir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    return files.map((f) => {
      const base = f.slice(0, -'.json'.length);
      const idx = base.lastIndexOf('_');
      const slug = idx >= 0 ? base.slice(0, idx) : base;
      const version = idx >= 0 ? base.slice(idx + 1) : null;
      const doc = readJson(path.join(logDir, f));
      const n = doc && Array.isArray(doc.rows) ? doc.rows.length : 0;
      const settled = !!(doc && Array.isArray(doc.rows) && doc.rows.some((r) => r.settled));
      let mtime = null;
      try { mtime = fs.statSync(path.join(logDir, f)).mtime.toISOString(); } catch {}
      return { version, slug, settled, n, mtime };
    });
  }

  function readLog(name) {
    const file = name.endsWith('.json') ? name : `${name}.json`;
    return readJson(path.join(logDir, file));
  }

  async function resumeAll() {
    const manifest = readJson(manifestFile());
    const active = manifest && Array.isArray(manifest.active) ? manifest.active : [];
    for (const entry of active) {
      const feeds = await makeFeeds(entry.version, entry.slug);
      const ab = entry.ab ?? false;
      const session = new Session({
        runId: entry.runId, version: entry.version, slug: entry.slug,
        continuousRemaining: entry.continuous ?? 0,
        stateDir, logDir: ab ? abLogDir : logDir, feeds, now, setTimer,
      });
      session.ab = ab;
      await session.start();
      sessions.set(entry.runId, session);
    }
    return active.length;
  }

  return { start, stop, list, rows, logs, readLog, resumeAll, _sessions: sessions };
}
