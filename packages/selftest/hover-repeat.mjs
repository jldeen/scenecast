// The hover check, and then the whole checklist, over and over on the selftest's kept demo: a hover that shows one
// run and not the next is a bug. Used by .github/workflows/repeat.yml after npm test (SCENECAST_SELFTEST_KEEP).
//   LOOPS=10 node packages/selftest/hover-repeat.mjs [demo folder]
import './reap.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selftestGuard } from './guard.mjs';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = resolve(process.env.SCENECAST_BIN || join(KIT, '..', 'target', 'debug', process.platform === 'win32' ? 'scenecast.exe' : 'scenecast'));
const keepFile = process.env.SCENECAST_SELFTEST_KEEP;
const tmp = process.argv[2] || (keepFile && existsSync(keepFile) ? readFileSync(keepFile, 'utf8').trim() : null);
if (!tmp) { console.log('no kept demo: run npm test with SCENECAST_SELFTEST_KEEP=<file>, or pass the folder'); process.exit(1); }
await selftestGuard({ tmp, kept: [existsSync(join(tmp, 'demo.json')) ? dirname(resolve(tmp)) : tmp] });
const DEMO = existsSync(join(tmp, 'demo.json')) ? tmp : join(tmp, 'fixture-demo');
const LOOPS = +(process.env.LOOPS || 10), PORT = 4731, URL = `http://127.0.0.1:${PORT}/`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const exec = (cmd, args, opts = {}) => new Promise(res => {
  const p = spawn(cmd, args, { cwd: DEMO, env: { ...process.env, REPLICA_NO_OPEN: '1' }, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  let out = ''; p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
  p.on('close', code => res({ code, out }));
});

const server = spawn(process.execPath, [join(KIT, 'player', 'serve.mjs'), '--demo', DEMO, '--port', String(PORT)], { stdio: 'ignore', env: { ...process.env, REPLICA_NO_OPEN: '1' } });
for (let i = 0; i < 100; i++) { try { if ((await fetch(URL)).ok) break; } catch (e) {} await sleep(200); }
let bad = 0;
try {
  for (let i = 1; i <= LOOPS; i++) {
    const r = await exec(process.execPath, [join(KIT, 'checks', 'hover-check.mjs'), '--demo', DEMO, '--url', URL, '--speed', '10', '--no-sheet']);
    let rep = null; try { rep = JSON.parse(readFileSync(join(DEMO, '.out', 'hovers', 'report.json'), 'utf8')); } catch (e) {}
    const ok = rep && rep.shown === rep.total && !rep.failed.length && !rep.errors.length;
    console.log(`${ok ? 'PASS' : 'FAIL'} hover check ${i}/${LOOPS}: ${rep ? `${rep.shown}/${rep.total} shown` : r.out.slice(-400)}`);
    if (!ok) { bad++; if (rep) for (const f of rep.failed) console.log(`  ${f.id}: ${f.text} ${JSON.stringify(f.at || '')}\n    ${(f.trace || []).join('\n    ')}`); }
  }
  const full = Math.max(1, Math.ceil(LOOPS / 3));
  for (let i = 1; i <= full; i++) {
    // Not focus: the selftest's last step (the editor) changes a date its script's lines quote.
    const r = await exec(BIN, ['check', '--url', URL, '--only', 'secrets,render,two-run,cold-start,light,transitions,composer,keys,lists,zoom,clicks,drags,groups,chips,reset,hovers,contact-sheet']);
    const ok = r.code === 0;
    console.log(`${ok ? 'PASS' : 'FAIL'} checklist ${i}/${full}`);
    if (!ok) { bad++; console.log(r.out.split('\n').filter(l => !/^PASS|^MANUAL/.test(l)).join('\n').slice(-6000)); }
  }
} finally {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); else server.kill();
}
console.log(bad ? `${bad} FAILED` : 'ALL PASS');
process.exit(bad ? 1 : 0);
