// v6 acceptance gate: replay ALL settled bars through the REAL v5.4 and v6 engines
// and compare. v6's lean stream (decision.sig) is untouched relative to v5.4 — the
// early-call channel is additive — so this gate is expected to show 100% retention,
// 0 hurt bars, GATE PASS.
// Usage: node v6/analysis/replay-compare.mjs <live-logs-dir> [bq-bars-dir]
// Accepts live session logs (*_v5[34].json) from dir arg 1 and/or BQ-reconstructed
// bars (*_bq.json) from dir arg 2. Read-only on both engines; writes nothing.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as OLD from '../../v5.4/src/signals.mjs';
import * as NEW from '../src/signals.mjs';

function loadBars(dir, pattern, stripSuffix) {
  const bars = [];
  if (!dir || !existsSync(dir)) return bars;
  for (const f of readdirSync(dir).filter(x => pattern.test(x)).sort()) {
    const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const settle = d.rows.find(r => r.settled);
    if (!settle) continue;
    const rows = d.rows.filter(r => !r.settled);
    if (rows.length < 100) continue;   // exclude test stubs (dataset rule)
    bars.push({ slug: d.slug.replace(stripSuffix, ''), open: settle.open, settle: settle.settled, rows });
  }
  return bars;
}

function replay(engine, bar) {
  const s = engine.newSession();
  const out = [];
  let t = 1700000000000;
  for (const r of bar.rows) {
    t += 1000;
    const res = engine.tick(s, {
      now: t, sinceOpen: r.cvd_since_open,
      price: r.cushion != null ? bar.open + r.cushion : null,
      bimb: r.btc_imb, pimb: r.poly_imb, cushion: r.cushion, remS: r.rem,
      vol1m: r.vol_1m ?? null, largePrints: r.large_prints ?? null,
      efficiency: r.efficiency ?? null, perpSpotDiv: r.perp_spot_div ?? null,
      cvd3m: r.cvd_d3m ?? null,
    });
    out.push({ r, sig: res ? res.decision.sig : 'MIXED' });
  }
  return out;
}

function score(bar, ticks) {
  let nm = 0, hit = 0, fw = 0, fwCov = 0, trans = 0, wrongEp = 0, prev = null;
  for (const { r, sig } of ticks) {
    if (prev != null && sig !== prev) trans++;
    prev = sig;
    if (sig !== 'MIXED') { nm++; if (sig === bar.settle) hit++; }
    if (r.cushion != null && r.vol_1m != null && Math.abs(r.cushion) >= Math.max(10, 0.5 * r.vol_1m)
        && ((r.cushion > 0 ? 'UP' : 'DOWN') === bar.settle)) { fw++; if (sig === bar.settle) fwCov++; }
  }
  let i = 0;
  while (i < ticks.length) {
    const sg = ticks[i].sig;
    if (sg !== 'MIXED') { let j = i; while (j < ticks.length - 1 && ticks[j + 1].sig === sg) j++; if (sg !== bar.settle) wrongEp++; i = j + 1; }
    else i++;
  }
  return { nm, hit, fw, fwCov, trans, wrongEp };
}

const liveDir = process.argv[2];
const bqDir = process.argv[3];
const bars = [
  ...loadBars(liveDir, /_v5[34]\.json$/, /_v5[34]$/),
  ...loadBars(bqDir, /_bq\.json$/, /_bq$/),
];
const rows = bars.map(bar => ({ bar, old: score(bar, replay(OLD, bar)), neu: score(bar, replay(NEW, bar)) }));

function pool(sel) {
  const p = rows.filter(x => sel(x.bar));
  const agg = k => e => p.reduce((a, x) => a + x[e][k], 0);
  const mk = e => ({
    n: p.length,
    acc: agg('hit')(e) / Math.max(agg('nm')(e), 1),
    cov: agg('fwCov')(e) / Math.max(agg('fw')(e), 1),
    trAvg: agg('trans')(e) / Math.max(p.length, 1),
    trMax: Math.max(...p.map(x => x[e].trans), 0),
    wrongEp: agg('wrongEp')(e),
  });
  return { old: mk('old'), neu: mk('neu') };
}

const fmt = (label, m) =>
  `  ${label.padEnd(6)} acc ${(100 * m.acc).toFixed(1)}%  cov ${(100 * m.cov).toFixed(1)}%  trans ${m.trAvg.toFixed(2)}/${m.trMax}  wrongEp ${m.wrongEp}  (n=${m.n})`;

console.log(`bars: ${bars.length}\n`);
for (const [name, sel] of [['ALL-BARS', b => true]]) {
  const { old, neu } = pool(sel);
  console.log(`${name}:`);
  console.log(fmt('v5.4', old));
  console.log(fmt('v6', neu));
}

// DOMINANCE GATE (same contract as v5.4/analysis/replay-compare.mjs): correct retention
// >=99% pooled, no bar loses >10% of its correct ticks, wrong strictly reduced OR missed
// converted with wrong not increased, transitions <= baseline avg+0.5 and <= baseline max.
const all = pool(b => true);
const perBarHurt = rows.filter(x => x.old.hit > 0 && x.neu.hit < 0.9 * x.old.hit);
const oldMissed = rows.reduce((a, x) => a + (x.old.fw - x.old.fwCov), 0);
const neuMissed = rows.reduce((a, x) => a + (x.neu.fw - x.neu.fwCov), 0);
console.log(`\nper-bar hurt (>10% correct loss): ${perBarHurt.length}` + (perBarHurt.length ? ' ' + perBarHurt.map(x => x.bar.slug).join(', ') : ''));
const oldW = rows.reduce((a, x) => a + (x.old.nm - x.old.hit), 0);
const neuW = rows.reduce((a, x) => a + (x.neu.nm - x.neu.hit), 0);
const oldC = rows.reduce((a, x) => a + x.old.hit, 0);
const neuC = rows.reduce((a, x) => a + x.neu.hit, 0);
const pass = neuC / oldC >= 0.99 && perBarHurt.length === 0
  && ((neuW < oldW) || (neuMissed < oldMissed && neuW <= oldW))
  && all.neu.trAvg <= all.old.trAvg + 0.5 && all.neu.trMax <= all.old.trMax;
console.log(`correct ${oldC} -> ${neuC} (${(100 * neuC / oldC).toFixed(1)}%) | wrong ${oldW} -> ${neuW} | missed ${oldMissed} -> ${neuMissed} | trans ${all.old.trAvg.toFixed(2)}/${all.old.trMax} -> ${all.neu.trAvg.toFixed(2)}/${all.neu.trMax}`);
console.log(`\nGATE: ${pass ? 'PASS' : 'FAIL'}`);
process.exit(pass ? 0 : 1);
