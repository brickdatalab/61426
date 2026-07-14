#!/usr/bin/env node
//
// v8-corpus-replay.mjs — authoritative V8 engine replay validator for the corpus.
//
// Replays EVERY included session (_v6/_v7s/_v8) through the real v8 engine
// (v8/src/signals.mjs) using the exact monotonic replay-time rule from the
// historical conversion (tools/rewrite-v6-v7s-as-v8.mjs): resolve the logged
// clock nearest the nominal bar time, then enforce file-order monotonicity with
// max(candidate, previous_ms + 1). Emits per-tick {expected_signal, v8_floor}
// so the Python builder can populate the deterministic-validation fields and
// check engine compatibility without re-implementing the rule.
//
// Usage: node v8-corpus-replay.mjs --logs-dir <dir> --out <jsonl-path>

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { newSession, tick } from '../v8/src/signals.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INCLUDE_RE = /^(?<asset>btc|eth)-updown-(?<interval>5m|15m)-(?<epoch>\d{10})_(?<version>v6|v7s|v8)\.json$/;

function isNumber(v) { return typeof v === 'number' && Number.isFinite(v); }

function intervalSeconds(interval) {
  const m = /^(\d+)([smhdw])$/.exec(interval);
  if (!m) throw new Error(`unsupported interval: ${interval}`);
  const unit = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[m[2]];
  return Number(m[1]) * unit;
}

// Exact copy of parseClockMillis from tools/rewrite-v6-v7s-as-v8.mjs.
function parseClockMillis(rawTime, nominalMs) {
  if (typeof rawTime !== 'string' || !/^\d{2}:\d{2}:\d{2}$/.test(rawTime)) return nominalMs;
  const [hours, minutes, seconds] = rawTime.split(':').map(Number);
  const nominal = new Date(nominalMs);
  const candidates = [-1, 0, 1].map((offset) => Date.UTC(
    nominal.getUTCFullYear(), nominal.getUTCMonth(), nominal.getUTCDate() + offset,
    hours, minutes, seconds,
  ));
  return candidates.reduce((best, candidate) => (
    Math.abs(candidate - nominalMs) < Math.abs(best - nominalMs) ? candidate : best
  ));
}

function replaySession(payload, epoch, barSeconds) {
  const rows = payload.rows;
  const settlement = rows[rows.length - 1];
  const open = settlement.open;
  const ticks = rows.slice(0, -1);
  const state = newSession();
  let previousMs = null;
  const results = ticks.map((raw) => {
    const rem = isNumber(raw.rem) ? raw.rem : barSeconds;
    const nominal = (epoch + barSeconds - rem) * 1000;
    const clock = parseClockMillis(raw.t, nominal);
    // Exact monotonic replay rule: clamp >15s drift to nominal, then force
    // strictly increasing milliseconds across file order.
    const candidate = Math.abs(clock - nominal) <= 15_000 ? clock : nominal;
    const now = previousMs == null ? candidate : Math.max(candidate, previousMs + 1);
    previousMs = now;
    const price = isNumber(raw.cushion) ? open + raw.cushion : null;
    const result = tick(state, {
      now,
      sinceOpen: raw.cvd_since_open ?? null,
      price,
      bimb: raw.btc_imb ?? null,
      pimb: raw.poly_imb ?? null,
      cushion: raw.cushion ?? null,
      remS: raw.rem ?? null,
      vol1m: raw.vol_1m ?? null,
      largePrints: raw.large_prints ?? null,
      efficiency: raw.efficiency ?? null,
      perpSpotDiv: raw.perp_spot_div ?? null,
      cvd3m: raw.cvd_d3m ?? null,
      polyMid: raw.poly_mid ?? null,
    });
    return {
      expected_signal: result ? result.decision.sig : 'MIXED',
      v8_floor: result ? result.decision.floor : null,
    };
  });
  return { tick_count: ticks.length, results };
}

function main() {
  const args = process.argv.slice(2);
  const value = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  const logsDir = resolve(value('--logs-dir'));
  const out = resolve(value('--out'));
  if (!logsDir || !out) {
    console.error('usage: v8-corpus-replay.mjs --logs-dir <dir> --out <jsonl>');
    process.exit(2);
  }
  const names = readdirSync(logsDir).filter((n) => INCLUDE_RE.test(n)).sort();
  const lines = [];
  let errors = 0;
  for (const name of names) {
    const path = join(logsDir, name);
    const bytes = readFileSync(path);
    const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
    let entry;
    try {
      const payload = JSON.parse(bytes.toString('utf8'));
      const m = INCLUDE_RE.exec(name);
      const epoch = Number(m.groups.epoch);
      const barSeconds = intervalSeconds(m.groups.interval);
      const { tick_count, results } = replaySession(payload, epoch, barSeconds);
      entry = { filename: name, source_sha256: sourceSha256, tick_count, results };
    } catch (err) {
      errors += 1;
      entry = { filename: name, source_sha256: sourceSha256, error: String(err.message || err) };
    }
    lines.push(JSON.stringify(entry));
  }
  writeFileSync(out, lines.join('\n') + '\n');
  console.error(`replayed ${names.length} sessions (${errors} errors) -> ${out}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
