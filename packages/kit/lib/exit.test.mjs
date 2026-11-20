// The engine's answers reach the app through a pipe, whole: Nov 19, an answer over 64 KB (the browser's profiles, with
// their pictures) was cut off when the engine exited, and the app's profile picker never filled in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'scenecast.mjs');

test('a long answer comes through a pipe whole', async () => {
  const big = 'x'.repeat(300000);
  const srv = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url.startsWith('/cmd') && req.method === 'POST' ? JSON.stringify({ id: 'a' }) : JSON.stringify({ id: 'a', ok: true, value: { big } }));
  }).listen(0, '127.0.0.1');
  await new Promise(r => srv.once('listening', r));
  const out = await new Promise(res => {
    const p = spawn(process.execPath, [ENTRY, 'cmd', 'ping', '--port', String(srv.address().port)], { stdio: ['ignore', 'pipe', 'inherit'] });
    let o = ''; p.stdout.on('data', d => { o += d; }); p.on('close', () => res(o));
  });
  srv.close();
  assert.equal(JSON.parse(out).big.length, big.length);
});
