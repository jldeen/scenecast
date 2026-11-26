import test from 'node:test';
import assert from 'node:assert/strict';
import './reap.mjs';
import { spawn } from 'node:child_process';

test('what a child leaves in its group ends when the child does', { skip: process.platform === 'win32' }, async () => {
  // A child (its own group, as reap starts it) that starts a long-lived one in its group and ends without stopping it.
  const p = spawn(process.execPath, ['-e', "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log(c.pid); setTimeout(() => process.exit(0), 300);"], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = ''; p.stdout.on('data', d => { out += d; });
  await new Promise(res => p.on('exit', res));
  const pid = +out.trim();
  assert.ok(pid > 0, out);
  const alive = () => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };
  for (let i = 0; i < 30 && alive(); i++) await new Promise(r => setTimeout(r, 100));
  const left = alive();
  if (left) process.kill(pid, 'SIGKILL');
  assert.equal(left, false, 'the grandchild outlived its group\'s leader');
  assert.equal(process.env.REPLICA_EXIT_WITH_PARENT, '1', 'a test\'s processes pass the flag on');
});

test("name parity's replica server ends when Chromium won't start", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createServer } = await import('node:net');
  const dir = mkdtempSync(join(tmpdir(), 'sc-parity-'));
  mkdirSync(join(dir, 'data', 'snaps'), { recursive: true });
  writeFileSync(join(dir, 'demo.json'), JSON.stringify({ name: 'parity', raw: join(dir, 'raw'), apps: [{ id: 'a', key: 'A' }] }));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schema_version: 'scenecast.bundle.v2', title: 'Parity', apps: [{ id: 'a', title: 'A', key: 'A' }],
    graph: { start_scene: 'a', scenes: [{ id: 'a', kind: 'live-page', live: { app: 'a', snapshot: 'data/snaps/a.html' } }] }, beats: [{ label: 'A', active: 'a', scenes: { a: 'a' } }] }));
  writeFileSync(join(dir, 'data', 'snaps', 'a.html'), '<!doctype html><title>A</title><button>Go</button>');
  const port = await new Promise(res => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  // In a process of its own, with no browsers where Playwright looks (the launch fails): is the server still on its
  // port once nameParity has failed? That process then exits, and a server left behind goes with it.
  const code = `const { nameParity } = await import(${JSON.stringify(new URL('./name-parity.mjs', import.meta.url).href)});
    await nameParity({ demo: ${JSON.stringify(dir)}, port: ${port} }).then(() => console.log('launched'), () => {});
    let up = true;
    for (let i = 0; i < 30 && up; i++) { up = await fetch('http://127.0.0.1:${port}/manifest.json').then(() => true, () => false); if (up) await new Promise(r => setTimeout(r, 100)); }
    console.log(up ? 'up' : 'down');
    process.exit(0);`;
  const p = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(dir, 'no-browsers') } });
  let out = ''; p.stdout.on('data', d => { out += d; });
  await new Promise(res => p.on('exit', res));
  assert.equal(out.trim(), 'down', 'the replica server stayed on its port');
});
