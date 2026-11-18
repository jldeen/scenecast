// The desktop app's UI test: a scripted new user goes through the whole flow on the fixture app, from create to
// present and export, in the real app window (WebDriver, through the app's embedded WebDriver server), on macOS,
// Windows and Linux. Nothing in it uses a terminal the way a presenter would: every step is a click or typing in the
// app. The browser the "presenter" records in is Playwright's Chromium with the recorder extension loaded unpacked
// (the one-time Load unpacked step), headless; the test plays the person going through the demo in it.
//
//   npm run build:test && npm run test:ui        (apps/desktop; the repo's npm ci and Playwright Chromium first)
// Env: SCENECAST_APP_BIN (the app built with --features webdriver), SCENECAST_UI_SHOTS (a folder: screenshots of each
// screen), SCENECAST_UI_KEEP=1 (keep the temp folder).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { remote } from 'webdriverio';
import { chromium } from 'playwright-core';
import { startFixture } from '../../../examples/fixture-app/server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');
const WIN = process.platform === 'win32';
const BIN = resolve(process.env.SCENECAST_APP_BIN || join(HERE, '..', 'src-tauri', 'target', 'debug', WIN ? 'scenecast-desktop.exe' : 'scenecast-desktop'));
const SHOTS = process.env.SCENECAST_UI_SHOTS ? resolve(process.env.SCENECAST_UI_SHOTS) : null;
const RX_PORT = 47693, WD_PORT = +(process.env.TAURI_WEBDRIVER_PORT || 4445);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fails = [];
const times = {};
const check = (name, ok, detail) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? `: ${String(detail).slice(0, 1500)}` : '')); if (!ok) fails.push(name); return ok; };

if (!existsSync(BIN)) { console.log(`no app at ${BIN}: npm run build:test first (or set SCENECAST_APP_BIN)`); process.exit(1); }
for (const port of [RX_PORT, WD_PORT, 47801, 47802]) {
  const taken = await new Promise(res => { const s = createServer().once('error', () => res(true)).once('listening', () => s.close(() => res(false))).listen(port, '127.0.0.1'); });
  if (taken) { console.log(`port ${port} is in use: stop whatever is on it and run again`); process.exit(1); }
}

const tmp = mkdtempSync(join(tmpdir(), 'scenecast-ui-'));
const LIB = join(tmp, 'Scenecast');
const EXT = join(tmp, 'extension');
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const fx = startFixture();

// ---- The app -----------------------------------------------------------------------------------------------------
const appLog = [];
const app = spawn(BIN, [], {
  env: {
    ...process.env,
    TAURI_WEBDRIVER_PORT: String(WD_PORT),
    SCENECAST_LIBRARY: LIB,
    SCENECAST_EXTENSION_DIR: EXT,
    SCENECAST_JS: process.env.SCENECAST_JS || join(ROOT, 'packages'),
    REPLICA_RX_PORT: String(RX_PORT),
    // The test's own headless browser plays the presenter's: the app shows each replica's address instead of opening it.
    REPLICA_NO_OPEN: '1',
    REPLICA_CHROME_CHANNEL: process.env.REPLICA_CHROME_CHANNEL || 'chrome',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
app.stdout.on('data', d => appLog.push(String(d)));
app.stderr.on('data', d => appLog.push(String(d)));
let appExit = null;
app.on('exit', code => { appExit = code; });

let b, ctx, viewer, receiverPid;
async function session() {
  const t0 = Date.now();
  for (let i = 0; ; i++) {
    if (appExit !== null) throw new Error(`the app exited (${appExit}):\n${appLog.join('')}`);
    // The app's WebDriver server starts with its window: wait for its port first (connecting earlier only logs errors).
    const up = await new Promise(res => { const c = connect(WD_PORT, '127.0.0.1').once('connect', () => { c.destroy(); res(true); }).once('error', () => res(false)); });
    if (!up) { if (Date.now() - t0 > 90000) throw new Error(`the app's WebDriver server isn't listening on ${WD_PORT} after 90 s`); await sleep(500); continue; }
    try {
      return await remote({ hostname: '127.0.0.1', port: WD_PORT, logLevel: 'error', connectionRetryCount: 0, capabilities: { browserName: 'tauri' } });
    } catch (e) {
      if (Date.now() - t0 > 90000) throw e;
      await sleep(1000);
    }
  }
}
const T = t => `[data-test="${t}"]`;
const el = t => b.$(T(t));
// Re-found on every try: the app re-renders parts of the window as progress comes in.
async function click(t, timeout = 30000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try {
      const e = await el(t);
      if (await e.isClickable()) { await e.click(); return; }
      last = 'not clickable';
    } catch (err) { last = err.message; }
    await sleep(250);
  }
  throw new Error(`${t} still not clickable after ${timeout / 1000} s: ${last}`);
}
async function waitFor(what, fn, timeout = 60000, every = 500) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e.message; }
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${what} (${Math.round(timeout / 1000)} s): ${typeof last === 'string' ? last : JSON.stringify(last)}`);
}
const attr = async (t, a) => { const e = await el(t); return (await e.isExisting()) ? e.getAttribute(a) : null; };
const exists = async t => (await el(t)).isExisting();
const text = async t => (await el(t)).getText();
async function shot(name) {
  if (!SHOTS) return;
  await sleep(400);
  await b.saveScreenshot(join(SHOTS, `${name}.png`));
}
async function type(t, value) {
  const e = await el(t);
  await e.waitForDisplayed({ timeout: 15000 });
  await e.click();
  await e.setValue(value);
}

// The presenter's browser: Chromium with the recorder extension loaded unpacked (the one-time step), headless.
async function launchWithExtension(ext, profile) {
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, viewport: null, colorScheme: 'light', ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--silent-debugger-extension-api', '--force-device-scale-factor=1', '--window-size=1700,1100', '--screen-info={0,0 2560x1600}',
      '--disable-features=DisableLoadExtensionCommandLineSwitch', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  if (!ctx.serviceWorkers().length) await ctx.waitForEvent('serviceworker', { timeout: 30000 });
  return ctx;
}
async function sizeWindow(page, w, h) {
  const s = await page.context().newCDPSession(page);
  const { windowId } = await s.send('Browser.getWindowForTarget');
  for (let i = 0; i < 4; i++) {
    const [iw, ih, ow, oh] = await page.evaluate(() => [innerWidth, innerHeight, outerWidth, outerHeight]);
    if (iw === w && ih === h) break;
    await s.send('Browser.setWindowBounds', { windowId, bounds: { width: ow + w - iw, height: oh + h - ih } });
    await sleep(300);
  }
  await s.detach();
}

const t00 = Date.now();
const lap = name => { times[name] = +((Date.now() - (lap.t || t00)) / 1000).toFixed(1); lap.t = Date.now(); };
try {
  b = await session();
  await b.setWindowSize(1360, 900).catch(() => {});
  check('the app opens on the demo library', await waitFor('the library', () => exists('empty-new'), 30000));
  await shot('01-library-empty');
  lap('open');

  // ---- 1 · A new demo, pointed at the fixture app's two tabs ---------------------------------------------------
  await click('empty-new');
  await type('new-title', 'Fixture demo');
  await type('app-id-0', 'chat');
  await type('app-url-0', fx.chat);
  await click('add-app');
  await type('app-id-1', 'admin');
  await type('app-url-1', fx.admin);
  await shot('02-new-demo');
  await click('create-demo');
  check('creates the demo and opens its Record step', await waitFor('the demo', async () => (await exists('demo-title')) && (await text('demo-title')) === 'Fixture demo'));
  const DEMO = join(LIB, 'fixture-demo');
  check('a live-page project in the library', existsSync(join(DEMO, 'demo.json')) && JSON.parse(readFileSync(join(DEMO, 'manifest.json'), 'utf8')).graph.scenes.every(s => s.kind === 'live-page'));
  // Test speed only: the recording in the temp folder, the headless window's size, and shorter quiet waits and zooms.
  const cfg = JSON.parse(readFileSync(join(DEMO, 'demo.json'), 'utf8'));
  Object.assign(cfg, { raw: join(tmp, 'raw'), viewport: { width: 1600, height: 900, dpr: 1 }, zooms: [150] });
  Object.assign(cfg.record, { settleMs: 1200, typeIdleMs: 700, everyMs: 250, streamMinMs: 1200 });
  writeFileSync(join(DEMO, 'demo.json'), JSON.stringify(cfg, null, 2));
  lap('create');

  // ---- 2 · The recorder: set it up, load it unpacked, preflight with its fixes ---------------------------------
  await click('prepare-extension');
  const extDir = await waitFor('the extension folder', async () => (await exists('extension-dir')) && text('extension-dir'), 120000);
  check('builds the recorder extension and says where it is', resolve(extDir) === resolve(EXT) && existsSync(join(EXT, 'manifest.json')), extDir);
  await shot('03-record-setup');
  // Before the presenter loads it: Check (no fixes, so it starts nothing) says the recorder isn't there, with what to do.
  await click('preflight');
  await waitFor('preflight', () => exists('preflight-result'), 120000);
  check('preflight without the extension: the recorder fails, with how to load it', (await attr('pf-recorder', 'data-status')) === 'fail' && (await exists('fix-recorder')));
  ctx = await launchWithExtension(EXT, join(tmp, 'profile'));
  const chat = await ctx.newPage();
  await chat.goto(fx.chat);
  for (const p of ctx.pages()) if (p !== chat) await p.close();
  await sizeWindow(chat, 1600, 900);
  await chat.bringToFront();
  // Check and fix: starts the receiver, opens the missing admin tab; the browser that's running isn't touched.
  await click('preflight-fix');
  await waitFor('preflight ready', async () => (await attr('preflight-result', 'data-ready')) === 'true', 180000);
  // Preflight started the receiver (it stays up for the presenter); the test stops it at the end.
  receiverPid = +((/pid (\d+)/.exec(await text('pf-receiver')) || [])[1]) || null;
  check('preflight: ready, the admin tab opened', (await attr('pf-app-admin', 'data-status')) === 'fixed' && (await attr('pf-browser', 'data-status')) === 'ok');
  const admin = ctx.pages().find(p => p.url().startsWith(fx.admin));
  check('the admin tab is open in the presenter\'s browser', !!admin);
  await shot('04-preflight');
  lap('preflight');

  // ---- 3 · Record: the person runs the demo once --------------------------------------------------------------
  await chat.bringToFront(); await sleep(300);
  await click('record-start');
  await waitFor('recording', () => exists('recording'), 60000);
  const settled = async () => {
    await sleep(1500);
    let quiet = 0;
    await waitFor('the recorder to settle', async () => {
      const busy = await attr('recording', 'data-busy');
      quiet = busy === 'false' ? quiet + 1 : 0;
      return quiet >= 3;
    }, 300000, 700);
  };
  await settled();
  await chat.click('[aria-label="Message"]');
  await chat.keyboard.type('Summarize the supplier delay on PO-450101', { delay: 15 });
  await chat.keyboard.press('Enter');
  await settled();
  await admin.bringToFront(); await sleep(300);
  await admin.click('[aria-label="Search tools by name"]');
  await admin.keyboard.type('alpha', { delay: 30 });
  await settled();
  const screens = +(await attr('recording', 'data-count'));
  check('the app shows screens captured as they come', screens >= 3, screens);
  await shot('05-recording');
  await click('record-stop');
  await waitFor('the recording', () => exists('record-done'), 300000);
  check('stop: the recording, with the recorder\'s and the product\'s time', /screens?/.test(await text('record-done')) && /recorder/.test(await text('record-done')));
  await shot('06-recorded');
  lap('record');

  // ---- 4 · Build and check -------------------------------------------------------------------------------------
  await click('tab-build');
  await click('build');
  await waitFor('the build', async () => (await exists('build-done')) || (await exists('build-failed')), 600000);
  check('builds the replica', await exists('build-done'), (await exists('build-failed')) && await text('build-failed'));
  check('shows the scrub report', (await exists('scrub-clean')) || (await exists('scrub-summary')));
  await click('checks-quick');
  await waitFor('the checks', () => exists('checks-done'), 600000);
  const failing = await b.execute(() => [...document.querySelectorAll('[aria-label=Checks] [data-status=fail]')].map(li => li.innerText.replace(/\s+/g, ' ')).join('; '));
  check('runs the checks', (await attr('checks-done', 'data-pass')) === 'true', `${await text('checks-done')} ${failing}`);
  await shot('07-build');
  lap('build');

  // ---- 5 · Fidelity --------------------------------------------------------------------------------------------
  await click('tab-fidelity');
  await click('fidelity-fix');
  await waitFor('fidelity', async () => (await exists('fidelity-summary')) && !(await exists('fidelity-running')), 900000, 1000);
  const within = +(await attr('fidelity-summary', 'data-within')), compared = +(await attr('fidelity-summary', 'data-compared'));
  check('fidelity: every state compared, real vs replica', compared >= 3 && within >= 1, `${within}/${compared}`);
  const shots = await b.$$(T('shot'));
  // With "only the ones that differ" ticked there may be none; untick to see every state side by side.
  const only = await b.$('#only-diffs');
  if (await only.isSelected()) await only.click();
  await waitFor('the side-by-side pictures', async () => (await b.$$(T('shot'))).length >= compared, 20000);
  // Lazy pictures: the first one is in view; wait for it to arrive.
  const loaded = await waitFor('a picture to load', () => b.execute(() => [...document.querySelectorAll('[data-test=shot] img')].filter(i => i.complete && i.naturalWidth > 0).length), 20000).catch(() => 0);
  check('each state real and replica side by side', loaded >= 1, `${loaded} pictures loaded, ${shots.length} differing`);
  await shot('08-fidelity');
  lap('fidelity');

  // ---- 6 · Script ----------------------------------------------------------------------------------------------
  await click('tab-script');
  await type('script-text', readFileSync(join(ROOT, 'examples', 'fixture-app', 'script.md'), 'utf8'));
  await click('script-run');
  await waitFor('script to focus', async () => (await exists('script-summary')) && !(await exists('script-running')), 600000, 1000);
  const points = +(await attr('script-summary', 'data-points'));
  check('script to focus points: lines on their screens, focus points made', points >= 1 && existsSync(join(DEMO, 'focus.json')), points);
  check('the line-to-screen sheet shows', await waitFor('the sheet', () => b.execute(() => { const f = document.querySelector('[data-test=sheet-frame]'); return !!f && /^(scenecast:|http:\/\/scenecast\.localhost)/.test(f.src); }), 20000));
  await shot('09-script');
  await click('cues-tab');
  check('the cue sheet shows', await waitFor('the cue sheet', () => b.execute(() => /cues\.html$/.test(document.querySelector('[data-test=sheet-frame]')?.src || '')), 20000));
  lap('script');

  // ---- 7 · Edit: a dot and a date ------------------------------------------------------------------------------
  await click('tab-edit');
  await click('edit-start');
  const editUrl = await waitFor('the editor', () => attr('editing', 'data-url'), 120000);
  check('the editor is served in edit mode', /edit=1/.test(editUrl), editUrl);
  // The editor in a plain browser (the presenter's has the recorder attached to its tabs).
  viewer = await chromium.launch({ channel: 'chromium', headless: true });
  const page = await viewer.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  await page.goto(editUrl);
  await page.waitForFunction(() => window.d1 && window.d1.state.active && window.d1.editor, null, { timeout: 60000 });
  const d1 = (fn, arg) => page.evaluate(fn, arg);
  const idle = async () => { await d1(() => window.d1.editor.idle()); await d1(() => window.d1.idle()); };
  // The app serves it with ?edit=1: the editor turns itself on once its data is in. Pressing its key here as well
  // could land just after that, and turn it off again.
  await page.waitForFunction(() => window.d1.editor.on && !!document.querySelector('[data-scenecast-editor="overlay"]'), null, { timeout: 60000 });
  await idle();
  const word = (app, w) => d1(([app, w]) => {
    const d = window.d1.doc(app), it = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT);
    for (let n; (n = it.nextNode());) { const i = n.data.indexOf(w); if (i < 0) continue; const r = d.createRange(); r.setStart(n, i); r.setEnd(n, i + w.length); const bx = r.getBoundingClientRect(), f = d.defaultView.frameElement.getBoundingClientRect(); if (bx.width) return { x0: f.x + bx.left, x1: f.x + bx.right, y: f.y + bx.top + bx.height / 2 }; }
    return null;
  }, [app, w]);
  // The screen with the first answer: the beat keys, until "Friday" is on screen.
  let fri = null;
  for (let n = 1; n <= 9 && !fri; n++) {
    await page.keyboard.press(`Control+Alt+Digit${n}`); await sleep(300); await idle();
    if ((await d1(() => window.d1.state.active)) === 'chat') fri = await word('chat', 'Friday');
  }
  check('the editor reaches the answer with its beat keys', !!fri);
  const more = await d1(() => window.d1.locate({ sel: 'button[aria-label="More options"]' }, 'chat'));
  await page.mouse.click(more.x, more.y); await idle();
  // On a miss: what the editor did with the click (its status, its dots) and what the app listed.
  const why = async () => {
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'zz-editor.png') }).catch(() => {});
    const s = await d1(() => { const x = window.d1.editor.state(); return { status: x.status, sel: x.sel, dots: x.points.filter(p => p.source === 'dot').map(p => p.id), history: x.history }; }).catch(e => e.message);
    let disk; try { disk = JSON.parse(readFileSync(join(DEMO, 'focus.json'), 'utf8')).points.filter(p => p.source === 'dot').map(p => p.id); } catch (e) { disk = e.message; }
    return JSON.stringify({ more, editor: s, onDisk: disk, appSaved: await text('saved-count').catch(e => e.message) });
  };
  await waitFor('the dot saved', async () => +(await text('saved-count')) >= 1, 30000).catch(async e => { throw new Error(`${e.message}: ${await why()}`); });
  fri = await word('chat', 'Friday');
  await page.mouse.move(fri.x0 + 2, fri.y); await page.mouse.down();
  await page.mouse.move((fri.x0 + fri.x1) / 2, fri.y, { steps: 4 }); await page.mouse.move(fri.x1 - 2, fri.y, { steps: 4 }); await page.mouse.up();
  await page.waitForSelector('input[data-replace]', { timeout: 15000 });
  await page.keyboard.type('Monday', { delay: 20 }); await page.keyboard.press('Enter'); await idle();
  await waitFor('the date saved', async () => +(await text('saved-count')) >= 2, 30000).catch(async e => { throw new Error(`${e.message}: ${await why()}`); });
  const fj = JSON.parse(readFileSync(join(DEMO, 'focus.json'), 'utf8')), ej = JSON.parse(readFileSync(join(DEMO, 'flow.editor.json'), 'utf8'));
  check('edit: the app lists the dot and the date as they are saved', fj.points.some(p => p.source === 'dot') && JSON.stringify(ej.edits).includes('Monday'), JSON.stringify(ej));
  await page.close();
  await shot('10-edit');
  await click('edit-stop');
  lap('edit');

  // ---- 8 · Present ---------------------------------------------------------------------------------------------
  await click('tab-present');
  await waitFor('the key reference', () => exists('key-reference'), 30000);
  check('the key reference before presenting', /presenter keys/.test(await text('key-reference')));
  await shot('11-present');
  await click('present-start');
  const presentUrl = await waitFor('presenting', () => attr('presenting', 'data-url'), 120000);
  const replica = await viewer.newPage({ viewport: { width: 1600, height: 900 } });
  await replica.goto(presentUrl);
  await replica.waitForFunction(() => window.d1 && window.d1.state.active, null, { timeout: 60000 });
  check('presents the replica, with no editor in the page', !(await replica.evaluate(() => !!window.d1.editor || !!document.querySelector('[data-scenecast-editor]'))));
  check('the key reference is off screen while presenting', !(await exists('key-reference')));
  await replica.close();
  await click('present-stop');
  await waitFor('stopped', () => exists('present-start'), 30000);
  lap('present');

  // ---- 9 · Export ----------------------------------------------------------------------------------------------
  await click('tab-export');
  await click('export-folder');
  const folder = await waitFor('the folder export', () => attr('export-done', 'data-path'), 300000);
  check('exports a plain folder', existsSync(join(folder, 'index.html')) && existsSync(join(folder, 'manifest.json')), folder);
  await shot('12-export');
  await click('export-zip');
  const zip = await waitFor('the zip export', async () => (await attr('export-done', 'data-kind')) === 'zip' && attr('export-done', 'data-path'), 300000);
  check('exports a zip', /\.zip$/.test(zip) && statSync(zip).size > 1000, zip);
  lap('export');

  // ---- The library shows where it stands ----------------------------------------------------------------------
  await click('nav-library');
  await waitFor('the library row', () => exists('row-fixture-demo'), 20000);
  const row = await text('row-fixture-demo');
  check('the library: recorded, built, fidelity score, focus points, last checked', /screens/.test(row) && /pages/.test(row) && /%/.test(row) && !/Never/.test(row), row);
  await shot('13-library');
  // Duplicate and delete, from the library. The library is drawn again once its list is in: a button found before
  // that is gone from the page, and a click on it does nothing. So: wait for it, and find the button afresh.
  await click('nav-library');
  await waitFor('the library', () => b.execute(() => !document.querySelector('#main[aria-busy]') && !!document.querySelector('[data-test="row-fixture-demo"]')), 30000);
  const open = () => b.execute(() => !!document.querySelector('#dialog[open]'));
  const ask = async sel => waitFor(`the dialog from ${sel}`, async () => {
    if (!(await open())) { const e = await b.$(sel); if (await e.isClickable()) await e.click(); await sleep(300); }
    return open();
  }, 30000);
  await ask('[data-duplicate="fixture-demo"]');
  await click('dialog-ok');
  await waitFor('the copy', () => exists('row-fixture-demo-copy'), 60000);
  check('duplicates a demo', existsSync(join(LIB, 'fixture-demo-copy', 'demo.json')));
  await ask('[data-delete="fixture-demo-copy"]');
  await click('dialog-ok');
  await waitFor('the copy gone', async () => !(await exists('row-fixture-demo-copy')), 60000);
  check('deletes a demo', !existsSync(join(LIB, 'fixture-demo-copy')));
  lap('library');
} catch (e) {
  check('the UI test ran to the end', false, e.stack || e);
  if (b && SHOTS) await b.saveScreenshot(join(SHOTS, 'zz-failure.png')).catch(() => {});
  console.log('--- app output ---\n' + appLog.join('').slice(-6000));
} finally {
  await ctx?.close().catch(() => {});
  await viewer?.close().catch(() => {});
  await b?.deleteSession().catch(() => {});
  app.kill();
  if (receiverPid) try { process.kill(receiverPid); } catch { /* gone */ }
  fx.close();
  await sleep(500);
  if (process.env.SCENECAST_UI_KEEP) console.log(`kept ${tmp}`);
  else try { rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }); } catch (e) { console.log(`left ${tmp}: ${e.message}`); }
}
console.log(`TIMES ${JSON.stringify(times)}`);
console.log(fails.length ? `${fails.length} FAILED` : 'all passed');
process.exit(fails.length ? 1 : 0);
