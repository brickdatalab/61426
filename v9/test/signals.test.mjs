import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as V8 from '../../v8/src/signals.mjs';
import * as V9 from '../src/signals.mjs';

function inputAt(i) {
  const cushion = Math.sin(i / 8) * 80;
  return {
    now: 1_700_000_000_000 + i * 1_000,
    sinceOpen: i * 50_000 + Math.cos(i / 5) * 100_000,
    price: 50_000 + cushion,
    cushion,
    remS: 300 - i,
    polyMid: 0.5 + Math.sin(i / 12) * 0.4,
    bimb: Math.sin(i / 7),
    pimb: Math.cos(i / 9),
    vol1m: 20 + (i % 40),
    largePrints: Math.sin(i / 4) * 400_000,
    efficiency: 0.2 + (i % 8) / 10,
    perpSpotDiv: Math.cos(i / 6) * 600_000,
    cvd3m: Math.sin(i / 3) * 2_000_000,
  };
}

test('V9 preserves every V8 output and all inherited state over a full market replay', () => {
  const v8 = V8.newSession();
  const v9 = V9.newSession();
  const inheritedKeys = Object.keys(v8);
  for (let i = 0; i < 300; i += 1) {
    const input = inputAt(i);
    const expected = V8.tick(v8, input);
    const actual = V9.tick(v9, input);
    assert.deepEqual({
      flow: actual.flow,
      cush_d10: actual.cush_d10,
      momentum: actual.momentum,
      decision: actual.decision,
      early: actual.early,
      flip: actual.flip,
    }, expected, `V8 output mismatch at tick ${i + 1}`);
    assert.deepEqual(
      Object.fromEntries(inheritedKeys.map(key => [key, v9[key]])),
      v8,
      `inherited V8 state mismatch at tick ${i + 1}`,
    );
  }
});

test('V9 decision remains the volatility-gated cushion rule', () => {
  const session = V9.newSession();
  assert.equal(V9.decideV8(session, { cushion: 9.9, vol1m: 20 }).sig, 'MIXED');
  assert.equal(V9.decideV8(session, { cushion: 10, vol1m: 20 }).sig, 'UP');
  assert.equal(V9.decideV8(session, { cushion: -51, vol1m: 100 }).sig, 'DOWN');
});

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const sha256 = data => createHash('sha256').update(data).digest('hex');

function protectedTreeFiles(root) {
  const files = [];
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.venv' || entry.name === '__pycache__' || entry.name === '.DS_Store') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  for (const folder of ['v8', 'v8.2']) walk(join(root, folder));
  return files.sort((a, b) => {
    const left = relative(root, a), right = relative(root, b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

test('build manifest locks V8/V8.2 references and the production V9 engine', () => {
  const manifest = JSON.parse(readFileSync(join(REPO, 'v9', 'build-manifest.json'), 'utf8'));
  assert.equal(sha256(readFileSync(join(REPO, 'v9', 'src', 'signals.mjs'))), manifest.v9_engine_sha256);
  for (const [path, expected] of Object.entries(manifest.protected_files)) {
    assert.equal(sha256(readFileSync(join(REPO, path))), expected, path);
  }
  const html = readFileSync(join(REPO, 'v9', 'updown-liquidity-overlap-v9.html'), 'utf8');
  assert.doesNotMatch(html, /(?:from|import\s*\()\s*['"][^'"]*v8(?:\.2)?\//i);

  // Linked worktrees intentionally omit the large untracked V8 analysis-data tree.
  // The real workspace has a .git directory and must pass the complete aggregate gate.
  if (statSync(join(REPO, '.git')).isDirectory()) {
    const files = protectedTreeFiles(REPO);
    assert.equal(files.length, manifest.reference_tree.file_count);
    const inventory = files.map(path => `${sha256(readFileSync(path))}  ${relative(REPO, path)}\n`).join('');
    assert.equal(sha256(inventory), manifest.reference_tree.sha256);
  }
});
