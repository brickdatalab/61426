// v8/analysis/70_extract_episodes.mjs — per-second v8 stream capture for the
// fire-episode study. Replays the REAL v8 engine over every <slug>_bq.json bar
// and dumps {rem, sig, p_flip, imb_ewma} per second -> data/stream/<slug>.json.
// --validate <live-log> replays a live log and asserts sig matches the logged
// signal column (the engine is deterministic; this must be ~100%).
//
//   node v8/analysis/70_extract_episodes.mjs --bq v6/analysis/bqbars --out v8/analysis/data/stream
//   node v8/analysis/70_extract_episodes.mjs --validate AUTOPSY/logs/<slug>_v8.json
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as ENGINE from '../src/signals.mjs';

function inpOf(r, open, now) {
  const price = r.cushion != null && open != null ? open + r.cushion : null;
  return { now, sinceOpen: r.cvd_since_open, price,
    bimb: r.btc_imb, pimb: r.poly_imb, cushion: r.cushion, remS: r.rem,
    vol1m: r.vol_1m ?? null, largePrints: r.large_prints ?? null,
    efficiency: r.efficiency ?? null, perpSpotDiv: r.perp_spot_div ?? null,
    cvd3m: r.cvd_d3m ?? null, polyMid: r.poly_mid ?? null };
}

function replay(rows, open) {
  const s = ENGINE.newSession();
  let t = 1700000000000;
  const out = [];
  for (const r of rows) {
    t += 1000;
    const res = ENGINE.tick(s, inpOf(r, open, t));
    out.push({ rem: r.rem, sig: res ? res.decision.sig : null,
               p_flip: res?.flip?.p ?? null, imb_ewma: res?.decision?.imbEwma ?? null });
  }
  return out;
}

const args = process.argv.slice(2);
const argOf = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };

if (argOf('--validate')) {
  const d = JSON.parse(readFileSync(argOf('--validate'), 'utf8'));
  const srow = d.rows.find(r => r.settled); const body = d.rows.filter(r => !r.settled);
  const per = replay(body, srow.open);
  let cmp = 0, match = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i].signal == null || per[i].sig == null) continue;
    cmp++; if (body[i].signal === per[i].sig) match++;
  }
  const pct = 100 * match / cmp;
  console.log(`validate ${d.slug}: ${match}/${cmp} (${pct.toFixed(2)}%)`);
  process.exit(pct >= 99.5 ? 0 : 1);
}

const bqDir = argOf('--bq') || 'v6/analysis/bqbars';
const outDir = argOf('--out') || 'v8/analysis/data/stream';
mkdirSync(outDir, { recursive: true });
let n = 0;
for (const f of readdirSync(bqDir).filter(x => /_bq\.json$/.test(x))) {
  const d = JSON.parse(readFileSync(join(bqDir, f), 'utf8'));
  const slug = d.slug.replace(/_bq$/, '');
  const srow = d.rows.find(r => r.settled); const body = d.rows.filter(r => !r.settled);
  if (!srow || body.length < 100) continue;
  writeFileSync(join(outDir, `${slug}.json`),
    JSON.stringify({ slug, settle: srow.settled, open: srow.open, close: srow.close, sec: replay(body, srow.open) }));
  n++;
}
console.log(`captured ${n} bar streams -> ${outDir}`);
