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
