import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
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

test('a newer take (Record again) replaces the demo\'s copy of the recording', async t => {
  // Jessica's Mac, Nov 20: the second recording (11 screens) was built as the first (14) because the demo folder's
  // recording.json from the first build won over the raw one.
  const dir = mkdtempSync(join(tmpdir(), 'scenecast-flow-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const raw = join(dir, 'raw');
  mkdirSync(raw);
  writeFileSync(join(dir, 'demo.json'), JSON.stringify({ name: 'fixture', raw, apps: [{ id: 'a', key: 'A' }] }));
  const take = id => ({ states: { [id]: { app: 'a', snap: id } }, beats: [{ active: 'a', states: { a: id } }] });
  writeFileSync(join(raw, 'recording.json'), JSON.stringify(take('first')));
  assert.ok((await compileFlow(loadDemo(dir))).flow.states.first);
  const later = new Date(Date.now() + 5000);
  writeFileSync(join(raw, 'recording.json'), JSON.stringify(take('second')));
  utimesSync(join(raw, 'recording.json'), later, later);
  const { flow } = await compileFlow(loadDemo(dir));
  assert.ok(flow.states.second && !flow.states.first, Object.keys(flow.states).join());
});

test('focus points from an earlier script that don\'t fit a new take are left out, not a failed build', async t => {
  // Nov 20: a new Record for me take had fewer beats than the last script, and Build stopped on its focus point.
  const dir = mkdtempSync(join(tmpdir(), 'scenecast-flow-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'demo.json'), JSON.stringify({ name: 'fixture', apps: [{ id: 'a', key: 'A' }] }));
  const recording = { states: { start: { app: 'a', snap: 'start' } }, beats: [{ active: 'a', states: { a: 'start' } }] };
  writeFileSync(join(dir, 'recording.json'), JSON.stringify(recording));
  writeFileSync(join(dir, 'focus.json'), JSON.stringify({ points: [
    { id: 'keep', app: 'a', states: ['start'], find: 'x', beat: 0 },
    { id: 'old-beat', app: 'a', states: ['start'], find: 'x', beat: 4 },
    { id: 'old-screen', app: 'a', states: ['gone'], find: 'x', beat: 0 },
  ] }));
  const demo = loadDemo(dir);
  const { flow } = await compileFlow(demo);
  const result = await finishFlow(demo, flow, recording);
  assert.deepEqual(result.flow.focus.map(p => p.id), ['keep']);
  assert.deepEqual(result.problems, []);
  assert.ok(result.flow.notes.some(n => /old-beat, old-screen/.test(n)));
});

test('a take recorded in a narrower window: compared at its size, zoom bands below it', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'scenecast-flow-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'demo.json'), JSON.stringify({ name: 'fixture', raw: 'raw', apps: [{ id: 'chat', key: 'C' }] }));
  mkdirSync(join(dir, 'raw'));
  const recording = {
    viewport: { width: 1374, height: 733, dpr: 2.2 },
    states: { start: { app: 'chat', snap: 'start' } }, beats: [{ active: 'chat', states: { chat: 'start' } }],
    sides: { zoom: [
      { app: 'chat', state: 'start', snap: 'v150-start', z: 150, vw: 916, bw: 1374, pw: 1099 },
      { app: 'chat', state: 'start', snap: 'v200-start', z: 200, vw: 687, pw: 916 },
    ] },
  };
  writeFileSync(join(dir, 'raw', 'recording.json'), JSON.stringify(recording));
  writeFileSync(join(dir, 'raw', 'viewport.json'), JSON.stringify(recording.viewport));
  const demo = loadDemo(dir);
  // No viewport in demo.json: the recorded window, not 1920 × 1080 @2.
  assert.deepEqual(demo.cfg.viewport, { width: 1374, height: 733, dpr: 2.2 });
  const { flow } = await compileFlow(demo);
  // The same numbers as the Rust compiler's test (flow.rs): no band at or above the 1374 window.
  assert.deepEqual(flow.apps[0].layout.responsive[0].bands.map(b => b.below), [1008, 802]);
});
