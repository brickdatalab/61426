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
  // flip-risk flow adjustment. DIRECTIONAL PRIORS — not tuned. Revisit only with
  // a body of captured v5.1 logs; do not fit to the 2 existing v5 samples.
  D60_SCALE: 400_000,    // $ of 60s net flow for tanh saturation
  LP_SCALE: 300_000,     // $ of 3m whale-print net
  PS_SCALE: 500_000,     // $ of perp-minus-spot 5m divergence
  EFF_LOW: 0.5,          // efficiency_3m below this = flow being absorbed
  ABSORB_BOOST: 0.5,     // extra opposing weight when absorption + opposing flow
  W_FLOW: 1.2,           // logit-space weight of the opposing score
  ALERT_P: 0.6, ALERT_CLEAR: 0.5, ALERT_TICKS: 10,
});

const KEEP_MS = 65_000;       // a little more than the 60s delta window

export function newSession() {
  return {
    openHist: [], priceHist: [], firstMs: null,
    slopeMean: null, slopeVar: null,   // EWMA moments of the 5s flow slope
    pMean: null, pVar: null,           // EWMA moments of the 6s price move
    imbEwma: null,
    sig: 'MIXED', pendingSig: null, pendingCount: 0,
    alertCount: 0, alert: null,
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
    if (s.pendingCount >= CFG.DWELL_TICKS) { s.sig = cand; s.pendingSig = null; s.pendingCount = 0; }
  } else { s.pendingSig = null; s.pendingCount = 0; }
  return { sig: s.sig, imbEwma: e, note };
}

// standard normal CDF (Abramowitz-Stegun 26.2.17, |err| < 7.5e-8)
export function phi(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

// fallback realized vol when the VM field is absent: sd of 1s price diffs * sqrt(60)
export function volFromHist(priceHist) {
  if (priceHist.length < 10) return 30;   // conservative $30 1-min move default
  const diffs = [];
  for (let i = 1; i < priceHist.length; i++) diffs.push(priceHist[i].v - priceHist[i - 1].v);
  const m = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const v = diffs.reduce((a, b) => a + (b - m) ** 2, 0) / diffs.length;
  return Math.sqrt(v) * Math.sqrt(60) || 30;
}

export function flipRisk(s, inp, flow) {
  const { cushion, remS, vol1m, largePrints, efficiency, perpSpotDiv } = inp;
  if (cushion == null || remS == null) return { p: null, side: null, alert: s.alert ?? null };
  const side = cushion > 0 ? 1 : cushion < 0 ? -1 : 0;
  if (side === 0) return { p: 0.5, base: 0.5, opposing: 0, side, expMove: null, alert: s.alert ?? null };
  const vol = Math.max(vol1m ?? volFromHist(s.priceHist), 1);
  const expMove = vol * Math.sqrt(Math.max(remS, 1) / 60);
  const base = phi(-Math.abs(cushion) / expMove);          // driftless-walk flip prob, <= 0.5
  const nz = (x, sc) => x == null ? 0 : Math.tanh(x / sc); // saturating normalizer
  const fFlow = -side * nz(flow?.d60, CFG.D60_SCALE);
  const fWhale = -side * nz(largePrints, CFG.LP_SCALE);
  const fPerp = -side * nz(perpSpotDiv, CFG.PS_SCALE);
  const absorb = (efficiency != null && efficiency < CFG.EFF_LOW && fFlow > 0.3) ? CFG.ABSORB_BOOST : 0;
  const opposing = Math.max(-1, Math.min(1, (fFlow + fWhale + fPerp + absorb) / 3));
  const logit = Math.log(base / (1 - base)) + CFG.W_FLOW * opposing;
  const p = 1 / (1 + Math.exp(-logit));
  // persistence: alert only after ALERT_TICKS consecutive ticks above ALERT_P
  if (p > CFG.ALERT_P) s.alertCount = (s.alertCount ?? 0) + 1;
  else if (p < CFG.ALERT_CLEAR) { s.alertCount = 0; s.alert = null; }
  if (s.alertCount >= CFG.ALERT_TICKS) s.alert = side > 0 ? 'FLIP→DOWN' : 'FLIP→UP';
  return { p, base, opposing, side, expMove, alert: s.alert ?? null };
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
    flip: flipRisk(s, inp, flow),
  };
}
