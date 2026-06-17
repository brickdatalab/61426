// engine/src/engine.mjs
import { fetchVenue } from './adapters.mjs';
import { buildTick } from './core.mjs';

const VENUES = ['binance', 'okx', 'coinbase'];

export async function runOnce({ asset, now = Date.now(), fetchVenueImpl = fetchVenue }) {
  const settled = await Promise.all(VENUES.map((v) => fetchVenueImpl(v, asset)));
  const results = {};
  VENUES.forEach((v, i) => { results[v] = settled[i]; });
  return buildTick({ asset, now, results });
}

export function runEngine({ asset, onTick, intervalMs = 1000, fetchVenueImpl = fetchVenue }) {
  let stopped = false;
  const loop = async () => {
    if (stopped) return;
    try { onTick(await runOnce({ asset, fetchVenueImpl })); } catch { /* never break the loop */ }
  };
  loop();
  const id = setInterval(loop, intervalMs);
  return () => { stopped = true; clearInterval(id); };
}
