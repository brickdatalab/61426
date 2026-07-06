// Test seams for session.test.mjs: load a captured bar, fake feeds that replay it,
// and an uninterrupted reference replay (the ground truth for the parity test).

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadEngine, buildInp } from '../engine-adapter.mjs';
import { reconstructTape, reconstructBook, BASE_MS } from '../session.mjs';

const LOGS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'AUTOPSY', 'logs',
);

// Pick a captured bar with a genuine early-call latch (row0 null -> later non-null)
// and enough rows that a mid-bar kill lands after the latch — that is what makes the
// resume-parity test load-bearing.
export function loadCapturedBar(version) {
  const files = readdirSync(LOGS_DIR).filter((x) => x.endsWith(`_${version}.json`)).sort();
  let chosen = null;
  for (const f of files) {
    const doc = JSON.parse(readFileSync(path.join(LOGS_DIR, f), 'utf8'));
    const nonSettle = doc.rows.filter((r) => !r.settled);
    const settle = doc.rows.find((r) => r.settled);
    if (!settle || nonSettle.length < 100) continue;
    const latched = nonSettle[0].early_call == null && nonSettle.some((r) => r.early_call != null);
    if (!latched) continue;
    chosen = { file: f, doc, nonSettle, settle };
    break;
  }
  if (!chosen) throw new Error(`no suitable ${version} bar found in ${LOGS_DIR}`);
  const slug = chosen.doc.slug.replace(new RegExp(`_${version}$`), '');
  return { version, slug, open: chosen.settle.open, rows: chosen.nonSettle };
}

// Fake feeds that replay a captured bar in row order. The Session drivers seek the
// cursor before each tick; latest() returns the reconstructed tape/book for that row.
export function makeFakeFeeds(bar) {
  const rows = bar ? bar.rows : [];
  const open = bar ? bar.open : null;
  let cur = 0;
  return {
    _rows: rows,
    _open: open,
    _seek(i) { cur = i; },
    ows: {
      start() {}, stop() {},
      latest() {
        const r = rows[cur];
        return { tape: r ? reconstructTape(r, open) : null, ageMs: r ? 0 : null };
      },
    },
    poly: {
      start() {}, stop() {}, setSlug() {},
      latest() {
        const r = rows[cur];
        return { pimb: r ? r.poly_imb : null, poly_mid: r ? r.poly_mid : null, ageMs: r ? 0 : null };
      },
    },
  };
}

// Uninterrupted reference: replay every captured row through a fresh engine using the
// same synthetic clock (base + i*1000) the Session drivers use. Ground truth.
export async function runToEnd(bar) {
  const { mod } = await loadEngine(bar.version);
  const s = mod.newSession();
  return bar.rows.map((row, i) => {
    const nowMs = BASE_MS + i * 1000;
    const inp = buildInp({
      now: nowMs, tape: reconstructTape(row, bar.open), book: reconstructBook(row),
      barOpen: bar.open, remS: row.rem,
    });
    const out = mod.tick(s, inp);
    return { signal: out ? out.decision.sig : 'MIXED', early_call: out && out.early ? out.early.side : null };
  });
}
