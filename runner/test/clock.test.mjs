import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remFor, gapSeconds, Scheduler } from '../lib/clock.mjs';

test('remFor computes seconds to bar end, floored at 0', () => {
  const end = 1783348800 + 300;                 // bar end epoch (sec)
  assert.equal(remFor((end - 90) * 1000, end), 90);
  assert.equal(remFor((end + 5) * 1000, end), 0);
});

test('gapSeconds detects missed ticks without fabricating them', () => {
  assert.equal(gapSeconds(100, 101), 1);        // normal
  assert.equal(gapSeconds(100, 130), 30);       // 29 missed
});

test('Scheduler: normal 1s ticks emit gapSec=1 via injected time seam', () => {
  let nowMs = 100000; // sec=100
  const timers = [];
  const fakeSetTimer = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  const fakeNow = () => nowMs;

  const sched = new Scheduler({ now: fakeNow, setTimer: fakeSetTimer });
  const seen = [];
  sched.onSecond((info) => seen.push(info));
  sched.start();

  assert.equal(timers.length, 1);

  // advance to sec=101
  nowMs = 101000;
  const t1 = timers.pop();
  t1.fn();
  assert.deepEqual(seen, [{ sec: 101, gapSec: 1 }]);

  // advance to sec=102
  nowMs = 102000;
  const t2 = timers.pop();
  t2.fn();
  assert.deepEqual(seen, [{ sec: 101, gapSec: 1 }, { sec: 102, gapSec: 1 }]);
});

test('Scheduler: after stop(), the pending timer is cleared and no further cb fires', () => {
  let nowMs = 100000; // sec=100
  const timers = [];
  const cleared = [];
  const fakeSetTimer = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  const fakeClearTimer = (h) => { cleared.push(h); };
  const fakeNow = () => nowMs;

  const sched = new Scheduler({ now: fakeNow, setTimer: fakeSetTimer, clearTimer: fakeClearTimer });
  const seen = [];
  sched.onSecond((info) => seen.push(info));
  sched.start();

  const armed = timers[timers.length - 1];
  sched.stop();
  assert.deepEqual(cleared, [timers.length], 'the pending timer handle was cleared');

  // Even if the already-scheduled callback still fires, it must be a no-op and
  // must NOT re-arm.
  nowMs = 101000;
  armed.fn();
  assert.equal(seen.length, 0, 'no callback after stop');
  assert.equal(timers.length, 1, 'no further timer armed after stop');
});

test('Scheduler: a jump from sec=100 to sec=130 emits exactly one cb with gapSec=30', () => {
  let nowMs = 100000; // sec=100
  const timers = [];
  const fakeSetTimer = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  const fakeNow = () => nowMs;

  const sched = new Scheduler({ now: fakeNow, setTimer: fakeSetTimer });
  const seen = [];
  sched.onSecond((info) => seen.push(info));
  sched.start();

  // simulate a long real-clock jump (e.g. process suspended) to sec=130
  nowMs = 130000;
  const t1 = timers.pop();
  t1.fn();

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { sec: 130, gapSec: 30 });
});

test('NTP backward slew: emits strictly-increasing seconds (no dup/backward), real forward gap still marked', () => {
  // Simulates the post-reboot window: wall clock steps BACKWARD as NTP disciplines it,
  // then a genuine forward jump (downtime). now() returns the scripted value at index i.
  const seq = [1000000, 1001000, 1000400, 1001300, 1130000];
  let i = 0;
  const now = () => seq[i];
  const fired = [];
  let timerFn = null;
  const s = new Scheduler({ now, setTimer: (fn) => { timerFn = fn; return 1; }, clearTimer() {} });
  s.onSecond((x) => fired.push(x));
  s.start();                 // lastSec = 1000
  i = 1; timerFn();          // wall sec 1001 -> 1001, gap 1
  i = 2; timerFn();          // wall sec 1000 (stepped back) -> clamp 1002, gap 1
  i = 3; timerFn();          // wall sec 1001 (still behind) -> clamp 1003, gap 1
  i = 4; timerFn();          // wall sec 1130 (real forward jump) -> 1130, gap 127
  assert.deepEqual(fired.map((f) => f.sec), [1001, 1002, 1003, 1130]); // strictly increasing, no dup
  assert.equal(fired.filter((f) => f.gapSec <= 0).length, 0);          // never zero/negative (no dup ticks)
  assert.equal(fired[3].gapSec, 127);                                   // genuine gap preserved for marking
});
