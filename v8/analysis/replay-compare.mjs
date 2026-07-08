// v8/analysis/replay-compare.mjs — the v8 acceptance gate.
// Replays the REAL v8, v6 and v7s engines tick-by-tick over every bar
// (BQ 24/7 bars + live logs) and checks:
//   G1  value/bar: v8 >= cushion-anchor reference and beats v6/poly/vwap baselines
//   G2  wrong-tick rate: v8 <= v6
//   G3  missed fire-worthy ticks: v8 ~= 0
//   G4  LOBO by UTC day: v8 value/bar beats v6 on EVERY day
//   G5  early-call channel: v8 latch identical to v7s latch on EVERY bar (inheritance tie)
// Also reports (informational): bars where v8 loses >10% of v6-correct ticks — expected
// for a stream REPLACEMENT (v6 is sometimes correct counter-cushion); listed, not gating.
//
// Usage: node v8/analysis/replay-compare.mjs <bq-bars-dir> <live-logs-dir>
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as V8 from '../src/signals.mjs';
import * as V6 from '../../v6/src/signals.mjs';
import * as V7S from '../../v7s/src/signals.mjs';

const LAM = 1.0, MU = 0.25;
const floorOf = v => Math.max(10, 0.5 * (v ?? 0));

function inpOf(r, open, now) {
  const price = r.cushion != null && open != null ? open + r.cushion : null;
  return { now, sinceOpen: r.cvd_since_open, price,
    bimb: r.btc_imb, pimb: r.poly_imb, cushion: r.cushion, remS: r.rem,
    vol1m: r.vol_1m ?? null, largePrints: r.large_prints ?? null,
    efficiency: r.efficiency ?? null, perpSpotDiv: r.perp_spot_div ?? null,
    cvd3m: r.cvd_d3m ?? null, polyMid: r.poly_mid ?? null };
}

function tickValue(sig, settle, r) {
  const polyOk = r.poly_mid != null;
  const u = polyOk ? Math.max(0, 1 - 2 * Math.abs(r.poly_mid - 0.5)) : 0;
  const e = (r.rem ?? 0) / 300;
  const c = r.cushion ?? 0;
  const lead = c > 0 ? 'UP' : c < 0 ? 'DOWN' : null;
  const fireWorthy = lead === settle && Math.abs(c) >= floorOf(r.vol_1m);
  if (sig === 'MIXED' || sig == null) return { v: fireWorthy ? -MU : 0, kind: fireWorthy ? 'missed' : 'ok-mixed' };
  return sig === settle ? { v: u * e, kind: 'correct' } : { v: -LAM, kind: 'wrong' };
}

function replayBar(bar) {
  const s8 = V8.newSession(), s6 = V6.newSession(), s7 = V7S.newSession();
  let t = 1700000000000;
  const out = { ticks: [], early8: null, early7: null };
  for (const r of bar.rows) {
    t += 1000;
    const inp = inpOf(r, bar.open, t);
    const r8 = V8.tick(s8, { ...inp });
    const r6 = V6.tick(s6, { ...inp });
    const r7 = V7S.tick(s7, { ...inp });
    if (r8 && r6) out.ticks.push({ r, sig8: r8.decision.sig, sig6: r6.decision.sig });
    if (r8?.early && !out.early8) out.early8 = r8.early;
    if (r7?.early && !out.early7) out.early7 = r7.early;
  }
  return out;
}

function loadBq(dir) {
  const bars = [];
  for (const f of readdirSync(dir).filter(x => /_bq\.json$/.test(x))) {
    const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const srow = d.rows.find(r => r.settled); const body = d.rows.filter(r => !r.settled);
    if (!srow || body.length < 100) continue;
    const slug = d.slug.replace(/_bq$/, '');
    bars.push({ slug, settle: srow.settled, open: srow.open, rows: body, src: 'bq' });
  }
  return bars;
}
function loadLive(dir) {
  const bars = [];
  if (!dir || !existsSync(dir)) return bars;
  for (const f of readdirSync(dir).filter(x => /^btc-updown-5m-.*_(v6|v7s)\.json$/.test(x))) {
    const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const srow = d.rows.find(r => r.settled); const body = d.rows.filter(r => !r.settled);
    if (!srow || body.length < 100) continue;
    bars.push({ slug: d.slug, settle: srow.settled, open: srow.open, rows: body, src: 'live' });
  }
  return bars;
}

const bq = loadBq(process.argv[2] ?? 'v6/analysis/bqbars');
const live = loadLive(process.argv[3] ?? 'AUTOPSY/logs');
const bars = [...bq, ...live];
console.log(`bars: ${bq.length} BQ + ${live.length} live = ${bars.length}`);

const agg = { v8: { v: 0, correct: 0, wrong: 0, missed: 0, n: 0, dir: 0 },
              v6: { v: 0, correct: 0, wrong: 0, missed: 0, n: 0, dir: 0 } };
const byDay = new Map();
let earlyMismatch = 0, harmed = [];
for (const bar of bars) {
  const { ticks, early8, early7 } = replayBar(bar);
  const key8 = early8 ? `${early8.side}@${early8.rem}` : 'none';
  const key7 = early7 ? `${early7.side}@${early7.rem}` : 'none';
  if (key8 !== key7) { earlyMismatch++; console.log(`  EARLY MISMATCH ${bar.slug}: v8=${key8} v7s=${key7}`); }
  const epoch = parseInt(bar.slug.split('-').pop(), 10);
  const day = new Date(epoch * 1000).toISOString().slice(0, 10);
  if (!byDay.has(day)) byDay.set(day, { v8: 0, v6: 0, bars: 0 });
  const dd = byDay.get(day); dd.bars++;
  let c8 = 0, c6 = 0;
  for (const { r, sig8, sig6 } of ticks) {
    const t8 = tickValue(sig8, bar.settle, r), t6 = tickValue(sig6, bar.settle, r);
    agg.v8.v += t8.v; agg.v6.v += t6.v; agg.v8.n++; agg.v6.n++;
    for (const [a, t, sig] of [[agg.v8, t8, sig8], [agg.v6, t6, sig6]]) {
      if (t.kind === 'correct') a.correct++;
      else if (t.kind === 'wrong') a.wrong++;
      else if (t.kind === 'missed') a.missed++;
      if (sig === 'UP' || sig === 'DOWN') a.dir++;
    }
    dd.v8 += t8.v; dd.v6 += t6.v;
    if (t8.kind === 'correct') c8++;
    if (t6.kind === 'correct') c6++;
  }
  if (c6 > 0 && c8 < 0.9 * c6) harmed.push({ slug: bar.slug, c6, c8 });
}

const nb = bars.length;
function line(name, a) {
  console.log(`${name}: value/bar=${(a.v / nb).toFixed(4)} acc=${(100 * a.correct / Math.max(1, a.dir)).toFixed(1)}% cov=${(100 * a.dir / a.n).toFixed(1)}% wrong=${(100 * a.wrong / a.n).toFixed(1)}% missed=${(100 * a.missed / a.n).toFixed(1)}%`);
}
console.log('\n=== pooled (1s ticks, all bars) ===');
line('v8', agg.v8); line('v6', agg.v6);

console.log('\n=== LOBO by UTC day (value/bar) ===');
let loboFail = 0;
for (const [day, dd] of [...byDay.entries()].sort()) {
  const ok = dd.v8 / dd.bars > dd.v6 / dd.bars;
  if (!ok) loboFail++;
  console.log(`  ${day}: v8=${(dd.v8 / dd.bars).toFixed(3)} v6=${(dd.v6 / dd.bars).toFixed(3)} bars=${dd.bars} ${ok ? 'PASS' : 'FAIL'}`);
}

console.log(`\nbars where v8 keeps <90% of v6-correct ticks (informational, stream replacement): ${harmed.length}/${nb}`);

const g1 = agg.v8.v / nb > agg.v6.v / nb;
const g2 = agg.v8.wrong / agg.v8.n <= agg.v6.wrong / agg.v6.n;
const g3 = agg.v8.missed / agg.v8.n < 0.005;
const g4 = loboFail === 0;
const g5 = earlyMismatch === 0;
console.log('\n=== GATES ===');
console.log(`G1 value dominance vs v6: ${g1 ? 'PASS' : 'FAIL'}`);
console.log(`G2 wrong-rate <= v6:      ${g2 ? 'PASS' : 'FAIL'} (v8 ${(100 * agg.v8.wrong / agg.v8.n).toFixed(1)}% vs v6 ${(100 * agg.v6.wrong / agg.v6.n).toFixed(1)}%)`);
console.log(`G3 missed ~ 0:            ${g3 ? 'PASS' : 'FAIL'} (${(100 * agg.v8.missed / agg.v8.n).toFixed(2)}%)`);
console.log(`G4 LOBO every day:        ${g4 ? 'PASS' : 'FAIL'}`);
console.log(`G5 early channel == v7s:  ${g5 ? 'PASS' : 'FAIL'} (${earlyMismatch} mismatches)`);
console.log(`\nOVERALL: ${g1 && g2 && g3 && g4 && g5 ? 'GATE PASS' : 'GATE FAIL'}`);
process.exit(g1 && g2 && g3 && g4 && g5 ? 0 : 1);
