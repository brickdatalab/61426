import assert from 'node:assert/strict';
import test from 'node:test';
import { newSession, tick } from '../src/signals.mjs';

function feed(session, {
  rem,
  cushion = 20,
  vol1m = 20,
  polyMid = 0.5,
  outcome = {},
  now = 1_700_000_000_000,
} = {}) {
  return tick(session, {
    now,
    sinceOpen: 1_000,
    price: 50_000 + cushion,
    bimb: 0,
    pimb: 0,
    largePrints: 0,
    efficiency: 1,
    perpSpotDiv: 0,
    cvd3m: 0,
    cushion,
    remS: rem,
    vol1m,
    polyMid,
    outcome,
  });
}

test('confirmed discounted call latches on the 30th directional tick', () => {
  const session = newSession();
  for (let i = 0; i < 29; i += 1) {
    feed(session, {
      rem: 150,
      now: 1_700_000_000_000 + i * 1_000,
      outcome: {
        supported: true,
        mapping: 'ready',
      },
    });
  }
  const result = feed(session, {
    rem: 104,
    now: 1_700_000_030_000,
    outcome: {
      supported: true,
      mapping: 'ready',
      quoteReceivedRem: 104,
      up: { valid: true, mid: 0.68 },
      down: { valid: true, mid: 0.32 },
    },
  });
  assert.equal(result.decision.sig, 'UP');
  assert.equal(result.outcome_shadow.call, 'UP');
  assert.equal(result.outcome_shadow.branch, 'CONFIRMED_DISCOUNTED');
  assert.equal(result.outcome_shadow.eligible, true);
  assert.equal(result.outcome_shadow.runAgeTicks, 30);
});

test('MIXED lead terminally abstains on the first valid mapped checkpoint quote', () => {
  const result = feed(newSession(), {
    rem: 104,
    cushion: 1,
    outcome: { supported: true, mapping: 'ready', quoteReceivedRem: 104, up: { valid: true, mid: 0.6 } },
  });
  assert.equal(result.outcome_shadow.call, null);
  assert.equal(result.outcome_shadow.reason, 'NON_DIRECTIONAL_SIGNAL');
  assert.equal(result.outcome_shadow.terminal, true);
});

test('invalid predicted-side quote waits and becomes NO_USABLE_QUOTE only after 100 seconds', () => {
  const session = newSession();
  const waiting = feed(session, {
    rem: 104,
    outcome: { supported: true, mapping: 'ready', quoteReceivedRem: 104, down: { valid: true, mid: 0.3 } },
  });
  assert.equal(waiting.outcome_shadow.reason, 'WAITING_CHECKPOINT');
  const final = feed(session, { rem: 99, now: 1_700_000_001_000, outcome: { supported: true, mapping: 'ready' } });
  assert.equal(final.outcome_shadow.reason, 'NO_USABLE_QUOTE');
});

test('early call wins and remains immutable after a later reversal', () => {
  const session = newSession();
  let result;
  for (const rem of [250, 249, 248]) {
    result = feed(session, {
      rem,
      cushion: 20,
      polyMid: 0.85,
      now: 1_700_000_000_000 + (250 - rem) * 1_000,
      outcome: { supported: true, mapping: 'ready', up: { valid: true, mid: 0.85 }, down: { valid: true, mid: 0.15 } },
    });
  }
  assert.equal(result.outcome_shadow.call, 'UP');
  assert.equal(result.outcome_shadow.branch, 'EARLY');
  const later = feed(session, { rem: 104, cushion: -20, now: 1_700_000_010_000, outcome: { supported: true, mapping: 'ready', quoteReceivedRem: 104, down: { valid: true, mid: 0.68 } } });
  assert.equal(later.decision.sig, 'DOWN');
  assert.equal(later.outcome_shadow.call, 'UP');
  assert.equal(later.outcome_shadow.eligible, false);
});
