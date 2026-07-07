// v7s/test/signals.test.mjs — the standard early-call channel + engine smoke.
import test from 'node:test';
import assert from 'node:assert';
import { newSession, tick, CFG } from '../src/signals.mjs';

const LO = CFG.EARLY_P_LO, HI = CFG.EARLY_P_HI;
const MID_IN = (LO + Math.min(HI, LO + 0.04)) / 2;      // safely inside the band
function feed(s, rem, polyMid, cushion = 5, extra = {}) {
  return tick(s, { now: 1700000000000 + (300 - rem) * 1000, sinceOpen: 1000, price: 50000 + (cushion ?? 0),
    cushion, remS: rem, polyMid, bimb: 0.1, pimb: 0.1, vol1m: 20, ...extra });
}

test('fires ' + 'standard' + ' after dwell inside the band, latches immutably', () => {
  const s = newSession();
  assert.equal(feed(s, 260, MID_IN).early, null);           // window not open yet
  assert.equal(feed(s, 250, MID_IN).early, null);           // dwell 1
  assert.equal(feed(s, 249, MID_IN).early, null);           // dwell 2
  const r = feed(s, 248, MID_IN).early;                     // dwell 3 -> latch
  assert.ok(r); assert.equal(r.side, 'UP'); assert.equal(r.tier, 'standard');
  assert.ok(Math.abs(r.price - MID_IN) < 0.001);
  const r2 = feed(s, 240, 0.5).early;                       // immutable after latch
  assert.deepEqual(r2, r);
});

test('DOWN side: polyMid below 0.5 fires DOWN with negative cushion', () => {
  const s = newSession();
  const m = 1 - MID_IN;
  feed(s, 250, m, -5); feed(s, 249, m, -5);
  const r = feed(s, 248, m, -5).early;
  assert.ok(r); assert.equal(r.side, 'DOWN');
});

test('transient flicker (2 ticks) does not fire; run resets', () => {
  const s = newSession();
  feed(s, 250, MID_IN); feed(s, 249, MID_IN);
  feed(s, 248, 0.5);                                        // leaves band -> reset
  feed(s, 247, MID_IN); feed(s, 246, MID_IN);
  assert.equal(feed(s, 245, 0.5).early, null);
});

test('out-of-band prices never fire (below LO, above HI)', () => {
  const s = newSession();
  for (let rem = 254; rem >= 211; rem--) feed(s, rem, LO - 0.03);
  assert.equal(s.earlyCall, null);
  const s2 = newSession();
  for (let rem = 254; rem >= 211; rem--) feed(s2, rem, Math.min(HI + 0.02, 0.979));
  assert.equal(s2.earlyCall, null);
});

test('abstains permanently once past the hard deadline', () => {
  const s = newSession();
  for (let rem = 254; rem >= 211; rem--) feed(s, rem, 0.5); // nothing qualifies in window
  assert.equal(feed(s, 205, MID_IN).early, null);           // past deadline -> abstain latch
  assert.equal(s.earlyAbstain, true);
  feed(s, 204, MID_IN); feed(s, 203, MID_IN);
  assert.equal(feed(s, 202, MID_IN).early, null);           // still abstained
});

test('cushion disagreeing with the call blocks; null cushion allowed', () => {
  const s = newSession();
  feed(s, 250, MID_IN, -8); feed(s, 249, MID_IN, -8); feed(s, 248, MID_IN, -8);
  assert.equal(s.earlyCall, null);                          // UP call vs negative cushion
  const s2 = newSession();
  feed(s2, 250, MID_IN, null); feed(s2, 249, MID_IN, null);
  const r = feed(s2, 248, MID_IN, null).early;
  assert.ok(r); assert.equal(r.side, 'UP');
});

test('degenerate poly reads are rejected by the sanity gate', () => {
  const s = newSession();
  feed(s, 250, 0.99); feed(s, 249, 0.99); feed(s, 248, 0.99);
  assert.equal(s.earlyCall, null);
});

test('late flag set when the session joins after the window opened', () => {
  const s = newSession();
  feed(s, 240, MID_IN); feed(s, 239, MID_IN);
  const r = feed(s, 238, MID_IN).early;
  assert.ok(r); assert.equal(r.late, true);
});

test('lean stream present and unchanged shape (decision/momentum/flip)', () => {
  const s = newSession();
  const out = feed(s, 250, MID_IN);
  assert.ok(out.decision && ['UP','DOWN','MIXED'].includes(out.decision.sig));
  assert.ok(out.momentum && out.flip);
});
