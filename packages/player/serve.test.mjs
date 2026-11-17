import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('a capture request immediately sees a changed live override', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'scenecast-serve-test-'));
  mkdirSync(join(dir, 'data', 'snaps'), { recursive: true });
  writeFileSync(join(dir, 'demo.json'), JSON.stringify({ name: 'fixture', apps: [{ id: 'a', key: 'A' }] }));
  writeFileSync(join(dir, 'recording.json'), JSON.stringify({
    states: { start: { app: 'a', snap: 'start' } },
    beats: [{ active: 'a', states: { a: 'start' } }],
  }));
  writeFileSync(join(dir, 'data', 'snaps', 'start.html'), '<p>before</p>');
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
    try { ready = (await fetch(base + '/flow.json')).ok; }
    catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  assert.ok(ready, 'server did not start');
  writeFileSync(override, "export default function(flow) { flow.edits = [{ replace: ['before', 'after'] }]; }\n");
  const next = new Date(Date.now() + 2000);
  utimesSync(override, next, next);
  const responses = await Promise.all([fetch(base + '/snaps/start.html'), fetch(base + '/snaps/start.html')]);
  assert.deepEqual(await Promise.all(responses.map(r => r.text())), ['<p>after</p>', '<p>after</p>']);
});
