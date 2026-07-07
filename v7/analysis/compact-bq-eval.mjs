import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const BQ = join(HERE, '..', '..', 'v6', 'analysis', 'bqbars');
const OUT = join(HERE, 'bq_eval.jsonl');
const COLS = ['rem','poly_mid','cushion','cvd_since_open','cvd_d3m','vol_1m','btc_imb','poly_imb','large_prints','perp_spot_div'];
if (!existsSync(BQ)) { console.error('no bqbars dir'); process.exit(1); }
const files = readdirSync(BQ).filter(f => /_bq\.json$/.test(f));
const lines = [JSON.stringify({ cols: COLS, note: 'v7 OOS eval; rows = first 2 min (rem 180-300)' })];
let kept = 0, epochs = [];
for (const f of files.sort()) {
const d = JSON.parse(readFileSync(join(BQ, f), 'utf8'));
const srow = d.rows.find(r => r.settled);
const body = d.rows.filter(r => !r.settled && r.rem != null && r.rem >= 180 && r.rem <= 300);
if (!srow || body.length < 30) continue;
const m = d.slug.match(/-(\d+)$/); if (m) epochs.push(+m[1]);
lines.push(JSON.stringify({ slug: d.slug, settle: srow.settled, open: srow.open, close: srow.close, rows: body.map(r => COLS.map(c => r[c] ?? null)) }));
kept++;
}
writeFileSync(OUT, lines.join('\n') + '\n');
epochs.sort((a,b)=>a-b);
console.log('bars kept:', kept, 'of', files.length);
if (epochs.length) console.log('epoch span:', epochs[0], '..', epochs[epochs.length-1], '(', new Date(epochs[0]*1000).toISOString(), '..', new Date(epochs[epochs.length-1]*1000).toISOString(), ')');
