// v8/src/signals.mjs
// v8 = the v7s early-call channel BYTE-IDENTICAL (earlyCallOf below is untouched)
// + a REPLACED per-tick stream: decideV8, the calibrated cushion-lead rule.
//   sig = sign(cushion) when |cushion| >= max($10, 0.5*vol_1m), else MIXED.
// Basis (v8/analysis/2026-07-08-frontier.md, walk-forward on 823 24/7 bars / 48,557 ticks):
// price location is the entire measurable per-tick signal — 40 microstructure features
// (taker split, whale split, basis, book pulls, poly dynamics, VWAP) add ~nothing beyond
// cushion (permutation imp: cush_norm 0.380, next 0.022). This rule scored value/bar -1.13
// vs v6 lean stream -6.53, acc 82.3% vs 73.7%, missed fire-worthy leads 0.0% vs 21.3%;
// hysteresis variants measured WORSE out-of-sample (50_distill.py) — the static rule ships.
// The legacy v6 lean stream (decideDebounced/momentumOf/flipRisk, byte-identical) still
// runs every tick for state parity + the pressure bar (imbEwma) + flip readout; its tag
// is exposed as decision.legacySig for comparison, but decision.sig is decideV8's call.
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
  // v7s early-call channel ('standard'): SELECTIVE. Fires the market-favored side ONLY
  // when the Polymarket favorite price sits in [0.82,0.93] within the 45-90s fire window,
  // sane read + cushion-agree + dwell 3; ABSTAINS otherwise (no call for the bar).
  // Basis: measured 2026-07-07 on the 883-bar pooled 24/7 evidence base: 85.1% @ 22.9% coverage (89.5% excluding the 07-05 cascade day), median fire ~67s in.
  // Full record: v7/analysis (bq_eval.jsonl, 709 BQ bars + live logs). Late fires (>90s) were
  // measured WORSE (~88%/no edge) - hence the hard 90s abstain deadline.
  EARLY_MIN_REM: 255,      // don't fire in the first 45s (poly needs to price in)
  EARLY_HARD_REM: 210,     // hard deadline: 90s in; abstain for the bar after this (later fires have no edge)
  EARLY_DWELL: 3,          // band condition must hold this many consecutive ticks (kills transient flickers)
  EARLY_P_LO: 0.82,        // favorite-price band low (below: market genuinely uncertain, no/neg edge)
  EARLY_P_HI: 0.93,        // band high
  EARLY_MID_MIN: 0.02,     // sanity floor: reject degenerate/one-sided poly book reads
  EARLY_MID_MAX: 0.98,     // sanity ceiling
  // v8 per-tick stream (decideV8): the calibrated cushion-lead rule. Walk-forward
  // winner on the 823-bar 24/7 base; hysteresis/dwell variants measured worse OOS.
  V8_FLOOR_ABS: 10,        // $ absolute floor (same floor family as the early/BAFO channels)
  V8_FLOOR_VOLMULT: 0.5,   // vol multiple: floor = max(ABS, VOLMULT * vol_1m)
  // v8 conviction tier (convictionOf) — measured 2026-07-08 (90_conviction_tiers.py,
  // 229,578 directional ticks, walk-forward): tier3 = all 5 pts -> 88.2% heldout /
  // 94.0% live; tier2 -> 81.2% / 85.1%; tier1 (<=1 pt, ~1% of ticks) -> 57.4% / 50.0%.
  // Points: ratio>=1.5x floor, ratio>=2.5x, p_flip<=0.5, poly agrees (>=+0.02 on the
  // side), zero reversals so far this bar. Display/logging layer ONLY — never gates
  // the emitted sig.
  CONV_R1: 1.5, CONV_R2: 2.5, CONV_PFLIP: 0.5, CONV_POLY: 0.02,
  CONV_T3: 5, CONV_T1: 1,
});

const KEEP_MS = 65_000;       // a little more than the 60s delta window

export function newSession() {
  return {
    openHist: [], priceHist: [], firstMs: null, firstRem: null,
    slopeMean: null, slopeVar: null,   // EWMA moments of the 5s flow slope
    pMean: null, pVar: null,           // EWMA moments of the 6s price move
    imbEwma: null,
    sig: 'MIXED', pendingSig: null, pendingCount: 0, counterHold: 0,
    sig8: 'MIXED', convPrev: null, convRev: 0,
    sig8Prev: null, sig8RunTicks: 0,
    outcomeCall: null, outcomeBranch: null, outcomeDecision: null,
    outcomeReason: 'WAITING_EARLY', outcomeTerminal: false,
    outcomeEarlyPending: null,
    alertCount: 0, alert: null,
    earlyCall: null, earlyAbstain: false, earlyRun: 0, earlyPendSide: null,
  };
}

function terminalOutcome(s, reason) {
  s.outcomeReason = reason;
  s.outcomeTerminal = true;
}

function latchOutcome(s, call, branch, decision) {
  s.outcomeCall = call;
  s.outcomeBranch = branch;
  s.outcomeDecision = decision;
  s.outcomeReason = branch === 'EARLY' ? 'EARLY_QUALIFIED' : 'CONFIRMED_DISCOUNTED';
}

function outcomeView(s, eligible = false) {
  return {
    call: s.outcomeCall,
    branch: s.outcomeBranch,
    decision: s.outcomeDecision,
    reason: s.outcomeReason,
    eligible,
    runAgeTicks: s.sig8RunTicks,
    terminal: s.outcomeTerminal,
  };
}

// V8.2 shadow-only settlement call. This does not change decision.sig, early, or conviction.
export function outcomeShadowOf(s, inp, v8, early) {
  if (v8.sig === 'UP' || v8.sig === 'DOWN') {
    s.sig8RunTicks = v8.sig === s.sig8Prev ? s.sig8RunTicks + 1 : 1;
    s.sig8Prev = v8.sig;
  } else {
    s.sig8Prev = 'MIXED';
    s.sig8RunTicks = 0;
  }

  const o = inp.outcome ?? {};
  if (o.checkpointMissed) terminalOutcome(s, 'CHECKPOINT_MISSED');
  if (!o.supported) terminalOutcome(s, o.disabledReason ?? 'UNSUPPORTED_MARKET');
  if (o.mapping === 'failed') terminalOutcome(s, 'TOKEN_MAPPING_FAILED');
  if (s.outcomeCall || s.outcomeTerminal) return outcomeView(s);

  // Early latches remain immutable in the inherited engine. Mapping may arrive later,
  // but never after the inherited early deadline.
  if (early && (early.side === 'UP' || early.side === 'DOWN') && !s.outcomeEarlyPending) {
    s.outcomeEarlyPending = { side: early.side, mid: early.price ?? null, rem: early.rem ?? inp.remS ?? null };
  }
  if (s.outcomeEarlyPending) {
    if (o.mapping === 'ready') {
      const p = s.outcomeEarlyPending;
      latchOutcome(s, p.side, 'EARLY', { upMid: o.up?.mid ?? null, downMid: o.down?.mid ?? null, signalSideMid: p.mid, rem: p.rem });
      return outcomeView(s, true);
    }
    if (inp.remS < CFG.EARLY_HARD_REM) terminalOutcome(s, 'TOKEN_MAPPING_FAILED');
    return outcomeView(s);
  }

  if (inp.remS < 100) {
    terminalOutcome(s, o.mapping === 'ready' ? 'NO_USABLE_QUOTE' : 'TOKEN_MAPPING_FAILED');
    return outcomeView(s);
  }
  if (inp.remS < CFG.EARLY_HARD_REM) s.outcomeReason = 'WAITING_CHECKPOINT';
  if (o.mapping !== 'ready') return outcomeView(s);

  const receivedRem = o.quoteReceivedRem;
  if (receivedRem == null || receivedRem < 100 || receivedRem > 105) return outcomeView(s);
  const anyValid = o.up?.valid || o.down?.valid;
  if (v8.sig === 'MIXED') {
    if (anyValid) terminalOutcome(s, 'NON_DIRECTIONAL_SIGNAL');
    return outcomeView(s);
  }
  const sideQuote = v8.sig === 'UP' ? o.up : o.down;
  if (!sideQuote?.valid) return outcomeView(s);
  if (s.sig8RunTicks < 30) terminalOutcome(s, 'RUN_TOO_SHORT');
  else if (sideQuote.mid > 0.75) terminalOutcome(s, 'MARKET_PRICED_ABOVE_LIMIT');
  else {
    latchOutcome(s, v8.sig, 'CONFIRMED_DISCOUNTED', {
      upMid: o.up?.mid ?? null, downMid: o.down?.mid ?? null,
      signalSideMid: sideQuote.mid, rem: receivedRem,
    });
    return outcomeView(s, true);
  }
  return outcomeView(s);
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

// v8 per-tick stream: the calibrated cushion-lead rule. One sentence: call the side
// price has genuinely moved to (vs bar open), judged against the vol floor; otherwise
// say MIXED. No book echo, no whale/flow corroboration — every one of those inputs was
// auditioned offline and measured to add nothing beyond price location (frontier report).
// Stateless by design: the static rule beat every hysteresis variant out-of-sample.
export function decideV8(s, inp) {
  const { cushion, vol1m } = inp;
  if (cushion == null) return { sig: s.sig8 ?? 'MIXED', floor: null, note: 'no-cushion' };
  const vol = vol1m ?? volFromHist(s.priceHist);
  const floor = Math.max(CFG.V8_FLOOR_ABS, CFG.V8_FLOOR_VOLMULT * vol);
  const sig = Math.abs(cushion) >= floor ? (cushion > 0 ? 'UP' : 'DOWN') : 'MIXED';
  s.sig8 = sig;
  return { sig, floor, note: sig === 'MIXED' ? '' : 'cushion-lead' };
}

// v8 conviction tier — a per-tick reliability grade on the emitted tag. Reads only
// components that survived walk-forward validation (see CFG.CONV_* provenance).
// Returns null on MIXED. Tracks bar reversal count on s (directional tag changes).
// Display/logging layer only: never alters decideV8's call or the early channel.
export function convictionOf(s, inp, sig, flipP) {
  if (sig !== 'UP' && sig !== 'DOWN') return null;
  if (s.convPrev && sig !== s.convPrev) s.convRev = (s.convRev ?? 0) + 1;
  s.convPrev = sig;
  const vol = inp.vol1m ?? volFromHist(s.priceHist);
  const floor = Math.max(CFG.V8_FLOOR_ABS, CFG.V8_FLOOR_VOLMULT * vol);
  const ratio = inp.cushion == null ? 0 : Math.abs(inp.cushion) / floor;
  const ds = sig === 'UP' ? 1 : -1;
  const polyOk = inp.polyMid != null && (inp.polyMid - 0.5) * ds >= CFG.CONV_POLY;
  const pfOk = flipP != null && flipP <= CFG.CONV_PFLIP;
  const pts = (ratio >= CFG.CONV_R1 ? 1 : 0) + (ratio >= CFG.CONV_R2 ? 1 : 0)
    + (pfOk ? 1 : 0) + (polyOk ? 1 : 0) + ((s.convRev ?? 0) === 0 ? 1 : 0);
  const tier = pts >= CFG.CONV_T3 ? 3 : (pts <= CFG.CONV_T1 ? 1 : 2);
  const why = [];
  if (ratio < CFG.CONV_R1) why.push('thin cushion');
  else if (ratio < CFG.CONV_R2) why.push('shallow cushion');
  if (!pfOk) why.push('flip-risk');
  if (!polyOk) why.push('poly not agreeing');
  if ((s.convRev ?? 0) > 0) why.push(`${s.convRev} reversal${s.convRev > 1 ? 's' : ''}`);
  return { tier, pts, why: why.join(', ') };
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

// v7 early-call channel: SELECTIVE, EDGE-SEEKING. Reads inp.polyMid (Polymarket favorite
// up-probability). Fires the market-favored side the FIRST tick in the early window
// [EARLY_HARD_REM, EARLY_MIN_REM] where: the read is sane, the favorite price sits in the
// underpriced-confident band [EARLY_P_LO, EARLY_P_HI], and the cushion (if present) agrees.
// Otherwise it keeps waiting; once past EARLY_HARD_REM with no fire it ABSTAINS for the bar
// (no call -> returns null, s.earlyAbstain latched). Immutable once latched. Independent of
// s.sig (the lean stream) — this channel does not use the v6 tier logic.
export function earlyCallOf(s, inp) {
  if (s.earlyCall) return s.earlyCall;            // immutable latch
  if (s.earlyAbstain) return null;                // deadline passed with no fire this bar
  const rem = inp.remS;
  if (rem == null) return null;
  if (rem > CFG.EARLY_MIN_REM) return null;       // too early — let poly price in
  if (rem < CFG.EARLY_HARD_REM) { s.earlyAbstain = true; return null; }  // past hard deadline -> abstain
  const m = inp.polyMid;
  const cush = inp.cushion;
  const fav = m == null ? null : Math.max(m, 1 - m);
  const side = m == null ? null : (m > 0.5 ? 'UP' : 'DOWN');
  const sane = m != null && m > CFG.EARLY_MID_MIN && m < CFG.EARLY_MID_MAX;
  const inBand = sane && fav >= CFG.EARLY_P_LO && fav <= CFG.EARLY_P_HI;
  const cushOk = cush == null || cush === 0 || ((cush > 0) === (side === 'UP'));
  // dwell: the qualifying condition (same side, in-band, sane, cushion-agree) must persist
  // EARLY_DWELL consecutive ticks — a transient flicker into the band does not fire.
  if (inBand && cushOk) {
    s.earlyRun = (s.earlyPendSide === side) ? s.earlyRun + 1 : 1;
    s.earlyPendSide = side;
    if (s.earlyRun >= CFG.EARLY_DWELL) {
      const late = s.firstRem != null && s.firstRem <= CFG.EARLY_MIN_REM;  // joined after the window opened
      s.earlyCall = { side, tier: 'standard', price: Math.round(fav * 1000) / 1000, rem, late };
      return s.earlyCall;
    }
  } else {
    s.earlyRun = 0; s.earlyPendSide = null;
  }
  return null;                                    // not yet — keep evaluating within the window
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
  if (s.firstMs == null) { s.firstMs = now; s.firstRem = inp.remS ?? null; }
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
  // legacy stream still runs every tick: keeps imbEwma/dwell state identical to v6/v7s
  // (pressure bar + comparability), but the emitted sig is decideV8's.
  const legacy = decideDebounced(s, inp, momentum, flow);
  const v8 = decideV8(s, inp);
  const flip = flipRisk(s, inp, flow);
  const conv = convictionOf(s, inp, v8.sig, flip?.p ?? null);
  const early = earlyCallOf(s, inp);
  const outcome_shadow = inp.outcome ? outcomeShadowOf(s, inp, v8, early) : null;
  return {
    flow,
    cush_d10: deltaAt(s.priceHist, now, 10_000),
    momentum,
    decision: { sig: v8.sig, imbEwma: legacy.imbEwma, note: v8.note, floor: v8.floor, legacySig: legacy.sig, conv },
    early,
    outcome_shadow,
    flip,
  };
}
