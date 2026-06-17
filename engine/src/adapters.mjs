// engine/src/adapters.mjs
import { SYMBOLS } from './core.mjs';

export function venueUrls(venue, asset) {
  const s = SYMBOLS[venue][asset];
  switch (venue) {
    case 'binance':
      return {
        book:   `https://fapi.binance.com/fapi/v1/depth?symbol=${s}&limit=100`,
        trades: `https://fapi.binance.com/fapi/v1/aggTrades?symbol=${s}&limit=1000`,
      };
    case 'okx':
      return {
        book:   `https://www.okx.com/api/v5/market/books?instId=${s}&sz=50`,
        trades: `https://www.okx.com/api/v5/market/trades?instId=${s}&limit=500`,
      };
    case 'coinbase':
      return {
        book:   `https://api.exchange.coinbase.com/products/${s}/book?level=2`,
        trades: `https://api.exchange.coinbase.com/products/${s}/trades?limit=200`,
      };
    default:
      throw new Error(`unknown venue ${venue}`);
  }
}

export async function fetchVenue(venue, asset, { timeoutMs = 2500, fetchImpl = fetch } = {}) {
  const fetchedAt = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const { book: bUrl, trades: tUrl } = venueUrls(venue, asset);
    const [bRes, tRes] = await Promise.all([
      fetchImpl(bUrl, { signal: ctrl.signal }),
      fetchImpl(tUrl, { signal: ctrl.signal }),
    ]);
    if (!bRes.ok || !tRes.ok) return { ok: false, raw: null, fetchedAt };
    const [book, trades] = await Promise.all([bRes.json(), tRes.json()]);
    return { ok: true, raw: { book, trades }, fetchedAt };
  } catch {
    return { ok: false, raw: null, fetchedAt };
  } finally {
    clearTimeout(timer);
  }
}
