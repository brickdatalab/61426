// Session: one continuous run of a chosen engine version against a market.
//
// Responsibilities:
//  - Tick the engine once per wall-clock second (live) or per driven row (tests),
//    building the exact public log row the v6 dashboard writes (+ staleness/gap in
//    the STATE row only).
//  - Persist state atomically every tick so a crash/reboot can resume.
//  - RESUME-BY-REPLAY: on start with an existing state file, rebuild engine state by
//    replaying the buffered in-bar rows through a fresh newSession() using each row's
//    OWN recorded now_ms (so warmup/momentum/early-call latch reconstruct identically),
//    then continue live.
//  - At bar end (rem<=0) write the <slug>_<version>.json log idempotently and, for a
//    continuous run, advance to the next bar with a fresh engine session.
//
// Additive only — imports the frozen engine via engine-adapter; never edits it.

import path from 'node:path';
import { loadEngine as defaultLoadEngine, buildInp, barEndEpoch, nextSlug } from './engine-adapter.mjs';
import { Scheduler, remFor } from './lib/clock.mjs';
import { writeAtomic, readJson } from './lib/atomic.mjs';

// Shared synthetic-clock base used by the deterministic test drivers and the
// uninterrupted reference replay (helpers.runToEnd). Absolute value is immaterial
// to the engine (it uses only now deltas); spacing is what matters.
export const BASE_MS = 1700000000000;

const DEFAULT_LOG_DIR = '/home/vincent/projects/61426/v5/logs';

// Fields that live ONLY in the persisted state row, never in the public log.
const STATE_ONLY = ['now_ms', 'tape_age_ms', 'book_age_ms', 'gap'];

// Inverse of buildInp: rebuild a tape object from a persisted/captured public row.
// (Same lossy reconstruction replay-compare.mjs uses; signal/early_call are stable
// under it. open supplies bar_open + the price base.)
export function reconstructTape(row, open) {
  return {
    cvd_candle_usd: row.cvd_since_open,
    price: row.cushion != null ? open + row.cushion : null,
    binance_imb: row.btc_imb,
    large_print_net_3m_usd: row.large_prints,
    efficiency_3m: row.efficiency,
    perp_cvd_minus_spot_cvd_5m_usd: row.perp_spot_div,
    cvd_delta_3m: row.cvd_d3m,
    vol_1m_usd: row.vol_1m,
    bar_open: open,
  };
}

export function reconstructBook(row) {
  return { pimb: row.poly_imb, poly_mid: row.poly_mid };
}

function publicOf(stateRow) {
  const r = { ...stateRow };
  for (const k of STATE_ONLY) delete r[k];
  return r;
}

// Build the PUBLIC row with EXACTLY the v6 dashboard keys + rounding (dashboard
// lines 522-545). out (=sg) may be null (engine connect gate).
function buildPublicRow(nowMs, remS, inp, out, book) {
  const t = new Date(nowMs).toISOString().slice(11, 19); // HH:MM:SS UTC
  const bimb = inp.bimb;
  const pimb = inp.pimb;
  const comb = (bimb != null && pimb != null) ? (bimb + pimb) / 2 : (bimb != null ? bimb : pimb);
  const cush = inp.cushion;
  const sg = out;
  const dr = sg ? sg.decision : { sig: 'MIXED' };
  const flip = sg ? sg.flip : null;
  const polyMid = book ? book.poly_mid : null;
  return {
    t, rem: Math.max(0, Math.round(remS)),
    btc_imb: bimb == null ? null : +bimb.toFixed(3),
    poly_imb: pimb == null ? null : +pimb.toFixed(3),
    comb: comb == null ? null : +comb.toFixed(3),
    cushion: cush == null ? null : +cush.toFixed(2),
    cvd: Math.round(inp.sinceOpen ?? 0),
    cvd_since_open: inp.sinceOpen == null ? null : Math.round(inp.sinceOpen),
    cvd_d5: sg && sg.flow.d5 != null ? Math.round(sg.flow.d5) : null,
    cvd_d10: sg && sg.flow.d10 != null ? Math.round(sg.flow.d10) : null,
    cvd_d60: sg && sg.flow.d60 != null ? Math.round(sg.flow.d60) : null,
    cush_d10: sg && sg.cush_d10 != null ? +sg.cush_d10.toFixed(1) : null,
    mom_z: sg ? +sg.momentum.z.toFixed(2) : null,
    mom_dir: sg ? sg.momentum.dir : null,
    imb_ewma: sg && dr.imbEwma != null ? +dr.imbEwma.toFixed(3) : null,
    large_prints: inp.largePrints == null ? null : Math.round(inp.largePrints),
    efficiency: inp.efficiency == null ? null : +(+inp.efficiency).toFixed(3),
    perp_spot_div: inp.perpSpotDiv == null ? null : Math.round(inp.perpSpotDiv),
    cvd_d3m: inp.cvd3m == null ? null : Math.round(inp.cvd3m),
    vol_1m: inp.vol1m == null ? null : +(+inp.vol1m).toFixed(2),
    poly_mid: polyMid == null ? null : +polyMid.toFixed(3),
    p_flip: flip && flip.p != null ? +flip.p.toFixed(3) : null,
    flip_alert: flip ? flip.alert : null,
    signal: sg ? dr.sig : 'MIXED',
    early_call: sg && sg.early ? sg.early.side : null,
    early_tier: sg && sg.early ? sg.early.tier : null,
  };
}

export class Session {
  constructor({
    runId, version, slug, continuousRemaining = 0, stateDir,
    feeds, overrideEngineChange = false, logDir, baseMs = BASE_MS,
    loadEngineImpl = defaultLoadEngine, now = Date.now, setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    this.runId = runId;
    this.version = version;
    this.slug = slug;
    this.continuousRemaining = continuousRemaining;
    this.stateDir = stateDir;
    this.feeds = feeds;
    this.overrideEngineChange = overrideEngineChange;
    this._logDir = logDir || process.env.RUNNER_LOG_DIR || DEFAULT_LOG_DIR;
    this._baseMs = baseMs;
    this._loadEngine = loadEngineImpl;
    this._now = now;
    this._setTimer = setTimer;
    this._clearTimer = clearTimer;

    this.mod = null;
    this.gitHash = null;
    this.engineSession = null;
    this._rows = [];          // in-bar STATE-row buffer
    this._barOpen = null;
    this._barEnd = null;
    this._lastNowMs = null;
    this._lastPrice = null;
    this._replaying = false;
    this._resumeLastSec = null; // gap baseline after resume (last persisted tick sec)
    this._scheduler = null;
    this._initDone = false;
  }

  _stateFile() {
    return path.join(this.stateDir, `${this.runId}.json`);
  }

  // Load engine + resume-or-fresh. No live scheduler (that is start()'s job).
  async _init() {
    if (this._initDone) return;
    const { mod, gitHash } = await this._loadEngine(this.version);
    this.mod = mod;
    this.gitHash = gitHash;

    const existing = readJson(this._stateFile());
    if (existing) {
      if (!this.overrideEngineChange &&
          (existing.engineGitHash !== gitHash || gitHash === 'unknown')) {
        throw new Error(
          `engine git hash changed (state ${existing.engineGitHash}, current ${gitHash})`,
        );
      }
      this.slug = existing.slug;
      this.version = existing.version;
      this.continuousRemaining = existing.continuousRemaining ?? 0;
      this._barOpen = existing.barOpen ?? null;
      this._rows = Array.isArray(existing.rows) ? existing.rows : [];
      this._barEnd = barEndEpoch(this.slug);
      // Reconstruct engine state by replaying buffered rows through a fresh session
      // using each row's OWN now_ms — never re-appending or re-persisting.
      this.engineSession = mod.newSession();
      this._replaying = true;
      for (const r of this._rows) {
        this._tickWith(r.now_ms, reconstructTape(r, this._barOpen), reconstructBook(r), r.rem, {});
      }
      this._replaying = false;
      const last = this._rows[this._rows.length - 1];
      if (last && last.now_ms != null) {
        this._lastNowMs = last.now_ms;
        this._resumeLastSec = Math.floor(last.now_ms / 1000);
      }
    } else {
      this.engineSession = mod.newSession();
      this._rows = [];
      this._barEnd = barEndEpoch(this.slug);
    }
    this._initDone = true;
  }

  // THE single tick path (live + replay + tests).
  _tickWith(nowMs, tape, book, remS, { tapeAgeMs = null, bookAgeMs = null, gap = false } = {}) {
    const inp = buildInp({ now: nowMs, tape, book, barOpen: this._barOpen, remS });
    if (inp.price != null) this._lastPrice = inp.price;
    const out = this.mod.tick(this.engineSession, inp);
    if (this._replaying) return null; // reconstruction only advances engine state
    const stateRow = {
      ...buildPublicRow(nowMs, remS, inp, out, book),
      now_ms: nowMs, tape_age_ms: tapeAgeMs, book_age_ms: bookAgeMs,
    };
    if (gap) stateRow.gap = true;
    this._rows.push(stateRow);
    this._lastNowMs = nowMs;
    this._persist();
    return stateRow;
  }

  // Read both feeds, capture bar_open once, tick.
  _ingestTick(nowMs, remS, { gap = false } = {}) {
    const o = this.feeds.ows.latest();
    const p = this.feeds.poly.latest();
    const tape = o.tape;
    const book = { pimb: p.pimb, poly_mid: p.poly_mid };
    if (this._barOpen == null && tape && tape.bar_open != null) this._barOpen = tape.bar_open;
    return this._tickWith(nowMs, tape, book, remS, { tapeAgeMs: o.ageMs, bookAgeMs: p.ageMs, gap });
  }

  _persist() {
    const doc = {
      runId: this.runId, version: this.version, slug: this.slug,
      continuousRemaining: this.continuousRemaining, barOpen: this._barOpen,
      engineGitHash: this.gitHash, rows: this._rows,
      lastTick: this._rows.length ? this._rows[this._rows.length - 1].t : null,
    };
    writeAtomic(this._stateFile(), JSON.stringify(doc));
  }

  // ---- live path ----
  async start() {
    await this._init();
    this.feeds.ows?.start?.();
    this.feeds.poly?.start?.();
    this._scheduler = new Scheduler({ now: this._now, setTimer: this._setTimer, clearTimer: this._clearTimer });
    this._scheduler.onSecond(({ sec, gapSec }) => this._onSecond(sec, gapSec));
    this._scheduler.start();
  }

  _onSecond(sec, gapSec) {
    const nowMs = sec * 1000;
    let gap;
    if (this._resumeLastSec != null) {
      // First tick after resume: gap is measured against the last persisted tick,
      // NOT the scheduler baseline (A2 finding).
      gap = (sec - this._resumeLastSec) > 1;
      this._resumeLastSec = null;
    } else {
      gap = gapSec > 1;
    }
    const remS = remFor(nowMs, this._barEnd);
    this._ingestTick(nowMs, remS, { gap });
    if (remS <= 0) this._settleAndAdvance(nowMs);
  }

  stop() {
    this._scheduler?.stop?.();
    this._scheduler = null;
    this.feeds.ows?.stop?.();
    this.feeds.poly?.stop?.();
  }

  // ---- settle + continuous advance ----
  _settleAndAdvance(nowMs) {
    const open = this._barOpen;
    const last = this._rows[this._rows.length - 1];
    // Settle close: use the RAW last tape price (full precision), not
    // barOpen + the 2dp-rounded cushion — that rounding can flip UP/DOWN on
    // near-flat bars. Fall back to the cushion reconstruction only if no
    // price was ever seen this bar.
    const close = this._lastPrice != null
      ? this._lastPrice
      : (open != null && last && last.cushion != null) ? open + last.cushion : open;
    const settleRow = {
      t: new Date(nowMs).toISOString().slice(11, 19),
      settled: close > open ? 'UP' : 'DOWN', open, close,
    };
    const rows = this._rows.map(publicOf).concat(settleRow);
    this._writeLogIdempotent(this.slug, rows);

    if (this.continuousRemaining > 0) {
      this.slug = nextSlug(this.slug);
      this._barEnd = barEndEpoch(this.slug);
      this.engineSession = this.mod.newSession();
      this._rows = [];
      this._barOpen = null;
      this._lastNowMs = null;
      this._lastPrice = null;
      this.continuousRemaining -= 1;
      this.feeds.poly?.setSlug?.(this.slug); // prod: repoint the book feed
      this._persist();
    } else {
      this.stop();
    }
  }

  _writeLogIdempotent(slug, rows) {
    const p = path.join(this._logDir, `${slug}_${this.version}.json`);
    const existing = readJson(p);
    if (existing && Array.isArray(existing.rows) && existing.rows.some((r) => r.settled)) {
      return p; // already settled — do not rewrite
    }
    const clean = rows.map((r) => {
      if (r.settled) return r;
      const c = { ...r };
      for (const k of STATE_ONLY) delete c[k];
      return c;
    });
    writeAtomic(p, JSON.stringify({ slug: `${slug}_${this.version}`, rows: clean }));
    return p;
  }

  // ---- introspection ----
  status() {
    return {
      runId: this.runId, version: this.version, slug: this.slug,
      rem: this._lastNowMs != null ? remFor(this._lastNowMs, this._barEnd) : null,
      continuousRemaining: this.continuousRemaining,
      lastTick: this._rows.length ? this._rows[this._rows.length - 1].t : null,
    };
  }

  rowsSince(n) {
    return this._rows.slice(n);
  }

  // ---- deterministic test drivers (synthetic clock: nowMs = base + i*1000) ----
  async playUntilRow(idx) {
    await this._init();
    const rows = this.feeds._rows;
    for (let i = this._rows.length; i <= idx && i < rows.length; i++) {
      this.feeds._seek(i);
      this._ingestTick(this._baseMs + i * 1000, rows[i].rem);
    }
    return this._rows.map(publicOf);
  }

  async playToEnd() {
    await this._init();
    const rows = this.feeds._rows;
    for (let i = this._rows.length; i < rows.length; i++) {
      this.feeds._seek(i);
      this._ingestTick(this._baseMs + i * 1000, rows[i].rem);
    }
    return this._rows.map(publicOf);
  }
}
