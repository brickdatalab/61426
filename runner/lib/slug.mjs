const SYM = { btc:'BTCUSDT', eth:'ETHUSDT', sol:'SOLUSDT', xrp:'XRPUSDT', doge:'DOGEUSDT' };
const RE = /^([a-z]+)-updown-(\d+)([mh])-(\d+)$/;
export function parseSlug(slug){
  const m = String(slug).trim().toLowerCase().match(RE);
  if(!m) return null;
  const [,asset,n,unit,ts]=m, num=+n, barSec=num*(unit==='h'?3600:60);
  return { asset, symbol: SYM[asset]||asset.toUpperCase()+'USDT', interval:num+unit, barSec, ts:+ts, end:+ts+barSec, label:`${asset.toUpperCase()} ${num}${unit}` };
}
export function barEndEpoch(slug){ const p=parseSlug(slug); return p.end; }
export function nextSlug(slug){ const p=parseSlug(slug); return `${p.asset}-updown-${p.interval}-${p.ts+p.barSec}`; }
