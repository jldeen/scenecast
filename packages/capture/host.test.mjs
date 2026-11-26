import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from './host.mjs';

const demo = { dir: '.', out: mkdtempSync(join(tmpdir(), 'host-')), cfg: {} };
const tries = answers => { const seen = []; return { seen, once: async () => { seen.push(1); return answers.shift(); } }; };

test('a start that couldn\'t tell an app\'s tenant starts once more; any other refusal is the answer', async () => {
  const stuck = { ok: false, phase: 'refused', error: "refusing to capture: couldn't tell which tenant copilot is signed in to" };
  const a = tries([stuck, { ok: true, phase: 'recording-ready' }]);
  assert.deepEqual(await start(demo, { once: a.once, pause: 0 }), { ok: true, phase: 'recording-ready', retried: true });
  assert.equal(a.seen.length, 2);
  const b = tries([{ ok: false, phase: 'refused', error: 'refusing to capture: copilot is signed in to another tenant' }]);
  assert.equal((await start(demo, { once: b.once, pause: 0 })).ok, false);
  assert.equal(b.seen.length, 1);
  const c = tries([stuck, stuck]);
  assert.equal((await start(demo, { once: c.once, pause: 0 })).ok, false);
  assert.equal(c.seen.length, 2);
});
