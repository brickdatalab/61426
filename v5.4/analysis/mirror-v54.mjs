// Mirror generator: replay every v53 session log through the REAL v5.4 engine
// and emit <slug>_v54m.json counterfactual mirrors (market data verbatim, engine
// outputs replaced, provenance embedded). Mirrors are artifacts — never commit,
// never name _v54 (they are not live sessions).
// Usage: node v5.4/analysis/mirror-v54.mjs <src-dir> <out-dir>
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { newSession, tick } from '../src/signals.mjs';

const [srcDir, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

const r2 = x => x == null ? null : +x.toFixed(2);
const r3 = x => x == null ? null : +x.toFixed(3);
const r1 = x => x == null ? null : +x.toFixed(1);
const ri = x => x == null ? null : Math.round(x);

let made = 0, skipped = [];
for (const f of readdirSync(srcDir).filter(x => /_v53\.json$/.test(x)).sort()) {
  const d = JSON.parse(readFileSync(join(srcDir, f), 'utf8'));
  const settle = d.rows.find(r => r.settled);
  if (!settle) { skipped.push(f); continue; }
  const s = newSession();
  let t = 1700000000000;
  const rows = d.rows.map(r => {
    if (r.settled) return r;                       // settle row verbatim
    t += 1000;
    const res = tick(s, {
      now: t, sinceOpen: r.cvd_since_open,
      price: r.cushion != null ? settle.open + r.cushion : null,
      bimb: r.btc_imb, pimb: r.poly_imb, cushion: r.cushion, remS: r.rem,
      vol1m: r.vol_1m ?? null, largePrints: r.large_prints ?? null,
      efficiency: r.efficiency ?? null, perpSpotDiv: r.perp_spot_div ?? null,
      cvd3m: r.cvd_d3m ?? null,
    });
    if (!res) return r;                            // pre-connect: nothing to recompute
    return { ...r,                                  // market data verbatim; engine outputs replaced:
      signal: res.decision.sig,
      imb_ewma: r3(res.decision.imbEwma),
      mom_z: r2(res.momentum.z), mom_dir: res.momentum.dir,
      cvd_d5: ri(res.flow.d5), cvd_d10: ri(res.flow.d10), cvd_d60: ri(res.flow.d60),
      cush_d10: r1(res.cush_d10),
      p_flip: res.flip && res.flip.p != null ? r3(res.flip.p) : null,
      flip_alert: res.flip ? res.flip.alert : null,
    };
  });
  const slug = d.slug.replace(/_v53$/, '');
  const out = {
    slug: slug + '_v54m',
    mirror: { from: f, engine: 'v5.4', note: 'counterfactual replay — not a live session',
              generated_at: new Date().toISOString() },
    rows,
  };
  writeFileSync(join(outDir, `${slug}_v54m.json`), JSON.stringify(out, null, 1));
  made++;
}
console.log(`mirrors written: ${made} -> ${outDir}` + (skipped.length ? ` | skipped (no settle): ${skipped.join(', ')}` : ''));
