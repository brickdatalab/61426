// v5/src/signals.mjs
// Pure V5 signal math. No DOM, no network -> browser-importable AND node-testable.
//
// Computes (all from the existing @trade CVD + price stream):
//  - cvdSinceOpen : cumulative net signed USD since the bar opened (== ourWebSocket
//                   tape.cvd_candle_usd formula: cum_now - cum_at_bar_open).
//  - cvd_d5/d10/d60 : change in the rolling 30s-CVD reading over 5/10/60s.
//  - cush_d10 : change in cushion (price) over 10s.
//  - momentum : forward-looking CVD flow-momentum = adaptive 5s slope z-scored vs
//               recent slope dispersion; CONTINUATION only (steep AND price-aligned).
//               Refuted: no slope-rollover->reversal, no simple divergence as primary.
//  - decide() : folds momentum into the imbalance call (tie-break / confirm / conflict).

export function newSession() {
  return { cvdSinceOpen: 0, cvdHist: [], priceHist: [], barStartMs: null };
}

export function startBar(s, barStartMs, seed = 0) {
  s.barStartMs = barStartMs;
  s.cvdSinceOpen = seed;       // seed supports mid-bar connect (backfilled flow)
  s.cvdHist = [];
  s.priceHist = [];
}

export function addTrade(s, signedUsd) {
  s.cvdSinceOpen += signedUsd; // running accumulator; reset per bar via startBar
}

// value of the sample at-or-before targetT (linear scan; histories are short)
export function valAt(hist, targetT) {
  let v = null;
  for (const s of hist) {
    if (s.t <= targetT) v = s.v;
    else break;
  }
  return v;
}

// current (at now) minus the value ~ms ago. now should be >= the last sample's t.
export function deltaAt(hist, now, ms) {
  if (!hist.length) return null;
  const cur = valAt(hist, now);
  const past = valAt(hist, now - ms);
  if (cur == null || past == null) return null;
  return cur - past;
}

const CVD_KEEP_MS = 65_000;   // a little more than the 60s delta window
const PRICE_KEEP_MS = 16_000;

function prune(hist, now, keepMs) {
  const cut = now - keepMs;
  while (hist.length > 1 && hist[0].t < cut) hist.shift();
}

export function tick(s, { now, cvd30, price }) {
  s.cvdHist.push({ t: now, v: cvd30 });
  s.priceHist.push({ t: now, v: price });
  prune(s.cvdHist, now, CVD_KEEP_MS);
  prune(s.priceHist, now, PRICE_KEEP_MS);
  return {
    cvdSinceOpen: s.cvdSinceOpen,
    cvd30, price,
    cvd_d5: deltaAt(s.cvdHist, now, 5000),
    cvd_d10: deltaAt(s.cvdHist, now, 10_000),
    cvd_d60: deltaAt(s.cvdHist, now, 60_000),
    cush_d10: deltaAt(s.priceHist, now, 10_000),
    momentum: momentumOf(s.cvdHist, s.priceHist, now),
  };
}

function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = arr.reduce((s, x) => s + x, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}

// recent 5s-slope series sampled at 1s steps -> regime-adaptive normalizer
function recentSlopes(hist, now, count = 25) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const d = deltaAt(hist, now - i * 1000, 5000);
    if (d != null) out.push(d);
  }
  return out;
}

export function momentumOf(cvdHist, priceHist, now) {
  const slope = deltaAt(cvdHist, now, 5000) ?? 0;
  const sd = stdev(recentSlopes(cvdHist, now));
  const z = sd > 0 ? slope / sd : 0;
  const priceSlope = deltaAt(priceHist, now, 6000) ?? 0;
  // CONTINUATION only: steep flow AND price already moving with it.
  let dir = 'FLAT';
  if (z > 1.4 && slope > 0 && priceSlope > 1.5) dir = 'UP';
  else if (z < -1.4 && slope < 0 && priceSlope < -1.5) dir = 'DOWN';
  return { slope, z, sd, priceSlope, dir };
}

// fold CVD momentum into the imbalance-based call
export function decide({ bimb, pimb, comb, momentum }) {
  let imbSig = 'MIXED';
  if (bimb != null && pimb != null) {
    if (bimb > 0.12 && pimb > 0.12) imbSig = 'UP';
    else if (bimb < -0.12 && pimb < -0.12) imbSig = 'DOWN';
  } else if (comb != null) {
    imbSig = comb > 0.15 ? 'UP' : comb < -0.15 ? 'DOWN' : 'MIXED';
  }
  const mdir = momentum?.dir ?? 'FLAT';
  let sig = imbSig, note = '';
  if (mdir !== 'FLAT') {
    if (imbSig === 'MIXED') { sig = mdir; note = 'flow-led'; }       // CVD breaks the tie
    else if (imbSig === mdir) { note = 'flow-confirm'; }             // aligned -> conviction
    else { sig = 'MIXED'; note = 'flow-vs-book'; }                   // conflict -> stand down
  }
  return { sig, imbSig, note, momentum };
}
