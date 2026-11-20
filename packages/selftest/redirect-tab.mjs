// Record finds the tab Check found (build plan slice 2): Record's start runs the same check, with its fixes, in one
// pass, and the check finds a tab the way Record does.
//   1. An app whose address redirects to another host: the tab it opens is found, its new host kept as the app's match
//      (demo.json), and the recording starts on the first try.
//   2. An app that lands on a sign-in page: not ready, and it says to sign in (never a recording of the sign-in page).
//   3. An app that isn't open, with nothing to open: not ready, with the open tabs, so the app can ask which one it is.
//   node packages/selftest/redirect-tab.mjs
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { buildExtension } from '../recorder/build.mjs';
import { send } from '../recorder/cli.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT = join(HERE, '..', 'kit', 'bin', 'scenecast.mjs');
const RX = 47697, WEB = 47897;
const tmp = mkdtempSync(join(tmpdir(), 'scenecast-redirect-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fails = [];
const check = (name, ok, detail) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? `: ${String(detail).slice(0, 1500)}` : '')); if (!ok) fails.push(name); };
const ping = () => fetch(`http://127.0.0.1:${RX}/ping`).then(r => r.json()).catch(() => null);

// The product: /moved redirects to the same server on another host (localhost); /signin to a sign-in host.
const web = createServer((q, s) => {
  const u = new URL(q.url, 'http://x');
  if (u.pathname === '/moved') { s.writeHead(302, { location: `http://localhost:${WEB}/app?who=admin` }); return s.end(); }
  if (u.pathname === '/signin') { s.writeHead(302, { location: `http://login.localhost:${WEB}/login` }); return s.end(); }
  s.setHeader('content-type', 'text/html');
  const who = u.searchParams.get('who') || (u.pathname === '/login' ? 'Sign in' : 'app');
  s.end(`<title>${who}</title><h1>${who}</h1><button>Open</button>`);
}).listen(WEB, '127.0.0.1');

const demoDir = (name, apps) => {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'demo.json'), JSON.stringify({ name, title: name, port: 47898, receiverPort: RX, raw: join(tmp, `${name}-raw`), chrome: { browser: 'chrome' }, record: { auto: false }, apps }, null, 2) + '\n');
  return dir;
};
const start = dir => {
  const r = spawnSync(process.execPath, [KIT, 'record', 'start', '--demo', dir], { encoding: 'utf8', env: { ...process.env, REPLICA_RX_PORT: String(RX), REPLICA_NO_OPEN: '1' }, timeout: 240000 });
  try { return JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))); } catch (e) { return { error: `no answer: ${r.stdout}\n${r.stderr}` }; }
};

const rx = spawn(process.execPath, [join(HERE, '..', 'recorder', 'receiver.mjs'), join(tmp, 'raw'), String(RX)], { stdio: 'ignore', env: { ...process.env, SCENECAST_RX_OWNER: 'cli' } });
let ctx;
try {
  buildExtension(join(tmp, 'ext'), RX);
  for (let i = 0; i < 50 && !(await ping()); i++) await sleep(100);
  ctx = await chromium.launchPersistentContext(join(tmp, 'profile'), { channel: 'chromium', headless: true, viewport: { width: 1200, height: 800 }, ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--silent-debugger-extension-api', '--disable-features=DisableLoadExtensionCommandLineSwitch', `--disable-extensions-except=${join(tmp, 'ext')}`, `--load-extension=${join(tmp, 'ext')}`] });
  await (await ctx.newPage()).goto(`http://127.0.0.1:${WEB}/app?who=chat`);
  for (let i = 0; i < 80; i++) { const p = await ping(); if (p && p.agent && p.agent.id) break; await sleep(250); }

  // 1 · Redirected: opened, found, kept, recorded.
  const moved = demoDir('moved', [{ id: 'chat', url: `http://127.0.0.1:${WEB}/app?who=chat`, match: `127.0.0.1:${WEB}` }, { id: 'admin', url: `http://127.0.0.1:${WEB}/moved`, match: `127.0.0.1:${WEB}/moved` }]);
  const r1 = start(moved);
  check('an app whose address redirects to another host records on the first Start', r1.recording === true, JSON.stringify(r1));
  const kept = JSON.parse(readFileSync(join(moved, 'demo.json'), 'utf8')).apps.find(a => a.id === 'admin');
  check('its new host is kept as the app\'s match', kept.match === `localhost:${WEB}`, JSON.stringify(kept));
  const status = await send({ op: 'recordStatus' }, 30, RX);
  check('both tabs are in the recording', status.ok && (status.value.apps || []).length === 2 || status.ok && status.value.recording, JSON.stringify(status.value).slice(0, 400));
  await send({ op: 'recordAbort' }, 60, RX);

  // 2 · A sign-in page: not ready, says so, nothing recorded.
  const signin = demoDir('signin', [{ id: 'admin', url: `http://127.0.0.1:${WEB}/signin`, match: `127.0.0.1:${WEB}/signin` }]);
  const r2 = start(signin);
  check('an app that lands on a sign-in page isn\'t recorded: it says to sign in', /^not ready to record: admin opened a sign-in page/.test(r2.error || '') && !r2.recording, JSON.stringify(r2).slice(0, 600));
  check('and its match is left alone', JSON.parse(readFileSync(join(signin, 'demo.json'), 'utf8')).apps[0].match === `127.0.0.1:${WEB}/signin`);

  // 3 · Not open, nothing to open: the open tabs come back, to pick from.
  const ghost = demoDir('ghost', [{ id: 'ghost', match: 'nowhere.invalid' }]);
  const r3 = start(ghost);
  const item = (r3.items || []).find(i => i.id === 'app ghost') || {};
  check('an app that can\'t be found comes back with the open tabs to pick from', /no tab for ghost/.test(r3.error || '') && item.missing === true && (item.tabs || []).some(t => t.title === 'chat' && t.host === `127.0.0.1:${WEB}`), JSON.stringify(item).slice(0, 600));
} catch (e) {
  check('ran', false, e.stack || e);
} finally {
  await send({ op: 'recordAbort' }, 30, RX).catch(() => {});
  await ctx?.close().catch(() => {});
  rx.kill(); web.close();
  try { rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
}
console.log(fails.length ? `redirect tab: ${fails.length} failed` : 'redirect tab: all pass');
process.exit(fails.length ? 1 : 0);
