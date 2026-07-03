// 24/7 tick collector — 4 streams (BTC/ETH x 5m/15m) -> BigQuery raw_d.
//
// Standalone World-2 service: connects to ourWebSocket as a plain WS client,
// polls the Polymarket CLOB book, runs BOTH signal engines (v5.3 + v5.4,
// verbatim copies in ./engines) on the identical input each second, and ships
// rows to BigQuery in 30s batches (NDJSON spool + retry on failure).
// It never writes JSON session logs and never touches the dashboard world.
//
// Tick input assembly, Polymarket book math, row field names and rounding are
// transcribed EXACTLY from v5.3/updown-liquidity-overlap.html tick().
// Settle verdict comes from Polymarket's official resolution ONLY.
import { readFileSync, writeFileSync, existsSync, unlinkSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as v53 from './engines/v53-signals.mjs';
import * as v54 from './engines/v54-signals.mjs';

export const STREAMS = [
  { asset: 'btc', symbol: 'BTCUSDT', interval: '5m',  barSec: 300 },
  { asset: 'btc', symbol: 'BTCUSDT', interval: '15m', barSec: 900 },
  { asset: 'eth', symbol: 'ETHUSDT', interval: '5m',  barSec: 300 },
  { asset: 'eth', symbol: 'ETHUSDT', interval: '15m', barSec: 900 },
];

export const slugFor = (stream, ts) => `${stream.asset}-updown-${stream.interval}-${ts}`;

// dashboard: POLY_BAND=0.06; pmid=(max bid+min ask)/2; bookStats(...) with value=price*size
const POLY_BAND = 0.06;
export function polyStats(book) {
  if (!book || !book.bids || !book.asks || !book.bids.length || !book.asks.length) return { pmid: null, pimb: null };
  const bb = Math.max(...book.bids.map(b => +b.price)), ba = Math.min(...book.asks.map(a => +a.price));
  const mid = (bb + ba) / 2;
  let bd = 0, ad = 0;
  for (const b of book.bids) { const p = +b.price, s = +b.size * p; if ((Math.abs(p - mid) <= mid * POLY_BAND || Math.abs(p - mid) <= POLY_BAND) && p <= mid) bd += s; }
  for (const a of book.asks) { const p = +a.price, s = +a.size * p; if ((Math.abs(p - mid) <= mid * POLY_BAND || Math.abs(p - mid) <= POLY_BAND) && p >= mid) ad += s; }
  return { pmid: mid, pimb: (bd + ad) ? (bd - ad) / (bd + ad) : 0 };
}

// dashboard tick(): the exact object handed to V5.sigTick
export function buildInp(sv, nowMs, remS, pimb) {
  const cush = (sv.last != null && sv.open != null) ? sv.last - sv.open : null;
  return {
    now: nowMs,
    sinceOpen: sv.owsSinceOpen, price: sv.last,
    bimb: sv.owsImb ?? null, pimb: pimb ?? null,
    largePrints: sv.owsLargePrints, efficiency: sv.owsEfficiency,
    perpSpotDiv: sv.owsPerpSpotDiv, cvd3m: sv.owsCvd3m,
    cushion: cush, remS, vol1m: sv.owsVol1m ?? null,
  };
}

// dashboard row (same names, same rounding) + paired engine outputs
export function buildRow(sv, date, rem, pimb, pmid, sg53, sg54) {
  const bimb = sv.owsImb ?? null;
  const comb = (bimb != null && pimb != null) ? (bimb + pimb) / 2 : (bimb != null ? bimb : pimb);
  const cush = (sv.last != null && sv.open != null) ? sv.last - sv.open : null;
  const cvd = sv.owsCvd1m ?? sv.cvdSticky ?? 0;          // dashboard: st.cvd = owsCvd1m ?? st.cvd ?? 0
  sv.cvdSticky = cvd;
  const eng = (sg, run) => sg ? {
    imb_ewma: sg.decision.imbEwma != null ? +sg.decision.imbEwma.toFixed(3) : null,
    signal: sg.decision.sig, note: sg.decision.note || null,
    pending: sg.decision.pendingSig ?? null, run,
    p_flip: sg.flip && sg.flip.p != null ? +sg.flip.p.toFixed(3) : null,
    flip_alert: sg.flip ? sg.flip.alert : null,
  } : { imb_ewma: null, signal: 'MIXED', note: null, pending: null, run: null, p_flip: null, flip_alert: null };
  const e53 = eng(sg53, sv.run53 ?? null), e54 = eng(sg54, sv.run54 ?? null);
  const sg = sg53;                                        // shared math (momentum/flow identical across engines)
  return {
    ts: date.toISOString(),
    symbol: sv.asset.toUpperCase(), bar_interval: sv.interval, slug: sv.slug,
    t: date.toISOString().substr(11, 8), rem: Math.max(0, Math.round(rem)),
    btc_imb: bimb == null ? null : +bimb.toFixed(3), poly_imb: pimb == null ? null : +pimb.toFixed(3), comb: comb == null ? null : +comb.toFixed(3),
    cushion: cush == null ? null : +cush.toFixed(2), cvd: Math.round(cvd),
    cvd_since_open: sv.owsSinceOpen == null ? null : Math.round(sv.owsSinceOpen),
    cvd_d5: sg && sg.flow.d5 != null ? Math.round(sg.flow.d5) : null,
    cvd_d10: sg && sg.flow.d10 != null ? Math.round(sg.flow.d10) : null,
    cvd_d60: sg && sg.flow.d60 != null ? Math.round(sg.flow.d60) : null,
    cush_d10: sg && sg.cush_d10 != null ? +sg.cush_d10.toFixed(1) : null,
    mom_z: sg ? +sg.momentum.z.toFixed(2) : null, mom_dir: sg ? sg.momentum.dir : null,
    mom_slope: sg && sg.momentum.slope != null ? Math.round(sg.momentum.slope) : null,
    large_prints: sv.owsLargePrints == null ? null : Math.round(sv.owsLargePrints),
    efficiency: sv.owsEfficiency == null ? null : +(+sv.owsEfficiency).toFixed(3),
    perp_spot_div: sv.owsPerpSpotDiv == null ? null : Math.round(sv.owsPerpSpotDiv),
    cvd_d3m: sv.owsCvd3m == null ? null : Math.round(sv.owsCvd3m),
    vol_1m: sv.owsVol1m == null ? null : +(+sv.owsVol1m).toFixed(2),
    poly_mid: pmid == null ? null : +pmid.toFixed(3),
    price: sv.last ?? null, bar_open: sv.open ?? null,
    imb_ewma_v53: e53.imb_ewma, signal_v53: e53.signal, note_v53: e53.note, run_v53: e53.run, pending_v53: e53.pending,
    p_flip_v53: e53.p_flip, flip_alert_v53: e53.flip_alert,
    imb_ewma_v54: e54.imb_ewma, signal_v54: e54.signal, note_v54: e54.note, run_v54: e54.run, pending_v54: e54.pending,
    p_flip_v54: e54.p_flip, flip_alert_v54: e54.flip_alert,
  };
}

// Polymarket official resolution from a gamma event: 'UP' | 'DOWN' | null (not resolved yet)
export function resolveOutcome(event) {
  const m = event && Array.isArray(event.markets) ? event.markets[0] : null;
  if (!m) return null;
  const parse = (x) => typeof x === 'string' ? JSON.parse(x) : x;
  let outcomes, prices;
  try { outcomes = parse(m.outcomes); prices = parse(m.outcomePrices); } catch { return null; }
  if (!Array.isArray(outcomes) || !Array.isArray(prices)) return null;
  const resolved = m.umaResolutionStatus === 'resolved' && prices.some(p => +p === 1);
  if (!resolved) return null;
  const i = prices.findIndex(p => +p === 1);
  return i >= 0 ? String(outcomes[i]).toUpperCase() : null;
}

// Buffered inserter: rows accumulate, flush() sends one batch; failures spool
// to NDJSON on disk and are retried on the next flush. Nothing lost to a blip.
export class Batcher {
  constructor({ spoolPath, insert }) { this.spoolPath = spoolPath; this.insert = insert; this.buf = []; }
  push(row) { this.buf.push(row); }
  async flush() {
    let rows = this.buf; this.buf = [];
    if (existsSync(this.spoolPath)) {
      const spooled = readFileSync(this.spoolPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
      rows = spooled.concat(rows);
    }
    if (!rows.length) return 0;
    try {
      await this.insert(rows);
      if (existsSync(this.spoolPath)) unlinkSync(this.spoolPath);
      return rows.length;
    } catch (e) {
      writeFileSync(this.spoolPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
      console.error(`[batcher] insert failed (${e.message}); ${rows.length} rows spooled`);
      return 0;
    }
  }
}

// ======================= runtime (not unit-tested) =======================
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const { BigQuery } = await import('@google-cloud/bigquery');
  const WebSocket = (await import('ws')).default;

  const PROJECT = 'strange-mason-474823-e0', DATASET = 'raw_d';
  const OWS_URL = process.env.OWS_URL || 'ws://localhost/ws/v5/tape';
  const bq = new BigQuery({ projectId: PROJECT });
  const ds = bq.dataset(DATASET);
  const here = (p) => fileURLToPath(new URL(p, import.meta.url));

  const tickBatcher = new Batcher({
    spoolPath: here('./spool-ticks.ndjson'),
    insert: (rows) => ds.table('ticks').insert(rows),
  });
  const barBatcher = new Batcher({
    spoolPath: here('./spool-bars.ndjson'),
    insert: (rows) => ds.table('bars').insert(rows),
  });

  const jget = async (u, timeoutMs = 2500) => {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
    try { const r = await fetch(u, { signal: ac.signal }); if (!r.ok) throw new Error(r.status); return await r.json(); }
    finally { clearTimeout(t); }
  };

  function newBarState(sv) {
    const nowSec = Date.now() / 1000;
    sv.ts = Math.floor(nowSec / sv.barSec) * sv.barSec;
    sv.end = sv.ts + sv.barSec;
    sv.slug = slugFor(sv, sv.ts);
    sv.s53 = v53.newSession(); sv.s54 = v54.newSession();
    sv.run53 = 0; sv.run54 = 0; sv.runVal53 = null; sv.runVal54 = null;
    sv.token = null; sv.tickCount = 0; sv.barOpenSeen = null;
    fetchToken(sv);
    console.log(`[${sv.tag}] bar ${sv.slug} (ends ${new Date(sv.end * 1000).toISOString().substr(11, 8)})`);
  }

  async function fetchToken(sv, attempt = 0) {
    const slug = sv.slug;
    try {
      const ev = await jget('https://gamma-api.polymarket.com/events?slug=' + encodeURIComponent(slug));
      const e = Array.isArray(ev) ? ev[0] : ev;
      let tk = e.markets[0].clobTokenIds; if (typeof tk === 'string') tk = JSON.parse(tk);
      if (sv.slug === slug) sv.token = tk[0];
    } catch (e) {
      if (sv.slug === slug && attempt < 20) setTimeout(() => fetchToken(sv, attempt + 1), 5000);
    }
  }

  // Polymarket resolution poller: starts 15s after bar end, retries every 10s
  // up to 18 attempts (~3 min), then writes the bars row (settled null if never resolved).
  function scheduleResolution(sv, snap) {
    let attempts = 0;
    const poll = async () => {
      attempts++;
      let outcome = null;
      try { const ev = await jget('https://gamma-api.polymarket.com/events?slug=' + encodeURIComponent(snap.slug)); outcome = resolveOutcome(Array.isArray(ev) ? ev[0] : ev); } catch { }
      if (outcome || attempts >= 18) {
        barBatcher.push({
          slug: snap.slug, symbol: snap.symbol, bar_interval: snap.interval,
          bar_start: new Date(snap.ts * 1000).toISOString(), bar_end: new Date(snap.end * 1000).toISOString(),
          open: snap.open, close: snap.close, settled: outcome,
          resolved_at: outcome ? new Date().toISOString() : null, resolution_attempts: attempts,
          tick_count: snap.tickCount,
        });
        console.log(`[${snap.tag}] ${snap.slug} settled=${outcome ?? 'UNRESOLVED'} (${attempts} attempts, ${snap.tickCount} ticks)`);
      } else setTimeout(poll, 10000);
    };
    setTimeout(poll, 15000);
  }

  function connectWS(sv) {
    if (sv.ws) { try { sv.ws.removeAllListeners(); sv.ws.close(); } catch { } sv.ws = null; }
    const w = new WebSocket(`${OWS_URL}?symbol=${sv.symbol}&bar=${sv.interval}`);
    sv.ws = w;
    w.on('message', (data) => {
      sv.lastOwsMsg = Date.now();
      let m; try { m = JSON.parse(data); } catch { return; }
      if (m.tape) {
        sv.owsCvd1m = m.tape.cvd_delta_1m; sv.owsCvd3m = m.tape.cvd_delta_3m;
        sv.owsSinceOpen = m.tape.cvd_candle_usd; sv.owsLargePrints = m.tape.large_print_net_3m_usd;
        sv.owsEfficiency = m.tape.efficiency_3m;
        if (m.tape.price != null) sv.last = m.tape.price;
        if (m.tape.bar_open != null) sv.open = m.tape.bar_open;
        sv.owsImb = m.tape.binance_imb; sv.owsVol1m = m.tape.vol_1m_usd ?? null;
      }
      if (m.perp_spot_divergence) sv.owsPerpSpotDiv = m.perp_spot_divergence.perp_cvd_minus_spot_cvd_5m_usd;
    });
    w.on('error', () => { });
    w.on('close', () => { if (!sv.stopped) setTimeout(() => connectWS(sv), 1000); });
  }

  async function tick(sv) {
    if (sv.inTick) return;          // never stack ticks (slow PM fetch)
    sv.inTick = true;
    try {
      const nowSec = Date.now() / 1000;
      if (nowSec >= sv.end) {
        scheduleResolution(sv, { slug: sv.slug, symbol: sv.asset.toUpperCase(), interval: sv.interval, tag: sv.tag, ts: sv.ts, end: sv.end, open: sv.open ?? null, close: sv.last ?? null, tickCount: sv.tickCount });
        newBarState(sv);            // roll to the next market immediately
        return;
      }
      const rem = sv.end - nowSec;
      let book = null;
      if (sv.token) { try { book = await jget('https://clob.polymarket.com/book?token_id=' + sv.token, 900); } catch { book = null; } }
      const { pmid, pimb } = polyStats(book);
      const inp = buildInp(sv, Date.now(), rem, pimb);
      const sg53 = v53.tick(sv.s53, inp);
      const sg54 = v54.tick(sv.s54, inp);
      // per-engine consecutive-run counters (dashboard st.sigRun semantics)
      sv.run53 = (sg53.decision.sig === sv.runVal53) ? sv.run53 + 1 : 1; sv.runVal53 = sg53.decision.sig;
      sv.run54 = (sg54.decision.sig === sv.runVal54) ? sv.run54 + 1 : 1; sv.runVal54 = sg54.decision.sig;
      tickBatcher.push(buildRow(sv, new Date(), rem, pimb, pmid, sg53, sg54));
      sv.tickCount++;
    } catch (e) {
      console.error(`[${sv.tag}] tick error: ${e.message}`);
    } finally { sv.inTick = false; }
  }

  // ---- boot all four streams, staggered so PM requests don't align ----
  const streams = STREAMS.map((s, i) => {
    const sv = { ...s, tag: `${s.asset}-${s.interval}`, stopped: false, cvdSticky: 0 };
    newBarState(sv);
    connectWS(sv);
    setTimeout(() => setInterval(() => tick(sv), 1000), i * 250);
    return sv;
  });

  // WS staleness watchdog (dashboard: >5s without a message -> reconnect)
  setInterval(() => {
    for (const sv of streams) if (sv.lastOwsMsg && Date.now() - sv.lastOwsMsg > 5000) connectWS(sv);
  }, 3000);

  setInterval(async () => {
    const n = await tickBatcher.flush();
    await barBatcher.flush();
    if (n) console.log(`[bq] +${n} tick rows`);
  }, 30000);

  process.on('SIGTERM', async () => { for (const sv of streams) sv.stopped = true; await tickBatcher.flush(); await barBatcher.flush(); process.exit(0); });
  console.log(`collector up: ${streams.map(s => s.tag).join(', ')} -> ${PROJECT}.${DATASET}`);
}
