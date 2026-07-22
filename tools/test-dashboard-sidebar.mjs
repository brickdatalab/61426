import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = join(import.meta.dirname, '..');
const pages = [
  ['v8/updown-liquidity-overlap.html', 'updownSidebarCollapsed:v8'],
  ['v8/updown-liquidity-overlap-demo.html', 'updownSidebarCollapsed:v8'],
  ['v8.2/updown-liquidity-overlap-shadow.html', 'updownSidebarCollapsed:v8.2'],
  ['v9/updown-liquidity-overlap-v9.html', 'updownSidebarCollapsed:v9'],
];

for (const [file, storageKey] of pages) {
  test(`${file} provides an accessible persistent sidebar toggle`, () => {
    const html = readFileSync(join(repo, file), 'utf8');

    assert.match(html, /\.wrap\.sidebar-collapsed\s*\{/);
    assert.match(html, /id="sidebarToggle"/);
    assert.match(html, /aria-controls="sidebarContent"/);
    assert.match(html, /aria-expanded="true"/);
    assert.match(html, /id="sidebarContent"/);
    assert.match(html, new RegExp(`const SIDEBAR_STATE_KEY='${storageKey.replace('.', '\\.')}'`));
    assert.match(html, /function setSidebarCollapsed\(/);
    assert.match(html, /localStorage\.setItem\(SIDEBAR_STATE_KEY/);
    assert.match(html, /window\.dispatchEvent\(new Event\('resize'\)\)/);
    assert.match(html, /@media \(max-width:760px\)[^}]*[\s\S]*?\.controls\{border-right:0;padding-top:54px\}/);
  });
}
