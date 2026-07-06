// Pre-deploy sanity check: constructs the REAL feeds against the live market and
// prints what they resolve, plus the mapped `inp`. Not a unit test — it hits the
// network, so run it manually on the VM before a deploy:
//   OWS_BASE=ws://127.0.0.1 node tools/first-light.mjs [btc|eth] [5m]
// It caught the PolyFeed Gamma-array-unwrap bug that the unit fixtures missed.
import { OwsFeed } from '../feeds/ows.mjs';
import { PolyFeed } from '../feeds/poly.mjs';
import { buildInp } from '../engine-adapter.mjs';

const asset = (process.argv[2] || 'btc').toLowerCase();
const interval = process.argv[3] || '5m';
const SYM = { btc: 'BTCUSDT', eth: 'ETHUSDT' };
const barSec = (interval.endsWith('h') ? 3600 : 60) * parseInt(interval, 10);
const now = Date.now();
const ep = Math.floor(now / (barSec * 1000)) * barSec;
const slug = `${asset}-updown-${interval}-${ep}`;
console.log('slug:', slug, '| bar ends in', ep + barSec - Math.floor(now / 1000), 's');

const ows = new OwsFeed(SYM[asset] || asset.toUpperCase() + 'USDT', interval);
ows.start();
const poly = new PolyFeed(slug);
await poly.start();
await new Promise((r) => setTimeout(r, 8000));

const o = ows.latest();
const p = poly.latest();
console.log('OWS  tape_age_ms:', o.ageMs, '| keys:', o.tape ? Object.keys(o.tape).length : 'NULL');
if (o.tape) console.log('     price:', o.tape.price, 'bar_open:', o.tape.bar_open, 'binance_imb:', o.tape.binance_imb, 'cvd:', o.tape.cvd_candle_usd, 'vol1m:', o.tape.vol_1m_usd);
console.log('POLY book_age_ms:', p.ageMs, '| pimb:', p.pimb, '| poly_mid:', p.poly_mid);
const inp = buildInp({ now: Date.now(), tape: o.tape, book: { pimb: p.pimb, poly_mid: p.poly_mid }, barOpen: o.tape?.bar_open, remS: ep + barSec - Math.floor(Date.now() / 1000) });
console.log('mapped inp:', JSON.stringify({ sinceOpen: inp.sinceOpen, price: inp.price, bimb: inp.bimb, pimb: inp.pimb, cushion: inp.cushion, vol1m: inp.vol1m, cvd3m: inp.cvd3m, remS: inp.remS }));
const ok = o.tape && p.pimb != null && p.poly_mid != null;
console.log(ok ? 'FIRST-LIGHT OK' : 'FIRST-LIGHT DEGRADED (a feed is null)');
process.exit(ok ? 0 : 1);
