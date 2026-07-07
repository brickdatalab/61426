// v7s/analysis/replay-compare.mjs — dominance gate vs v6: the v7s lean stream
// (decision.sig) is intentionally BYTE-IDENTICAL to v6 (only the early-call channel differs,
// and it is additive/read-only), so this gate must show a perfect tie -> PASS.
// Usage: node v7s/analysis/replay-compare.mjs <live-logs-dir>
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as OLD from '../../v6/src/signals.mjs';
import * as NEW from '../src/signals.mjs';

function loadBars(dir) {
  const bars = [];
  if (!dir || !existsSync(dir)) return bars;
  for (const f of readdirSync(dir).filter(x => /_(v5[34]|v6)\.json$/.test(x)).sort()) {
    const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const settle = d.rows.find(r => r.settled);
    if (!settle) continue;
    const rows = d.rows.filter(r => !r.settled);
    if (rows.length < 100) continue;
    bars.push({ slug: d.slug, open: settle.open, settle: settle.settled, rows });
  }
  return bars;
}
function replay(engine, bar) {
  const s = engine.newSession();
  const out = []; let t = 1700000000000;
  for (const r of bar.rows) {
    t += 1000;
    const res = engine.tick(s, { now: t, sinceOpen: r.cvd_since_open,
      price: r.cushion != null ? bar.open + r.cushion : null,
      bimb: r.btc_imb, pimb: r.poly_imb, cushion: r.cushion, remS: r.rem,
      vol1m: r.vol_1m ?? null, largePrints: r.large_prints ?? null,
      efficiency: r.efficiency ?? null, perpSpotDiv: r.perp_spot_div ?? null,
      cvd3m: r.cvd_d3m ?? null, polyMid: r.poly_mid ?? null });
    out.push(res ? res.decision.sig : 'MIXED');
  }
  return out;
}
const bars = loadBars(process.argv[2]);
if (!bars.length) { console.log('no bars'); console.log('\nGATE: FAIL'); process.exit(1); }
let diffTicks = 0, diffBars = 0, oldC = 0, neuC = 0, ticks = 0;
for (const bar of bars) {
  const a = replay(OLD, bar), b = replay(NEW, bar);
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    ticks++;
    if (a[i] !== 'MIXED' && a[i] === bar.settle) oldC++;
    if (b[i] !== 'MIXED' && b[i] === bar.settle) neuC++;
    if (a[i] !== b[i]) d++;
  }
  if (d) diffBars++;
  diffTicks += d;
}
console.log(`bars: ${bars.length}  ticks: ${ticks}`);
console.log(`lean-stream diff: ${diffTicks} ticks across ${diffBars} bars | correct ${oldC} -> ${neuC}`);
const pass = diffTicks === 0 && oldC === neuC;
console.log(`\nGATE: ${pass ? 'PASS (perfect tie — early channel is additive)' : 'FAIL'}`);
process.exit(pass ? 0 : 1);
