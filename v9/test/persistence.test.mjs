import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ENGINE_STATE_VERSION,
  applyMappingEvent,
  applyResumeInvalid,
  newSession,
  restoreSession,
  settlementSummary,
  serializeSession,
  tick,
  validateResumeSequence,
} from '../src/signals.mjs';

function feed(session, index = 0) {
  return tick(session, {
    now: 1_700_000_000_000 + index * 1_000,
    sinceOpen: 1_000 + index,
    price: 50_020,
    cushion: 20,
    remS: 250 - index,
    polyMid: 0.5,
    bimb: 0,
    pimb: 0,
    vol1m: 20,
    marketSupported: true,
  });
}

test('engine snapshot round-trips pending state without shared references', () => {
  const original = newSession();
  applyMappingEvent(original, {
    status: 'VALID', upTokenId: 'up-token', downTokenId: 'down-token',
    now: 1_700_000_000_000, remS: 250,
  });
  feed(original);
  const snapshot = serializeSession(original);
  const restored = restoreSession(snapshot);
  assert.deepEqual(restored, original);
  restored.openHist.push({ t: 0, v: 0 });
  assert.notDeepEqual(restored.openHist, original.openHist);
  assert.equal(snapshot.engineStateVersion, ENGINE_STATE_VERSION);
});

test('engine snapshot round-trips called and terminal states immutably', () => {
  const called = newSession();
  applyMappingEvent(called, {
    status: 'VALID', upTokenId: 'up-token', downTokenId: 'down-token',
    now: 1_700_000_000_000, remS: 250,
  });
  for (let i = 0; i < 3; i += 1) {
    tick(called, {
      now: 1_700_000_000_000 + i * 1_000,
      sinceOpen: 1_000,
      price: 50_020,
      cushion: 20,
      remS: 250 - i,
      polyMid: 0.85,
      bimb: 0,
      pimb: 0,
      vol1m: 20,
      marketSupported: true,
    });
  }
  assert.equal(restoreSession(serializeSession(called)).outcomeShadow.call, 'UP');

  const terminal = newSession();
  applyResumeInvalid(terminal);
  const restoredTerminal = restoreSession(serializeSession(terminal));
  assert.equal(restoredTerminal.outcomeShadow.status, 'NO_CALL');
  assert.equal(restoredTerminal.outcomeShadow.reason, 'RESUME_STATE_INVALID');
});

test('invalid versions and malformed state are rejected instead of partially restored', () => {
  assert.throws(() => restoreSession(null), /snapshot/i);
  assert.throws(() => restoreSession({ engineStateVersion: 'v0', state: {} }), /version/i);
  assert.throws(() => restoreSession({ engineStateVersion: ENGINE_STATE_VERSION, state: { openHist: [] } }), /structure/i);
  const contradictory = serializeSession(newSession());
  contradictory.state.outcomeShadow.status = 'CALLED';
  contradictory.state.outcomeShadow.terminal = false;
  contradictory.state.outcomeShadow.call = null;
  assert.throws(() => restoreSession(contradictory), /structure/i);
  const invalidMapping = serializeSession(newSession());
  invalidMapping.state.outcomeShadow.mappingStatus = 'VALID';
  assert.throws(() => restoreSession(invalidMapping), /structure/i);
});

test('invalid resume leaves V8 and nowcast usable while permanently disabling Outcome Shadow', () => {
  const session = newSession();
  applyResumeInvalid(session);
  const result = feed(session);
  assert.equal(result.decision.sig, 'UP');
  assert.equal(result.v9.nowcast.side, 'UP');
  assert.equal(result.v9.outcomeShadow.status, 'NO_CALL');
  assert.equal(result.v9.outcomeShadow.reason, 'RESUME_STATE_INVALID');
});

test('settlement summary uses the canonical tie rule and nulls correctness on explicit conflict', () => {
  assert.deepEqual(settlementSummary({
    open: 100, close: 100, lastNowcastSide: 'UP', outcomeCall: 'DOWN',
  }), {
    settled: 'UP', settlementConflict: false,
    lastNowcastCorrect: true, outcomeCallCorrect: false,
  });
  assert.deepEqual(settlementSummary({
    open: 100, close: 99, explicitSettlement: 'UP', lastNowcastSide: 'DOWN', outcomeCall: 'DOWN',
  }), {
    settled: 'DOWN', settlementConflict: true,
    lastNowcastCorrect: null, outcomeCallCorrect: null,
  });
});

test('resume sequence accepts pre-engine rows without quote cycles and rejects duplicate identities', () => {
  const rows = [
    { session_tick_seq: 1, quote_cycle_id: null },
    { session_tick_seq: 2, quote_cycle_id: 1 },
  ];
  assert.equal(validateResumeSequence({
    rows, sessionTickSeq: 2, latestQuoteCycleId: 1,
    counters: { up: 1, down: 0, mixed: 1, last: 'UP', locked: false, reversal: false },
  }), true);
  assert.equal(validateResumeSequence({
    rows: [...rows, { session_tick_seq: 2, quote_cycle_id: 2 }],
    sessionTickSeq: 2, latestQuoteCycleId: 2,
    counters: { up: 1, down: 0, mixed: 2, last: 'UP', locked: false, reversal: false },
  }), false);
  assert.equal(validateResumeSequence({
    rows: [{ session_tick_seq: 1, quote_cycle_id: null }, { session_tick_seq: 3, quote_cycle_id: 1 }],
    sessionTickSeq: 3, latestQuoteCycleId: 1,
    counters: { up: 1, down: 0, mixed: 1, last: 'UP', locked: false, reversal: false },
  }), false);
  assert.equal(validateResumeSequence({
    rows: [{ session_tick_seq: 2, quote_cycle_id: 1 }, { session_tick_seq: 1, quote_cycle_id: 2 }],
    sessionTickSeq: 2, latestQuoteCycleId: 2,
    counters: { up: 1, down: 0, mixed: 1, last: 'UP', locked: false, reversal: false },
  }), false);
});

test('production dashboard is isolated, uses V9 identities, updates tick rows, and contains the stable schema', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const html = readFileSync(join(here, '..', 'updown-liquidity-overlap-v9.html'), 'utf8');
  assert.match(html, /from '\.\/src\/signals\.mjs\?v=v9-1'/);
  assert.doesNotMatch(html, /from ['"][^'"]*v8(?:\.2)?\//i);
  assert.match(html, /updownV9_log_/);
  assert.match(html, /updownV9_state_/);
  assert.match(html, /_v9_log\.json/);
  assert.match(html, /session\.slug\+'_v9'/);
  assert.doesNotMatch(html, /Promise\.all\s*\(/);
  assert.match(html, /session\.log\.find\(r=>r\.session_tick_seq===cycle\.tickSequence/);
  assert.match(html, /st===session&&session\.running/);
  assert.match(html, /outcomeAbortControllers:new Set\(\)/);
  assert.match(html, /requestAbortControllers:new Set\(\)/);
  assert.match(html, /try\{await tickBody\(session\);\}finally\{session\._inTick=false;\}/);
  assert.doesNotMatch(html, /finally\s*\{\s*if\(st\)st\._inTick=false/);
  assert.match(html, /if\(result\.changed\|\|result\.callCreated\)/);
  assert.match(html, /function validatedSnapshot\(/);
  assert.match(html, /launchLatestPendingQuoteCycle\(session\)/);
  for (const field of [
    'v9_directional_side', 'v9_directional_run_age_ticks', 'v9_directional_run_age_ms',
    'v9_nowcast_side', 'v9_nowcast_phase', 'v9_nowcast_reason', 'v9_recency_balance',
    'outcome_status', 'outcome_call', 'outcome_reason', 'decision_signal_side_mid',
    'up_best_bid', 'up_best_ask', 'up_bid_size', 'up_ask_size', 'up_mid',
    'down_best_bid', 'down_best_ask', 'down_bid_size', 'down_ask_size', 'down_mid',
    'session_tick_seq', 'quote_cycle_id', 'engine_state_version', 'resume_degraded',
  ]) assert.match(html, new RegExp(`\\b${field}\\b`), field);
  assert.doesNotMatch(html, /\b(createOrder|placeOrder|walletConnect|simulateTrade|betSizing|tradeRecommendation)\b/i);
});
