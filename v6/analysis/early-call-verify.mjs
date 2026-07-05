// v6 early-call channel verification: replays the REAL v6 engine over live session
// logs + BQ-reconstructed bars, latches the early-call channel exactly as the
// dashboard would, and reports:
//   - the tier table (strong/qualified/lean): n, accuracy, median rem-at-latch
//   - coverage: bars with a call / bars that reached the mark; any no-call bars
//   - priced-in: implied odds (from poly_mid) at the latch tick, per tier
//   - study reconciliation: the original 90s-snapshot methodology (last tick with
//     rem >= 210, on the same LIVE set) vs. the engine's latch-form (first tick
//     with rem <= 210), side by side
//
// Usage: node v6/analysis/early-call-verify.mjs <live-logs-dir> [bq-bars-dir]
// Exit 0 only if coverage is complete (every bar that reached the mark got a call)
// and the study/engine reconciliation is within tolerance (see STOP condition below).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as ENGINE from '../src/signals.mjs';

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

// Replay one bar through the real v6 engine, capturing:
//  - latch: the first non-null `early` result (side/tier/ratio/rem), plus poly_mid at that tick
//  - studySnapshot: engine state (sig, cushion, vol1m, priceHist-fallback vol) at the LAST
//    tick with rem >= 210 (the original study's fixed-mark methodology)
//  - reachedMark: whether any tick in the bar had rem <= 210
function replayBar(bar) {
  const s = ENGINE.newSession();
  let t = 1700000000000;
  let latch = null;
  let studySnapshot = null;
  let reachedMark = false;
  for (const r of bar.rows) {
    t += 1000;
    const res = ENGINE.tick(s, {
      now: t, sinceOpen: r.cvd_since_open,
      price: r.cushion != null ? bar.open + r.cushion : null,
      bimb: r.btc_imb, pimb: r.poly_imb, cushion: r.cushion, remS: r.rem,
      vol1m: r.vol_1m ?? null, largePrints: r.large_prints ?? null,
      efficiency: r.efficiency ?? null, perpSpotDiv: r.perp_spot_div ?? null,
      cvd3m: r.cvd_d3m ?? null,
    });
    if (!res) continue;
    if (r.rem != null && r.rem >= 210) {
      studySnapshot = { sig: res.decision.sig, cushion: r.cushion, vol1m: r.vol_1m, volFallback: ENGINE.volFromHist(s.priceHist) };
    }
    if (r.rem != null && r.rem <= 210) reachedMark = true;
    if (!latch && res.early) latch = { ...res.early, polyMid: r.poly_mid ?? null };
  }
  return { bar, latch, studySnapshot, reachedMark, firstRem: s.firstRem };
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---- load ----
const liveDir = process.argv[2];
const bqDir = process.argv[3];
const liveBars = loadBars(liveDir, /_v5[34]\.json$/, /_v5[34]$/);
const bqBars = loadBars(bqDir, /_bq\.json$/, /_bq$/);
const sets = {
  LIVE: liveBars.map(replayBar),
  BQ: bqBars.map(replayBar),
};
sets.POOLED = [...sets.LIVE, ...sets.BQ];

console.log(`bars: LIVE=${liveBars.length} BQ=${bqBars.length} POOLED=${liveBars.length + bqBars.length}\n`);

// ---- TIER TABLE ----
// Tier rows count ONLY late:false calls — the full-pre-mark-history condition the
// badge percentages quote. late:true calls (session's first tick already at/after
// the mark, i.e. a mid-bar session start) go in a separate `late` row so nothing
// is silently dropped. Coverage counts ALL calls (a late call is still a call).
function tierTable(recs) {
  const tiers = ['strong', 'qualified', 'lean'];
  const out = {};
  for (const tier of tiers) {
    const withCall = recs.filter(x => x.latch && !x.latch.late && x.latch.tier === tier);
    const correct = withCall.filter(x => x.latch.side === x.bar.settle).length;
    out[tier] = {
      n: withCall.length,
      acc: withCall.length ? correct / withCall.length : null,
      medRem: median(withCall.map(x => x.latch.rem)),
    };
  }
  const lateCalls = recs.filter(x => x.latch && x.latch.late);
  const lateCorrect = lateCalls.filter(x => x.latch.side === x.bar.settle).length;
  out.late = {
    n: lateCalls.length,
    acc: lateCalls.length ? lateCorrect / lateCalls.length : null,
    medFirstRem: median(lateCalls.map(x => x.firstRem).filter(v => v != null)),
  };
  const reached = recs.filter(x => x.reachedMark);
  const called = reached.filter(x => x.latch);
  const noCall = reached.filter(x => !x.latch);
  return { tiers: out, coverage: { called: called.length, reached: reached.length }, noCall };
}

console.log('=== TIER TABLE (tier rows: late:false calls only; late calls in their own row) ===');
for (const [name, recs] of Object.entries(sets)) {
  const t = tierTable(recs);
  console.log(`\n${name} (n=${recs.length}):`);
  for (const tier of ['strong', 'qualified', 'lean']) {
    const r = t.tiers[tier];
    console.log(`  ${tier.padEnd(10)} n=${String(r.n).padEnd(4)} acc=${r.acc == null ? '—' : (100 * r.acc).toFixed(1) + '%'.padEnd(1)}  median rem-at-latch=${r.medRem == null ? '—' : r.medRem + 's'}`);
  }
  const L = t.tiers.late;
  console.log(`  ${'late'.padEnd(10)} n=${String(L.n).padEnd(4)} acc=${L.acc == null ? '—' : (100 * L.acc).toFixed(1) + '%'.padEnd(1)}  median firstRem=${L.medFirstRem == null ? '—' : L.medFirstRem + 's'}`);
  console.log(`  coverage: ${t.coverage.called}/${t.coverage.reached} bars with ≥1 tick at rem<=210 got a call (${t.coverage.reached ? (100 * t.coverage.called / t.coverage.reached).toFixed(1) : '—'}%)`);
  if (t.noCall.length) console.log(`  NO-CALL bars: ${t.noCall.map(x => x.bar.slug).join(', ')}`);
}

// ---- PRICED-IN ----
function pricedIn(recs) {
  const out = {};
  for (const tier of ['strong', 'qualified', 'lean']) {
    const withCall = recs.filter(x => x.latch && x.latch.tier === tier);
    const withMid = withCall.filter(x => x.latch.polyMid != null);
    const implied = withMid.map(x => x.latch.side === 'UP' ? x.latch.polyMid : 1 - x.latch.polyMid);
    const correct = withMid.filter(x => x.latch.side === x.bar.settle).length;
    out[tier] = { n: withMid.length, medImplied: median(implied), acc: withMid.length ? correct / withMid.length : null };
  }
  return out;
}

console.log('\n=== PRICED-IN (implied odds of the called side at the latch tick) ===');
for (const [name, recs] of Object.entries(sets)) {
  const p = pricedIn(recs);
  console.log(`\n${name}:`);
  for (const tier of ['strong', 'qualified', 'lean']) {
    const r = p[tier];
    console.log(`  ${tier.padEnd(10)} n-with-mid=${String(r.n).padEnd(4)} median implied=${r.medImplied == null ? '—' : (100 * r.medImplied).toFixed(0) + '¢'.padEnd(1)}  acc(subset)=${r.acc == null ? '—' : (100 * r.acc).toFixed(1) + '%'}`);
  }
}

// ---- STUDY RECONCILIATION (LIVE set only) ----
// Study-form: at the LAST tick with rem >= 210, was sig on the cushion side with
// ratio >= 2 (T1) / >= 3 (T2)? ratio = |cushion| / max(10, 0.5*vol_floor).
function studyForm(recs) {
  const calls = { t1: [], t2: [] };
  for (const x of recs) {
    const ss = x.studySnapshot;
    if (!ss) continue;
    const cushSign = ss.cushion == null ? 0 : Math.sign(ss.cushion);
    if (ss.sig === 'MIXED' || cushSign === 0) continue;
    if ((ss.sig === 'UP') !== (cushSign > 0)) continue;   // not cushion-side
    const vol = Math.max(ss.vol1m ?? ss.volFallback, 1);
    const floor = Math.max(10, 0.5 * vol);
    const ratio = Math.abs(ss.cushion) / floor;
    if (ratio >= 2) calls.t1.push({ x, side: ss.sig, correct: ss.sig === x.bar.settle });
    if (ratio >= 3) calls.t2.push({ x, side: ss.sig, correct: ss.sig === x.bar.settle });
  }
  const summarize = arr => ({ n: arr.length, correct: arr.filter(a => a.correct).length, acc: arr.length ? arr.filter(a => a.correct).length / arr.length : null });
  return { t1: summarize(calls.t1), t2: summarize(calls.t2) };
}

// Engine-form: T1 = tier in {strong, qualified} (ratio >= 2, latched at first tick rem<=210);
// T2 = tier === strong (ratio >= 3).
function engineForm(recs) {
  const t1 = recs.filter(x => x.latch && (x.latch.tier === 'strong' || x.latch.tier === 'qualified'));
  const t2 = recs.filter(x => x.latch && x.latch.tier === 'strong');
  const summarize = arr => ({ n: arr.length, correct: arr.filter(x => x.latch.side === x.bar.settle).length, acc: arr.length ? arr.filter(x => x.latch.side === x.bar.settle).length / arr.length : null });
  return { t1: summarize(t1), t2: summarize(t2) };
}

const sf = studyForm(sets.LIVE);
const ef = engineForm(sets.LIVE);

console.log('\n=== STUDY RECONCILIATION (LIVE set, n=' + liveBars.length + ') ===');
console.log('  form            T1 (ratio>=2)                    T2 (ratio>=3)');
const fmtCell = r => `n=${r.n} correct=${r.correct} acc=${r.acc == null ? '—' : (100 * r.acc).toFixed(1) + '%'}`;
console.log(`  study (last tick rem>=210):   ${fmtCell(sf.t1).padEnd(30)}  ${fmtCell(sf.t2)}`);
console.log(`  engine (first tick rem<=210): ${fmtCell(ef.t1).padEnd(30)}  ${fmtCell(ef.t2)}`);
console.log(`  reference (2026-07-05 study, v5.4 stream, cited in brief): T1 36/39 (92.3%)  T2 25/26 (96.2%)`);

const accDiffPct = (a, b) => (a == null || b == null) ? null : Math.abs(100 * a - 100 * b);
const t1AccDiff = accDiffPct(sf.t1.acc, ef.t1.acc);
const t2AccDiff = accDiffPct(sf.t2.acc, ef.t2.acc);
const t1CovDiff = Math.abs(sf.t1.n - ef.t1.n);
const t2CovDiff = Math.abs(sf.t2.n - ef.t2.n);
console.log(`\n  T1 accuracy diff: ${t1AccDiff == null ? '—' : t1AccDiff.toFixed(1) + 'pp'}  T1 coverage diff: ${t1CovDiff} bars`);
console.log(`  T2 accuracy diff: ${t2AccDiff == null ? '—' : t2AccDiff.toFixed(1) + 'pp'}  T2 coverage diff: ${t2CovDiff} bars`);

const TOL_ACC_PP = 3, TOL_COV_BARS = 4;
const reconciliationOk =
  (t1AccDiff == null || t1AccDiff <= TOL_ACC_PP) && (t2AccDiff == null || t2AccDiff <= TOL_ACC_PP) &&
  t1CovDiff <= TOL_COV_BARS && t2CovDiff <= TOL_COV_BARS;

if (!reconciliationOk) {
  console.log(`\n*** STOP CONDITION TRIPPED: engine-form vs study-form exceeds tolerance (>${TOL_ACC_PP}pp accuracy or >${TOL_COV_BARS} bars coverage). ***`);
} else {
  console.log(`\nreconciliation: within tolerance (<=${TOL_ACC_PP}pp accuracy, <=${TOL_COV_BARS} bars coverage on both T1 and T2).`);
}

// ---- coverage-complete check (pooled) ----
const pooledTable = tierTable(sets.POOLED);
const coverageComplete = pooledTable.noCall.length === 0;
console.log(`\n=== COVERAGE CHECK (pooled) ===`);
console.log(`  ${pooledTable.coverage.called}/${pooledTable.coverage.reached} bars with a call; no-call bars: ${pooledTable.noCall.length ? pooledTable.noCall.map(x => x.bar.slug).join(', ') : 'none'}`);

const pass = coverageComplete && reconciliationOk;
console.log(`\nRESULT: ${pass ? 'PASS' : 'FAIL'}`);
process.exit(pass ? 0 : 1);
