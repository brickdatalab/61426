import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CFG,
  applyMappingEvent,
  applyOutcomeDeadline,
  applyOutcomeQuoteEvent,
  beginQuoteCycle,
  mapOutcomeTokens,
  newSession,
  normalizeOutcomeQuote,
  tick,
} from '../src/signals.mjs';

const BASE_MS = 1_700_000_000_000;

function feed(session, {
  now = BASE_MS,
  rem = 150,
  cushion = 20,
  polyMid = 0.5,
  supported = true,
} = {}) {
  return tick(session, {
    now, sinceOpen: 1_000, price: 50_000 + cushion,
    bimb: 0, pimb: 0, largePrints: 0, efficiency: 1,
    perpSpotDiv: 0, cvd3m: 0, cushion, remS: rem, vol1m: 20,
    polyMid, marketSupported: supported,
  });
}

function validQuote(mid = 0.68) {
  return {
    valid: true,
    bestBid: mid - 0.01,
    bestAsk: mid + 0.01,
    bidSize: 12,
    askSize: 15,
    mid,
    exchangeTimestamp: null,
    receivedTimestamp: BASE_MS,
    latencyMs: 25,
  };
}

function prepareDirectionalSession(ticks = 30, side = 'UP') {
  const session = newSession();
  applyMappingEvent(session, {
    status: 'VALID', remS: 150, now: BASE_MS,
    upTokenId: 'up-token', downTokenId: 'down-token',
  });
  for (let i = 0; i < ticks; i += 1) {
    feed(session, {
      now: BASE_MS + i * 1_000,
      rem: 150 - i,
      cushion: side === 'UP' ? 20 : -20,
    });
  }
  return session;
}

test('declared outcome labels map token IDs without relying on array order', () => {
  assert.deepEqual(
    mapOutcomeTokens(['down', 'UP'], ['down-token', 'up-token']),
    { status: 'VALID', upTokenId: 'up-token', downTokenId: 'down-token' },
  );
  assert.equal(mapOutcomeTokens(['UP', 'UP'], ['a', 'b']).status, 'DETERMINISTIC_FAILURE');
  assert.equal(mapOutcomeTokens('["UP","DOWN"]', '["same","same"]').status, 'DETERMINISTIC_FAILURE');
  assert.equal(mapOutcomeTokens(['UP', 'DOWN', 'TIE'], ['a', 'b', 'c']).status, 'DETERMINISTIC_FAILURE');
  assert.equal(mapOutcomeTokens(['UP', 'DOWN'], ['a', 123]).status, 'DETERMINISTIC_FAILURE');
});

test('quote normalization uses executable levels and rejects partial or crossed books', () => {
  const quote = normalizeOutcomeQuote({
    bids: [{ price: '0.64', size: '7' }, { price: '0.66', size: '12' }],
    asks: [{ price: '0.70', size: '9' }, { price: '0.68', size: '15' }],
    timestamp: 12345,
  }, { receivedTimestamp: BASE_MS, latencyMs: 31 });
  assert.deepEqual(quote, {
    valid: true,
    bestBid: 0.66,
    bestAsk: 0.68,
    bidSize: 12,
    askSize: 15,
    mid: 0.67,
    exchangeTimestamp: 12345,
    receivedTimestamp: BASE_MS,
    latencyMs: 31,
  });
  assert.equal(normalizeOutcomeQuote({ bids: [], asks: [] }).valid, false);
  assert.equal(normalizeOutcomeQuote({ bids: [{ price: 0.7, size: 1 }], asks: [{ price: 0.6, size: 1 }] }).valid, false);
  assert.equal(normalizeOutcomeQuote({ bids: [{ price: 0.6, size: 0 }], asks: [{ price: 0.7, size: 1 }] }).valid, false);
});

test('confirmed discounted calls exactly on run tick 30 and midpoint 0.75', () => {
  const session = prepareDirectionalSession(30, 'UP');
  beginQuoteCycle(session, { quoteCycleId: 1, requestStartedMs: BASE_MS + 30_000 });
  const event = applyOutcomeQuoteEvent(session, {
    quoteCycleId: 1, responseSide: 'UP', receiptMs: BASE_MS + 30_050,
    receiptRemS: 105, leadSnapshot: 'UP', runAgeSnapshot: 30,
    tickSequence: 30, upQuote: validQuote(0.75), downQuote: null,
  });
  assert.equal(event.changed, true);
  assert.equal(event.callCreated, true);
  assert.equal(event.outcome.status, 'CALLED');
  assert.equal(event.outcome.call, 'UP');
  assert.equal(event.outcome.branch, 'CONFIRMED_DISCOUNTED');
  assert.equal(event.outcome.reason, 'CONFIRMED_DISCOUNTED');
  assert.equal(event.outcome.decisionSignalSideMid, 0.75);
  assert.equal(event.outcome.eligible, true);
  assert.equal(event.outcome.firstSeen, true);
});

test('first valid predicted-side quote is terminal when run is short or price is high', () => {
  for (const [runAgeSnapshot, mid, reason] of [
    [29, 0.7, 'RUN_TOO_SHORT'],
    [30, 0.750001, 'MARKET_PRICED_ABOVE_LIMIT'],
  ]) {
    const session = prepareDirectionalSession(runAgeSnapshot, 'UP');
    beginQuoteCycle(session, { quoteCycleId: 1, requestStartedMs: BASE_MS });
    const result = applyOutcomeQuoteEvent(session, {
      quoteCycleId: 1, responseSide: 'UP', receiptMs: BASE_MS,
      receiptRemS: 100, leadSnapshot: 'UP', runAgeSnapshot,
      upQuote: validQuote(mid), tickSequence: runAgeSnapshot,
    });
    assert.equal(result.outcome.status, 'NO_CALL');
    assert.equal(result.outcome.reason, reason);
    assert.equal(result.outcome.terminal, true);
  }
});

test('directional checkpoint ignores the opposite side and waits through invalid predicted quotes', () => {
  const session = prepareDirectionalSession(30, 'DOWN');
  beginQuoteCycle(session, { quoteCycleId: 1, requestStartedMs: BASE_MS });
  const opposite = applyOutcomeQuoteEvent(session, {
    quoteCycleId: 1, responseSide: 'UP', receiptMs: BASE_MS,
    receiptRemS: 104, leadSnapshot: 'DOWN', runAgeSnapshot: 30,
    upQuote: validQuote(0.3), tickSequence: 30,
  });
  assert.equal(opposite.outcome.status, 'PENDING');

  const invalidPredicted = applyOutcomeQuoteEvent(session, {
    quoteCycleId: 1, responseSide: 'DOWN', receiptMs: BASE_MS + 10,
    receiptRemS: 104, leadSnapshot: 'DOWN', runAgeSnapshot: 30,
    downQuote: { valid: false }, tickSequence: 30,
  });
  assert.equal(invalidPredicted.outcome.status, 'PENDING');
  assert.equal(feed(session, { now: BASE_MS + 31_000, rem: 99, cushion: -20 }).v9.outcomeShadow.reason, 'NO_USABLE_QUOTE');
});

test('MIXED checkpoint terminally abstains on first valid mapped quote from either side', () => {
  const session = prepareDirectionalSession(1, 'UP');
  feed(session, { now: BASE_MS + 2_000, rem: 104, cushion: 1 });
  beginQuoteCycle(session, { quoteCycleId: 2, requestStartedMs: BASE_MS + 2_000 });
  const result = applyOutcomeQuoteEvent(session, {
    quoteCycleId: 2, responseSide: 'DOWN', receiptMs: BASE_MS + 2_020,
    receiptRemS: 104, leadSnapshot: 'MIXED', runAgeSnapshot: 0,
    downQuote: validQuote(0.45), tickSequence: 2,
  });
  assert.equal(result.outcome.status, 'NO_CALL');
  assert.equal(result.outcome.reason, 'NON_DIRECTIONAL_SIGNAL');
});

test('early call waits for mapping, promotes original decision values, and stays immutable', () => {
  const session = newSession();
  let result;
  for (let i = 0; i < CFG.EARLY_DWELL; i += 1) {
    result = feed(session, { now: BASE_MS + i * 1_000, rem: 250 - i, cushion: 20, polyMid: 0.85 });
  }
  assert.equal(result.early.side, 'UP');
  assert.equal(result.v9.outcomeShadow.status, 'PENDING');
  assert.equal(result.v9.outcomeShadow.call, null);

  const promoted = applyMappingEvent(session, {
    status: 'VALID', remS: 240, now: BASE_MS + 10_000,
    upTokenId: 'up-token', downTokenId: 'down-token',
  });
  assert.equal(promoted.outcome.status, 'CALLED');
  assert.equal(promoted.outcome.call, 'UP');
  assert.equal(promoted.outcome.branch, 'EARLY');
  assert.equal(promoted.outcome.decisionRem, 248);
  assert.equal(promoted.outcome.decisionTimestamp, BASE_MS + 2_000);
  assert.equal(promoted.outcome.decisionSignalSideMid, 0.85);
  assert.equal(promoted.outcome.firstSeen, true);

  feed(session, { now: BASE_MS + 11_000, rem: 104, cushion: -20 });
  assert.equal(session.outcomeShadow.call, 'UP');
});

test('mapping failure precedence, checkpoint miss, unsupported, duplicate and stale events are immutable', () => {
  const mappingFailure = newSession();
  applyMappingEvent(mappingFailure, { status: 'DETERMINISTIC_FAILURE', remS: 150, now: BASE_MS });
  assert.equal(mappingFailure.outcomeShadow.reason, 'TOKEN_MAPPING_FAILED');

  const missed = feed(newSession(), { rem: 99 });
  assert.equal(missed.v9.outcomeShadow.reason, 'CHECKPOINT_MISSED');

  const unsupported = feed(newSession(), { supported: false });
  assert.equal(unsupported.v9.outcomeShadow.status, 'NO_CALL');
  assert.equal(unsupported.v9.outcomeShadow.reason, 'UNSUPPORTED_MARKET');

  const session = prepareDirectionalSession(30, 'UP');
  beginQuoteCycle(session, { quoteCycleId: 4, requestStartedMs: BASE_MS });
  const stale = applyOutcomeQuoteEvent(session, {
    quoteCycleId: 3, responseSide: 'UP', receiptMs: BASE_MS, receiptRemS: 104,
    leadSnapshot: 'UP', runAgeSnapshot: 30, upQuote: validQuote(), tickSequence: 30,
  });
  assert.equal(stale.ignored, 'STALE_CYCLE');
  const call = applyOutcomeQuoteEvent(session, {
    quoteCycleId: 4, responseSide: 'UP', receiptMs: BASE_MS, receiptRemS: 104,
    leadSnapshot: 'UP', runAgeSnapshot: 30, upQuote: validQuote(), tickSequence: 30,
  });
  assert.equal(call.callCreated, true);
  assert.equal(applyOutcomeQuoteEvent(session, {
    quoteCycleId: 4, responseSide: 'UP', receiptMs: BASE_MS + 1, receiptRemS: 104,
    leadSnapshot: 'DOWN', runAgeSnapshot: 30, upQuote: validQuote(0.2), tickSequence: 30,
  }).ignored, 'TERMINAL');
});

test('deadline precedence distinguishes mapping, quote, and first-open failures', () => {
  const pendingMapping = newSession();
  assert.equal(applyOutcomeDeadline(pendingMapping, { remS: 99 }).outcome.reason, 'TOKEN_MAPPING_FAILED');

  const lateMappingResponse = newSession();
  const lateMappingResult = applyMappingEvent(lateMappingResponse, {
    status: 'VALID', upTokenId: 'up-token', downTokenId: 'down-token', remS: 99.9, now: BASE_MS,
  });
  assert.equal(lateMappingResult.outcome.reason, 'TOKEN_MAPPING_FAILED');
  assert.equal(lateMappingResult.outcome.mappingStatus, 'DETERMINISTIC_FAILURE');
  assert.equal(lateMappingResult.outcome.upTokenId, null);

  const missingQuote = newSession();
  applyMappingEvent(missingQuote, {
    status: 'VALID', upTokenId: 'up-token', downTokenId: 'down-token', remS: 150, now: BASE_MS,
  });
  assert.equal(applyOutcomeDeadline(missingQuote, { remS: 99 }).outcome.reason, 'NO_USABLE_QUOTE');

  const firstOpen = newSession();
  assert.equal(applyOutcomeDeadline(firstOpen, { remS: 99, checkpointMissed: true }).outcome.reason, 'CHECKPOINT_MISSED');
});

test('a pending early candidate fails at its own mapping deadline and never falls through', () => {
  const session = newSession();
  for (let i = 0; i < CFG.EARLY_DWELL; i += 1) {
    feed(session, { now: BASE_MS + i * 1_000, rem: 250 - i, cushion: 20, polyMid: 0.85 });
  }
  const result = applyMappingEvent(session, {
    status: 'TRANSIENT_FAILURE', remS: CFG.EARLY_HARD_REM - 0.001, now: BASE_MS + 50_000,
  });
  assert.equal(result.callCreated, false);
  assert.equal(result.outcome.status, 'NO_CALL');
  assert.equal(result.outcome.reason, 'TOKEN_MAPPING_FAILED');
});
