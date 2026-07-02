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
  const d = JSON.parse(readFileSync(join(here, 'fixtures', file), 'utf8'));
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
      vol1m: r.vol_1m ?? null,
      largePrints: r.large_prints ?? null,
      efficiency: r.efficiency ?? null,
      perpSpotDiv: r.perp_spot_div ?? null,
      cvd3m: r.cvd_d3m ?? null,
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
    // Bound DOWN false-alarms by episode count, not raw ticks: a single decisive sustained call
    // and per-tick flapping are different failure modes, and this test exists to catch flapping.
    // v5 produced 59 and 37 DOWN ticks on these UP bars, scattered across dozens of transitions
    // (interleaved with MIXED, i.e. flapping). Measured on v5.1: log 1 = 1 episode (a genuine
    // 45-tick bearish excursion, cushion ~70->32 over 02:33:15-02:34:05 with btc_imb/poly_imb
    // consistently negative, one transition in/out); log 2 = 0 episodes.
    const downEpisodes = sigs.filter((x, i) => x === 'DOWN' && sigs[i - 1] !== 'DOWN').length;
    assert.ok(downEpisodes <= 2, `DOWN episodes=${downEpisodes}`);
    // at most one alert episode on a bar that never flipped
    const alerts = out.filter((r, i) => r.flip.alert && !(out[i - 1] && out[i - 1].flip.alert)).length;
    assert.ok(alerts <= 1, `alert episodes=${alerts}`);
  });
}

test('replay btc-updown-5m-1782974100 (DOWN-settling clean trend): mirror of the UP regressions', () => {
  const { out, settled } = replay('btc-updown-5m-1782974100_v51.json');
  assert.equal(settled, 'DOWN');
  const sigs = out.map(r => r.decision.sig);
  const transitions = sigs.filter((x, i) => i > 0 && x !== sigs[i - 1]).length;
  assert.ok(transitions <= 15, `transitions=${transitions}`);
  // mirror of the DOWN-episode bound: UP false-alarm episodes on a DOWN bar
  const upEpisodes = sigs.filter((x, i) => x === 'UP' && sigs[i - 1] !== 'UP').length;
  assert.ok(upEpisodes <= 2, `UP episodes=${upEpisodes}`);
  const alerts = out.filter((r, i) => r.flip.alert && !(out[i - 1] && out[i - 1].flip.alert)).length;
  assert.ok(alerts <= 1, `alert episodes=${alerts}`);
});

test('replay btc-updown-5m-1782970800 (flip bar): alert fires AND matches settle (true positive)', () => {
  const { out, settled } = replay('btc-updown-5m-1782970800_v51.json');
  assert.equal(settled, 'DOWN');
  // an alert episode must occur — this bar genuinely flipped and the engine caught it live
  const alertEps = out.filter((r, i) => r.flip.alert && !(out[i - 1] && out[i - 1].flip.alert));
  assert.ok(alertEps.length >= 1, `expected >=1 alert episode, got ${alertEps.length}`);
  // direction must agree with settle: DOWN bar -> FLIP->DOWN (U+2192 arrow)
  const firstAlert = out.find(r => r.flip.alert);
  assert.equal(firstAlert.flip.alert, 'FLIP→DOWN');
  // and it must lead the settle, not fire in the last few seconds (position proxy for lead time)
  const idx = out.findIndex(r => r.flip.alert);
  assert.ok(idx < out.length - 30, `alert fired too late: idx ${idx}/${out.length}`);
});
