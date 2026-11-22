// Pause and go on (build plan slice 10): the capture window's Hold on comes from the recorder's status, and a
// recording paused (by Pause, or by closing the browser's "debugging" bar) keeps every screen and goes on from there.
//   1. A click while a screen is being captured: status says busy (the capture window's Hold on), then not.
//   2. Pause: what's done in the browser isn't recorded; Go on with the tab moved says which; Go on from here goes on.
//   3. The debugging bar closed: paused by itself; Go on attaches again, every screen kept, and the next click records.
//   node packages/selftest/pause-go-on.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { buildExtension } from '@stuntdouble/capture/build.mjs';
import { send } from '@stuntdouble/capture/cli.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RX = 47707, WEB = 47907;
const tmp = mkdtempSync(join(tmpdir(), 'scenecast-pause-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fails = [];
const check = (name, ok, detail) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? `: ${String(detail).slice(0, 1200)}` : '')); if (!ok) fails.push(name); };
const ping = () => fetch(`http://127.0.0.1:${RX}/ping`).then(r => r.json()).catch(() => null);
const status = async () => (await send({ op: 'recordStatus' }, 30, RX)).value || {};
// Settled: not busy three times running.
const settled = async () => { let quiet = 0; for (let i = 0; i < 120 && quiet < 3; i++) { await sleep(300); quiet = (await status()).busy ? 0 : quiet + 1; } };

// The product: a heading and buttons that each change it (a new screen per click). /live is a second app whose page
// keeps changing by itself (a list that grows every half second), left in the background: Go on mustn't count it as moved.
const web = createServer((q, s) => {
  s.setHeader('content-type', 'text/html');
  if (q.url.startsWith('/live')) return s.end(`<title>Live</title><h1>live</h1><ul id="l"></ul><script>setInterval(() => { const li = document.createElement('li'); li.textContent = new Date().toISOString(); document.getElementById('l').append(li); }, 500)</script>`);
  s.end(`<title>Pause</title><h1 id="t">home</h1>${['two', 'three', 'four', 'five', 'six'].map(w => `<button id="${w}" onclick="document.getElementById('t').textContent='${w}'">${w}</button>`).join(' ')}`);
}).listen(WEB, '127.0.0.1');

const rx = spawn(process.execPath, [join(HERE, '..', 'capture', 'receiver.mjs'), join(tmp, 'raw'), String(RX)], { stdio: 'ignore', env: { ...process.env, SCENECAST_RX_OWNER: 'cli' } });
let ctx;
try {
  buildExtension(join(tmp, 'ext'), RX);
  for (let i = 0; i < 50 && !(await ping()); i++) await sleep(100);
  ctx = await chromium.launchPersistentContext(join(tmp, 'profile'), { channel: 'chromium', headless: true, viewport: { width: 1000, height: 700 }, ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--silent-debugger-extension-api', '--disable-features=DisableLoadExtensionCommandLineSwitch', `--disable-extensions-except=${join(tmp, 'ext')}`, `--load-extension=${join(tmp, 'ext')}`] });
  const live = await ctx.newPage();
  await live.goto(`http://127.0.0.1:${WEB}/live`);
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${WEB}/app`);
  for (let i = 0; i < 80; i++) { const p = await ping(); if (p && p.agent && p.agent.id) break; await sleep(250); }

  const start = await send({ op: 'recordStart', apps: [{ id: 'app', match: `127.0.0.1:${WEB}/app` }, { id: 'live', match: `127.0.0.1:${WEB}/live` }], first: 'app', record: { auto: false, settleMs: 900, everyMs: 250, typeIdleMs: 700 } }, 180, RX);
  check('recording starts', start.ok && start.value.recording, JSON.stringify(start));
  await settled();

  // 1 · A click while capturing: busy (Hold on), then Ready.
  await page.click('#two');
  let busy = false;
  for (let i = 0; i < 40 && !busy; i++) { busy = !!(await status()).busy; if (!busy) await sleep(100); }
  check('a click: the status says busy while the screen is captured (the capture window\'s Hold on)', busy);
  await settled();
  check('and then ready, with the new screen', (await status()).count === 3, JSON.stringify(await status()).slice(0, 300));

  // 2 · Pause: not recorded; Go on with the tab moved says which; Go on from here.
  const p1 = await send({ op: 'recordPause' }, 30, RX);
  check('Pause: paused, by the presenter', p1.ok && p1.value.held === 'you' && (await status()).held?.why === 'you', JSON.stringify(p1));
  await page.click('#three');
  await sleep(2500);
  check('a click while paused isn\'t recorded', (await status()).count === 3, (await status()).count);
  const g1 = await send({ op: 'recordGoOn' }, 120, RX);
  check('Go on with the tab on another screen: still paused, and it says which tab (not the background app that changed by itself)', g1.ok && (g1.value.off || []).join() === 'app' && !!(await status()).held, JSON.stringify(g1.value));
  await page.click('#two');
  const g2 = await send({ op: 'recordGoOn' }, 120, RX);
  check('back on the screen it was paused on: Go on goes on', g2.ok && g2.value.recording && !(await status()).held, JSON.stringify(g2.value));
  await page.click('#four');
  await settled();
  check('the next click records', (await status()).count === 4, (await status()).count);

  // 3 · The debugging bar closed: paused by itself; Go on keeps every screen.
  await send({ op: 'testCloseBar' }, 30, RX);
  let held = null;
  for (let i = 0; i < 20 && !held; i++) { held = (await status()).held; if (!held) await sleep(250); }
  check('the debugging bar closed: paused by itself, and it says why', held?.why === 'bar', JSON.stringify(held));
  const g3 = await send({ op: 'recordGoOn' }, 120, RX);
  const after = await status();
  check('Pick up where I left off: every screen kept', g3.ok && g3.value.recording && !after.held && after.count === 4, JSON.stringify({ g3: g3.value, count: after.count }));
  await page.click('#five');
  await settled();
  check('and the next click records', (await status()).count === 5, (await status()).count);

  // Stop while paused: at once, with every screen (nothing done while paused counts).
  await send({ op: 'recordPause' }, 30, RX);
  await page.click('#six');
  const t0 = Date.now();
  const stop = await send({ op: 'recordStop' }, 300, RX);
  check('Stop while paused: at once, every screen (five), nothing done while paused', stop.ok && stop.value.states === 5 && Date.now() - t0 < 30000, JSON.stringify({ secs: (Date.now() - t0) / 1000, v: stop.value }).slice(0, 300));
  // Chrome's "started debugging this browser" bar goes: no tab is attached once the recording's stopped.
  const ext = (await send({ op: 'extension' }, 30, RX)).value || {};
  check('after Stop: the recorder lets go of every tab (no debugging bar on the stage)', Array.isArray(ext.watching) && ext.watching.length === 0, JSON.stringify(ext).slice(0, 300));
  // A tab looked at while not recording (Record's quiet check) is let go once nothing has needed it for 20 s.
  const looked = await send({ op: 'observe', tab: `127.0.0.1:${WEB}/app` }, 30, RX);
  const attached = ((await send({ op: 'extension' }, 30, RX)).value || {}).watching || [];
  let watching = [];
  for (let i = 0; i < 40; i++) { await sleep(1000); watching = ((await send({ op: 'extension' }, 30, RX)).value || {}).watching || []; if (i > 3 && !watching.length) break; }
  check('not recording: a tab the recorder looked at is let go after a while', looked.ok && attached.length >= 1 && !watching.length, JSON.stringify({ looked: looked.ok || looked.error, attached, watching }).slice(0, 400));
  // Present: the stage window full screen in a browser that was already running (it ignores --start-fullscreen).
  const full = await send({ op: 'stageWindow', url: `http://127.0.0.1:${WEB}/app` }, 30, RX);
  check('present: the recorder puts the stage window full screen', full.ok && full.value && full.value.state === 'fullscreen', JSON.stringify(full).slice(0, 300));
  // Stop presenting: the stage's own window closes; a window with the presenter's other tabs in it doesn't.
  const popup = ctx.waitForEvent('page');
  await (await ctx.newCDPSession(live)).send('Target.createTarget', { url: `http://127.0.0.1:${WEB}/stage`, newWindow: true });
  await (await popup).waitForLoadState();
  const closed = await send({ op: 'closeStage', url: `http://127.0.0.1:${WEB}/stage` }, 30, RX);
  await sleep(500);
  const left = ctx.pages().map(p => p.url());
  check('present: Stop closes the stage window and nothing else', closed.ok && closed.value.closed === 1 && !left.some(u => u.endsWith('/stage')) && left.some(u => u.endsWith('/live')) && left.some(u => u.endsWith('/app')), JSON.stringify({ closed, left }).slice(0, 300));
} catch (e) {
  check('ran', false, e.stack || e);
} finally {
  if (fails.length) try { console.log(readFileSync(join(tmp, 'raw', 'receiver.log'), 'utf8').split('\n').slice(-40).join('\n')); } catch (e) {}
  await send({ op: 'recordAbort' }, 30, RX).catch(() => {});
  await ctx?.close().catch(() => {});
  rx.kill(); web.close();
  try { rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
}
console.log(fails.length ? `pause and go on: ${fails.length} failed` : 'pause and go on: all pass');
process.exit(fails.length ? 1 : 0);
