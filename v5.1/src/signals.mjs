// v5.1/src/signals.mjs
// Pure v5.1 signal math. No DOM, no network -> browser-importable AND node-testable.
// v5.1 vs v5: flow derivatives come from the sinceOpen accumulator (cvd_candle_usd),
// not a rolling-window value, so short deltas are exact net flow with no
// window-exit contamination. Momentum, decision, and flip-risk are added in
// subsequent layers (momentumOf / decideDebounced / flipRisk).

export const CFG = {};        // populated by the momentum/decision/flip layers

const KEEP_MS = 65_000;       // a little more than the 60s delta window

export function newSession() {
  return {
    openHist: [],   // {t, v: sinceOpen}
    priceHist: [],  // {t, v: price}
    firstMs: null,  // first real sample (warmup anchor)
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
  return {
    flow,
    cush_d10: deltaAt(s.priceHist, now, 10_000),
    momentum: null,   // Task 2
    decision: null,   // Task 3
    flip: null,       // Task 4
  };
}
