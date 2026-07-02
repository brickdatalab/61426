import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newSession, tick, valAt, deltaAt, decideDebounced, flipRisk, volFromHist, phi } from '../src/signals.mjs';

const T0 = 1700000000000;
// feed a session one sample per second from arrays of sinceOpen/price values
function feed(s, sinceOpens, prices, extra = {}) {
  let out = null;
  for (let i = 0; i < sinceOpens.length; i++) {
    out = tick(s, { now: T0 + i * 1000, sinceOpen: sinceOpens[i],
                    price: prices[i] ?? 60000, ...extra });
  }
  return out;
}

test('flow deltas come from the sinceOpen accumulator — exact, no window-exit contamination', () => {
  const s = newSession();
  // +10k flow per second for 20s -> d5 = 50k, d10 = 100k
  const so = Array.from({ length: 20 }, (_, i) => (i + 1) * 10_000);
  const r = feed(s, so, so.map(() => 60000));
  assert.equal(r.flow.d5, 50_000);
  assert.equal(r.flow.d10, 100_000);
});

test('a burst 60s ago does NOT create a phantom negative d5 now (the v5 bug)', () => {
  const s = newSession();
  // big buy burst in seconds 0-5, then perfectly flat flow
  const so = [];
  for (let i = 0; i < 5; i++) so.push((i + 1) * 200_000);   // burst to 1M
  for (let i = 0; i < 70; i++) so.push(1_000_000);           // flat for 70s
  const r = feed(s, so, so.map(() => 60000));
  assert.equal(r.flow.d5, 0);   // v5's rolling-window delta would read ~-1M here
});

test('tick returns null before data arrives (connect gate)', () => {
  const s = newSession();
  assert.equal(tick(s, { now: T0, sinceOpen: null, price: 60000 }), null);
  assert.equal(tick(s, { now: T0, sinceOpen: 5000, price: null }), null);
  // and the null ticks left no history behind
  const r = tick(s, { now: T0 + 1000, sinceOpen: 5000, price: 60000 });
  assert.equal(r.flow.d5, null);   // only one sample -> no 5s-old sample yet
});

test('cush_d10 is the 10s price change', () => {
  const s = newSession();
  const prices = Array.from({ length: 15 }, (_, i) => 60000 + i * 2); // +$2/s
  const so = prices.map((_, i) => i * 1000);
  const r = feed(s, so, prices);
  assert.equal(r.cush_d10, 20);
});

test('momentum is FLAT during warmup no matter how steep the flow', () => {
  const s = newSession();
  // 30s of violent flow + rising price — inside the 60s warmup
  const so = Array.from({ length: 30 }, (_, i) => (i + 1) * 500_000);
  const prices = Array.from({ length: 30 }, (_, i) => 60000 + i * 10);
  const r = feed(s, so, prices);
  assert.equal(r.momentum.warm, false);
  assert.equal(r.momentum.dir, 'FLAT');
  assert.equal(r.momentum.z, 0);
});

test('after warmup, sustained steep flow + aligned price fires UP', () => {
  const s = newSession();
  const so = [], prices = [];
  for (let i = 0; i < 70; i++) { so.push(i * 5_000); prices.push(60000); }        // quiet baseline past warmup
  for (let i = 0; i < 15; i++) { so.push(350_000 + (i + 1) * 100_000); prices.push(60000 + (i + 1) * 4); } // surge, price follows
  const r = feed(s, so, prices);
  assert.equal(r.momentum.warm, true);
  assert.equal(r.momentum.dir, 'UP');
  assert.ok(r.momentum.z > 2, `z=${r.momentum.z}`);
});

test('steep flow WITHOUT a real price move does not fire (adaptive gate)', () => {
  const s = newSession();
  const so = [], prices = [];
  for (let i = 0; i < 70; i++) { so.push(i * 5_000); prices.push(60000 + (i % 2)); } // $1 jitter baseline
  for (let i = 0; i < 15; i++) { so.push(350_000 + (i + 1) * 100_000); prices.push(60000 + (i % 2)); } // surge, price flat
  const r = feed(s, so, prices);
  assert.equal(r.momentum.dir, 'FLAT');
});

test('sd floor prevents z explosion in dead-quiet tape', () => {
  const s = newSession();
  // 70s of ZERO flow (sd would be 0), then one modest 5s print of $8k
  const so = [], prices = [];
  for (let i = 0; i < 70; i++) { so.push(0); prices.push(60000); }
  for (let i = 0; i < 5; i++) { so.push((i + 1) * 1600); prices.push(60000 + i * 3); }
  const r = feed(s, so, prices);
  // slope=8k, floor=5k -> z=1.6 < Z_FIRE(2.0): must not fire
  assert.equal(r.momentum.dir, 'FLAT');
  assert.ok(Math.abs(r.momentum.z) < 2, `z=${r.momentum.z}`);
});

const FLAT_MOM = { dir: 'FLAT' };

test('raw 1s imbalance jitter around the threshold does NOT flip the signal', () => {
  const s = newSession();
  // comb oscillates 0.10 <-> 0.14 every tick (the v5 killer): EWMA ~0.12 stays
  // inside the hysteresis band -> signal must stay MIXED throughout
  const sigs = new Set();
  for (let i = 0; i < 60; i++) {
    const v = i % 2 ? 0.14 : 0.10;
    sigs.add(decideDebounced(s, { bimb: v, pimb: v }, FLAT_MOM).sig);
  }
  assert.deepEqual([...sigs], ['MIXED']);
});

test('sustained strong imbalance enters UP only after EWMA>ENTER plus DWELL ticks', () => {
  const s = newSession();
  let firstUp = null;
  for (let i = 0; i < 60; i++) {
    const r = decideDebounced(s, { bimb: 0.5, pimb: 0.5 }, FLAT_MOM);
    if (r.sig === 'UP' && firstUp == null) firstUp = i;
  }
  assert.ok(firstUp != null, 'never entered UP');
  assert.ok(firstUp >= 6, `entered too fast: tick ${firstUp}`);   // dwell floor: cannot enter before 7 consecutive ticks (0-indexed); actual entry is later once the EWMA crossing is included
});

test('once UP, drifting back inside the band holds UP; only a real exit clears it', () => {
  const s = newSession();
  for (let i = 0; i < 60; i++) decideDebounced(s, { bimb: 0.5, pimb: 0.5 }, FLAT_MOM);
  // drift to 0.12 — between EXIT(0.08) and ENTER(0.20): must hold UP
  let r;
  for (let i = 0; i < 40; i++) r = decideDebounced(s, { bimb: 0.12, pimb: 0.12 }, FLAT_MOM);
  assert.equal(r.sig, 'UP');
  // collapse to 0 — inside EXIT: clears to MIXED (after dwell)
  for (let i = 0; i < 60; i++) r = decideDebounced(s, { bimb: 0, pimb: 0 }, FLAT_MOM);
  assert.equal(r.sig, 'MIXED');
});

test('momentum folds in: breaks MIXED ties, conflicts stand down — both through the dwell', () => {
  const s = newSession();
  // neutral book, momentum UP long enough to pass dwell -> flow-led UP
  let r;
  for (let i = 0; i < 10; i++) r = decideDebounced(s, { bimb: 0, pimb: 0 }, { dir: 'UP' });
  assert.equal(r.sig, 'UP');
  // now book goes hard DOWN while momentum still UP -> conflict -> MIXED
  for (let i = 0; i < 60; i++) r = decideDebounced(s, { bimb: -0.6, pimb: -0.6 }, { dir: 'UP' });
  assert.equal(r.sig, 'MIXED');
});

test('phi: standard normal CDF sanity', () => {
  assert.ok(Math.abs(phi(0) - 0.5) < 1e-4);
  assert.ok(Math.abs(phi(-1.645) - 0.05) < 2e-3);
  assert.ok(Math.abs(phi(1.645) - 0.95) < 2e-3);
});

test('big cushion + little time + calm vol -> tiny flip risk; base never exceeds 0.5', () => {
  const s = newSession();
  const r = flipRisk(s, { cushion: 80, remS: 30, vol1m: 20 }, { d60: 0 });
  assert.ok(r.p < 0.05, `p=${r.p}`);
  assert.equal(r.side, 1);
  const s2 = newSession();
  const r2 = flipRisk(s2, { cushion: 1, remS: 280, vol1m: 40 }, { d60: 0 });
  assert.ok(r2.base <= 0.5 && r2.base > 0.4, `base=${r2.base}`);
});

test('opposing whale flow + perp divergence raise flip risk above the neutral base', () => {
  const inp = { cushion: 25, remS: 120, vol1m: 30 };
  const neutral = flipRisk(newSession(), { ...inp }, { d60: 0 });
  const opposed = flipRisk(newSession(),
    { ...inp, largePrints: -600_000, perpSpotDiv: -900_000 }, { d60: -500_000 });
  assert.ok(opposed.p > neutral.p + 0.1, `${opposed.p} vs ${neutral.p}`);
  assert.ok(opposed.opposing > 0.3);
});

test('aligned (supporting) flow LOWERS flip risk', () => {
  const inp = { cushion: 25, remS: 120, vol1m: 30 };
  const neutral = flipRisk(newSession(), { ...inp }, { d60: 0 });
  const backed = flipRisk(newSession(),
    { ...inp, largePrints: 600_000, perpSpotDiv: 900_000 }, { d60: 500_000 });
  assert.ok(backed.p < neutral.p);
});

test('alert requires persistence: fires only after ALERT_TICKS consecutive high-p ticks', () => {
  const s = newSession();
  const hi = { cushion: 5, remS: 200, vol1m: 60, largePrints: -800_000, perpSpotDiv: -900_000 };
  let r;
  for (let i = 0; i < 9; i++) r = flipRisk(s, hi, { d60: -600_000 });
  assert.equal(r.alert, null);
  r = flipRisk(s, hi, { d60: -600_000 });          // 10th consecutive tick
  assert.equal(r.alert, 'FLIP→DOWN');               // UP side flipping down
  // p dropping below ALERT_CLEAR resets the alert
  for (let i = 0; i < 3; i++) r = flipRisk(s, { cushion: 80, remS: 30, vol1m: 15 }, { d60: 0 });
  assert.equal(r.alert, null);
});

test('volFromHist: $2/s alternating jitter -> sane 1-minute vol estimate', () => {
  const hist = Array.from({ length: 60 }, (_, i) => ({ t: T0 + i * 1000, v: 60000 + (i % 2) * 2 }));
  const v = volFromHist(hist);
  assert.ok(v > 5 && v < 40, `vol=${v}`);   // ~$2 diffs * sqrt(60) ~= $15
});

// ---- v5.3: cushion-aligned entry + counter-cushion confirmation + hold-release ----
const LP0 = { dir: 'FLAT' };

test('v5.3 aligned entry: EWMA 0.16 enters UP when cushion agrees, stays MIXED when cushion is null', () => {
  const a = newSession();
  let ra; for (let i = 0; i < 40; i++) ra = decideDebounced(a, { bimb: 0.16, pimb: 0.16, cushion: 25 }, LP0);
  assert.equal(ra.sig, 'UP');                     // 0.14 <= 0.16 < 0.20, cushion-aligned -> enters
  const b = newSession();
  let rb; for (let i = 0; i < 40; i++) rb = decideDebounced(b, { bimb: 0.16, pimb: 0.16 }, LP0);
  assert.equal(rb.sig, 'MIXED');                  // no cushion -> stock ENTER 0.20 -> never enters
});

test('v5.3 aligned entry does NOT lower the bar for the counter-cushion direction', () => {
  const s = newSession();
  let r; for (let i = 0; i < 40; i++) r = decideDebounced(s, { bimb: -0.16, pimb: -0.16, cushion: 25, largePrints: -900000 }, LP0);
  assert.equal(r.sig, 'MIXED');                   // |-0.16| < ENTER 0.20 for the against-cushion side
});

test('v5.3 counter-confirm: strong counter-cushion book alone cannot enter', () => {
  const s = newSession();
  let r; for (let i = 0; i < 60; i++) r = decideDebounced(s, { bimb: -0.5, pimb: -0.5, cushion: 25 }, LP0);
  assert.equal(r.sig, 'MIXED');                   // DOWN vs +cushion, FLAT momentum, no whale prints -> blocked
});

test('v5.3 counter-confirm: momentum agreement unlocks the counter entry', () => {
  const s = newSession();
  let r; for (let i = 0; i < 60; i++) r = decideDebounced(s, { bimb: -0.5, pimb: -0.5, cushion: 25 }, { dir: 'DOWN' });
  assert.equal(r.sig, 'DOWN');
});

test('v5.3 counter-confirm: whale prints agreement unlocks the counter entry', () => {
  const s = newSession();
  let r; for (let i = 0; i < 60; i++) r = decideDebounced(s, { bimb: -0.5, pimb: -0.5, cushion: 25, largePrints: -500000 }, LP0);
  assert.equal(r.sig, 'DOWN');
});

test('v5.3 hold-release: an uncorroborated counter-cushion hold decays to MIXED after HOLD_RELEASE+dwell', () => {
  const s = newSession();
  let r; for (let i = 0; i < 60; i++) r = decideDebounced(s, { bimb: -0.5, pimb: -0.5, cushion: -25 }, LP0);
  assert.equal(r.sig, 'DOWN');                    // entered WITH the cushion...
  for (let i = 0; i < 10; i++) r = decideDebounced(s, { bimb: -0.5, pimb: -0.5, cushion: 25 }, LP0);
  assert.equal(r.sig, 'DOWN');                    // ...short counter-hold still allowed (10 < 15)
  for (let i = 0; i < 15; i++) r = decideDebounced(s, { bimb: -0.5, pimb: -0.5, cushion: 25 }, LP0);
  assert.equal(r.sig, 'MIXED');                   // 15-tick uncorroborated counter-hold + 7-tick dwell -> released
});

test('v5.3 hold-release: whale-print backing keeps the counter-hold alive', () => {
  const s = newSession();
  let r; for (let i = 0; i < 60; i++) r = decideDebounced(s, { bimb: -0.5, pimb: -0.5, cushion: -25 }, LP0);
  assert.equal(r.sig, 'DOWN');
  for (let i = 0; i < 60; i++) r = decideDebounced(s, { bimb: -0.5, pimb: -0.5, cushion: 25, largePrints: -400000 }, LP0);
  assert.equal(r.sig, 'DOWN');                    // lp backs the held DOWN -> counterHold resets every tick, no release
});

// ---- v5.4: BAFO (book-against flow override) — 52-bar LHF winner ----
// Feed: book EWMA firmly negative while cushion is fat-positive and flow agrees with cushion.
function bafoInp(over = {}) {
  return { bimb: -0.3, pimb: -0.3, cushion: 150, vol1m: 20, cvd3m: 800000, ...over };
}
const BFLOW = { d60: 50000 };

test('v5.4 BAFO: fat cushion + agreeing flow overrides an opposing book (fires cushion side)', () => {
  const s = newSession();
  let r; for (let i = 0; i < 20; i++) r = decideDebounced(s, bafoInp(), { dir: 'FLAT' }, BFLOW);
  assert.equal(r.sig, 'UP');           // without BAFO this feed is counter-blocked -> MIXED forever
});

test('v5.4 BAFO guard: flow disagreement means no override (counter-blocked as before)', () => {
  const s = newSession();
  let r; for (let i = 0; i < 20; i++) r = decideDebounced(s, bafoInp({ cvd3m: -800000 }), { dir: 'FLAT' }, BFLOW);
  assert.equal(r.sig, 'MIXED');
});

test('v5.4 BAFO guard: thin cushion (below max(30, 3*vol)) means no override', () => {
  const s = newSession();
  let r; for (let i = 0; i < 20; i++) r = decideDebounced(s, bafoInp({ cushion: 40 }), { dir: 'FLAT' }, BFLOW);
  assert.equal(r.sig, 'MIXED');        // 40 < max(30, 3*20)=60
});

test('v5.4 BAFO guard: without a flow argument the rule is inert (back-compat)', () => {
  const s = newSession();
  let r; for (let i = 0; i < 20; i++) r = decideDebounced(s, bafoInp(), { dir: 'FLAT' });
  assert.equal(r.sig, 'MIXED');
});
