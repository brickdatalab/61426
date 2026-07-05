#!/usr/bin/env node
// v6/analysis/bq-export-bars.mjs
//
// Pulls BTCUSDT 1s tables from the `bin` BigQuery dataset (via ssh to the VM — the only
// account with jobs.create), builds one session-log-schema JSON file per settled 5m
// btc-updown bar, then runs a fidelity check (overlap vs live v5.4 logs + Binance klines
// settle check). Node, no deps. See scratchpad/sdd/task-2-brief.md for the exact spec.
//
// Usage:
//   node v6/analysis/bq-export-bars.mjs [--since <iso>]
//
// Raw BQ pulls are cached under v6/analysis/bqbars/raw/<table>.json; delete that dir (or
// individual files) to force a re-pull. Exported bars land in v6/analysis/bqbars/<slug>_bq.json.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const SSH_KEY = '/Users/vitolo/.ssh/pm';
const SSH_HOST = 'vincent@34.89.159.108';

const OUT_DIR = path.join(__dirname, 'bqbars');
const RAW_DIR = path.join(OUT_DIR, 'raw');

const LIVE_LOG_DIR = path.join(REPO_ROOT, 'AUTOPSY', 'logs');
const OVERLAP_RANGE = [1783197000, 1783225200]; // slug epoch range to check for overlap, per brief

const MAX_BUFFER = 1024 * 1024 * 400; // 400MB — trades_1s pull has 2 rows/sec (spot+perp)

// ---------- CLI args ----------
function parseArgs(argv) {
  const out = { since: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--since') out.since = argv[++i];
  }
  return out;
}

// ---------- ssh/bq/curl plumbing ----------
function runSSH(remoteCmd) {
  const res = spawnSync('ssh', ['-i', SSH_KEY, SSH_HOST, remoteCmd], {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    timeout: 10 * 60 * 1000,
  });
  if (res.status !== 0) {
    throw new Error(`ssh command failed (exit ${res.status}): ${remoteCmd}\nstderr: ${res.stderr}`);
  }
  return res.stdout;
}

function bqQuery(sql) {
  const remoteCmd = `bq query --use_legacy_sql=false --format=json --max_rows=500000 "${sql}"`;
  const stdout = runSSH(remoteCmd);
  const trimmed = stdout.trim();
  if (trimmed === '') return [];
  return JSON.parse(trimmed);
}

function fetchKlinesViaVM(startMs, endMs) {
  const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&startTime=${startMs}&endTime=${endMs}&limit=500`;
  const remoteCmd = `curl -s "${url}"`;
  const stdout = runSSH(remoteCmd);
  return JSON.parse(stdout.trim());
}

// ---------- cached bulk pulls ----------
function pulledOrCached(name, sql) {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  const cachePath = path.join(RAW_DIR, `${name}.json`);
  if (fs.existsSync(cachePath)) {
    console.log(`[cache] ${name} <- ${cachePath}`);
    return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  }
  console.log(`[pull] ${name} ...`);
  const t0 = Date.now();
  const rows = bqQuery(sql);
  console.log(`[pull] ${name}: ${rows.length} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  fs.writeFileSync(cachePath, JSON.stringify(rows));
  return rows;
}

// ---------- helpers ----------
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function toEpoch(bqTs) {
  // bq --format=json renders TIMESTAMP as "YYYY-MM-DD HH:MM:SS" UTC (no offset).
  return Math.floor(Date.parse(bqTs.replace(' ', 'T') + 'Z') / 1000);
}

function hhmmss(epoch) {
  return new Date(epoch * 1000).toISOString().slice(11, 19);
}

function roundN(x, n) {
  if (x === null || x === undefined || Number.isNaN(x)) return null;
  const f = 10 ** n;
  let v = Math.round(x * f) / f;
  if (Object.is(v, -0)) v = 0;
  return v;
}

function sumOverWindow(map, fromExclusive, toInclusive, fn) {
  let s = 0;
  for (let t = fromExclusive + 1; t <= toInclusive; t++) {
    const r = map.get(t);
    if (r) {
      const v = fn(r);
      if (v !== null && v !== undefined) s += v;
    }
  }
  return s;
}

function median(arr) {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ---------- build indices from raw rows ----------
function buildIndices(tradesRows, bookRows, polyRows) {
  const spot = new Map(); // epoch -> {open, close, buyUsd, sellUsd, buyBase, sellBase, largeBuy, largeSell}
  const perp = new Map(); // epoch -> {buyUsd, sellUsd}

  for (const r of tradesRows) {
    const t = toEpoch(r.ts_second);
    const rec = {
      open: num(r.open),
      close: num(r.close),
      buyUsd: num(r.buy_vol_usd) ?? 0,
      sellUsd: num(r.sell_vol_usd) ?? 0,
      buyBase: num(r.buy_vol_base) ?? 0,
      sellBase: num(r.sell_vol_base) ?? 0,
      largeBuy: num(r.large_buy_usd) ?? 0,
      largeSell: num(r.large_sell_usd) ?? 0,
    };
    if (r.venue === 'spot') spot.set(t, rec);
    else if (r.venue === 'perp') perp.set(t, { buyUsd: rec.buyUsd, sellUsd: rec.sellUsd });
  }

  const book = new Map(); // epoch -> imb
  for (const r of bookRows) {
    book.set(toEpoch(r.ts_second), num(r.imb));
  }

  const polyBySlug = new Map(); // slug -> Map(epoch -> {up_mid, imb})
  for (const r of polyRows) {
    if (!polyBySlug.has(r.slug)) polyBySlug.set(r.slug, new Map());
    polyBySlug.get(r.slug).set(toEpoch(r.ts_second), { up_mid: num(r.up_mid), imb: num(r.imb) });
  }

  return { spot, perp, book, polyBySlug };
}

// ---------- per-bar computation ----------
function resolveBarOpen(spot, barStart) {
  const prev = spot.get(barStart - 1);
  if (prev && prev.close !== null) return prev.close;
  const first = spot.get(barStart);
  if (first && first.open !== null) return first.open;
  return null;
}

function resolveSettleClose(spot, barEnd) {
  // Prefer the exact last second of the bar; fall back a few seconds if that one
  // second is entirely absent from the table (distinct from a present NO_TRADES row,
  // which already carries the close forward).
  for (let back = 1; back <= 10; back++) {
    const r = spot.get(barEnd - back);
    if (r && r.close !== null) return r.close;
  }
  return null;
}

function buildBar(slug, barStart, indices) {
  const { spot, perp, book, polyBySlug } = indices;
  const barEnd = barStart + 300;

  let present = 0;
  for (let t = barStart; t < barEnd; t++) if (spot.has(t)) present++;

  const barOpen = resolveBarOpen(spot, barStart);
  if (present < 290 || barOpen === null) {
    return { status: 'skipped_coverage', present, barOpen };
  }

  const settleClose = resolveSettleClose(spot, barEnd);
  if (settleClose === null) {
    return { status: 'skipped_coverage', present, barOpen, reason: 'no settle close' };
  }
  if (settleClose === barOpen) {
    return { status: 'skipped_flat', barOpen, settleClose };
  }

  const polyMap = polyBySlug.get(slug) || new Map();
  const rows = [];

  for (let ts = barStart; ts < barEnd; ts++) {
    const spotRow = spot.get(ts);
    if (!spotRow) continue; // sub-second gap inside an otherwise-qualifying bar

    const cvdSinceOpen = sumOverWindow(spot, barStart - 1, ts, (r) => r.buyUsd - r.sellUsd);
    const cvdD3m = sumOverWindow(spot, ts - 180, ts, (r) => r.buyUsd - r.sellUsd);
    const largePrints = sumOverWindow(spot, ts - 180, ts, (r) => r.largeBuy - r.largeSell);
    const perpNet300 = sumOverWindow(perp, ts - 300, ts, (r) => r.buyUsd - r.sellUsd);
    const spotNet300 = sumOverWindow(spot, ts - 300, ts, (r) => r.buyUsd - r.sellUsd);
    const perpSpotDiv = perpNet300 - spotNet300;

    const closeTs = spotRow.close;
    const prev3m = spot.get(ts - 180);
    let efficiency = null;
    if (closeTs !== null && prev3m && prev3m.close !== null) {
      const spotBaseNet180 = sumOverWindow(spot, ts - 180, ts, (r) => r.buyBase - r.sellBase);
      efficiency = roundN(Math.abs(closeTs - prev3m.close) / Math.max(Math.abs(spotBaseNet180), 0.01), 4);
    }

    // vol_1m: population stdev of consecutive 1s close diffs over the trailing 60s
    // window, scaled to a 1-min move (x sqrt(60)). Mirrors ourWebSocket/compute.py's
    // _vol_1m_usd: only in-window points are used, so a diff is only formed between
    // two consecutive present seconds inside (ts-60, ts].
    const closes = [];
    for (let t = ts - 59; t <= ts; t++) {
      const r = spot.get(t);
      if (r && r.close !== null) closes.push(r.close);
      else closes.push(null);
    }
    const diffs = [];
    for (let i = 1; i < closes.length; i++) {
      if (closes[i] !== null && closes[i - 1] !== null) diffs.push(closes[i] - closes[i - 1]);
    }
    let vol1m = null;
    if (diffs.length >= 10) {
      const m = diffs.reduce((a, b) => a + b, 0) / diffs.length;
      const variance = diffs.reduce((a, b) => a + (b - m) ** 2, 0) / diffs.length;
      vol1m = roundN(Math.sqrt(variance) * Math.sqrt(60), 2);
    }

    const polyRow = polyMap.get(ts);

    rows.push({
      t: hhmmss(ts),
      rem: barEnd - ts,
      cushion: roundN(closeTs - barOpen, 2),
      cvd_since_open: roundN(cvdSinceOpen, 0),
      cvd_d3m: roundN(cvdD3m, 0),
      large_prints: roundN(largePrints, 0),
      efficiency,
      perp_spot_div: roundN(perpSpotDiv, 0),
      vol_1m: vol1m,
      btc_imb: roundN(book.get(ts) ?? null, 4),
      poly_imb: roundN(polyRow ? polyRow.imb : null, 4),
      poly_mid: polyRow ? polyRow.up_mid : null,
    });
  }

  rows.push({
    t: hhmmss(barEnd),
    settled: settleClose > barOpen ? 'UP' : 'DOWN',
    open: barOpen,
    close: settleClose,
  });

  return {
    status: 'exported',
    doc: {
      slug: `${slug}_bq`,
      bq: { source: 'bin dataset pm', generated_at: new Date().toISOString() },
      rows,
    },
  };
}

// ---------- fidelity check 1: overlap vs live v5.4 logs ----------
function checkOverlap(indices, maxSpotTs, minSpotTs) {
  if (!fs.existsSync(LIVE_LOG_DIR)) {
    return { overlap: false, note: `${LIVE_LOG_DIR} does not exist` };
  }
  const files = fs.readdirSync(LIVE_LOG_DIR).filter((f) => /^btc-updown-5m-(\d+)_v54\.json$/.test(f));
  const candidates = [];
  for (const f of files) {
    const m = f.match(/^btc-updown-5m-(\d+)_v54\.json$/);
    const epoch = Number(m[1]);
    if (epoch >= OVERLAP_RANGE[0] && epoch <= OVERLAP_RANGE[1]) candidates.push({ f, epoch });
  }
  const overlapping = candidates.filter((c) => c.epoch < maxSpotTs && c.epoch + 300 > minSpotTs);

  if (overlapping.length === 0) {
    return {
      overlap: false,
      note: `No overlap: checked live-log slugs span [${OVERLAP_RANGE[0]}, ${OVERLAP_RANGE[1] + 300}), ` +
        `BQ pull spans [${minSpotTs}, ${maxSpotTs}]. ${candidates.length} live logs found in the target slug range, 0 overlap the BQ pull.`,
    };
  }

  const diffs = [];
  for (const { f, epoch } of overlapping) {
    const live = JSON.parse(fs.readFileSync(path.join(LIVE_LOG_DIR, f), 'utf8'));
    const built = buildBar(`btc-updown-5m-${epoch}`, epoch, indices);
    if (built.status !== 'exported') {
      diffs.push({ slug: f, note: `not exportable from BQ pull (${built.status})` });
      continue;
    }
    const byT = new Map(built.doc.rows.filter((r) => r.rem !== undefined).map((r) => [r.t, r]));
    let maxCushionDelta = 0;
    let maxCvdDelta = 0;
    let compared = 0;
    for (const lr of live.rows) {
      if (lr.rem === undefined) continue; // settle row
      const br = byT.get(lr.t);
      if (!br || lr.cushion === null || lr.cushion === undefined || lr.cvd_since_open === null || lr.cvd_since_open === undefined) continue;
      compared++;
      maxCushionDelta = Math.max(maxCushionDelta, Math.abs(lr.cushion - br.cushion));
      maxCvdDelta = Math.max(maxCvdDelta, Math.abs(lr.cvd_since_open - br.cvd_since_open));
    }
    diffs.push({ slug: f, compared, maxCushionDelta, maxCvdDelta });
  }
  return { overlap: true, diffs };
}

// ---------- fidelity check 2: klines settle check ----------
function checkKlines(exportedBars) {
  if (exportedBars.length === 0) return { matched: 0, total: 0, note: 'no exported bars to check' };
  const startMs = Math.min(...exportedBars.map((b) => b.barStart)) * 1000;
  const endMs = (Math.max(...exportedBars.map((b) => b.barStart)) + 300) * 1000;
  console.log(`[klines] fetching via VM: startTime=${startMs} endTime=${endMs}`);
  const klines = fetchKlinesViaVM(startMs, endMs);
  const byOpenTime = new Map();
  for (const k of klines) byOpenTime.set(k[0], { open: Number(k[1]), close: Number(k[4]) });

  let matched = 0;
  let correct = 0;
  const openDeltas = [];
  const mismatches = [];
  for (const b of exportedBars) {
    const k = byOpenTime.get(b.barStart * 1000);
    if (!k) continue;
    matched++;
    const klineDir = k.close > k.open ? 'UP' : 'DOWN';
    if (klineDir === b.settled) correct++;
    else mismatches.push({ slug: b.slug, ours: b.settled, kline: klineDir });
    openDeltas.push(Math.abs(b.open - k.open));
  }
  return {
    total: exportedBars.length,
    matched,
    correct,
    mismatches,
    medianOpenDelta: roundN(median(openDeltas), 4),
  };
}

// ---------- main ----------
function main() {
  const args = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const sinceClause = args.since ? ` AND ts_second >= TIMESTAMP('${args.since}')` : '';

  const tradesRows = pulledOrCached(
    'trades_1s',
    `SELECT ts_second, venue, open, close, buy_vol_base, sell_vol_base, buy_vol_usd, sell_vol_usd, large_buy_usd, large_sell_usd, quality_flag FROM bin.trades_1s WHERE symbol='BTCUSDT'${sinceClause} ORDER BY ts_second`,
  );
  const bookRows = pulledOrCached(
    'book_imb_1s',
    `SELECT ts_second, imb, quality_flag FROM bin.book_imb_1s WHERE symbol='BTCUSDT'${sinceClause} ORDER BY ts_second`,
  );
  const polyRows = pulledOrCached(
    'poly_5m_1s',
    `SELECT ts_second, slug, up_mid, imb, quality_flag FROM bin.poly_5m_1s WHERE asset='BTC' AND slug LIKE 'btc-updown-5m-%'${sinceClause} ORDER BY ts_second`,
  );

  const indices = buildIndices(tradesRows, bookRows, polyRows);

  let minSpotTs = Infinity;
  let maxSpotTs = -Infinity;
  for (const t of indices.spot.keys()) {
    if (t < minSpotTs) minSpotTs = t;
    if (t > maxSpotTs) maxSpotTs = t;
  }

  const slugs = [...indices.polyBySlug.keys()]
    .filter((s) => /^btc-updown-5m-\d+$/.test(s))
    .sort();

  let exported = 0;
  let skippedCoverage = 0;
  let skippedFlat = 0;
  let skippedUnsettled = 0;
  const exportedBars = [];
  const flatSlugs = [];

  for (const slug of slugs) {
    const barStart = Number(slug.match(/(\d+)$/)[1]);
    const barEnd = barStart + 300;

    if (barEnd + 30 > maxSpotTs) {
      skippedUnsettled++;
      continue;
    }

    const built = buildBar(slug, barStart, indices);
    if (built.status === 'skipped_coverage') {
      skippedCoverage++;
    } else if (built.status === 'skipped_flat') {
      skippedFlat++;
      flatSlugs.push(slug);
    } else {
      fs.writeFileSync(path.join(OUT_DIR, `${slug}_bq.json`), JSON.stringify(built.doc, null, 2));
      const settleRow = built.doc.rows[built.doc.rows.length - 1];
      exportedBars.push({ slug, barStart, settled: settleRow.settled, open: settleRow.open });
      exported++;
    }
  }

  console.log(`\nbars exported: ${exported}`);
  console.log(`skipped (coverage): ${skippedCoverage}`);
  console.log(`skipped (flat open==close): ${skippedFlat}${flatSlugs.length ? ' -> ' + flatSlugs.join(', ') : ''}`);
  console.log(`skipped (not yet settled): ${skippedUnsettled}`);

  // ---- fidelity checks ----
  console.log('\n--- fidelity check 1: overlap vs live v5.4 logs ---');
  const overlapResult = checkOverlap(indices, maxSpotTs, minSpotTs);
  console.log(JSON.stringify(overlapResult, null, 2));

  console.log('\n--- fidelity check 2: Binance klines settle check ---');
  const klinesResult = checkKlines(exportedBars);
  console.log(JSON.stringify(klinesResult, null, 2));

  const runtimeSec = (Date.now() - t0) / 1000;
  console.log(`\nruntime: ${runtimeSec.toFixed(1)}s`);

  // sample row for the report
  if (exportedBars.length > 0) {
    const sampleSlug = exportedBars[Math.floor(exportedBars.length / 2)].slug;
    const sampleDoc = JSON.parse(fs.readFileSync(path.join(OUT_DIR, `${sampleSlug}_bq.json`), 'utf8'));
    console.log(`\nsample bar: ${sampleSlug}`);
    console.log(JSON.stringify(sampleDoc.rows[Math.floor(sampleDoc.rows.length / 2)], null, 2));
    console.log('settle row:', JSON.stringify(sampleDoc.rows[sampleDoc.rows.length - 1]));
  }
}

main();
