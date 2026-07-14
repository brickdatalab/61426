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

export const LOG_VERSION = 'v9-1';
export const ENGINE_STATE_VERSION = 'v9-1';
export const SNAPSHOT_VERSION = 'v9-1';

export function newSession() {
  return {
    openHist: [], priceHist: [], firstMs: null, firstRem: null,
    slopeMean: null, slopeVar: null,   // EWMA moments of the 5s flow slope
    pMean: null, pVar: null,           // EWMA moments of the 6s price move
    imbEwma: null,
    sig: 'MIXED', pendingSig: null, pendingCount: 0, counterHold: 0,
    sig8: 'MIXED', convPrev: null, convRev: 0,
    alertCount: 0, alert: null,
    earlyCall: null, earlyAbstain: false, earlyRun: 0, earlyPendSide: null,
    marketSupported: true,
    v9DirectionalSide: null, v9DirectionalRunAgeTicks: 0,
    v9DirectionalRunStartMs: null, v9DirectionalChangeCount: 0,
    v9NowcastSide: null, v9NowcastPreviousSide: null,
    v9NowcastChanged: false, v9NowcastChangeCount: 0,
    v9NowcastFirstSeen: false, v9NowcastHasSeenDirectional: false,
    v9RecencyUpWeight: 0, v9RecencyDownWeight: 0,
    v9RecencyBalance: null, v9RecencyLastMs: null,
    v9HasTicked: false,
    outcomeShadow: {
      status: 'PENDING', call: null, branch: null, reason: 'WAITING_EARLY',
      firstSeen: false, eligible: false, terminal: false,
      decisionRem: null, decisionTimestamp: null,
      decisionUpMid: null, decisionDownMid: null, decisionSignalSideMid: null,
      earlyPending: null, mappingStatus: 'PENDING',
      upTokenId: null, downTokenId: null, checkpointEvaluated: false,
      latestQuoteCycleId: 0, processedQuoteResponses: [],
    },
  };
}

export function applyMarketSupport(s, supported) {
  const value = typeof supported === 'object' ? supported?.supported : supported;
  s.marketSupported = value !== false;
  if (!s.marketSupported && !s.outcomeShadow.terminal && s.outcomeShadow.status === 'PENDING') {
    setOutcomeTerminal(s, 'UNSUPPORTED_MARKET');
  }
  return s.marketSupported;
}

function updateDirectionalRun(s, sig, now) {
  if (sig !== 'UP' && sig !== 'DOWN') {
    s.v9DirectionalSide = null;
    s.v9DirectionalRunAgeTicks = 0;
    s.v9DirectionalRunStartMs = null;
    return;
  }
  if (sig === s.v9DirectionalSide) {
    s.v9DirectionalRunAgeTicks += 1;
    return;
  }
  if (s.v9DirectionalSide === 'UP' || s.v9DirectionalSide === 'DOWN') {
    s.v9DirectionalChangeCount += 1;
  }
  s.v9DirectionalSide = sig;
  s.v9DirectionalRunAgeTicks = 1;
  s.v9DirectionalRunStartMs = now;
}

function nowcastPhase(remS, sig) {
  if (sig !== 'UP' && sig !== 'DOWN') return 'NO_FORECAST_MIXED';
  if (remS > 120) return 'DEVELOPING';
  if (remS > 60) return 'STRONG_WINDOW';
  if (remS > 10) return 'LATE_NOWCAST';
  return 'FINAL_NOWCAST';
}

function updateNowcast(s, sig, remS) {
  const supported = s.marketSupported !== false;
  const next = supported && (sig === 'UP' || sig === 'DOWN') ? sig : null;
  const previous = s.v9NowcastSide;
  const firstDirectional = next != null && !s.v9NowcastHasSeenDirectional;
  const changed = !firstDirectional && s.v9NowcastHasSeenDirectional && next !== previous;
  s.v9NowcastPreviousSide = previous;
  s.v9NowcastSide = next;
  s.v9NowcastFirstSeen = firstDirectional;
  s.v9NowcastChanged = changed;
  if (firstDirectional) s.v9NowcastHasSeenDirectional = true;
  if (changed) s.v9NowcastChangeCount += 1;
  return {
    side: next,
    phase: supported ? nowcastPhase(remS, sig) : 'UNSUPPORTED_MARKET',
    reason: !supported ? 'UNSUPPORTED_MARKET' : `CURRENT_V8_${sig}`,
    changed,
    firstSeen: firstDirectional,
    changeCount: s.v9NowcastChangeCount,
  };
}

function updateRecency(s, sig, now) {
  if (s.v9RecencyLastMs != null) {
    const elapsedSeconds = Math.max(0, now - s.v9RecencyLastMs) / 1_000;
    const decay = 2 ** (-elapsedSeconds / 10);
    s.v9RecencyUpWeight *= decay;
    s.v9RecencyDownWeight *= decay;
  }
  if (sig === 'UP') s.v9RecencyUpWeight += 1;
  else if (sig === 'DOWN') s.v9RecencyDownWeight += 1;
  s.v9RecencyLastMs = now;
  const total = s.v9RecencyUpWeight + s.v9RecencyDownWeight;
  s.v9RecencyBalance = total > 0
    ? (s.v9RecencyUpWeight - s.v9RecencyDownWeight) / total
    : null;
  return {
    upWeight: s.v9RecencyUpWeight,
    downWeight: s.v9RecencyDownWeight,
    balance: s.v9RecencyBalance,
  };
}

function directionalView(s, now) {
  return {
    side: s.v9DirectionalSide,
    runAgeTicks: s.v9DirectionalRunAgeTicks,
    runAgeMs: s.v9DirectionalRunStartMs == null ? 0 : Math.max(0, now - s.v9DirectionalRunStartMs),
    changeCount: s.v9DirectionalChangeCount,
  };
}

function setOutcomeTerminal(s, reason) {
  const o = s.outcomeShadow;
  if (o.status !== 'PENDING' || o.terminal) return false;
  o.status = 'NO_CALL';
  o.reason = reason;
  o.terminal = true;
  o.eligible = false;
  o.firstSeen = false;
  return true;
}

function outcomeView(s) {
  return structuredClone(s.outcomeShadow);
}

function latchOutcome(s, { call, branch, rem, timestamp, upMid = null, downMid = null, signalSideMid = null }) {
  const o = s.outcomeShadow;
  if (o.status !== 'PENDING' || o.terminal) return false;
  o.status = 'CALLED';
  o.call = call;
  o.branch = branch;
  o.reason = branch === 'EARLY' ? 'EARLY_QUALIFIED' : 'CONFIRMED_DISCOUNTED';
  o.eligible = true;
  o.firstSeen = true;
  o.terminal = true;
  o.checkpointEvaluated = branch === 'CONFIRMED_DISCOUNTED';
  o.decisionRem = rem ?? null;
  o.decisionTimestamp = timestamp ?? null;
  o.decisionUpMid = upMid;
  o.decisionDownMid = downMid;
  o.decisionSignalSideMid = signalSideMid;
  return true;
}

function resetOutcomeEventFlags(s) {
  s.outcomeShadow.eligible = false;
  s.outcomeShadow.firstSeen = false;
}

function promoteEarlyIfReady(s, now, remS) {
  const o = s.outcomeShadow;
  if (!o.earlyPending || o.mappingStatus !== 'VALID') return false;
  if (remS < CFG.EARLY_HARD_REM) return false;
  const p = o.earlyPending;
  return latchOutcome(s, {
    call: p.side,
    branch: 'EARLY',
    rem: p.rem,
    timestamp: p.timestamp,
    upMid: p.side === 'UP' ? p.mid : null,
    downMid: p.side === 'DOWN' ? p.mid : null,
    signalSideMid: p.mid,
  });
}

function updateOutcomeForTick(s, early, inp, firstTick) {
  const o = s.outcomeShadow;
  if (o.status !== 'PENDING' || o.terminal) return;
  if (s.marketSupported === false) { setOutcomeTerminal(s, 'UNSUPPORTED_MARKET'); return; }

  if (early && (early.side === 'UP' || early.side === 'DOWN') && !o.earlyPending) {
    o.earlyPending = {
      side: early.side,
      mid: early.price ?? null,
      rem: early.rem ?? inp.remS ?? null,
      timestamp: inp.now ?? null,
      late: early.late === true,
    };
  }
  if (o.earlyPending) {
    if (promoteEarlyIfReady(s, inp.now, inp.remS)) return;
    if (inp.remS < CFG.EARLY_HARD_REM) setOutcomeTerminal(s, 'TOKEN_MAPPING_FAILED');
    return;
  }

  if (firstTick && inp.remS < 100) { setOutcomeTerminal(s, 'CHECKPOINT_MISSED'); return; }
  if (inp.remS < 100) {
    setOutcomeTerminal(s, o.mappingStatus === 'VALID' ? 'NO_USABLE_QUOTE' : 'TOKEN_MAPPING_FAILED');
    return;
  }
  if (inp.remS < CFG.EARLY_HARD_REM) o.reason = 'WAITING_CHECKPOINT';
  else o.reason = 'WAITING_EARLY';
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function mapOutcomeTokens(outcomes, tokenIds) {
  if (arguments.length === 1 && outcomes && typeof outcomes === 'object' && !Array.isArray(outcomes)) {
    tokenIds = outcomes.tokenIds ?? outcomes.clobTokenIds;
    outcomes = outcomes.outcomes;
  }
  const labels = parseArray(outcomes);
  const tokens = parseArray(tokenIds);
  if (!labels || !tokens || labels.length !== 2 || tokens.length !== 2) {
    return { status: 'DETERMINISTIC_FAILURE', upTokenId: null, downTokenId: null };
  }
  const mapped = { UP: [], DOWN: [] };
  for (let i = 0; i < labels.length; i += 1) {
    const label = typeof labels[i] === 'string' ? labels[i].trim().toUpperCase() : '';
    const token = typeof tokens[i] === 'string' ? tokens[i].trim() : '';
    if ((label !== 'UP' && label !== 'DOWN') || !token) {
      return { status: 'DETERMINISTIC_FAILURE', upTokenId: null, downTokenId: null };
    }
    mapped[label].push(token);
  }
  if (mapped.UP.length !== 1 || mapped.DOWN.length !== 1 || mapped.UP[0] === mapped.DOWN[0]) {
    return { status: 'DETERMINISTIC_FAILURE', upTokenId: null, downTokenId: null };
  }
  return { status: 'VALID', upTokenId: mapped.UP[0], downTokenId: mapped.DOWN[0] };
}

export function applyMappingEvent(s, event = {}) {
  resetOutcomeEventFlags(s);
  const o = s.outcomeShadow;
  if (o.status !== 'PENDING' || o.terminal) return { changed: false, ignored: 'TERMINAL', outcome: outcomeView(s) };
  const status = event.status;
  if (o.earlyPending && (event.remS ?? Infinity) < CFG.EARLY_HARD_REM) {
    const changed = setOutcomeTerminal(s, 'TOKEN_MAPPING_FAILED');
    return { changed, callCreated: false, outcome: outcomeView(s) };
  }
  if ((event.remS ?? Infinity) < 100 && o.mappingStatus !== 'VALID') {
    o.mappingStatus = 'DETERMINISTIC_FAILURE';
    o.upTokenId = null;
    o.downTokenId = null;
    const changed = setOutcomeTerminal(s, 'TOKEN_MAPPING_FAILED');
    return { changed, callCreated: false, outcome: outcomeView(s) };
  }
  if (status === 'DETERMINISTIC_FAILURE') {
    o.mappingStatus = status;
    const changed = setOutcomeTerminal(s, 'TOKEN_MAPPING_FAILED');
    return { changed, callCreated: false, outcome: outcomeView(s) };
  }
  if (status === 'VALID') {
    const up = typeof event.upTokenId === 'string' ? event.upTokenId.trim() : '';
    const down = typeof event.downTokenId === 'string' ? event.downTokenId.trim() : '';
    if (!up || !down || up === down) {
      o.mappingStatus = 'DETERMINISTIC_FAILURE';
      const changed = setOutcomeTerminal(s, 'TOKEN_MAPPING_FAILED');
      return { changed, callCreated: false, outcome: outcomeView(s) };
    }
    o.mappingStatus = 'VALID';
    o.upTokenId = up;
    o.downTokenId = down;
    const callCreated = promoteEarlyIfReady(s, event.now ?? null, event.remS ?? Infinity);
    return { changed: true, callCreated, outcome: outcomeView(s) };
  }
  if (status === 'PENDING' || status === 'TRANSIENT_FAILURE') o.mappingStatus = status;
  if ((event.remS ?? Infinity) < 100 && o.mappingStatus !== 'VALID') {
    const changed = setOutcomeTerminal(s, 'TOKEN_MAPPING_FAILED');
    return { changed, callCreated: false, outcome: outcomeView(s) };
  }
  return { changed: status != null, callCreated: false, outcome: outcomeView(s) };
}

function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function invalidQuote(meta = {}) {
  return {
    valid: false,
    bestBid: null, bestAsk: null, bidSize: null, askSize: null, mid: null,
    exchangeTimestamp: null,
    receivedTimestamp: Number.isFinite(Number(meta.receivedTimestamp)) ? Number(meta.receivedTimestamp) : null,
    latencyMs: Number.isFinite(Number(meta.latencyMs)) ? Number(meta.latencyMs) : null,
  };
}

export function normalizeOutcomeQuote(book, meta = {}) {
  if (!book || !Array.isArray(book.bids) || !Array.isArray(book.asks)) return invalidQuote(meta);
  const bids = book.bids.map(level => ({ price: finitePositive(level?.price), size: finitePositive(level?.size) }))
    .filter(level => level.price != null && level.size != null);
  const asks = book.asks.map(level => ({ price: finitePositive(level?.price), size: finitePositive(level?.size) }))
    .filter(level => level.price != null && level.size != null);
  if (!bids.length || !asks.length) return invalidQuote(meta);
  const bid = bids.reduce((best, level) => level.price > best.price ? level : best);
  const ask = asks.reduce((best, level) => level.price < best.price ? level : best);
  if (!(ask.price > bid.price)) return invalidQuote(meta);
  const exchangeTimestamp = book.timestamp ?? book.exchange_timestamp ?? null;
  return {
    valid: true,
    bestBid: bid.price,
    bestAsk: ask.price,
    bidSize: bid.size,
    askSize: ask.size,
    mid: (bid.price + ask.price) / 2,
    exchangeTimestamp,
    receivedTimestamp: Number.isFinite(Number(meta.receivedTimestamp)) ? Number(meta.receivedTimestamp) : null,
    latencyMs: Number.isFinite(Number(meta.latencyMs)) ? Number(meta.latencyMs) : null,
  };
}

export function beginQuoteCycle(s, event = {}) {
  const id = Number(event.quoteCycleId);
  if (!Number.isInteger(id) || id <= s.outcomeShadow.latestQuoteCycleId) return false;
  s.outcomeShadow.latestQuoteCycleId = id;
  s.outcomeShadow.processedQuoteResponses = [];
  return true;
}

export function applyOutcomeQuoteEvent(s, event = {}) {
  resetOutcomeEventFlags(s);
  const o = s.outcomeShadow;
  if (o.status !== 'PENDING' || o.terminal) return { changed: false, ignored: 'TERMINAL', outcome: outcomeView(s) };
  const cycleId = Number(event.quoteCycleId);
  if (cycleId < o.latestQuoteCycleId) return { changed: false, ignored: 'STALE_CYCLE', outcome: outcomeView(s) };
  if (cycleId !== o.latestQuoteCycleId) return { changed: false, ignored: 'UNKNOWN_CYCLE', outcome: outcomeView(s) };
  const side = event.responseSide;
  if (side !== 'UP' && side !== 'DOWN') return { changed: false, ignored: 'INVALID_SIDE', outcome: outcomeView(s) };
  const responseKey = `${cycleId}:${side}`;
  if (o.processedQuoteResponses.includes(responseKey)) {
    return { changed: false, ignored: 'DUPLICATE_RESPONSE', outcome: outcomeView(s) };
  }
  o.processedQuoteResponses.push(responseKey);
  if (o.mappingStatus !== 'VALID') return { changed: false, ignored: 'MAPPING_PENDING', outcome: outcomeView(s) };

  const rem = Number(event.receiptRemS);
  if (!Number.isFinite(rem) || rem < 100 || rem > 105) {
    return { changed: false, ignored: 'OUTSIDE_CHECKPOINT', outcome: outcomeView(s) };
  }
  const upQuote = event.upQuote ?? null;
  const downQuote = event.downQuote ?? null;
  const responseQuote = side === 'UP' ? upQuote : downQuote;
  const lead = event.leadSnapshot;
  if (lead === 'MIXED') {
    if (!responseQuote?.valid) return { changed: false, ignored: 'INVALID_QUOTE', outcome: outcomeView(s) };
    o.checkpointEvaluated = true;
    const changed = setOutcomeTerminal(s, 'NON_DIRECTIONAL_SIGNAL');
    return { changed, callCreated: false, outcome: outcomeView(s) };
  }
  if (lead !== 'UP' && lead !== 'DOWN') return { changed: false, ignored: 'INVALID_LEAD', outcome: outcomeView(s) };
  if (side !== lead) return { changed: false, ignored: 'OPPOSITE_SIDE', outcome: outcomeView(s) };
  if (!responseQuote?.valid) return { changed: false, ignored: 'INVALID_QUOTE', outcome: outcomeView(s) };

  o.checkpointEvaluated = true;
  if (Number(event.runAgeSnapshot) < 30) {
    const changed = setOutcomeTerminal(s, 'RUN_TOO_SHORT');
    return { changed, callCreated: false, outcome: outcomeView(s) };
  }
  if (responseQuote.mid > 0.75) {
    const changed = setOutcomeTerminal(s, 'MARKET_PRICED_ABOVE_LIMIT');
    return { changed, callCreated: false, outcome: outcomeView(s) };
  }
  const callCreated = latchOutcome(s, {
    call: lead,
    branch: 'CONFIRMED_DISCOUNTED',
    rem,
    timestamp: event.receiptMs ?? null,
    upMid: upQuote?.valid ? upQuote.mid : null,
    downMid: downQuote?.valid ? downQuote.mid : null,
    signalSideMid: responseQuote.mid,
  });
  return { changed: callCreated, callCreated, outcome: outcomeView(s) };
}

export function applyResumeInvalid(s) {
  s.v9DirectionalSide = null;
  s.v9DirectionalRunAgeTicks = 0;
  s.v9DirectionalRunStartMs = null;
  s.v9DirectionalChangeCount = 0;
  s.v9NowcastSide = null;
  s.v9NowcastPreviousSide = null;
  s.v9NowcastChanged = false;
  s.v9NowcastChangeCount = 0;
  s.v9NowcastFirstSeen = false;
  s.v9NowcastHasSeenDirectional = false;
  s.v9RecencyUpWeight = 0;
  s.v9RecencyDownWeight = 0;
  s.v9RecencyBalance = null;
  s.v9RecencyLastMs = null;
  s.outcomeShadow = {
    ...s.outcomeShadow,
    status: 'NO_CALL', call: null, branch: null,
    reason: 'RESUME_STATE_INVALID', eligible: false, firstSeen: false,
    terminal: true, decisionRem: null, decisionTimestamp: null,
    decisionUpMid: null, decisionDownMid: null, decisionSignalSideMid: null,
    earlyPending: null, checkpointEvaluated: false,
  };
  return outcomeView(s);
}

export function applyOutcomeDeadline(s, { remS, checkpointMissed = false } = {}) {
  resetOutcomeEventFlags(s);
  const o = s.outcomeShadow;
  if (o.status !== 'PENDING' || o.terminal) return { changed: false, ignored: 'TERMINAL', outcome: outcomeView(s) };
  if (checkpointMissed) {
    const changed = setOutcomeTerminal(s, 'CHECKPOINT_MISSED');
    return { changed, callCreated: false, outcome: outcomeView(s) };
  }
  if (o.earlyPending && remS < CFG.EARLY_HARD_REM) {
    const changed = setOutcomeTerminal(s, 'TOKEN_MAPPING_FAILED');
    return { changed, callCreated: false, outcome: outcomeView(s) };
  }
  if (remS < 100) {
    const changed = setOutcomeTerminal(s, o.mappingStatus === 'VALID' ? 'NO_USABLE_QUOTE' : 'TOKEN_MAPPING_FAILED');
    return { changed, callCreated: false, outcome: outcomeView(s) };
  }
  return { changed: false, callCreated: false, outcome: outcomeView(s) };
}

export function serializeSession(s) {
  if (!s || !Array.isArray(s.openHist) || !s.outcomeShadow) throw new TypeError('Invalid engine state');
  return {
    engineStateVersion: ENGINE_STATE_VERSION,
    state: structuredClone(s),
  };
}

const OUTCOME_TERMINAL_REASONS = new Set([
  'NO_USABLE_QUOTE', 'NON_DIRECTIONAL_SIGNAL', 'RUN_TOO_SHORT',
  'MARKET_PRICED_ABOVE_LIMIT', 'CHECKPOINT_MISSED', 'TOKEN_MAPPING_FAILED',
  'UNSUPPORTED_MARKET', 'RESUME_STATE_INVALID',
]);

function validOutcomeSnapshot(o) {
  if (!o || !['PENDING', 'CALLED', 'NO_CALL'].includes(o.status)
    || !Array.isArray(o.processedQuoteResponses)
    || new Set(o.processedQuoteResponses).size !== o.processedQuoteResponses.length
    || !Number.isInteger(o.latestQuoteCycleId) || o.latestQuoteCycleId < 0) return false;
  const mappingValid = o.mappingStatus === 'VALID';
  if (mappingValid !== (typeof o.upTokenId === 'string' && o.upTokenId.length > 0
    && typeof o.downTokenId === 'string' && o.downTokenId.length > 0 && o.upTokenId !== o.downTokenId)) return false;
  if (o.status === 'PENDING') {
    return o.terminal === false && o.call == null && o.branch == null
      && (o.reason === 'WAITING_EARLY' || o.reason === 'WAITING_CHECKPOINT');
  }
  if (o.status === 'CALLED') {
    const branchReason = o.branch === 'EARLY' ? 'EARLY_QUALIFIED'
      : o.branch === 'CONFIRMED_DISCOUNTED' ? 'CONFIRMED_DISCOUNTED' : null;
    return mappingValid && o.terminal === true && (o.call === 'UP' || o.call === 'DOWN')
      && o.reason === branchReason
      && Number.isFinite(o.decisionRem)
      && Number.isFinite(o.decisionTimestamp)
      && Number.isFinite(o.decisionSignalSideMid);
  }
  return o.terminal === true && o.call == null && o.branch == null
    && OUTCOME_TERMINAL_REASONS.has(o.reason);
}

export function restoreSession(snapshot) {
  let parsed = snapshot;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { throw new TypeError('Invalid engine snapshot JSON'); }
  }
  if (!parsed || typeof parsed !== 'object') throw new TypeError('Invalid engine snapshot');
  if (parsed.engineStateVersion !== ENGINE_STATE_VERSION) throw new TypeError('Engine snapshot version mismatch');
  const state = parsed.state;
  if (!state || !Array.isArray(state.openHist) || !Array.isArray(state.priceHist)
    || typeof state.sig8 !== 'string' || !validOutcomeSnapshot(state.outcomeShadow)
    || !Number.isInteger(state.v9DirectionalRunAgeTicks) || state.v9DirectionalRunAgeTicks < 0
    || !Number.isInteger(state.v9DirectionalChangeCount) || state.v9DirectionalChangeCount < 0
    || !Number.isInteger(state.v9NowcastChangeCount) || state.v9NowcastChangeCount < 0
    || typeof state.v9HasTicked !== 'boolean') {
    throw new TypeError('Engine snapshot structure is invalid');
  }
  return structuredClone(state);
}

export function settlementSummary({ open, close, explicitSettlement = null,
  lastNowcastSide = null, outcomeCall = null } = {}) {
  const openValue = Number(open), closeValue = Number(close);
  if (!Number.isFinite(openValue) || !Number.isFinite(closeValue)) {
    return { settled: null, settlementConflict: false, lastNowcastCorrect: null, outcomeCallCorrect: null };
  }
  const settled = closeValue >= openValue ? 'UP' : 'DOWN';
  const explicit = explicitSettlement === 'UP' || explicitSettlement === 'DOWN' ? explicitSettlement : null;
  const settlementConflict = explicit != null && explicit !== settled;
  const nowcast = lastNowcastSide === 'UP' || lastNowcastSide === 'DOWN' ? lastNowcastSide : null;
  const call = outcomeCall === 'UP' || outcomeCall === 'DOWN' ? outcomeCall : null;
  return {
    settled,
    settlementConflict,
    lastNowcastCorrect: settlementConflict || nowcast == null ? null : nowcast === settled,
    outcomeCallCorrect: settlementConflict || call == null ? null : call === settled,
  };
}

export function validateResumeSequence({ rows, sessionTickSeq, latestQuoteCycleId, counters } = {}) {
  if (!Array.isArray(rows) || !Number.isInteger(sessionTickSeq) || sessionTickSeq < 0
    || !Number.isInteger(latestQuoteCycleId) || latestQuoteCycleId < 0) return false;
  const seqs = rows.map(row => row?.session_tick_seq);
  const cycles = rows.map(row => row?.quote_cycle_id).filter(value => value != null);
  if (seqs.some((value, index) => !Number.isInteger(value) || value !== index + 1)
    || new Set(seqs).size !== seqs.length
    || cycles.some((value, index) => !Number.isInteger(value) || value !== index + 1)
    || new Set(cycles).size !== cycles.length
    || seqs.length !== sessionTickSeq || cycles.length !== latestQuoteCycleId
    || (seqs.length ? Math.max(...seqs) : 0) !== sessionTickSeq
    || (cycles.length ? Math.max(...cycles) : 0) !== latestQuoteCycleId) return false;
  const counts = counters && [counters.up, counters.down, counters.mixed];
  return Array.isArray(counts) && counts.every(value => Number.isInteger(value) && value >= 0)
    && counts.reduce((sum, value) => sum + value, 0) === rows.length
    && (counters.last == null || counters.last === 'UP' || counters.last === 'DOWN')
    && typeof counters.locked === 'boolean' && typeof counters.reversal === 'boolean';
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
  const firstV9Tick = !s.v9HasTicked;
  s.v9HasTicked = true;
  resetOutcomeEventFlags(s);
  if (Object.hasOwn(inp, 'marketSupported')) applyMarketSupport(s, inp.marketSupported);
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
  updateDirectionalRun(s, v8.sig, now);
  const nowcast = updateNowcast(s, v8.sig, inp.remS);
  const recency = updateRecency(s, v8.sig, now);
  updateOutcomeForTick(s, early, inp, firstV9Tick);
  return {
    flow,
    cush_d10: deltaAt(s.priceHist, now, 10_000),
    momentum,
    decision: { sig: v8.sig, imbEwma: legacy.imbEwma, note: v8.note, floor: v8.floor, legacySig: legacy.sig, conv },
    early,
    flip,
    v9: {
      directional: directionalView(s, now),
      nowcast,
      recency,
      outcomeShadow: structuredClone(s.outcomeShadow),
    },
  };
}
