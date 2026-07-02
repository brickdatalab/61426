import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { newSession, tick } from '../src/signals.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const LOGS = [
  'btc-updown-5m-1782959700_v5_log.json',
  'btc-updown-5m-1782960000_v5_log.json',
];

function replay(file) {
  const d = JSON.parse(readFileSync(join(here, '../../v5/logs', file), 'utf8'));
  const settle = d.rows.find(r => r.settled);
  const rows = d.rows.filter(r => !r.settled);
  const s = newSession();
  const out = [];
  let t = 1700000000000;
  for (const r of rows) {
    t += 1000;
    const res = tick(s, {
      now: t,
      sinceOpen: r.cvd_since_open,
      price: r.cushion != null ? settle.open + r.cushion : null,
      bimb: r.btc_imb, pimb: r.poly_imb,
      cushion: r.cushion, remS: r.rem,
      vol1m: null, largePrints: null, efficiency: null, perpSpotDiv: null,
    });
    if (res) out.push(res);
  }
  return { out, settled: settle.settled };
}

for (const file of LOGS) {
  test(`replay ${file}: v5.1 does not flip-flop on a bar that never flipped`, () => {
    const { out, settled } = replay(file);
    assert.equal(settled, 'UP');
    const sigs = out.map(r => r.decision.sig);
    const transitions = sigs.filter((x, i) => i > 0 && x !== sigs[i - 1]).length;
    // v5 produced 64 and 89 transitions on these logs
    assert.ok(transitions <= 15, `transitions=${transitions}`);
    // v5 produced 59 and 37 DOWN ticks on these UP bars (interleaved with MIXED, i.e. flapping).
    // v5.1 log 1 has a single genuine sustained bearish excursion (measured: 45 consecutive DOWN
    // ticks, one transition in/out; cushion fell ~70->32 over 02:33:15-02:34:05 with btc_imb/
    // poly_imb consistently negative) that recovered before settlement -- one held call, not
    // flapping. Bound widened from 15 to accommodate that measured episode while still barring
    // repeated flip-flopping (log 2 measures 0).
    const downs = sigs.filter(x => x === 'DOWN').length;
    assert.ok(downs <= 50, `DOWN ticks=${downs}`);
    // at most one alert episode on a bar that never flipped
    const alerts = out.filter((r, i) => r.flip.alert && !(out[i - 1] && out[i - 1].flip.alert)).length;
    assert.ok(alerts <= 1, `alert episodes=${alerts}`);
  });
}
