import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
export { parseSlug, barEndEpoch, nextSlug } from './lib/slug.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function loadEngine(version){
  const rel = `${version}/src/signals.mjs`;
  const mod = await import(path.join(REPO, rel));
  let gitHash = 'unknown';
  try { gitHash = execFileSync('git', ['-C', REPO, 'log','-1','--format=%H','--', rel], {encoding:'utf8'}).trim(); } catch {}
  return { mod, gitHash };
}

// EXACT inp the dashboard feeds V5.sigTick (v6 dashboard lines 404-410)
export function buildInp({ now, tape, book, barOpen, remS }){
  const price = tape?.price ?? null;
  const open = barOpen ?? tape?.bar_open ?? null;
  return {
    now,
    sinceOpen: tape?.cvd_candle_usd ?? null,
    price,
    bimb: tape?.binance_imb ?? null,
    pimb: book?.pimb ?? null,
    largePrints: tape?.large_print_net_3m_usd ?? null,
    efficiency: tape?.efficiency_3m ?? null,
    perpSpotDiv: tape?.perp_cvd_minus_spot_cvd_5m_usd ?? null,
    cvd3m: tape?.cvd_delta_3m ?? null,
    cushion: (price!=null && open!=null) ? price-open : null,
    remS,
    vol1m: tape?.vol_1m_usd ?? null,
  };
}
