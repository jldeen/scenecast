// Two browsers with the recorder, one receiver (Jessica's real setup, Nov 19: a check opened the apps' tabs in one
// browser and the recording looked for them in another, so Record said "not open" right after "Ready to record").
//   1. The receiver serves one recorder: every command goes to the same browser, the other waits (standby).
//   2. Preflight says the recorder is in two places, by name, instead of passing.
//   3. A recorder built for a test's port never finds a presenter's Scenecast (an app's receiver on 47621-47630).
//   node packages/selftest/two-recorders.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { buildExtension } from '../recorder/build.mjs';
import { send } from '../recorder/cli.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RX = 47697, APP_RX = 47629;
const tmp = mkdtempSync(join(tmpdir(), 'scenecast-two-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fails = [];
const check = (name, ok, detail) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? `: ${String(detail).slice(0, 1200)}` : '')); if (!ok) fails.push(name); };
const ping = port => fetch(`http://127.0.0.1:${port}/ping`).then(r => r.json()).catch(() => null);
const procs = [], ctxs = [];
async function receiver(port, owner) {
  const raw = join(tmp, 'raw-' + port);
  const p = spawn(process.execPath, [join(HERE, '..', 'recorder', 'receiver.mjs'), raw, String(port)], { stdio: 'ignore', env: { ...process.env, SCENECAST_RX_OWNER: owner } });
  procs.push(p);
  for (let i = 0; i < 50 && !(await ping(port)); i++) await sleep(100);
}
async function browser(name) {
  const ext = join(tmp, 'ext');
  const ctx = await chromium.launchPersistentContext(join(tmp, 'profile-' + name), { channel: 'chromium', headless: true, viewport: { width: 1200, height: 800 }, ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--silent-debugger-extension-api', '--disable-features=DisableLoadExtensionCommandLineSwitch', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
  ctxs.push(ctx);
  const p = await ctx.newPage(); await p.goto('about:blank');
  for (let i = 0; i < (name === 'two' ? 2 : 0); i++) await (await ctx.newPage()).goto('about:blank');
  return ctx;
}
try {
  buildExtension(join(tmp, 'ext'), RX);
  await receiver(RX, 'cli');
  await receiver(APP_RX, 'app');
  const one = await browser('one');
  for (let i = 0; i < 60; i++) { const p = await ping(RX); if (p && p.agent && p.agent.id) break; await sleep(250); }
  const first = (await ping(RX)).agent.id;
  await browser('two');
  for (let i = 0; i < 60; i++) { const p = await ping(RX); if (p && p.agent.others && p.agent.others.length) break; await sleep(250); }
  const p = await ping(RX);
  check('the receiver keeps the first recorder and lists the other', p.agent.id === first && p.agent.others.length === 1 && p.agent.others[0].id !== first, JSON.stringify(p.agent));
  const seen = new Set();
  for (let i = 0; i < 12; i++) { const r = await send({ op: 'diag' }, 30, RX); seen.add(r.ok ? `${r.value.agent} ${r.value.pages.length}` : r.error); }
  check('every command goes to the same browser', seen.size === 1 && [...seen][0].startsWith(first), [...seen].join(' | '));
  const app = await ping(APP_RX);
  check('a test\'s recorder never finds a presenter\'s Scenecast (an app receiver on 47621-47630)', app && !app.agent.id && app.agent.secsAgo === null, JSON.stringify(app.agent));
  // Preflight says so (through the engine, as the app runs it).
  const demo = join(tmp, 'demo');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(demo, { recursive: true });
  writeFileSync(join(demo, 'demo.json'), JSON.stringify({ kit: 1, name: 'two', title: 'Two', port: 4697, receiverPort: RX, raw: join(tmp, 'raw-' + RX), apps: [{ id: 'blank', url: 'about:blank', match: 'about:blank' }], chrome: {} }));
  const pf = await new Promise(res => { const c = spawn(process.execPath, [join(HERE, '..', 'kit', 'bin', 'scenecast.mjs'), 'preflight', '--check', '--json', '--demo', demo], { env: { ...process.env, REPLICA_RX_PORT: String(RX) } }); let o = ''; c.stdout.on('data', d => o += d); c.on('close', () => res(o)); });
  const rec = (() => { try { return JSON.parse(pf.slice(pf.indexOf('{'))).items.find(i => i.id === 'recorder'); } catch (e) { return null; } })();
  check('preflight: "the recorder is in more than one browser"', rec && rec.status === 'fail' && /more than one/.test(rec.detail), pf.slice(-800));
  // The other one goes: the first is still the one, and the warning goes too.
  await ctxs[1].close();
  void one;
} catch (e) {
  check('ran to the end', false, e.stack || e);
} finally {
  for (const c of ctxs) await c.close().catch(() => {});
  for (const p of procs) p.kill();
  await sleep(300);
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
}
console.log(fails.length ? `${fails.length} failing` : 'two recorders: pass');
process.exit(fails.length ? 1 : 0);
