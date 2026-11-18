import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileFlow, finishFlow, validate } from './flow.mjs';
import { loadDemo } from '../lib/demo.mjs';

test('app shortcuts cannot collide with focus, next or fill', () => {
  const flow = key => ({
    apps: [{ id: 'app', key }],
    states: { start: { app: 'app', snap: 'start' } },
    beats: [{ active: 'app', states: { app: 'start' } }],
  });

  for (const key of ['F', 'f', 'N', 'P', '1', '?']) {
    assert.ok(validate(flow(key)).some(p => p.startsWith('app key')), key);
  }
  assert.deepEqual(validate(flow('A')), []);
});

test('flow finishing applies overrides before focus points', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'scenecast-flow-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'demo.json'), JSON.stringify({ name: 'fixture', apps: [{ id: 'a', key: 'A' }] }));
  const recording = { states: { start: { app: 'a', snap: 'start' } }, beats: [{ active: 'a', states: { a: 'start' } }] };
  writeFileSync(join(dir, 'recording.json'), JSON.stringify(recording));
  const demo = loadDemo(dir);
  const { flow } = await compileFlow(demo);
  writeFileSync(join(dir, 'flow.overrides.mjs'), "export default flow => { flow.custom = 'edited'; };\n");
  writeFileSync(join(dir, 'focus.mjs'), "export default flow => [{ id: flow.custom, app: 'a', states: ['start'], find: 'text', beat: 0 }];\n");
  const result = await finishFlow(demo, flow, recording);
  assert.deepEqual(result.problems, []);
  assert.equal(result.flow.focus[0].id, 'edited');
  assert.deepEqual(result.flow.modules, ['/app/focus-module.js']);
});

test('focus points follow wording and date edits', async () => {
  const { focusAfterEdits } = await import('./flow.mjs');
  const states = { a: { snap: 'a' }, b: { snap: 'b' } };
  const points = [
    { id: 'p1', states: ['a'], find: 'The earliest is due Friday.' },
    { id: 'p2', states: ['b'], union: ['due Friday', { text: 'Friday', up: 1 }, { sel: 'button' }] },
  ];
  const out = focusAfterEdits(points, [{ replace: ['Friday', 'Monday'] }], states);
  assert.equal(out[0].find, 'The earliest is due Monday.');
  assert.deepEqual(out[1].union, ['due Monday', { text: 'Monday', up: 1 }, { sel: 'button' }]);
  // An edit for some captures only changes the points on them.
  const only = focusAfterEdits(points, [{ replace: ['Friday', 'Monday'], in: ['b'] }], states);
  assert.equal(only[0].find, 'The earliest is due Friday.');
  assert.equal(only[1].union[0], 'due Monday');
  assert.equal(points[0].find, 'The earliest is due Friday.');
});
