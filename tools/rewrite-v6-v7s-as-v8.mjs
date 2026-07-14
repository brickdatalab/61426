#!/usr/bin/env node
/**
 * Rewrite historical V6/V7s payloads in place as current-V8 counterfactuals.
 * Physical filenames stay unchanged; payload slugs become _v8.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { newSession, tick } from '../v8/src/signals.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_LOG_DIR = join(ROOT, 'AUTOPSY', 'logs');
const TARGET_RE = /^(?<asset>btc|eth)-updown-(?<interval>\d+[smhdw])-(?<epoch>\d{10})_(?<version>v6|v7s)\.json$/;
const ANY_VERSION_RE = /^(?<asset>btc|eth)-updown-(?<interval>\d+[smhdw])-(?<epoch>\d{10})_(?<version>v6|v7s|v8)\.json$/;
const TICK_KEYS = [
  't', 'rem', 'btc_imb', 'poly_imb', 'comb', 'cushion', 'cvd', 'cvd_since_open',
  'cvd_d5', 'cvd_d10', 'cvd_d60', 'cush_d10', 'mom_z', 'mom_dir', 'imb_ewma',
  'large_prints', 'efficiency', 'perp_spot_div', 'cvd_d3m', 'vol_1m', 'poly_mid',
  'p_flip', 'flip_alert', 'signal', 'conv', 'early_call', 'early_tier',
];

function fail(message) {
  throw new Error(message);
}

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function rounded(value, digits) {
  return isNumber(value) ? Number(value.toFixed(digits)) : null;
}

function roundedInt(value) {
  return isNumber(value) ? Math.round(value) : null;
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

function intervalSeconds(interval) {
  const match = /^(\d+)([smhdw])$/.exec(interval);
  if (!match) fail(`unsupported interval: ${interval}`);
  const unit = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[match[2]];
  return Number(match[1]) * unit;
}

export function targetFromFilename(filename) {
  const match = TARGET_RE.exec(basename(filename));
  if (!match?.groups) fail(`not a V6/V7s rewrite target: ${filename}`);
  const { asset, interval, epoch, version } = match.groups;
  return {
    filename: basename(filename), asset, interval, epoch: Number(epoch), version,
    marketBase: `${asset}-updown-${interval}-${epoch}`,
    barSeconds: intervalSeconds(interval),
  };
}

function parseAnyMarket(filename) {
  const match = ANY_VERSION_RE.exec(basename(filename));
  if (!match?.groups) return null;
  const { asset, interval, epoch, version } = match.groups;
  return { filename: basename(filename), version, marketBase: `${asset}-updown-${interval}-${epoch}` };
}

function validateSourceSession(payload, target) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.rows)) {
    fail(`${target.filename}: missing rows array`);
  }
  const settlements = payload.rows.filter((row) => row && typeof row === 'object' && 'settled' in row);
  if (settlements.length !== 1 || payload.rows[payload.rows.length - 1] !== settlements[0]) {
    fail(`${target.filename}: expected exactly one final settlement row`);
  }
  const settlement = settlements[0];
  if (!isNumber(settlement.open) || !isNumber(settlement.close)) {
    fail(`${target.filename}: settlement lacks finite open/close`);
  }
  const ticks = payload.rows.slice(0, -1);
  if (!ticks.length || ticks.some((row) => !row || typeof row !== 'object' || 'settled' in row)) {
    fail(`${target.filename}: missing usable tick rows`);
  }
  return { ticks, settlement };
}

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

function replayNow(row, target, previousMs) {
  const rem = isNumber(row.rem) ? row.rem : target.barSeconds;
  const nominal = (target.epoch + target.barSeconds - rem) * 1000;
  const clock = parseClockMillis(row.t, nominal);
  const candidate = Math.abs(clock - nominal) <= 15_000 ? clock : nominal;
  return previousMs == null ? candidate : Math.max(candidate, previousMs + 1);
}

function combineImbalance(bimb, pimb) {
  const combined = isNumber(bimb) && isNumber(pimb) ? (bimb + pimb) / 2
    : isNumber(bimb) ? bimb : isNumber(pimb) ? pimb : null;
  return rounded(combined, 3);
}

function nativeRow(raw, result) {
  const decision = result?.decision ?? null;
  const flow = result?.flow ?? null;
  const flip = result?.flip ?? null;
  const conv = decision?.conv ?? null;
  const early = result?.early ?? null;
  return {
    t: raw.t ?? null,
    rem: isNumber(raw.rem) ? Math.max(0, Math.round(raw.rem)) : null,
    btc_imb: rounded(raw.btc_imb, 3),
    poly_imb: rounded(raw.poly_imb, 3),
    comb: combineImbalance(raw.btc_imb, raw.poly_imb),
    cushion: rounded(raw.cushion, 2),
    cvd: roundedInt(raw.cvd),
    cvd_since_open: roundedInt(raw.cvd_since_open),
    cvd_d5: roundedInt(flow?.d5),
    cvd_d10: roundedInt(flow?.d10),
    cvd_d60: roundedInt(flow?.d60),
    cush_d10: rounded(result?.cush_d10, 1),
    mom_z: rounded(result?.momentum?.z, 2),
    mom_dir: result?.momentum?.dir ?? null,
    imb_ewma: rounded(decision?.imbEwma, 3),
    large_prints: roundedInt(raw.large_prints),
    efficiency: rounded(raw.efficiency, 3),
    perp_spot_div: roundedInt(raw.perp_spot_div),
    cvd_d3m: roundedInt(raw.cvd_d3m),
    vol_1m: rounded(raw.vol_1m, 2),
    poly_mid: rounded(raw.poly_mid, 3),
    p_flip: rounded(flip?.p, 3),
    flip_alert: flip?.alert ?? null,
    signal: decision?.sig ?? 'MIXED',
    conv: conv ? { tier: conv.tier, pts: conv.pts, why: conv.why || '' } : null,
    early_call: early?.side ?? null,
    early_tier: early?.tier ?? null,
  };
}

export function rewriteSession(payload, filename) {
  const target = targetFromFilename(filename);
  const { ticks, settlement } = validateSourceSession(payload, target);
  const state = newSession();
  let previousMs = null;
  let fallbackRows = 0;
  const rewrittenTicks = ticks.map((raw) => {
    const now = replayNow(raw, target, previousMs);
    previousMs = now;
    const price = isNumber(raw.cushion) ? settlement.open + raw.cushion : null;
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
    if (raw.vol_1m == null || result == null) fallbackRows += 1;
    return nativeRow(raw, result);
  });
  const counts = { UP: 0, DOWN: 0, MIXED: 0 };
  for (const row of rewrittenTicks) counts[row.signal] += 1;
  const rewrittenSettlement = {
    t: settlement.t ?? null,
    settled: settlement.settled,
    open: settlement.open,
    close: settlement.close,
    signal_mixed_sum: String(counts.MIXED),
    signal_up_sum: String(counts.UP),
    signal_down_sum: String(counts.DOWN),
  };
  return {
    slug: `${target.marketBase}_v8`,
    rows: [...rewrittenTicks, rewrittenSettlement],
    _audit: { fallbackRows, target },
  };
}

function validateRewritten(payload, filename) {
  const result = rewriteSession(payload, filename);
  const clean = { slug: result.slug, rows: result.rows };
  if (JSON.stringify(clean) !== JSON.stringify(payload)) {
    fail(`${filename}: rewritten payload is not a stable V8 replay`);
  }
  for (const row of payload.rows.slice(0, -1)) {
    if (JSON.stringify(Object.keys(row)) !== JSON.stringify(TICK_KEYS)) {
      fail(`${filename}: tick schema does not match the current V8 writer`);
    }
  }
  const settlement = payload.rows.at(-1);
  const counts = { UP: 0, DOWN: 0, MIXED: 0 };
  for (const row of payload.rows.slice(0, -1)) counts[row.signal] += 1;
  if (settlement.signal_up_sum !== String(counts.UP)
    || settlement.signal_down_sum !== String(counts.DOWN)
    || settlement.signal_mixed_sum !== String(counts.MIXED)) {
    fail(`${filename}: settlement signal summaries do not match ticks`);
  }
}

function writeAtomic(path, bytes) {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.v8-rewrite.tmp`);
  writeFileSync(temporary, bytes);
  renameSync(temporary, path);
}

function parseArgs(args) {
  const value = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : null;
  };
  return {
    apply: args.includes('--apply'),
    dryRun: args.includes('--dry-run'),
    logsDir: resolve(value('--logs-dir') ?? DEFAULT_LOG_DIR),
    auditDir: value('--audit-dir') ? resolve(value('--audit-dir')) : null,
    restoreDir: value('--restore'),
  };
}

function collectInventory(logsDir) {
  const names = readdirSync(logsDir).filter((name) => name.endsWith('.json')).sort();
  const targets = names.filter((name) => TARGET_RE.test(name));
  const v6 = targets.filter((name) => name.endsWith('_v6.json'));
  const v7s = targets.filter((name) => name.endsWith('_v7s.json'));
  if (v6.length !== 89 || v7s.length !== 85) {
    fail(`expected 89 V6 and 85 V7s targets; found ${v6.length} V6 and ${v7s.length} V7s`);
  }
  const marketNames = new Map();
  for (const name of names) {
    const parsed = parseAnyMarket(name);
    if (!parsed) continue;
    if (marketNames.has(parsed.marketBase)) fail(`duplicate market identity: ${parsed.marketBase}`);
    marketNames.set(parsed.marketBase, name);
  }
  const untouched = names.filter((name) => !TARGET_RE.test(name)).map((name) => ({
    filename: name, sha256: sha256File(join(logsDir, name)),
  }));
  return { names, targets, untouched };
}

function makeAuditDir(input) {
  if (input) return input;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(ROOT, 'AUTOPSY', 'v8-counterfactual-rewrite', stamp);
}

function createBackup(auditDir, logsDir, sourceEntries) {
  mkdirSync(auditDir, { recursive: true });
  const preimageDir = join(auditDir, 'preimage');
  mkdirSync(preimageDir);
  const manifest = sourceEntries.map(({ filename, sourceSha256, bytes }) => ({
    filename, source_sha256: sourceSha256, size_bytes: bytes.length,
  }));
  for (const entry of sourceEntries) copyFileSync(join(logsDir, entry.filename), join(preimageDir, entry.filename));
  const archive = join(auditDir, 'preimage.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', preimageDir, '.']);
  rmSync(preimageDir, { recursive: true, force: true });
  writeFileSync(join(auditDir, 'preimage-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(auditDir, 'preimage.tar.gz.sha256'), `${sha256File(archive)}  preimage.tar.gz\n`);
  return archive;
}

function writeAudit(auditDir, payload) {
  writeFileSync(join(auditDir, 'conversion-audit.json'), JSON.stringify(payload, null, 2) + '\n');
  const header = 'filename,source_sha256,rewritten_sha256,internal_slug,fallback_rows\n';
  const lines = payload.entries.map((entry) => [
    entry.filename, entry.source_sha256, entry.rewritten_sha256, entry.internal_slug, entry.fallback_rows,
  ].join(','));
  writeFileSync(join(auditDir, 'conversion-audit.csv'), header + lines.join('\n') + '\n');
}

function restore(auditDir, logsDir) {
  const manifest = JSON.parse(readFileSync(join(auditDir, 'preimage-manifest.json'), 'utf8'));
  const extracted = mkdtempSync(join(tmpdir(), 'v8-rewrite-restore-'));
  try {
    execFileSync('tar', ['-xzf', join(auditDir, 'preimage.tar.gz'), '-C', extracted]);
    for (const entry of manifest) {
      const source = join(extracted, entry.filename);
      if (sha256File(source) !== entry.source_sha256) fail(`backup hash mismatch: ${entry.filename}`);
      writeAtomic(join(logsDir, entry.filename), readFileSync(source));
    }
  } finally {
    rmSync(extracted, { recursive: true, force: true });
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.restoreDir) {
    restore(resolve(args.restoreDir), args.logsDir);
    console.log(`restored V6/V7s preimage from ${resolve(args.restoreDir)}`);
    return;
  }
  if (args.apply === args.dryRun) {
    fail('choose exactly one of --dry-run or --apply');
  }
  if (!existsSync(args.logsDir)) fail(`log directory does not exist: ${args.logsDir}`);
  const inventory = collectInventory(args.logsDir);
  const sourceEntries = inventory.targets.map((filename) => {
    const bytes = readFileSync(join(args.logsDir, filename));
    const source = JSON.parse(bytes.toString('utf8'));
    const rewritten = rewriteSession(source, filename);
    const payload = { slug: rewritten.slug, rows: rewritten.rows };
    validateRewritten(payload, filename);
    return {
      filename, bytes, sourceSha256: sha256Bytes(bytes), payload,
      rewrittenBytes: Buffer.from(JSON.stringify(payload, null, 2) + '\n'),
      fallbackRows: rewritten._audit.fallbackRows,
    };
  });
  if (args.dryRun) {
    console.log(`dry run passed: ${sourceEntries.length} V6/V7s logs can be rewritten as V8`);
    return;
  }
  const auditDir = makeAuditDir(args.auditDir);
  if (existsSync(auditDir)) fail(`audit directory already exists: ${auditDir}`);
  const backup = createBackup(auditDir, args.logsDir, sourceEntries);
  const journal = { status: 'prepared', logs_dir: args.logsDir, backup, entries: [] };
  writeFileSync(join(auditDir, 'journal.json'), JSON.stringify(journal, null, 2) + '\n');
  for (const entry of sourceEntries) {
    writeAtomic(join(args.logsDir, entry.filename), entry.rewrittenBytes);
    journal.entries.push(entry.filename);
    writeFileSync(join(auditDir, 'journal.json'), JSON.stringify(journal, null, 2) + '\n');
  }
  for (const entry of sourceEntries) {
    const path = join(args.logsDir, entry.filename);
    if (sha256File(path) !== sha256Bytes(entry.rewrittenBytes)) fail(`post-write hash mismatch: ${entry.filename}`);
    validateRewritten(JSON.parse(readFileSync(path, 'utf8')), entry.filename);
  }
  for (const entry of inventory.untouched) {
    if (sha256File(join(args.logsDir, entry.filename)) !== entry.sha256) {
      fail(`untouched log changed: ${entry.filename}`);
    }
  }
  journal.status = 'complete';
  writeFileSync(join(auditDir, 'journal.json'), JSON.stringify(journal, null, 2) + '\n');
  writeAudit(auditDir, {
    status: 'complete', source_count: sourceEntries.length, backup,
    entries: sourceEntries.map((entry) => ({
      filename: entry.filename,
      source_sha256: entry.sourceSha256,
      rewritten_sha256: sha256Bytes(entry.rewrittenBytes),
      internal_slug: entry.payload.slug,
      fallback_rows: entry.fallbackRows,
    })),
  });
  console.log(`rewrote ${sourceEntries.length} V6/V7s logs in place as V8 payloads`);
  console.log(`backup and audit: ${auditDir}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
