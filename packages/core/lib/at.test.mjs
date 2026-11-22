// The packages stay apart: one reaches another by its package name, never by a relative path (which works in this
// repository and breaks once the packages are installed from npm or bundled into the desktop app).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { at, has, ROOT } from './at.mjs';

const files = dir => readdirSync(dir).flatMap(n => { const f = join(dir, n); return n === 'node_modules' ? [] : statSync(f).isDirectory() ? files(f) : /\.m?js$/.test(n) ? [f] : []; });

test('no relative import or path reaches into another package', () => {
  const bad = [];
  for (const pkg of readdirSync(ROOT).filter(n => statSync(join(ROOT, n)).isDirectory())) {
    for (const f of files(join(ROOT, pkg))) {
      const s = readFileSync(f, 'utf8');
      for (const m of s.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bnew URL\(\s*)(['"`])(\.{1,2}\/[^'"`]+)\1/g)) {
        const target = relative(ROOT, resolve(f, '..', m[2])).split(sep);
        if (target[0] !== pkg && target[0] !== '..') bad.push(`${relative(ROOT, f)}: ${m[2]}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

test('at() finds a file in another package', () => {
  assert.ok(has('player') && has('capture') && has('checks'));
  assert.equal(at('player', 'serve.mjs'), resolve(ROOT, 'player', 'serve.mjs'));
  assert.equal(at('player/app/shell.js'), resolve(ROOT, 'player', 'app', 'shell.js'));
});
