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
