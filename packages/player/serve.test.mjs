import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyFlowOverrides, flowFromBundle } from './app/bundle-flow.js';

test('a capture request immediately sees a changed live override', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'scenecast-serve-test-'));
  mkdirSync(join(dir, 'data', 'snaps'), { recursive: true });
  mkdirSync(join(dir, 'custom'));
  writeFileSync(join(dir, 'demo.json'), JSON.stringify({ name: 'fixture', apps: [{ id: 'a', key: 'A' }] }));
  writeFileSync(join(dir, 'recording.json'), JSON.stringify({
    states: { start: { app: 'a', snap: 'start' } },
    beats: [{ active: 'a', states: { a: 'start' } }],
  }));
  writeFileSync(join(dir, 'data', 'snaps', 'start.html'), '<p>before</p>');
  writeFileSync(join(dir, 'custom', 'start.html'), '<p>custom</p>');
  writeFileSync(join(dir, 'custom', 'private.txt'), 'private');
  writeFileSync(join(dir, 'custom', 'fallback.png'), 'fallback');
  writeFileSync(join(dir, 'custom', 'frame.png'), 'frame');
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    schema_version: 'scenecast.bundle.v2', title: 'Fixture',
    apps: [{ id: 'a', title: 'A', key: 'A' }],
    graph: { start_scene: 'start', scenes: [
      { id: 'start', title: 'Bundle Start', kind: 'live-page', live: { app: 'a', snapshot: 'custom/start.html' } },
      { id: 'fallback', kind: 'screenshot', assets: { screenshot: 'custom/fallback.png' },
        hotspots: [{ transition: { frames: [{ path: 'custom/frame.png' }] } }] },
    ] },
    beats: [{ label: 'Reset', active: 'a', scenes: { a: 'start' } }],
  }));
  const override = join(dir, 'flow.overrides.mjs');
  writeFileSync(override, 'export default function(flow) {}\n');
  const port = await new Promise(resolve => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
  const child = spawn(process.execPath, [fileURLToPath(new URL('./serve.mjs', import.meta.url)), '--demo', dir, '--port', String(port)], {
    stdio: 'ignore',
    env: { ...process.env, REPLICA_NO_OPEN: '1', REPLICA_RAW: join(dir, 'raw') },
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise(resolve => child.once('close', resolve));
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try { ready = (await fetch(base + '/__replica/status')).ok; }
    catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  assert.ok(ready, 'server did not start');
  assert.equal((await fetch(base + '/flow.json')).status, 404);
  const baseline = JSON.parse(readFileSync(join(dir, 'flow.json'), 'utf8'));
  mkdirSync(join(dir, '.out'), { recursive: true });
  writeFileSync(join(dir, '.out', 'live-base.json'), JSON.stringify(baseline));
  writeFileSync(override, "export default function(flow) { flow.edits = [{ replace: ['before', 'after'] }]; flow.states.start.fill = [{ value: 'live' }]; }\n");
  const next = new Date(Date.now() + 2000);
  utimesSync(override, next, next);
  const responses = await Promise.all([fetch(base + '/snaps/start.html'), fetch(base + '/snaps/start.html')]);
  assert.deepEqual(await Promise.all(responses.map(r => r.text())), ['<p>after</p>', '<p>after</p>']);
  const manifest = await (await fetch(base + '/manifest.json')).json();
  const flow = applyFlowOverrides(flowFromBundle(manifest), manifest.development_overrides);
  assert.equal(flow.states.start.fill[0].value, 'live');
  assert.equal(flow.states.start.snapshot, 'custom/start.html');
  assert.equal(flow.states.start.title, 'Bundle Start');
  assert.equal(await (await fetch(base + '/bundle/custom/start.html')).text(), '<p>custom</p>');
  assert.equal(await (await fetch(base + '/bundle/custom/fallback.png')).text(), 'fallback');
  assert.equal(await (await fetch(base + '/bundle/custom/frame.png')).text(), 'frame');
  assert.equal((await fetch(base + '/bundle/custom/private.txt')).status, 404);
});

test('demo.json static: a folder of the demo served as is, with byte ranges and its service worker allowed', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'scenecast-static-test-'));
  mkdirSync(join(dir, 'data', 'snaps'), { recursive: true });
  mkdirSync(join(dir, 'trace'));
  writeFileSync(join(dir, 'trace', 'trace.zip'), '0123456789');
  writeFileSync(join(dir, 'demo.json'), JSON.stringify({ name: 'fixture', apps: [{ id: 'a', key: 'A' }], static: { '/trace/': 'trace' } }));
  writeFileSync(join(dir, 'recording.json'), JSON.stringify({ states: { start: { app: 'a', snap: 'start' } }, beats: [{ active: 'a', states: { a: 'start' } }] }));
  writeFileSync(join(dir, 'data', 'snaps', 'start.html'), '<p>x</p>');
  const port = await new Promise(resolve => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const child = spawn(process.execPath, [fileURLToPath(new URL('./serve.mjs', import.meta.url)), '--demo', dir, '--port', String(port)], { stdio: 'ignore', env: { ...process.env, REPLICA_NO_OPEN: '1', REPLICA_RAW: join(dir, 'raw') } });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await new Promise(r => child.once('close', r)); } rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) { try { ready = (await fetch(base + '/__replica/status')).ok; } catch { await new Promise(r => setTimeout(r, 20)); } }
  assert.ok(ready, 'server did not start');
  const whole = await fetch(base + '/trace/trace.zip');
  assert.equal(whole.headers.get('content-type'), 'application/zip');
  assert.equal(whole.headers.get('service-worker-allowed'), '/trace/');
  assert.equal(await whole.text(), '0123456789');
  const part = await fetch(base + '/trace/trace.zip', { headers: { range: 'bytes=2-4' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 2-4/10');
  assert.equal(await part.text(), '234');
  assert.equal((await fetch(base + '/trace/../demo.json')).status, 404);
});

test('a server started for a check goes when what started it goes (REPLICA_EXIT_WITH_PARENT)', { skip: process.platform === 'win32' }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'scenecast-serve-parent-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'data', 'snaps'), { recursive: true });
  writeFileSync(join(dir, 'demo.json'), JSON.stringify({ name: 'fixture', apps: [{ id: 'a', key: 'A' }] }));
  writeFileSync(join(dir, 'recording.json'), JSON.stringify({ states: { start: { app: 'a', snap: 'start' } }, beats: [{ active: 'a', states: { a: 'start' } }] }));
  writeFileSync(join(dir, 'data', 'snaps', 'start.html'), '<p>x</p>');
  const port = await new Promise(res => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const serve = fileURLToPath(new URL('./serve.mjs', import.meta.url));
  // A parent that starts the server and ends without stopping it (a check that crashed).
  const parent = spawn(process.execPath, ['-e', `const c = require('node:child_process').spawn(process.execPath, [${JSON.stringify(serve)}, '--demo', ${JSON.stringify(dir)}, '--port', '${port}', '--no-editor'], { stdio: 'ignore', env: { ...process.env, REPLICA_NO_OPEN: '1', REPLICA_EXIT_WITH_PARENT: '1' } }); console.log(c.pid); setTimeout(() => process.exit(0), 1500);`], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = ''; parent.stdout.on('data', d => { out += d; });
  await new Promise(res => parent.on('exit', res));
  const pid = +out.trim();
  assert.ok(pid > 0, out);
  const alive = () => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };
  for (let i = 0; i < 50 && alive(); i++) await new Promise(r => setTimeout(r, 100));
  const left = alive();
  if (left) process.kill(pid, 'SIGTERM');
  assert.equal(left, false, 'the server outlived its parent');
});
