import assert from 'node:assert/strict';
import test from 'node:test';

import { newSession, tick } from '../src/signals.mjs';

const BASE_MS = 1_700_000_000_000;

function feed(session, {
  now = BASE_MS,
  rem = 150,
  cushion = 20,
  vol1m = 20,
  supported = true,
  extra = {},
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
    polyMid: 0.5,
    marketSupported: supported,
    ...extra,
  });
}

test('directional runs include the current tick, reverse at one, and MIXED resets', () => {
  const session = newSession();
  assert.equal(feed(session, { cushion: 20 }).v9.directional.runAgeTicks, 1);
  assert.equal(feed(session, { now: BASE_MS + 1_000, cushion: 20 }).v9.directional.runAgeTicks, 2);

  const reversed = feed(session, { now: BASE_MS + 2_000, cushion: -20 });
  assert.deepEqual(reversed.v9.directional, {
    side: 'DOWN',
    runAgeTicks: 1,
    runAgeMs: 0,
    changeCount: 1,
  });

  const mixed = feed(session, { now: BASE_MS + 3_000, cushion: 1 });
  assert.equal(mixed.v9.directional.side, null);
  assert.equal(mixed.v9.directional.runAgeTicks, 0);
  assert.equal(mixed.v9.directional.runAgeMs, 0);
  assert.equal(feed(session, { now: BASE_MS + 4_000, cushion: 20 }).v9.directional.runAgeTicks, 1);
});

test('nowcast mirrors only the current V8 lead and abstains immediately on MIXED', () => {
  const session = newSession();
  const up = feed(session, { cushion: 20 });
  assert.equal(up.decision.sig, 'UP');
  assert.equal(up.v9.nowcast.side, 'UP');
  assert.equal(up.v9.nowcast.reason, 'CURRENT_V8_UP');
  assert.equal(up.v9.nowcast.firstSeen, true);
  assert.equal(up.v9.nowcast.changed, false);

  const mixed = feed(session, { now: BASE_MS + 1_000, cushion: 1 });
  assert.equal(mixed.decision.sig, 'MIXED');
  assert.equal(mixed.v9.nowcast.side, null);
  assert.equal(mixed.v9.nowcast.phase, 'NO_FORECAST_MIXED');
  assert.equal(mixed.v9.nowcast.changed, true);

  const down = feed(session, {
    now: BASE_MS + 2_000,
    cushion: -20,
    extra: { upCount: 10_000, downCount: 0, v9RecencyBalance: 1 },
  });
  assert.equal(down.decision.sig, 'DOWN');
  assert.equal(down.v9.nowcast.side, 'DOWN');
  assert.equal(down.v9.nowcast.changed, true);
  assert.equal(down.v9.nowcast.changeCount, 2);
});

test('nowcast phases honor every raw-time boundary', () => {
  const cases = [
    [120.001, 'DEVELOPING'],
    [120, 'STRONG_WINDOW'],
    [60.001, 'STRONG_WINDOW'],
    [60, 'LATE_NOWCAST'],
    [30, 'LATE_NOWCAST'],
    [10.001, 'LATE_NOWCAST'],
    [10, 'FINAL_NOWCAST'],
    [0, 'FINAL_NOWCAST'],
  ];
  for (const [rem, phase] of cases) {
    assert.equal(feed(newSession(), { rem }).v9.nowcast.phase, phase, `rem=${rem}`);
  }
});

test('unsupported markets retain V8 Lead but disable Settlement Nowcast', () => {
  const result = feed(newSession(), { supported: false, cushion: 20 });
  assert.equal(result.decision.sig, 'UP');
  assert.equal(result.v9.nowcast.side, null);
  assert.equal(result.v9.nowcast.reason, 'UNSUPPORTED_MARKET');
});

test('ten-second half-life telemetry decays by elapsed milliseconds and never gates direction', () => {
  const session = newSession();
  const first = feed(session, { cushion: 20 });
  assert.equal(first.v9.recency.upWeight, 1);
  assert.equal(first.v9.recency.downWeight, 0);
  assert.equal(first.v9.recency.balance, 1);

  const second = feed(session, { now: BASE_MS + 10_000, cushion: -20 });
  assert.equal(second.v9.recency.upWeight, 0.5);
  assert.equal(second.v9.recency.downWeight, 1);
  assert.ok(Math.abs(second.v9.recency.balance + (1 / 3)) < 1e-12);
  assert.equal(second.v9.nowcast.side, 'DOWN');
});
