export function imbalance(book, band = 0.0012) {
  const bids = book?.bids ?? [];
  const asks = book?.asks ?? [];
  if (bids.length === 0 || asks.length === 0) return 0;
  const bestBid = Math.max(...bids.map(([p]) => p));
  const bestAsk = Math.min(...asks.map(([p]) => p));
  const mid = (bestBid + bestAsk) / 2;
  const lo = mid - mid * band;
  const hi = mid + mid * band;
  let bidUSD = 0, askUSD = 0;
  for (const [p, usd] of bids) if (p >= lo) bidUSD += usd;
  for (const [p, usd] of asks) if (p <= hi) askUSD += usd;
  const tot = bidUSD + askUSD;
  return tot === 0 ? 0 : (bidUSD - askUSD) / tot;
}

export function cvd30s(trades, now, windowMs = 30000) {
  const cutoff = now - windowMs;
  let sum = 0;
  for (const t of trades) if (t.ts >= cutoff) sum += t.signedUSD;
  return sum;
}

export const SYMBOLS = {
  binance:  { BTC: 'BTCUSDT',       ETH: 'ETHUSDT' },
  okx:      { BTC: 'BTC-USDT-SWAP', ETH: 'ETH-USDT-SWAP' },
  coinbase: { BTC: 'BTC-USD',       ETH: 'ETH-USD' },
};
export const OKX_CTVAL = { BTC: 0.01, ETH: 0.1 };

export function normalizeBinance(raw) {
  const book = {
    bids: raw.book.bids.map(([p, q]) => [+p, +p * +q]),
    asks: raw.book.asks.map(([p, q]) => [+p, +p * +q]),
  };
  const trades = raw.trades.map((t) => ({
    ts: +t.T,
    signedUSD: (t.m ? -1 : 1) * +t.p * +t.q, // m=true: buyer is maker => sell aggressor
  }));
  return { book, trades };
}

export function normalizeOkx(raw, asset) {
  const ct = OKX_CTVAL[asset];
  const b = raw.book.data[0];
  const book = {
    bids: b.bids.map(([p, sz]) => [+p, +p * +sz * ct]),
    asks: b.asks.map(([p, sz]) => [+p, +p * +sz * ct]),
  };
  const trades = raw.trades.data.map((t) => ({
    ts: +t.ts,
    signedUSD: (t.side === 'buy' ? 1 : -1) * +t.px * +t.sz * ct,
  }));
  return { book, trades };
}

export function normalizeCoinbase(raw) {
  const book = {
    bids: raw.book.bids.map(([p, s]) => [+p, +p * +s]),
    asks: raw.book.asks.map(([p, s]) => [+p, +p * +s]),
  };
  // Coinbase Exchange trade `side` is the MAKER side; taker is the opposite.
  // side='sell' => maker sold => taker BOUGHT => +.  VERIFY live in smoke (Task 7).
  const trades = raw.trades.map((t) => ({
    ts: Date.parse(t.time),
    signedUSD: (t.side === 'sell' ? 1 : -1) * +t.price * +t.size,
  }));
  return { book, trades };
}

export const NORMALIZERS = {
  binance: normalizeBinance,
  okx: normalizeOkx,
  coinbase: normalizeCoinbase,
};
