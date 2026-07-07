// v7c/analysis/validate.mjs — replay the REAL v7c engine tick-by-tick; report
// coverage / accuracy / EDGE (accuracy − price paid) / fire-time / misses.
// Usage: node v7c/analysis/validate.mjs <live-logs-dir> [bq_eval.jsonl]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as ENGINE from '../src/signals.mjs';

function replay(bar) {
  const s = ENGINE.newSession();
  let t = 1700000000000, latch = null;
  for (const r of bar.rows) {
    t += 1000;
    const price = r.cushion != null && bar.open != null ? bar.open + r.cushion : null;
    const res = ENGINE.tick(s, { now: t, sinceOpen: r.cvd_since_open, price,
      bimb: r.btc_imb, pimb: r.poly_imb, cushion: r.cushion, remS: r.rem,
      vol1m: r.vol_1m ?? null, largePrints: r.large_prints ?? null,
      efficiency: r.efficiency ?? null, perpSpotDiv: r.perp_spot_div ?? null,
      cvd3m: r.cvd_d3m ?? null, polyMid: r.poly_mid ?? null });
    if (res && res.early && !latch) latch = res.early;
  }
  return latch;
}
function loadLive(dir) {
  const bars = [];
  if (!dir || !existsSync(dir)) return bars;
  for (const f of readdirSync(dir).filter(x => /-updown-5m-.*\.json$/.test(x))) {
    const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const srow = d.rows.find(r => r.settled); const body = d.rows.filter(r => !r.settled);
    if (!srow || body.length < 100) continue;
    bars.push({ slug: d.slug, settle: srow.settled, open: srow.open, close: srow.close, rows: body });
  }
  return bars;
}
function loadBqEval(file) {
  const bars = [];
  if (!file || !existsSync(file)) return bars;
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  const cols = JSON.parse(lines[0]).cols;
  for (const ln of lines.slice(1)) {
    const o = JSON.parse(ln);
    bars.push({ slug: o.slug, settle: o.settle, open: o.open, close: o.close,
      rows: o.rows.map(a => Object.fromEntries(cols.map((c, i) => [c, a[i]]))) });
  }
  return bars;
}
function report(name, bars) {
  let fired = 0, correct = 0, priceSum = 0, rems = [], misses = [];
  for (const b of bars) {
    const e = replay(b);
    if (!e) continue;
    fired++; rems.push(e.rem); priceSum += e.price;
    if (e.side === b.settle) correct++;
    else misses.push(`${b.slug}(${e.side}@${e.price},$${Math.abs((b.close || 0) - (b.open || 0)).toFixed(0)})`);
  }
  const acc = fired ? 100 * correct / fired : 0, price = fired ? priceSum / fired : 0;
  rems.sort((a, b) => a - b);
  const med = rems.length ? rems[Math.floor(rems.length / 2)] : null;
  console.log(`\n=== ${name} (n=${bars.length}) ===`);
  console.log(`  fired ${fired} (${(100 * fired / bars.length).toFixed(1)}% cov) | acc ${acc.toFixed(1)}% | price ${price.toFixed(3)} | EDGE ${(acc - 100 * price).toFixed(1)}pp | median fire ${med != null ? 300 - med + 's in' : '—'}`);
  if (misses.length) console.log('  misses: ' + misses.join(', '));
}
const live = loadLive(process.argv[2]), bq = loadBqEval(process.argv[3]);
if (live.length) report('LIVE', live);
if (bq.length) report('BQ 24/7', bq);
if (live.length && bq.length) report('POOLED', [...live, ...bq]);
