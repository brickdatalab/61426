// v8/test/signals.test.mjs — inherited v7s early-call suite (channel must be unchanged)
// + the v8 per-tick stream (decideV8) units + the pain-case fixture replays.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { newSession, tick, CFG, decideV8, convictionOf } from '../src/signals.mjs';

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

test('stream present and shape intact (decision/momentum/flip + legacySig)', () => {
  const s = newSession();
  const out = feed(s, 250, MID_IN);
  assert.ok(out.decision && ['UP','DOWN','MIXED'].includes(out.decision.sig));
  assert.ok(['UP','DOWN','MIXED'].includes(out.decision.legacySig));
  assert.ok(out.momentum && out.flip);
});

// ---------------- v8 per-tick stream (decideV8) ----------------

test('decideV8: calls the cushion side at/above the vol floor, MIXED below', () => {
  const s = newSession();
  // vol1m=20 -> floor = max(10, 10) = 10
  assert.equal(decideV8(s, { cushion: 12, vol1m: 20 }).sig, 'UP');
  assert.equal(decideV8(s, { cushion: -12, vol1m: 20 }).sig, 'DOWN');
  assert.equal(decideV8(s, { cushion: 9.9, vol1m: 20 }).sig, 'MIXED');
  assert.equal(decideV8(s, { cushion: 0, vol1m: 20 }).sig, 'MIXED');
});

test('decideV8: floor scales with vol (0.5*vol_1m above the $10 base)', () => {
  const s = newSession();
  // vol1m=100 -> floor = 50
  assert.equal(decideV8(s, { cushion: 49, vol1m: 100 }).sig, 'MIXED');
  assert.equal(decideV8(s, { cushion: 51, vol1m: 100 }).sig, 'UP');
  assert.equal(decideV8(s, { cushion: 51, vol1m: 100 }).floor, 50);
});

test('decideV8: null cushion carries last sig; never fabricates a call', () => {
  const s = newSession();
  assert.equal(decideV8(s, { cushion: null, vol1m: 20 }).sig, 'MIXED');
  decideV8(s, { cushion: 60, vol1m: 20 });
  assert.equal(decideV8(s, { cushion: null, vol1m: 20 }).sig, 'UP');
});

test('decideV8: the -166/-1.2M pain shape can never be MIXED', () => {
  const s = newSession();
  const r = decideV8(s, { cushion: -166, vol1m: 120 });   // floor = 60
  assert.equal(r.sig, 'DOWN');
});

// ---------------- v8 conviction tier (display/logging only) ----------------

test('conviction metadata does not gate or change the v8 signal', () => {
  const s = newSession();
  const out = tick(s, {
    now: 1700000000000,
    sinceOpen: 1000,
    price: 50020,
    cushion: 20,
    remS: 60,
    vol1m: 20,
    polyMid: 0.4,    // poly disagrees with UP; conviction drops but sig remains UP
  });
  assert.equal(out.decision.sig, 'UP');
  assert.ok(out.decision.conv);
  assert.equal(out.decision.conv.tier, 2);
  assert.match(out.decision.conv.why, /poly not agreeing/);
});

test('MIXED ticks have no conviction tier', () => {
  const s = newSession();
  const out = tick(s, {
    now: 1700000000000,
    sinceOpen: 1000,
    price: 50005,
    cushion: 5,
    remS: 60,
    vol1m: 20,
    polyMid: 0.7,
  });
  assert.equal(out.decision.sig, 'MIXED');
  assert.equal(out.decision.conv, null);
});

test('conviction tier 3 requires all five measured points', () => {
  const s = newSession();
  const out = tick(s, {
    now: 1700000000000,
    sinceOpen: 1000,
    price: 50100,
    cushion: 100,
    remS: 60,
    vol1m: 20,
    polyMid: 0.7,
  });
  assert.equal(out.decision.sig, 'UP');
  assert.deepEqual(out.decision.conv, { tier: 3, pts: 5, why: '' });

  const missingPoly = convictionOf(newSession(), {
    cushion: 100,
    vol1m: 20,
    polyMid: null,
  }, 'UP', 0.1);
  assert.equal(missingPoly.tier, 2);
  assert.equal(missingPoly.pts, 4);
  assert.match(missingPoly.why, /poly not agreeing/);
});

test('current-tick directional reversal loses the no-reversal conviction point', () => {
  const s = newSession();
  tick(s, {
    now: 1700000000000,
    sinceOpen: 1000,
    price: 50100,
    cushion: 100,
    remS: 60,
    vol1m: 20,
    polyMid: 0.7,
  });
  const out = tick(s, {
    now: 1700001000000,
    sinceOpen: 1000,
    price: 49900,
    cushion: -100,
    remS: 59,
    vol1m: 20,
    polyMid: 0.3,
  });
  assert.equal(out.decision.sig, 'DOWN');
  assert.equal(out.decision.conv.tier, 2);
  assert.equal(out.decision.conv.pts, 4);
  assert.match(out.decision.conv.why, /1 reversal/);
});

test('elevated flip risk lowers conviction without changing the displayed side', () => {
  const sig = decideV8(newSession(), { cushion: 100, vol1m: 20 }).sig;
  const conv = convictionOf(newSession(), {
    cushion: 100,
    vol1m: 20,
    polyMid: 0.7,
  }, sig, 0.7);
  assert.equal(sig, 'UP');
  assert.equal(conv.tier, 2);
  assert.equal(conv.pts, 4);
  assert.match(conv.why, /flip-risk/);
});

// ---------------- pain-case fixture replays (real bars, real engine) ----------------
// Both bars are documented pain cases (v8/analysis: |cushion|>=150, >=1M same-side CVD,
// v6 lean stream said MIXED at the pain tick). v8's stream must call the evidence side.
const HERE = dirname(fileURLToPath(import.meta.url));
function replayFixture(name) {
  const d = JSON.parse(readFileSync(join(HERE, 'fixtures', name), 'utf8'));
  const srow = d.rows.find(r => r.settled); const body = d.rows.filter(r => !r.settled);
  const s = newSession();
  let t = 1700000000000;
  const sigAtRem = {};
  for (const r of body) {
    t += 1000;
    const price = r.cushion != null && srow.open != null ? srow.open + r.cushion : null;
    const res = tick(s, { now: t, sinceOpen: r.cvd_since_open, price,
      bimb: r.btc_imb, pimb: r.poly_imb, cushion: r.cushion, remS: r.rem,
      vol1m: r.vol_1m ?? null, largePrints: r.large_prints ?? null,
      efficiency: r.efficiency ?? null, perpSpotDiv: r.perp_spot_div ?? null,
      cvd3m: r.cvd_d3m ?? null, polyMid: r.poly_mid ?? null });
    if (res) sigAtRem[r.rem] = { sig: res.decision.sig, legacy: res.decision.legacySig };
  }
  return { settle: srow.settled, sigAtRem };
}

test('pain fixture 1783341600 (cushion -197.8, cvd -8.2M at rem 35): v8 calls DOWN where v6 sat MIXED', () => {
  const { settle, sigAtRem } = replayFixture('btc-updown-5m-1783341600_bq.json');
  assert.equal(settle, 'DOWN');
  const at = sigAtRem[35];
  assert.ok(at, 'tick at rem 35 exists');
  assert.equal(at.legacy, 'MIXED');       // the documented v6 failure
  assert.equal(at.sig, 'DOWN');           // v8 calls the screaming evidence
});

test('pain fixture 1783290000 (cushion +203.1, cvd +11.3M at rem 250): v8 calls UP where v6 sat MIXED', () => {
  const { settle, sigAtRem } = replayFixture('btc-updown-5m-1783290000_bq.json');
  assert.equal(settle, 'UP');
  const at = sigAtRem[250];
  assert.ok(at, 'tick at rem 250 exists');
  assert.equal(at.legacy, 'MIXED');
  assert.equal(at.sig, 'UP');
});
