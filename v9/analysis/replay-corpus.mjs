#!/usr/bin/env node

import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createZstdDecompress } from 'node:zlib';

import * as V8 from '../../v8/src/signals.mjs';
import * as V9 from '../src/signals.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const checkpoints = [120, 105, 100, 60, 30, 20, 10, 5, 2];
const arg = name => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const corpusRoot = resolve(arg('--corpus') || join(REPO, 'v8_corpus'));
const outputJson = resolve(arg('--output-json') || join(HERE, 'replay_report.json'));
const outputMd = resolve(arg('--output-md') || join(HERE, 'replay_report.md'));

function requireVerifiedCorpus() {
  const report = JSON.parse(readFileSync(join(corpusRoot, 'audit', 'verification_report.json'), 'utf8'));
  const failures = Array.isArray(report.failures) ? report.failures : [];
  const failedChecks = Array.isArray(report.checks) ? report.checks.filter(check => !check.passed) : [];
  if (report.passed !== true || failures.length || failedChecks.length) {
    throw new Error(`Corpus verification is not PASS (${failures.length + failedChecks.length} failures)`);
  }
  return { passed: true, checks: report.checks.length };
}

function parseCollectionWindows() {
  const lines = readFileSync(join(corpusRoot, 'audit', 'collection_windows.csv'), 'utf8').trim().split(/\r?\n/).slice(1);
  return lines.map((line, index) => {
    const [start, end, asset, interval, mode] = line.split(',');
    return { id: `block_${String(index + 1).padStart(3, '0')}`, startMs: Date.parse(start), endMs: Date.parse(end), asset, interval, mode };
  });
}

async function readSessions() {
  const stream = createReadStream(join(corpusRoot, 'raw', 'v8_sessions_raw.jsonl.zst')).pipe(createZstdDecompress());
  const sessions = [];
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const envelope = JSON.parse(line);
    const payload = JSON.parse(envelope.raw_payload_text);
    sessions.push({ envelope, payload });
  }
  return sessions;
}

function slugEpoch(slug) {
  const match = String(slug).match(/-(\d+)(?:_v8)?$/);
  if (!match) throw new Error(`Cannot parse market epoch from ${slug}`);
  return Number(match[1]);
}

function cleanResult(result) {
  if (result == null) return null;
  return {
    flow: result.flow,
    cush_d10: result.cush_d10,
    momentum: result.momentum,
    decision: result.decision,
    early: result.early,
    flip: result.flip,
  };
}

function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function pct(correct, calls) { return calls ? correct / calls : null; }
function newStats() { return { eligible: 0, calls: 0, correct: 0, mixed: 0 }; }
function addCheckpoint(stats, side, settled) {
  stats.eligible += 1;
  if (side === 'UP' || side === 'DOWN') {
    stats.calls += 1;
    if (side === settled) stats.correct += 1;
  } else stats.mixed += 1;
}
function finalizeStats(stats) {
  return { ...stats, coverage: pct(stats.calls, stats.eligible), accuracy: pct(stats.correct, stats.calls) };
}
function checkpointMap() { return Object.fromEntries(checkpoints.map(cp => [cp, newStats()])); }

function pickCausalCheckpoint(observations, checkpoint) {
  let best = null;
  for (const observation of observations) {
    if (observation.rem < checkpoint) continue;
    if (!best || observation.rem < best.rem || (observation.rem === best.rem && observation.index > best.index)) best = observation;
  }
  return best;
}

function collectionBlockFor(epochMs, windows) {
  return windows.find(window => epochMs >= window.startMs && epochMs < window.endMs)?.id ?? 'unassigned';
}

function aggregateBreakdown(target, key, observations, settled) {
  if (!target[key]) target[key] = checkpointMap();
  for (const checkpoint of checkpoints) {
    const observation = pickCausalCheckpoint(observations, checkpoint);
    if (observation) addCheckpoint(target[key][checkpoint], observation.side, settled);
  }
}

function strictTallyCall(observations) {
  const counts = { UP: 0, DOWN: 0, MIXED: 0 };
  for (const observation of observations) counts[observation.side] += 1;
  const ordered = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (ordered[0][1] === ordered[1][1] || ordered[0][0] === 'MIXED') return { call: null, counts };
  return { call: ordered[0][0], counts };
}

function finalizeBreakdown(breakdown) {
  return Object.fromEntries(Object.entries(breakdown).sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => [
    key,
    Object.fromEntries(checkpoints.map(cp => [cp, finalizeStats(values[cp])])),
  ]));
}

function markdown(report) {
  const lines = [
    '# V9 Corpus Replay Report', '',
    `Generated: ${report.generated_at_utc}`,
    `Corpus: ${report.corpus.sessions} canonical BTC 5-minute markets / ${report.corpus.ticks} replayed ticks`,
    `Corpus verification: PASS (${report.corpus.verification_checks} checks)`, '',
    '## V8 parity', '',
    `- Compared outputs: decision, floor, early call, conviction, flip, momentum, flow, and inherited engine state.`,
    `- Compared ticks: ${report.v8_parity.compared_ticks}`,
    `- Mismatches: ${report.v8_parity.mismatches}`, '',
    '## Strict occupancy tally', '',
    '| calls | correct | accuracy | abstained |', '|---:|---:|---:|---:|',
    `| ${report.strict_tally.calls} | ${report.strict_tally.correct} | ${formatRate(report.strict_tally.accuracy)} | ${report.strict_tally.abstained} |`, '',
    'This is reported for verification only. V9 does not use occupancy counts as a settlement forecast.', '',
    '## Settlement Nowcast checkpoints', '',
    'Checkpoint selection is causal: the closest available observation at or before the checkpoint (remaining seconds greater than or equal to the target).', '',
    '| remaining | eligible | calls | MIXED abstentions | coverage | correct | accuracy |', '|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const checkpoint of checkpoints) {
    const row = report.settlement_nowcast.checkpoints[checkpoint];
    lines.push(`| ${checkpoint}s | ${row.eligible} | ${row.calls} | ${row.mixed} | ${formatRate(row.coverage)} | ${row.correct} | ${formatRate(row.accuracy)} |`);
  }
  lines.push('', '## Change diagnostics', '',
    `- Nowcast transition events: ${report.settlement_nowcast.change_events}`,
    `- Markets with a nowcast transition: ${report.settlement_nowcast.markets_with_changes}`,
    `- Direct UP↔DOWN directional reversals: ${report.settlement_nowcast.directional_reversals}`,
    `- Markets with a direct directional reversal: ${report.settlement_nowcast.markets_with_directional_reversals}`, '',
    '## Outcome Shadow historical availability', '',
    `- Early candidate calls: ${report.outcome_shadow.early.calls}; correct: ${report.outcome_shadow.early.correct}; accuracy: ${formatRate(report.outcome_shadow.early.accuracy)}.`,
    `- Confirmed-discounted branch: unavailable for ${report.outcome_shadow.confirmed_discounted.unavailable_sessions} sessions without an early call because actual two-sided executable quotes were not logged.`,
    '- No DOWN midpoint was synthesized from `1 − UP midpoint`, and no combined Outcome Shadow accuracy is reported.', '',
    '## Breakdowns', '',
    'UTC-day and collection-block checkpoint statistics are included in `replay_report.json` under `breakdowns`.', '',
    '## Guardrail', '',
    'This is an untuned verification replay. It does not change V9 thresholds or behavior.', '');
  return lines.join('\n');
}

function formatRate(value) { return value == null ? '—' : `${(value * 100).toFixed(1)}%`; }

async function main() {
  const verification = requireVerifiedCorpus();
  const windows = parseCollectionWindows();
  const sessions = await readSessions();
  if (sessions.length !== 381) throw new Error(`Expected 381 canonical sessions, found ${sessions.length}`);

  V8.CFG.EARLY_MIN_REM = 255; V8.CFG.EARLY_HARD_REM = 210;
  V9.CFG.EARLY_MIN_REM = 255; V9.CFG.EARLY_HARD_REM = 210;

  let comparedTicks = 0, mismatches = 0, rawTickTotal = 0;
  let strictCalls = 0, strictCorrect = 0;
  let nowcastChangeEvents = 0, marketsWithChanges = 0, directionalReversals = 0, marketsWithDirectionalReversals = 0;
  let earlyCalls = 0, earlyCorrect = 0;
  const checkpointStats = checkpointMap(), byDay = {}, byBlock = {};

  for (const { payload } of sessions) {
    const settlement = payload.rows.find(row => row?.settled);
    if (!settlement || !Number.isFinite(Number(settlement.open)) || !Number.isFinite(Number(settlement.close))) {
      throw new Error(`Missing canonical settlement in ${payload.slug}`);
    }
    const settled = Number(settlement.close) >= Number(settlement.open) ? 'UP' : 'DOWN';
    const epoch = slugEpoch(payload.slug), barStartMs = epoch * 1_000, barEndMs = barStartMs + 300_000;
    const v8 = V8.newSession(), v9 = V9.newSession();
    const inheritedKeys = Object.keys(v8);
    const observations = [], loggedSignals = [];
    let replayNow = barStartMs - 1, early = null;

    for (const [index, row] of payload.rows.entries()) {
      if (row?.settled) continue;
      rawTickTotal += 1;
      if (row.signal === 'UP' || row.signal === 'DOWN' || row.signal === 'MIXED') loggedSignals.push({ side: row.signal });
      const rem = Number(row.rem);
      if (!Number.isFinite(rem)) continue;
      const nominalNow = barEndMs - rem * 1_000;
      replayNow = Math.max(replayNow + 1, nominalNow);
      const cushion = row.cushion == null ? null : Number(row.cushion);
      const input = {
        now: replayNow,
        sinceOpen: row.cvd_since_open == null ? null : Number(row.cvd_since_open),
        price: cushion == null ? null : 50_000 + cushion,
        bimb: row.btc_imb ?? null, pimb: row.poly_imb ?? null,
        largePrints: row.large_prints ?? null, efficiency: row.efficiency ?? null,
        perpSpotDiv: row.perp_spot_div ?? null, cvd3m: row.cvd_d3m ?? null,
        cushion, remS: rem, vol1m: row.vol_1m ?? null, polyMid: row.poly_mid ?? null,
      };
      const expected = V8.tick(v8, input);
      const actual = V9.tick(v9, { ...input, marketSupported: true });
      if (expected == null || actual == null) {
        if (expected !== actual) mismatches += 1;
        continue;
      }
      comparedTicks += 1;
      const inheritedState = Object.fromEntries(inheritedKeys.map(key => [key, v9[key]]));
      if (!equal(cleanResult(actual), expected) || !equal(inheritedState, v8)) mismatches += 1;
      if (!early && actual.early && (actual.early.side === 'UP' || actual.early.side === 'DOWN')) early = actual.early;
      observations.push({ index, rem, side: actual.v9.nowcast.side, phase: actual.v9.nowcast.phase });
    }

    const strict = strictTallyCall(loggedSignals);
    if (strict.call) { strictCalls += 1; if (strict.call === settled) strictCorrect += 1; }
    for (const checkpoint of checkpoints) {
      const observation = pickCausalCheckpoint(observations, checkpoint);
      if (observation) addCheckpoint(checkpointStats[checkpoint], observation.side, settled);
    }
    const changes = v9.v9NowcastChangeCount;
    const reversals = v9.v9DirectionalChangeCount;
    nowcastChangeEvents += changes; directionalReversals += reversals;
    if (changes) marketsWithChanges += 1;
    if (reversals) marketsWithDirectionalReversals += 1;
    if (early) { earlyCalls += 1; if (early.side === settled) earlyCorrect += 1; }

    const day = new Date(barStartMs).toISOString().slice(0, 10);
    const block = collectionBlockFor(barStartMs, windows);
    aggregateBreakdown(byDay, day, observations, settled);
    aggregateBreakdown(byBlock, block, observations, settled);
  }

  const report = {
    report_version: 'v9-replay-1',
    generated_at_utc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    corpus: { sessions: sessions.length, ticks: rawTickTotal, engine_eligible_ticks: comparedTicks, verification_passed: true, verification_checks: verification.checks },
    v8_parity: { compared_ticks: comparedTicks, mismatches, passed: mismatches === 0 },
    strict_tally: { calls: strictCalls, correct: strictCorrect, accuracy: pct(strictCorrect, strictCalls), abstained: sessions.length - strictCalls },
    settlement_nowcast: {
      checkpoints: Object.fromEntries(checkpoints.map(cp => [cp, finalizeStats(checkpointStats[cp])])),
      change_events: nowcastChangeEvents, markets_with_changes: marketsWithChanges,
      directional_reversals: directionalReversals, markets_with_directional_reversals: marketsWithDirectionalReversals,
    },
    outcome_shadow: {
      early: { calls: earlyCalls, correct: earlyCorrect, accuracy: pct(earlyCorrect, earlyCalls) },
      confirmed_discounted: {
        status: 'UNAVAILABLE_MISSING_EXECUTABLE_TWO_SIDED_QUOTES',
        unavailable_sessions: sessions.length - earlyCalls,
        synthesized_down_quotes: 0,
      },
      combined_accuracy: null,
    },
    breakdowns: { by_utc_day: finalizeBreakdown(byDay), by_collection_block: finalizeBreakdown(byBlock) },
    tuning_performed: false,
  };

  writeFileSync(outputJson, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(outputMd, markdown(report));
  if (mismatches) throw new Error(`V8 parity failed with ${mismatches} mismatches`);
  console.log(`V9 replay PASS: ${sessions.length} sessions, ${rawTickTotal} raw ticks, ${comparedTicks} engine-eligible ticks, ${mismatches} parity mismatches`);
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
