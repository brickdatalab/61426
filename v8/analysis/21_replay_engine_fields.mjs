// v8/analysis/21_replay_engine_fields.mjs
// Replays the REAL v6 engine (v6/src/signals.mjs, byte-frozen) over every
// <slug>_bq.json bar and records the per-second lean-stream tag, sampled at
// the matrix tick marks (elapsed 5..295 step 5). This is baseline (b) for the
// v8 value scoring, produced by the actual engine — never re-implemented.
//
//   node v8/analysis/21_replay_engine_fields.mjs --bq v6/analysis/bqbars --out v8/analysis/data/engine
//   node v8/analysis/21_replay_engine_fields.mjs --validate AUTOPSY/logs/<slug>_v6.json
//
// inp mapping is copied verbatim from v7s/analysis/validate.mjs replay().
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import * as ENGINE from '../../v6/src/signals.mjs';

const ELAPSED = []; for (let e = 5; e < 300; e += 5) ELAPSED.push(e); // 59 ticks

function inpFromRow(r, open, now) {
  const price = r.cushion != null && open != null ? open + r.cushion : null;
  return { now, sinceOpen: r.cvd_since_open, price,
    bimb: r.btc_imb, pimb: r.poly_imb, cushion: r.cushion, remS: r.rem,
    vol1m: r.vol_1m ?? null, largePrints: r.large_prints ?? null,
    efficiency: r.efficiency ?? null, perpSpotDiv: r.perp_spot_div ?? null,
    cvd3m: r.cvd_d3m ?? null, polyMid: r.poly_mid ?? null };
}

function replayRows(rows, open) {
  const s = ENGINE.newSession();
  let t = 1700000000000;
  const perSec = []; // {rem, sig}
  for (const r of rows) {
    t += 1000;
    const res = ENGINE.tick(s, inpFromRow(r, open, t));
    perSec.push({ rem: r.rem, sig: res ? res.decision.sig : null });
  }
  return perSec;
}

function sampleAtTicks(perSec) {
  // last known sig at or before each elapsed mark (rem = 300 - elapsed)
  const out = {};
  for (const e of ELAPSED) {
    const remMark = 300 - e;
    let sig = null;
    for (const p of perSec) { if (p.rem != null && p.rem >= remMark && p.sig != null) sig = p.sig; if (p.rem != null && p.rem < remMark) break; }
    out[String(remMark)] = sig ?? 'MIXED';
  }
  return out;
}

const args = process.argv.slice(2);
function argOf(k) { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; }

if (argOf('--validate')) {
  const d = JSON.parse(readFileSync(argOf('--validate'), 'utf8'));
  const srow = d.rows.find(r => r.settled); const body = d.rows.filter(r => !r.settled);
  if (!srow || body.length < 100) { console.error('log too short'); process.exit(1); }
  const perSec = replayRows(body, srow.open);
  let cmp = 0, match = 0;
  for (let i = 0; i < body.length; i++) {
    const logged = body[i].signal;
    if (logged == null || perSec[i].sig == null) continue;
    cmp++; if (logged === perSec[i].sig) match++;
  }
  const pct = 100 * match / cmp;
  console.log(`validate ${d.slug}: ${match}/${cmp} sig rows match (${pct.toFixed(2)}%)`);
  if (pct < 98) { console.error('FAIL: <98% match'); process.exit(1); }
  console.log('PASS');
} else {
  const bqDir = argOf('--bq') || 'v6/analysis/bqbars';
  const outDir = argOf('--out') || 'v8/analysis/data/engine';
  mkdirSync(outDir, { recursive: true });
  let n = 0;
  for (const f of readdirSync(bqDir).filter(x => /_bq\.json$/.test(x))) {
    const d = JSON.parse(readFileSync(join(bqDir, f), 'utf8'));
    const slug = d.slug.replace(/_bq$/, '');
    const srow = d.rows.find(r => r.settled); const body = d.rows.filter(r => !r.settled);
    if (!srow || body.length < 100) continue;
    const perSec = replayRows(body, srow.open);
    writeFileSync(join(outDir, `${slug}.json`), JSON.stringify({ slug, settle: srow.settled, sig_at_rem: sampleAtTicks(perSec) }));
    n++;
  }
  console.log(`replayed ${n} bars -> ${outDir}`);
}
