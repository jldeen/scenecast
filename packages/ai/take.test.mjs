import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keepLastTake, endTake } from './take.mjs';

const take = (raw, n) => {
  for (const d of ['snaps', 'shots', 'blobs']) mkdirSync(join(raw, d), { recursive: true });
  writeFileSync(join(raw, 'recording.json'), `take ${n}`);
  writeFileSync(join(raw, 'snaps', 'copilot-start.json'), `start ${n}`);
  writeFileSync(join(raw, 'blobs', `b${n}`), 'blob');
};

test('a take that stops part way puts the last one back whole; one that finishes, or a first take, stays', () => {
  const raw = join(mkdtempSync(join(tmpdir(), 'sc-take-')), 'raw');
  take(raw, 1);
  const kept = keepLastTake(raw);
  // The new take reuses the screen's file name and adds one.
  take(raw, 2);
  writeFileSync(join(raw, 'snaps', 'copilot-01.json'), 'new only');
  endTake(raw, kept, { restore: true });
  assert.equal(readFileSync(join(raw, 'recording.json'), 'utf8'), 'take 1');
  assert.equal(readFileSync(join(raw, 'snaps', 'copilot-start.json'), 'utf8'), 'start 1');
  assert.equal(existsSync(join(raw, 'snaps', 'copilot-01.json')), false);
  assert.equal(existsSync(join(raw, 'blobs', 'b2')), true);
  assert.equal(existsSync(kept), false);
  // Ran to the end: the new take stays.
  const kept2 = keepLastTake(raw);
  take(raw, 3);
  endTake(raw, kept2, { restore: false });
  assert.equal(readFileSync(join(raw, 'recording.json'), 'utf8'), 'take 3');
  // A first take: nothing to put back, so what it recorded stays.
  const first = join(mkdtempSync(join(tmpdir(), 'sc-take-')), 'raw');
  assert.equal(keepLastTake(first), null);
  take(first, 1);
  endTake(first, null, { restore: true });
  assert.equal(readFileSync(join(first, 'recording.json'), 'utf8'), 'take 1');
});
