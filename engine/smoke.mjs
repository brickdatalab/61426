// engine/smoke.mjs
// Live network. Run: node engine/smoke.mjs BTC   (or ETH)
import { runOnce } from './src/engine.mjs';

const asset = (process.argv[2] || 'BTC').toUpperCase();
console.log(`Live smoke: ${asset} — 8 ticks, ~1s apart\n`);
let prevMidNote = '';
for (let i = 0; i < 8; i++) {
  const t = await runOnce({ asset });
  const h = t.health;
  const dots = `B:${h.binance ? 'OK' : '--'} O:${h.okx ? 'OK' : '--'} C:${h.coinbase ? 'OK' : '--'}`;
  const imb = t.blended.imbalance == null ? '—' : t.blended.imbalance.toFixed(3);
  const cvd = t.blended.cvd == null ? '—' : Math.round(t.blended.cvd).toLocaleString();
  console.log(`#${i + 1} [${dots}] imbalance=${imb}  cvd30s=$${cvd}  (nFresh=${t.blended.nFresh})`);
  // Coinbase sign sanity: print its raw imbalance vs cvd direction for manual review
  if (t.venues.coinbase.fresh) {
    console.log(`     coinbase cvd=$${Math.round(t.venues.coinbase.cvd).toLocaleString()}  imb=${t.venues.coinbase.imb.toFixed(3)}`);
  }
  await new Promise((r) => setTimeout(r, 1000));
}
console.log('\nCoinbase sign check: over a stretch where price rises, coinbase cvd should trend POSITIVE.');
console.log('If it trends opposite to price, flip the sign in normalizeCoinbase (core.mjs) and re-run tests.');
