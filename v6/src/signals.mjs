// v6/src/signals.mjs
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
  ALIGNED_ENTER: 0.14, // v5.3: entry threshold when the direction agrees with the cushion sign.
                       // FIT to the 20-bar replay set (deep-dive 2026-07-02, acc 70.8%->80.1%),
                       // validated out-of-sample — NOT an untuned prior like the rest of CFG.
  BAFO_ABS: 30,        // v5.4 BAFO: absolute cushion floor ($) for the book-against override
  BAFO_MULT: 3.0,      // v5.4 BAFO: vol multiple for the cushion floor (fit to the 52-bar set)
  HOLD_RELEASE: 15,    // v5.3: ticks an uncorroborated counter-cushion HOLD survives before decaying
                       // to MIXED. From bar 1782985200 (288 wrong ticks -> 67); OOS acc 58.1%->75.2%
                       // (n=6). Zero effect on the 20 tuning bars (never triggers there).
  // flip-risk flow adjustment. DIRECTIONAL PRIORS — not tuned. Revisit only with
  // a body of captured v5.1 logs; do not fit to the 2 existing v5 samples.
  D60_SCALE: 400_000,    // $ of 60s net flow for tanh saturation
  LP_SCALE: 300_000,     // $ of 3m whale-print net
  PS_SCALE: 500_000,     // $ of perp-minus-spot 5m divergence
  EFF_LOW: 0.5,          // efficiency_3m below this = flow being absorbed
  ABSORB_BOOST: 0.5,     // extra opposing weight when absorption + opposing flow
  W_FLOW: 1.2,           // logit-space weight of the opposing score
  ALERT_P: 0.6, ALERT_CLEAR: 0.5, ALERT_TICKS: 10,
  // v6 early-call channel: one tiered, latched directional call per bar.
  EARLY_MARK_REM: 210,     // early-call mark: 90s into a 5m bar; dashboard overrides to barS-90. Basis: 145-bar study 2026-07-05
  EARLY_RATIO: 2,          // qualified tier: cushion >= 2x vol floor at the mark -- 36/39 = 92.3% on v5.4 stream
  EARLY_RATIO_STRONG: 3,   // strong tier -- 25/26 = 96.2%
});

const KEEP_MS = 65_000;       // a little more than the 60s delta window

export function newSession() {
  return {
    openHist: [], priceHist: [], firstMs: null,
    slopeMean: null, slopeVar: null,   // EWMA moments of the 5s flow slope
    pMean: null, pVar: null,           // EWMA moments of the 6s price move
    imbEwma: null,
    sig: 'MIXED', pendingSig: null, pendingCount: 0, counterHold: 0,
    alertCount: 0, alert: null,
    earlyCall: null,
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

export function decideDebounced(s, inp, momentum, flow) {
  const { bimb, pimb, cushion, largePrints, vol1m, cvd3m } = inp;
  const comb = (bimb != null && pimb != null) ? (bimb + pimb) / 2 : (bimb ?? pimb);
  if (comb != null) s.imbEwma = ewma(s.imbEwma, comb, CFG.ALPHA_IMB);
  const e = s.imbEwma;
  const cushSign = cushion == null ? 0 : Math.sign(cushion);
  // v5.3 rule 1: aligned entry — lower bar only for the cushion-agreeing direction
  const enterFor = dir => (cushSign !== 0 && ((dir === 'UP') === (cushSign > 0))) ? CFG.ALIGNED_ENTER : CFG.ENTER;
  // hysteresis candidate on the SMOOTHED imbalance (between EXIT and ENTER: hold)
  let cand = s.sig, note = '';
  if (e != null) {
    if (e > enterFor('UP')) cand = 'UP';
    else if (e < -enterFor('DOWN')) cand = 'DOWN';
    else if (Math.abs(e) < CFG.EXIT) cand = 'MIXED';
  }
  // v5.4 rule 4: BAFO (book-against flow override) — a fat cushion with agreeing flow
  // overrides a stale/opposing book EWMA. 52-bar LHF winner (2026-07-02): +482 correct,
  // -9 wrong, -473 missed, 0 of 52 bars lose a correct tick, LOBO 52/52. FIT to that set.
  if (flow && cushSign !== 0) {
    const cushDir = cushSign > 0 ? 'UP' : 'DOWN';
    if (cand !== cushDir && e != null && Math.sign(e) !== 0 && Math.sign(e) !== cushSign
      && Math.abs(cushion) >= Math.max(CFG.BAFO_ABS, CFG.BAFO_MULT * (vol1m ?? 20))
      && flow.d60 != null && cvd3m != null
      && Math.sign(flow.d60) === cushSign && Math.sign(cvd3m) === cushSign) {
      cand = cushDir; note = 'bafo';
    }
  }
  // fold momentum (same semantics as v5 decide, but on the debounced call)
  const mdir = momentum?.dir ?? 'FLAT';
  if (mdir !== 'FLAT') {
    if (cand === 'MIXED') { cand = mdir; note = 'flow-led'; }
    else if (cand === mdir) { note = 'flow-confirm'; }
    else { cand = 'MIXED'; note = 'flow-vs-book'; }
  }
  // v5.3 rule 2: counter-cushion confirmation — a NEW entry against the cushion needs corroboration
  if (cand !== 'MIXED' && cand !== s.sig && cushSign !== 0) {
    const against = (cand === 'UP') !== (cushSign > 0);
    if (against) {
      const momAgrees = mdir === cand;
      const lpAgrees = largePrints != null && largePrints !== 0 && ((largePrints > 0) === (cand === 'UP'));
      if (!momAgrees && !lpAgrees) { cand = s.sig; note = 'counter-unconfirmed'; }
    }
  }
  // v5.3 rule 3: hold-release — an uncorroborated counter-cushion HOLD decays to MIXED
  if (s.sig !== 'MIXED' && cushSign !== 0) {
    const heldAgainst = (s.sig === 'UP') !== (cushSign > 0);
    const momBacks = mdir === s.sig;
    const lpBacks = largePrints != null && largePrints !== 0 && ((largePrints > 0) === (s.sig === 'UP'));
    if (heldAgainst && !momBacks && !lpBacks) {
      s.counterHold++;
      if (s.counterHold >= CFG.HOLD_RELEASE && cand === s.sig) { cand = 'MIXED'; note = 'counter-hold-release'; }
    } else s.counterHold = 0;
  } else s.counterHold = 0;
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

// v6 early-call channel: one tiered, latched directional call per bar, evaluated
// from CFG.EARLY_MARK_REM onward. Always-call mandate -- every bar gets a direction
// as early as determinable. Must run AFTER decideDebounced has updated s.sig.
export function earlyCallOf(s, inp) {
  if (s.earlyCall) return s.earlyCall;                          // immutable latch
  if (inp.remS == null || inp.remS > CFG.EARLY_MARK_REM) return null;   // before the mark
  const vol = Math.max(inp.vol1m ?? volFromHist(s.priceHist), 1);
  const floor = Math.max(10, 0.5 * vol);
  const cushSign = inp.cushion == null ? 0 : Math.sign(inp.cushion);
  const ratio = inp.cushion == null ? 0 : Math.abs(inp.cushion) / floor;
  let side, tier;
  if (s.sig !== 'MIXED' && cushSign !== 0 && ((s.sig === 'UP') === (cushSign > 0)) && ratio >= CFG.EARLY_RATIO) {
    side = s.sig; tier = ratio >= CFG.EARLY_RATIO_STRONG ? 'strong' : 'qualified';
  } else if (s.sig !== 'MIXED') {
    side = s.sig; tier = 'lean';
  } else if (cushSign !== 0) {
    side = cushSign > 0 ? 'UP' : 'DOWN'; tier = 'lean';
  } else if (s.imbEwma != null && s.imbEwma !== 0) {
    side = s.imbEwma > 0 ? 'UP' : 'DOWN'; tier = 'lean';
  } else {
    return null;   // nothing determinable yet -- keep evaluating on subsequent ticks
  }
  s.earlyCall = { side, tier, ratio: Math.round(ratio * 100) / 100, rem: inp.remS };
  return s.earlyCall;
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
    decision: decideDebounced(s, inp, momentum, flow),
    early: earlyCallOf(s, inp),
    flip: flipRisk(s, inp, flow),
  };
}
