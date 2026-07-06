// Polymarket book feed: bookStats parity port of the v6 dashboard bookStats
// (v6/updown-liquidity-overlap.html lines 253-259) + CLOB token resolution (Gamma)
// + book polling with a 900ms fetch cap + error/429 backoff. Self-driving via
// injectable fetchImpl/now/setTimer (no network needed in tests) — mirrors the
// OwsFeed shape so session.mjs can treat both feeds the same way.

const GAMMA_BASE = 'https://gamma-api.polymarket.com/events?slug=';
const CLOB_BOOK_BASE = 'https://clob.polymarket.com/book?token_id=';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
export const POLY_BAND = 0.06;

// Verbatim port of the dashboard's bookStats, specialized to [price, size] pairs
// (dashboard passes priceKey=0, sizeKey=1 for Polymarket book levels).
export function bookStats(bids, asks, mid, band = POLY_BAND) {
  let bd = 0, ad = 0;
  for (const b of bids) {
    const p = +b[0], s = +b[1] * p;
    if (Math.abs(p - mid) <= mid * band || Math.abs(p - mid) <= band) {
      if (p <= mid) bd += s;
    }
  }
  for (const a of asks) {
    const p = +a[0], s = +a[1] * p;
    if (Math.abs(p - mid) <= mid * band || Math.abs(p - mid) <= band) {
      if (p >= mid) ad += s;
    }
  }
  const imb = (bd + ad) ? (bd - ad) / (bd + ad) : 0;
  return { imb, bd, ad };
}

export function _backoffMs(n) {
  return Math.min(1000 * 2 ** n, 30000);
}

export class PolyFeed {
  constructor(slug, opts = {}) {
    this.slug = slug;
    this._fetch = opts.fetchImpl || fetch;
    this._now = opts.now || (() => Date.now());
    this._setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
    this._pollMs = opts.pollMs ?? 1000;
    this._band = opts.band ?? POLY_BAND;
    this._token = null;
    this._pimb = null;
    this._polyMid = null;
    this._lastOkTs = null;
    this._backoffN = 0;
    this._stopped = true;
  }

  _backoffMs(n) {
    return _backoffMs(n);
  }

  async start() {
    this._stopped = false;
    await this._resolveToken();
    this._scheduleNext();
  }

  stop() {
    this._stopped = true;
  }

  _scheduleNext() {
    if (this._stopped) return;
    const delay = (this._token && this._backoffN === 0) ? this._pollMs : this._backoffMs(this._backoffN);
    this._setTimer(() => this._tick(), delay);
  }

  async _tick() {
    if (this._stopped) return;
    if (!this._token) {
      await this._resolveToken();
    } else {
      await this._pollBook();
    }
    this._scheduleNext();
  }

  async _resolveToken() {
    try {
      const r = await this._fetch(`${GAMMA_BASE}${this.slug}`, { headers: { 'User-Agent': BROWSER_UA } });
      if (!r.ok) throw new Error(String(r.status));
      const j = await r.json();
      const e = Array.isArray(j) ? j[0] : j; // Gamma /events?slug= returns an array (mirrors dashboard's Array.isArray(ev)?ev[0]:ev)
      let ids = e?.markets?.[0]?.clobTokenIds;
      if (typeof ids === 'string') ids = JSON.parse(ids);
      const token = ids?.[0];
      if (!token) throw new Error('no token');
      this._token = token;
      this._backoffN = 0;
    } catch {
      this._token = null; // no throw — never stall the tick loop
      this._backoffN = Math.min(this._backoffN + 1, 10);
    }
  }

  async _pollBook() {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 900); // cap: a slow Polymarket costs poly fields, never cadence
    try {
      const r = await this._fetch(`${CLOB_BOOK_BASE}${this._token}`, { signal: ac.signal });
      if (!r.ok) throw new Error(String(r.status));
      const book = await r.json();
      const bids = book?.bids || [];
      const asks = book?.asks || [];
      if (bids.length && asks.length) {
        const bb = Math.max(...bids.map((b) => +b.price));
        const ba = Math.min(...asks.map((a) => +a.price));
        const mid = (bb + ba) / 2;
        const stats = bookStats(
          bids.map((b) => [b.price, b.size]),
          asks.map((a) => [a.price, a.size]),
          mid,
          this._band,
        );
        this._pimb = stats.imb;
        this._polyMid = mid;
        this._lastOkTs = this._now();
      }
      this._backoffN = 0;
    } catch {
      this._backoffN = Math.min(this._backoffN + 1, 10); // no throw — never stall the tick loop
    } finally {
      clearTimeout(timer);
    }
  }

  latest() {
    return {
      pimb: this._pimb,
      poly_mid: this._polyMid,
      ageMs: this._lastOkTs == null ? null : this._now() - this._lastOkTs,
    };
  }
}
