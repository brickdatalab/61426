import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OwsFeed } from '../feeds/ows.mjs';

test('latest() reports null before first message and ageMs after', () => {
  let handlers = {};
  const fakeWS = () => ({ on: (e, f) => handlers[e] = f, close(){}, terminate(){} });
  const f = new OwsFeed('BTCUSDT', '5m', { wsFactory: fakeWS, now: () => 1000 });
  f.start();
  assert.equal(f.latest().tape, null);
  handlers.message(JSON.stringify({ tape: { price: 62000 } }));
  f._now = () => 1300;
  const l = f.latest();
  assert.equal(l.tape.price, 62000);
  assert.equal(l.ageMs, 300);
});

test('backoff grows then caps at 30s', () => {
  const f = new OwsFeed('BTCUSDT', '5m', {});
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(n => f._backoffMs(n)), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
});

test('perp_spot_divergence merges into tape as perp_cvd_minus_spot_cvd_5m_usd', () => {
  let handlers = {};
  const fakeWS = () => ({ on: (e, f) => handlers[e] = f, close(){}, terminate(){} });
  const f = new OwsFeed('BTCUSDT', '5m', { wsFactory: fakeWS, now: () => 500 });
  f.start();
  handlers.message(JSON.stringify({
    tape: { price: 62000 },
    perp_spot_divergence: { perp_cvd_minus_spot_cvd_5m_usd: 1234 },
  }));
  assert.equal(f.latest().tape.perp_cvd_minus_spot_cvd_5m_usd, 1234);
  assert.equal(f.latest().tape.price, 62000);
});

test('on close, schedules a reconnect via injected setTimer, and the new socket receives messages', () => {
  let wsInstances = 0;
  let handlers = {};
  const fakeWS = () => {
    wsInstances += 1;
    const h = {};
    handlers = h;
    return { on: (e, fn) => h[e] = fn, close(){}, terminate(){} };
  };
  const timers = [];
  const fakeSetTimer = (fn, ms) => { timers.push({ fn, ms }); };
  const f = new OwsFeed('BTCUSDT', '5m', { wsFactory: fakeWS, now: () => 0, setTimer: fakeSetTimer });
  f.start();
  assert.equal(wsInstances, 1);

  // simulate the socket dying
  handlers.close();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 1000); // _backoffMs(0)

  // fire the scheduled reconnect
  timers.shift().fn();
  assert.equal(wsInstances, 2);

  // the new socket delivers a message fine
  handlers.message(JSON.stringify({ tape: { price: 1 } }));
  assert.equal(f.latest().tape.price, 1);

  // a second close schedules with the grown backoff (n=1 -> 2000ms),
  // since the successful message reset backoffN to 0, so it's back to 1000... unless
  // reconnect itself doesn't reset until a message arrives after reconnect (it did above).
  handlers.close();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 1000);
});

test('malformed messages and socket errors do not throw', () => {
  let handlers = {};
  const fakeWS = () => ({ on: (e, f) => handlers[e] = f, close(){}, terminate(){} });
  const timers = [];
  const f = new OwsFeed('BTCUSDT', '5m', {
    wsFactory: fakeWS,
    now: () => 0,
    setTimer: (fn, ms) => timers.push({ fn, ms }),
  });
  f.start();
  assert.doesNotThrow(() => handlers.message('not json'));
  assert.equal(f.latest().tape, null);
  assert.doesNotThrow(() => handlers.error(new Error('boom')));
  assert.equal(timers.length, 1);
});
