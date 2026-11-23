// Scrollbars in a clean capture, on a Mac that always shows them (System Settings, Show scroll bars: Always, as with a
// mouse connected). Headed Chrome with the recorder, the fixture admin page (a scrolling grid): a plain screenshot must
// show the bar (or this Mac can't test it), the recorder's start-screen capture must not, and the recorder's log says
// how much room each scroller's bar took before and after cleaning.
//   defaults write -g AppleShowScrollBars -string Always   (then this; Diagnose on a macOS runner)
//   node packages/selftest/scrollbar-capture.mjs
import './reap.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { buildExtension } from '@stuntdouble/capture/build.mjs';
import { send } from '@stuntdouble/capture/cli.mjs';
import { startFixture } from '../../examples/fixture-app/server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RX = 47699;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fails = [];
const check = (name, ok, detail) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? `: ${String(detail).slice(0, 1500)}` : '')); if (!ok) fails.push(name); return ok; };
const tmp = mkdtempSync(join(tmpdir(), 'scenecast-bars-'));
const raw = join(tmp, 'raw');
const OUT = process.env.DIAG_DIR || tmp;
const fx = startFixture({ chatPort: 47831, adminPort: 47832 });
const rx = spawn(process.execPath, [join(HERE, '..', 'capture', 'receiver.mjs'), raw, String(RX)], { stdio: 'ignore', env: { ...process.env, SCENECAST_RX_OWNER: 'cli' } });
let ctx;
const ping = () => fetch(`http://127.0.0.1:${RX}/ping`).then(r => r.json()).catch(() => null);
// Dark pixels in the right 16 px of the grid (where its scrollbar is), in a PNG.
const bar = (page, b64) => page.evaluate(async b64 => {
  const i = await new Promise(r => { const im = new Image(); im.onload = () => r(im); im.src = 'data:image/png;base64,' + b64; });
  const k = i.width / innerWidth, c = new OffscreenCanvas(i.width, i.height), g = c.getContext('2d'); g.drawImage(i, 0, 0);
  const d = g.getImageData(Math.floor((innerWidth - 16) * k), Math.floor(80 * k), Math.floor(16 * k), Math.floor(400 * k)).data; let n = 0;
  for (let j = 0; j < d.length; j += 4) if (d[j] < 200 && Math.abs(d[j] - d[j + 1]) < 10 && Math.abs(d[j] - d[j + 2]) < 10) n++;
  return n;
}, b64);
try {
  const ext = join(tmp, 'ext');
  buildExtension(ext, RX);
  for (let i = 0; i < 50 && !(await ping()); i++) await sleep(100);
  ctx = await chromium.launchPersistentContext(join(tmp, 'profile'), { channel: 'chromium', headless: false, viewport: { width: 1200, height: 800 }, ignoreDefaultArgs: ['--disable-extensions', '--hide-scrollbars'],
    args: ['--silent-debugger-extension-api', '--disable-features=DisableLoadExtensionCommandLineSwitch', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
  const p = await ctx.newPage(); await p.goto(fx.admin); await sleep(1500);
  const room = await p.evaluate(() => { const b = document.getElementById('box'); return b.offsetWidth - b.clientWidth; });
  const plain = (await p.screenshot()).toString('base64');
  writeFileSync(join(OUT, 'bars-plain.png'), Buffer.from(plain, 'base64'));
  const plainBar = await bar(p, plain);
  console.log(`the grid's scrollbar takes ${room} px; a plain screenshot has ${plainBar} bar pixels`);
  const testable = check('this Mac draws the scrollbar in a plain screenshot', plainBar > 0 || room > 0, `room ${room}, bar pixels ${plainBar}`);
  for (let i = 0; i < 80; i++) { const g = await ping(); if (g && g.agent && g.agent.id) break; await sleep(250); }
  const match = fx.admin.replace(/^https?:\/\//, '');
  const rs = await send({ op: 'recordStart', apps: [{ id: 'admin', match }], record: { auto: false } }, 120, RX);
  check('recording starts', rs.ok, JSON.stringify(rs));
  for (let i = 0; i < 60 && !readdirSync(join(raw, 'shots')).some(f => /^admin-start/.test(f)); i++) await sleep(500);
  await send({ op: 'recordAbort' }, 60, RX);
  const shot = readdirSync(join(raw, 'shots')).find(f => /^admin-start\.png$/.test(f));
  const b64 = shot ? readFileSync(join(raw, 'shots', shot)).toString('base64') : '';
  if (shot) writeFileSync(join(OUT, 'bars-capture.png'), Buffer.from(b64, 'base64'));
  const capBar = b64 ? await bar(p, b64) : -1;
  const log = readFileSync(join(raw, 'receiver.log'), 'utf8').split('\n').filter(l => /clean admin-start/.test(l)).join('\n');
  console.log(log || '(no clean line in the recorder log)');
  if (testable) check('the recorder\'s clean capture has no scrollbar', capBar === 0, `bar pixels ${capBar}`);
} catch (e) {
  check('ran', false, e.stack || e);
} finally {
  await ctx?.close().catch(() => {});
  rx.kill(); fx.close();
  if (!process.env.SCENECAST_KEEP) rmSync(tmp, { recursive: true, force: true });
}
console.log(fails.length ? `scrollbar capture: ${fails.length} failed` : 'scrollbar capture: all pass');
process.exit(fails.length ? 1 : 0);
