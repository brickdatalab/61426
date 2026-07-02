// v5.1/src/signals.mjs
// Pure v5.1 signal math. No DOM, no network -> browser-importable AND node-testable.
// v5.1 vs v5: flow derivatives come from the sinceOpen accumulator (cvd_candle_usd),
// not a rolling-window value, so short deltas are exact net flow with no
// window-exit contamination. Momentum, decision, and flip-risk are added in
// subsequent layers (momentumOf / decideDebounced / flipRisk).

export const CFG = {};        // populated by the momentum/decision/flip layers

Object.assign(CFG, {
  // momentum
  ALPHA_SLOPE: 0.05,       // EWMA half-life ~13s at 1 tick/s
  SD_FLOOR_USD: 5_000,     // slope-sd floor: quiet tape can't produce infinite z
  WARMUP_MS: 60_000,       // no firing until 60s of real samples
  Z_FIRE: 2.0,
  PRICE_Z_GATE: 1.0,       // 6s price move must be > 1 sd of its own recent moves
  PRICE_SD_FLOOR: 0.5,     // $; BTC never has < $0.5 of 6s noise
  // decision debounce
  ALPHA_IMB: 0.06,     // EWMA of combined imbalance, ~17s mean lifetime at 1 tick/s
  ENTER: 0.20,         // |imbEwma| must exceed this to take a side
  EXIT: 0.08,          // must fall inside this to give the side back
  DWELL_TICKS: 7,      // a new state must persist 7 consecutive ticks to stick
});

const KEEP_MS = 65_000;       // a little more than the 60s delta window

export function newSession() {
  return {
    openHist: [], priceHist: [], firstMs: null,
    slopeMean: null, slopeVar: null,   // EWMA moments of the 5s flow slope
    pMean: null, pVar: null,           // EWMA moments of the 6s price move
    imbEwma: null,
    sig: 'MIXED', pendingSig: null, pendingCount: 0,
  };
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

// current (at now) minus the value ~ms ago; null until history is deep enough
export function deltaAt(hist, now, ms) {
  if (!hist.length) return null;
  const past = valAt(hist, now - ms);
  const cur = valAt(hist, now);
  if (cur == null || past == null) return null;
  return cur - past;
}

function ewma(prev, x, a) { return prev == null ? x : a * x + (1 - a) * prev; }

export function momentumOf(s, now) {
  const slope = deltaAt(s.openHist, now, 5000) ?? 0;         // exact 5s net flow
  s.slopeMean = ewma(s.slopeMean, slope, CFG.ALPHA_SLOPE);
  s.slopeVar = ewma(s.slopeVar, (slope - s.slopeMean) ** 2, CFG.ALPHA_SLOPE);
  const sd = Math.max(Math.sqrt(s.slopeVar ?? 0), CFG.SD_FLOOR_USD);
  const pm = deltaAt(s.priceHist, now, 6000) ?? 0;
  s.pMean = ewma(s.pMean, pm, CFG.ALPHA_SLOPE);
  s.pVar = ewma(s.pVar, (pm - s.pMean) ** 2, CFG.ALPHA_SLOPE);
  const psd = Math.max(Math.sqrt(s.pVar ?? 0), CFG.PRICE_SD_FLOOR);
  const warm = s.firstMs != null && now - s.firstMs >= CFG.WARMUP_MS;
  const z = warm ? slope / sd : 0;
  const priceZ = warm ? pm / psd : 0;
  let dir = 'FLAT';   // CONTINUATION only: steep flow AND price genuinely moving with it
  if (z > CFG.Z_FIRE && priceZ > CFG.PRICE_Z_GATE) dir = 'UP';
  else if (z < -CFG.Z_FIRE && priceZ < -CFG.PRICE_Z_GATE) dir = 'DOWN';
  return { slope, z, sd, priceZ, dir, warm };
}

export function decideDebounced(s, { bimb, pimb }, momentum) {
  const comb = (bimb != null && pimb != null) ? (bimb + pimb) / 2 : (bimb ?? pimb);
  if (comb != null) s.imbEwma = ewma(s.imbEwma, comb, CFG.ALPHA_IMB);
  const e = s.imbEwma;
  // hysteresis candidate on the SMOOTHED imbalance (between EXIT and ENTER: hold)
  let cand = s.sig, note = '';
  if (e != null) {
    if (e > CFG.ENTER) cand = 'UP';
    else if (e < -CFG.ENTER) cand = 'DOWN';
    else if (Math.abs(e) < CFG.EXIT) cand = 'MIXED';
  }
  // fold momentum (same semantics as v5 decide, but on the debounced call)
  const mdir = momentum?.dir ?? 'FLAT';
  if (mdir !== 'FLAT') {
    if (cand === 'MIXED') { cand = mdir; note = 'flow-led'; }
    else if (cand === mdir) { note = 'flow-confirm'; }
    else { cand = 'MIXED'; note = 'flow-vs-book'; }
  }
  // dwell: a change must persist DWELL_TICKS consecutive ticks before it sticks
  if (cand !== s.sig) {
    s.pendingCount = (s.pendingSig === cand) ? s.pendingCount + 1 : 1;
    s.pendingSig = cand;
    if (s.pendingCount > CFG.DWELL_TICKS) { s.sig = cand; s.pendingSig = null; s.pendingCount = 0; }
  } else { s.pendingSig = null; s.pendingCount = 0; }
  return { sig: s.sig, imbEwma: e, note };
}

function prune(hist, now, keepMs) {
  const cut = now - keepMs;
  while (hist.length > 1 && hist[0].t < cut) hist.shift();
}

export function tick(s, inp) {
  const { now, sinceOpen, price } = inp;
  if (sinceOpen == null || price == null) return null;   // connect gate
  if (s.firstMs == null) s.firstMs = now;
  s.openHist.push({ t: now, v: sinceOpen });
  s.priceHist.push({ t: now, v: price });
  prune(s.openHist, now, KEEP_MS);
  prune(s.priceHist, now, KEEP_MS);
  const flow = {
    d5: deltaAt(s.openHist, now, 5000),
    d10: deltaAt(s.openHist, now, 10_000),
    d60: deltaAt(s.openHist, now, 60_000),
  };
  const momentum = momentumOf(s, now);
  return {
    flow,
    cush_d10: deltaAt(s.priceHist, now, 10_000),
    momentum,
    decision: decideDebounced(s, inp, momentum),
    flip: null,       // Task 4
  };
}
