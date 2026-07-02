// v5.3 acceptance gate: replay ALL settled session logs through the REAL v5.1 and v5.3
// engines and compare, split into the 20-bar TUNING set vs OUT-OF-SAMPLE bars.
// Usage: node v5.3/analysis/replay-compare.mjs <logs-dir>
// Read-only on both engines; writes nothing.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as OLD from '../../v5.1/src/signals.mjs';
import * as NEW from '../src/signals.mjs';

// the 20 bars the deep-dive sweep tuned on (v5.1/analysis/2026-07-02-deepdive-20bars.md)
const TUNING = new Set([...Array(23).keys()].map(i => `btc-updown-5m-${1782969600 + i * 300}`)
  .filter(s => !['1782970200', '1782970500'].some(t => s.endsWith(t))));
// (contiguous 1782969600..1782976200 was the actual set: 9600 + 0800..76200; the two
//  fillers above never existed as logs — membership is decided by slug match below.)

function loadBars(dir) {
  const bars = [];
  for (const f of readdirSync(dir).filter(x => /_v5[123]\.json$/.test(x)).sort()) {
    const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const settle = d.rows.find(r => r.settled);
    if (!settle) continue;
    bars.push({ slug: d.slug.replace(/_v5[123]$/, ''), open: settle.open, settle: settle.settled,
                rows: d.rows.filter(r => !r.settled) });
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

const dir = process.argv[2];
const bars = loadBars(dir);
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

console.log(`bars: ${bars.length} (${rows.filter(x => TUNING.has(x.bar.slug)).length} tuning / ${rows.filter(x => !TUNING.has(x.bar.slug)).length} out-of-sample)\n`);
for (const [name, sel] of [['TUNING', b => TUNING.has(b.slug)], ['OUT-OF-SAMPLE', b => !TUNING.has(b.slug)]]) {
  const { old, neu } = pool(sel);
  console.log(`${name}:`);
  console.log(fmt('v5.1', old));
  console.log(fmt('v5.3', neu));
}
console.log('\nper-bar (OOS only):');
for (const x of rows.filter(x => !TUNING.has(x.bar.slug)))
  console.log(`  ${x.bar.slug} settle=${x.bar.settle}  v5.1 ${x.old.hit}/${x.old.nm} (tr ${x.old.trans})  ->  v5.3 ${x.neu.hit}/${x.neu.nm} (tr ${x.neu.trans})`);

const oos = pool(b => !TUNING.has(b.slug));
const pass = oos.neu.acc >= oos.old.acc && oos.neu.wrongEp <= oos.old.wrongEp && oos.neu.trAvg <= 6 && oos.neu.trMax <= 9;
console.log(`\nGATE: ${pass ? 'PASS' : 'FAIL'}`);
process.exit(pass ? 0 : 1);
