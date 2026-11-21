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
// The update feed, played by the test: a version newer than the app, then the app's own.
const FEED = { version: '9.9.9' };
const feed = (await import('node:http')).createServer((req, res) => {
  const entry = { signature: 'dGVzdA==', url: 'http://127.0.0.1:1/none.tar.gz' };
  const platforms = Object.fromEntries(['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64', 'windows-x86_64-nsis', 'windows-x86_64-msi', 'linux-x86_64'].map(k => [k, entry]));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ version: FEED.version, notes: 'test', pub_date: '2026-11-20T00:00:00Z', platforms }));
}).listen(0, '127.0.0.1');
await new Promise(r => feed.once('listening', r));
const FEED_URL = `http://127.0.0.1:${feed.address().port}/latest.json`;

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
    SCENECAST_UPDATE_URL: FEED_URL,
    // The AI modes on the deterministic stand-in model: no network, no GitHub account.
    SCENECAST_AI_MODEL: 'stub',
    SCENECAST_AI_HOME: join(tmp, 'ai-home'),
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
// The app's own state: whether a demo's job (the quick checks it starts after a build, a script or an edit) runs.
const checksAfter = (since, id = 'fixture-demo') => b.execute((since, id) => { const j = window.__scenecast?.jobs?.[id]?.checks; return j && j.startedAt > since && !window.__scenecast.jobs[id].running.checks ? (j.outcome || { error: j.error }) : null; }, since, id);
// The checks the app starts on its own after a step that began at `since`: wait for them to start and end.
const quickAfter = (what, since, timeout = 600000) => waitFor(`the checks after ${what}`, () => checksAfter(since), timeout, 500);
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
  // A newer version: it shows by itself (checked at start), with nothing clicked.
  const avail = await waitFor('the update indicator', async () => (await exists('update-now')) && b.execute(() => document.querySelector('#check-updates').dataset.available), 60000).catch(() => null);
  check('a newer version shows by itself: "Update to v9.9.9" and a dot', avail === '9.9.9' && /Update to v9\.9\.9/.test(await text('update-now')) && await b.execute(() => document.querySelector('#check-updates').classList.contains('has-update')), String(avail));
  await shot('01b-update-available');
  // The same version as the app: no indicator.
  FEED.version = (await b.execute(() => window.__scenecast.info.version));
  await click('check-updates');
  await click('dialog-ok');
  check('the same version: no indicator', !(await exists('update-now')) && await b.execute(() => document.querySelector('#update').hidden && !document.querySelector('#check-updates').classList.contains('has-update')));
  FEED.version = '0.0.1';
  await click('check-updates');
  await click('dialog-ok');
  check('an older one: no indicator', !(await exists('update-now')));
  lap('open');

  // ---- 1 · A new demo, pointed at the fixture app's two tabs ---------------------------------------------------
  await click('empty-new');
  // One short form: name, apps, an optional talk track, the slot. How it's recorded is chosen on Record; the browser
  // and profile are the ones the recorder is in (no question).
  check('New demo: no question about how to record, or which profile', await waitFor('the form', () => exists('new-title'), 20000) && !(await exists('mode-record')) && !(await exists('new-profiles')));
  await shot('02a-new-demo-choice');
  await type('new-title', 'Fixture demo');
  await type('app-id-0', 'chat');
  await type('app-url-0', fx.chat);
  await click('add-app');
  await type('app-id-1', 'admin');
  await type('app-url-1', fx.admin);
  // The slot (8 min): picked as a change does (WebDriver's option click doesn't select in every webview).
  await b.execute(() => { const s = document.querySelector('[data-test="new-slot"]'); s.scrollIntoView({ block: 'center' }); s.value = '480'; s.dispatchEvent(new Event('change', { bubbles: true })); });
  await shot('02-new-demo');
  await click('create-demo');
  check('creates the demo and opens its Record step', await waitFor('the demo', async () => (await exists('demo-title')) && (await text('demo-title')) === 'Fixture demo'));
  const DEMO = join(LIB, 'fixture-demo');
  check('the slot is kept with the demo', JSON.parse(readFileSync(join(DEMO, 'demo.json'), 'utf8')).presenter?.slot === 480);
  // The default view in plain words; the technical view (folder, files, the matching command) one button away.
  const plain = await b.execute(() => document.querySelector('#main').innerText);
  check('Record: no ports, receivers, paths or profile folders on screen', !/\b(port \d+|receiver|preflight|unpacked|localhost)\b|\/Users\/|\b[A-Z]:\\/i.test(plain), plain.slice(0, 600));
  await click('details');
  check('Details: the folder, the matching command, diagnostics', /scenecast record start --demo/.test(await text('details-drawer')) && await exists('copy-diagnostics'), await text('details-drawer'));
  await click('details');
  check('a live-page project in the library', existsSync(join(DEMO, 'demo.json')) && JSON.parse(readFileSync(join(DEMO, 'manifest.json'), 'utf8')).graph.scenes.every(s => s.kind === 'live-page'));
  // Test speed only: the recording in the temp folder, the headless window's size, and shorter quiet waits and zooms.
  const cfg = JSON.parse(readFileSync(join(DEMO, 'demo.json'), 'utf8'));
  Object.assign(cfg, { raw: join(tmp, 'raw'), viewport: { width: 1600, height: 900, dpr: 1 }, zooms: [150] });
  Object.assign(cfg.record, { settleMs: 1200, typeIdleMs: 700, everyMs: 250, streamMinMs: 1200 });
  writeFileSync(join(DEMO, 'demo.json'), JSON.stringify(cfg, null, 2));
  lap('create');

  // ---- 2 · The recorder: the app's receiver, Install recorder, the extension connecting, preflight ---------------
  // Opening the demo started the receiver (on REPLICA_RX_PORT here): nothing to run, nothing to fix.
  const rx = await waitFor('the receiver', async () => (await exists('receiver-state')) && (await attr('receiver-state', 'data-port')), 60000);
  const ping = await fetch(`http://127.0.0.1:${RX_PORT}/ping`).then(r => r.json()).catch(() => null);
  check('opening the demo starts the receiver, the app\'s own', +rx === RX_PORT && ping?.owner === 'app' && resolve(ping.demo) === resolve(DEMO), JSON.stringify(ping));
  receiverPid = ping?.pid || null;
  // An app's address, changed on Record's pre-show (and kept in demo.json, with how its tab is found).
  await click('edit-app-admin');
  const addr = await el('app-addr-admin');
  await addr.waitForDisplayed({ timeout: 15000 });
  await addr.clearValue(); await addr.setValue(`${fx.admin}?from=ui-test`);
  await click('app-save-admin');
  const edited = await waitFor('the new address', () => { const a = JSON.parse(readFileSync(join(DEMO, 'demo.json'), 'utf8')).apps.find(x => x.id === 'admin'); return a.url.endsWith('?from=ui-test') && a; }, 20000).catch(() => null);
  check('an app\'s address changes after the demo is made', !!edited && edited.match === new URL(fx.admin).host, JSON.stringify(edited));
  await click('install-recorder');
  const extDir = await waitFor('the extension folder', async () => (await exists('extension-dir')) && attr('extension-dir', 'data-dir'), 120000);
  check('Install recorder: the folder, ready to drag in, with the steps', resolve(extDir) === resolve(EXT) && existsSync(join(EXT, 'manifest.json')) && (await exists('install-status')) && (await attr('install-status', 'data-connected')) === 'false', extDir);
  await shot('03-record-setup');
  // Before the presenter loads it: Check (no fixes; under Details now) says the recorder isn't there.
  if ((await attr('details', 'aria-expanded')) !== 'true') await click('details');
  await click('preflight');
  // Pressed again at once (and then Check and fix): the newer check takes over; never "busy (preflight)".
  await sleep(300);
  await click('preflight');
  await waitFor('preflight', () => exists('preflight-result'), 120000);
  check('overlapping checks: the newest one finishes, no busy error', !(await b.execute(() => [...document.querySelectorAll('.toast')].some(t => /busy/.test(t.textContent)))) && (await attr('pf-receiver', 'data-status')) === 'ok');
  check('preflight without the extension: the recorder fails, with Add the recorder', (await attr('pf-recorder', 'data-status')) === 'fail' && (await exists('install-recorder')));
  ctx = await launchWithExtension(EXT, join(tmp, 'profile'));
  // The extension finds the receiver on its own (no port to set), and the app turns green.
  const t0c = Date.now();
  await waitFor('the recorder to connect', async () => (await attr('recorder-state', 'data-connected')) === 'true', 60000);
  check('the extension connects by itself and the app shows it', (await attr('install-status', 'data-connected')) === 'true', `${Date.now() - t0c} ms`);
  times.connectMs = Date.now() - t0c;
  const chat = await ctx.newPage();
  await chat.goto(fx.chat);
  for (const p of ctx.pages()) if (p !== chat) await p.close();
  await sizeWindow(chat, 1600, 900);
  await chat.bringToFront();
  // No Check and fix: Start runs the same check with its fixes, opens the missing admin tab (the browser that's
  // running isn't touched), and starts, in one press.
  if ((await attr('details', 'aria-expanded')) === 'true') await click('details');
  await shot('04-preflight');
  lap('preflight');

  // ---- 3 · Record: the person runs the demo once --------------------------------------------------------------
  await chat.bringToFront(); await sleep(300);
  await click('record-start');
  await waitFor('recording', () => exists('recording'), 180000);
  check('Start checked and fixed first: ready, the admin tab opened', (await attr('pf-app-admin', 'data-status')) === 'fixed' && (await attr('pf-browser', 'data-status')) === 'ok', await b.execute(() => [...document.querySelectorAll('[data-test^=pf-]')].map(e => `${e.dataset.test}=${e.dataset.status}`).join(' ')));
  const admin = ctx.pages().find(p => p.url().startsWith(fx.admin));
  check('the admin tab is open in the presenter\'s browser', !!admin);
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
  // The capture window, on top of the browser while recording: what it says, read through the window list (null
  // when this WebDriver can't switch windows).
  const capture = async () => {
    try {
      const main = await b.getWindowHandle(), other = (await b.getWindowHandles()).find(h => h !== main);
      if (!other) return { open: false };
      await b.switchToWindow(other);
      try { return { open: true, ...(await b.execute(() => ({ state: document.querySelector('[data-test="capture-state"]')?.dataset.state, count: +document.querySelector('[data-test="capture-count"]')?.dataset.count }))) }; }
      finally { await b.switchToWindow(main); }
    } catch (e) { return null; }
  };
  const before = await capture();
  if (before) check('the capture window is open while recording, and says Ready', before.open && before.state === 'ready', JSON.stringify(before));
  else console.log('NOTE: this WebDriver can\'t switch windows; the capture window isn\'t checked here (the preview shows each of its states)');
  await chat.click('[aria-label="Message"]');
  await chat.keyboard.type('Summarize the supplier delay on PO-450101', { delay: 15 });
  await chat.keyboard.press('Enter');
  if (before) {
    let seen = null;
    for (let i = 0; i < 20 && !seen; i++) { const c = await capture(); if (c?.state === 'busy') seen = c; else await sleep(500); }
    check('a click during capture: the capture window says Hold on', !!seen, 'never busy');
  }
  await settled();
  // Pause: nothing recorded until Go on; every screen so far kept.
  const kept = +(await attr('recording', 'data-count'));
  await click('record-pause');
  check('Pause: the recording says Paused, its screens kept', await waitFor('paused', async () => (await attr('recording', 'data-held')) === 'you', 15000).catch(() => false) && +(await attr('recording', 'data-count')) === kept);
  await click('record-go-on');
  check('Go on: recording again from where it paused', await waitFor('going on', async () => (await exists('recording')) && (await attr('recording', 'data-held')) === null && (await attr('recording', 'data-busy')) !== null, 30000).catch(() => false));
  await admin.bringToFront(); await sleep(300);
  await admin.click('[aria-label="Search tools by name"]');
  await admin.keyboard.type('alpha', { delay: 30 });
  await settled();
  const screens = +(await attr('recording', 'data-count'));
  check('the app shows screens captured as they come', screens >= 3, screens);
  await shot('05-recording');
  await click('record-stop');
  // Stop: on to Review, which makes the replica without a button (build, checks, every screen compared).
  await waitFor('the recording', () => exists('record-done'), 300000);
  const done = await b.execute(() => document.querySelector('[data-test="record-done"]').innerText);
  check('stop: the recording, in plain words (what was made)', /Recorded \d+ screens?/.test(done) && !/streamed|recorder took/.test(done), done);
  await shot('06-making');
  lap('record');

  // ---- 4 · Review: made and checked on its own ------------------------------------------------------------------
  await waitFor('Review, made on its own', async () => (await attr('review', 'data-compared')) === 'true' || (await exists('making-failed')), 1500000, 1000);
  check('after Stop, Review appears on its own: built, checked and compared with the real product, no button pressed',
    (await attr('review', 'data-compared')) === 'true' && +(await attr('review', 'data-screens')) >= 3 && await exists('screen'),
    (await exists('making-failed')) ? await text('making-failed') : JSON.stringify({ screens: await attr('review', 'data-screens'), differ: await attr('review', 'data-differ') }));
  const differ = +(await attr('review', 'data-differ'));
  check('Review: the one next step (Fix it for me, or Next: rehearse)', differ ? await exists('review-fix') : await exists('review-next'), differ);
  await shot('06b-review');
  // Its build and checks, in full, a tab away.
  await click('tab-build');
  await waitFor('the build', async () => (await exists('build-done')) || (await exists('build-failed')), 60000);
  check('builds the replica', await exists('build-done'), (await exists('build-failed')) && await text('build-failed'));
  check('shows the scrub report', (await exists('scrub-clean')) || (await exists('scrub-summary')));
  // The checks for what changed ran on their own after the build; never the whole checklist (that's Export).
  await waitFor('the checks', () => exists('checks-done'), 600000);
  const failing = await b.execute(() => [...document.querySelectorAll('[aria-label=Checks] [data-status=fail]')].map(li => li.innerText.replace(/\s+/g, ' ')).join('; '));
  check('the build runs the quick checks on its own, and they pass', (await attr('checks-done', 'data-pass')) === 'true' && (await attr('checks-done', 'data-quick')) === 'true', `${await text('checks-done')} ${failing}`);
  check('no "run every check" outside Export', !(await exists('checks-full')));
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
  const tScript = await b.execute(() => Date.now());
  await click('script-run');
  await waitFor('script to focus', async () => (await exists('script-summary')) && !(await exists('script-running')), 600000, 1000);
  const points = +(await attr('script-summary', 'data-points'));
  check('script to focus points: lines on their screens, focus points made', points >= 1 && existsSync(join(DEMO, 'focus.json')), points);
  check('the line-to-screen sheet shows', await waitFor('the sheet', () => b.execute(() => { const f = document.querySelector('[data-test=sheet-frame]'); return !!f && /^(scenecast:|http:\/\/scenecast\.localhost)/.test(f.src); }), 20000));
  const guideShots = existsSync(join(DEMO, 'presenter', 'notes.json')) ? JSON.parse(readFileSync(join(DEMO, 'presenter', 'notes.json'), 'utf8')).shots : [];
  check('the presenter guide is made from the same script, with its pictures', +(await attr('script-guide', 'data-beats')) === 4 && guideShots.length > 0 && guideShots.every(x => existsSync(join(DEMO, 'presenter', 'shots', x.name + '.png'))), JSON.stringify([await attr('script-guide', 'data-beats'), guideShots.map(x => x.name)]));
  await shot('09-script');
  await click('cues-tab');
  check('the cue sheet shows', await waitFor('the cue sheet', () => b.execute(() => /cues\.html$/.test(document.querySelector('[data-test=sheet-frame]')?.src || '')), 20000));
  const afterScript = await quickAfter('the script', tScript);
  check('the script runs the quick checks on its own', afterScript.quick && afterScript.pass, JSON.stringify(afterScript.items?.filter(i => i.status === 'fail')));
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
  const tEdit = await b.execute(() => Date.now());
  await click('edit-stop');
  // Stopping the editor checks what the edits touched (the dot's screen, the date's), quickly; the focus points the
  // script made still find their words after "Friday" became "Monday".
  const tq = Date.now();
  const afterEdit = await quickAfter('the edits', tEdit);
  times.quickAfterEdit = Math.round((Date.now() - tq) / 1000);
  check('edits: the quick checks run on their own, pass, and take under 3 minutes', afterEdit.quick && afterEdit.pass && times.quickAfterEdit < 180, JSON.stringify([times.quickAfterEdit, afterEdit.items?.filter(i => i.status === 'fail')]));
  lap('edit');

  // ---- 8 · Present ---------------------------------------------------------------------------------------------
  await click('tab-present');
  await waitFor('the key reference', () => exists('key-reference'), 30000);
  check('the key reference before presenting', /presenter keys/.test(await text('key-reference')) && /presenter guide/.test(await text('key-reference')));
  check('the presenter guide, ready, with its keys', +(await attr('guide-status', 'data-beats')) === 4 && (await b.$('#with-guide').isSelected()), await text('guide-card'));
  await shot('11-present');
  await click('present-start');
  const presentUrl = await waitFor('presenting', () => attr('presenting', 'data-url'), 120000);
  const guideUrl = await waitFor('the presenter guide', () => attr('guide-open', 'data-url'), 30000);
  check('Start presenting opens the presenter guide on this screen too', /\/presenter\.html(#place=-?\d+,-?\d+,\d+,\d+)?$/.test(guideUrl) && guideUrl.startsWith(new URL(presentUrl).origin), guideUrl);
  await shot('11b-presenting');
  // The stage and the guide in one browser (they talk over a BroadcastChannel, as in her Edge or Chrome).
  const stageBrowser = await viewer.newContext({ viewport: { width: 1600, height: 900 } });
  const replica = await stageBrowser.newPage();
  await replica.goto(presentUrl);
  await replica.waitForFunction(() => window.d1 && window.d1.state.active, null, { timeout: 60000 });
  check('presents the replica, with no editor in the page', !(await replica.evaluate(() => !!window.d1.editor || !!document.querySelector('[data-scenecast-editor]'))));
  check('the key reference is off screen while presenting', !(await exists('key-reference')));
  // The guide, next to the stage in the same browser: in sync, it follows a beat key, and moves the stage.
  const guide = await stageBrowser.newPage();
  await guide.setViewportSize({ width: 1440, height: 900 });
  await guide.goto(guideUrl);
  const synced = n => guide.waitForFunction(n => window.presenter && window.presenter.connected && window.presenter.live === n, n, { timeout: 15000 }).then(() => true, () => false);
  const inSync = await synced(0);
  await replica.bringToFront(); await replica.keyboard.press('Control+Alt+Digit2'); await replica.evaluate(() => window.d1.idle());
  const follows = await synced(2);
  await guide.bringToFront(); await guide.click('[data-goto="3"]'); await guide.click('[data-pn="go-stage"]');
  const moved = await replica.waitForFunction(() => window.d1.presenter.beat === 3 && !window.d1.presenter.pending, null, { timeout: 15000 }).then(() => true, () => false);
  check('the presenter guide: in sync with the stage, follows it, and "Go to this beat on stage" moves it', inSync && follows && moved, JSON.stringify({ inSync, follows, moved }));
  await guide.click('[data-goto="2"]'); await sleep(300);
  if (SHOTS) await guide.screenshot({ path: join(SHOTS, '11c-presenter-guide.png') });
  await stageBrowser.close();
  await click('present-stop');
  await waitFor('stopped', () => exists('present-start'), 30000);
  // Rehearse: the stage keeps each beat's time, and the run of show shows them next to the plan.
  await click('rehearse');
  const rehUrl = await waitFor('rehearsing', () => attr('presenting', 'data-url'), 120000);
  check('Rehearse serves the stage for a rehearsal', /rehearse=1/.test(rehUrl), rehUrl);
  {
    const ctx2 = await viewer.newContext({ viewport: { width: 1600, height: 900 } });
    const st = await ctx2.newPage();
    await st.goto(rehUrl);
    await st.waitForFunction(() => window.d1 && window.d1.state.active, null, { timeout: 60000 });
    for (const k of [1, 2]) { await st.keyboard.press(`Control+Alt+Digit${k}`); await st.evaluate(() => window.d1.idle()); await sleep(1500); }
    await ctx2.close();
  }
  await click('present-stop');
  await waitFor('the rehearsal in the run of show', async () => (await attr('ready-rehearsed', 'data-status')) === 'ok', 30000).catch(() => null);
  check('the run of show: rehearsed, with each beat\'s time', (await attr('ready-rehearsed', 'data-status')) === 'ok' && /took \d+:\d\d/.test(await text('beat-1')), await text('beat-1').catch(e => e.message));
  await shot('11d-rehearsed');
  lap('present');

  // ---- 9 · Export (Share) --------------------------------------------------------------------------------------
  await click('tab-share');
  await click('share-kind-folder');
  await click('export-go');
  const folder = await waitFor('the folder export', async () => (await attr('export-done', 'data-path')) || ((await exists('export-checks-failed')) && 'failed'), 900000, 1000);
  if (folder === 'failed') check('every check passes before the export', false, await text('export-checks-failed'));
  check('Share runs every check first, then makes a plain folder', (await attr('export-done', 'data-checked')) === 'ran' && existsSync(join(folder, 'index.html')) && existsSync(join(folder, 'manifest.json')), folder);
  check('the whole checklist ran (not quick)', JSON.parse(readFileSync(join(DEMO, '.out', 'fidelity.json'), 'utf8')).quick === false);
  await shot('12-export');
  // One Scenecast file: made without the checks again (nothing changed), and it opens ready to rehearse.
  await click('share-kind-file');
  await click('export-go');
  const file = await waitFor('the Scenecast file', async () => (await attr('export-done', 'data-kind')) === 'share' && attr('export-done', 'data-path'), 300000);
  check('makes one .scenecast file, without running every check again', /\.scenecast$/.test(file) && statSync(file).size > 1000 && (await attr('export-done', 'data-checked')) === 'current', file);
  await b.execute(p => window.__scenecast.openFile(p), file);
  const OPENED = join(LIB, 'fixture-demo-2');
  await waitFor('the shared demo, open on Present', async () => (await b.execute(() => window.__scenecast.id)) === 'fixture-demo-2' && (await attr('guide-status', 'data-beats')) === '4', 60000).catch(() => null);
  check('the file opens into the library on Present, with its guide, and without the presenter\'s own things',
    (await b.execute(() => window.__scenecast.id)) === 'fixture-demo-2' && (await attr('guide-status', 'data-beats')) === '4'
    && existsSync(join(OPENED, 'presenter', 'notes.json')) && !existsSync(join(OPENED, 'ai.json')) && !existsSync(join(OPENED, '.out', 'fidelity', 'contact.html')),
    JSON.stringify({ id: await b.execute(() => window.__scenecast.id), beats: await attr('guide-status', 'data-beats') }));
  await shot('12b-opened');
  await click('present-start');
  const openedUrl = await waitFor('presenting the shared demo', () => attr('presenting', 'data-url'), 120000).catch(() => null);
  check('the shared demo presents, with its guide', !!openedUrl && !!(await attr('guide-open', 'data-url')), openedUrl);
  await click('present-stop');
  await waitFor('stopped', () => exists('present-start'), 30000);
  lap('export');

  // ---- Record for me: a goal, the plan, the browser driven while it records, the presenter saying yes ------------
  await click('nav-copilot');
  check('Copilot: the account and what it sees', await waitFor('the Copilot page', () => exists('ai-signed-in'), 60000) && (await exists('ai-page-text')));
  await shot('14-copilot');
  await click('new-demo');
  await type('new-title', 'For me');
  // The browser's open tabs, to pick the apps from (the recorder is connected now). The fixture's aren't product
  // pages, so none is ticked; its two apps are typed in, to give them their names.
  const tabs = await waitFor('the open tabs', async () => (await exists('tab-row')) && b.execute(() => [...document.querySelectorAll('[data-test="tab-row"]')].map(r => r.dataset.url)), 45000).catch(() => null);
  check('New demo lists the browser\'s open tabs to pick from, none ticked that isn\'t a product page', Array.isArray(tabs) && tabs.some(u => u.startsWith(fx.chat)) && !(await b.execute(() => document.querySelector('[data-tab-url]:checked'))), JSON.stringify(tabs));
  await shot('13b-new-from-tabs');
  if (await b.execute(() => !document.querySelector('[data-test="show-manual"]').hidden)) await click('show-manual');
  await type('app-id-0', 'chat');
  await type('app-url-0', fx.chat);
  await click('add-app');
  await type('app-id-1', 'admin');
  await type('app-url-1', fx.admin);
  await click('create-demo');
  await waitFor('the demo', async () => (await exists('demo-title')) && (await text('demo-title')) === 'For me');
  const FM = join(LIB, 'for-me');
  {
    const c = JSON.parse(readFileSync(join(FM, 'demo.json'), 'utf8'));
    Object.assign(c, { raw: join(tmp, 'raw-for-me'), viewport: { width: 1600, height: 900, dpr: 1 }, zooms: [150] });
    Object.assign(c.record, { settleMs: 1200, typeIdleMs: 700, everyMs: 250, streamMinMs: 1200, auto: false });
    writeFileSync(join(FM, 'demo.json'), JSON.stringify(c, null, 2));
  }
  // A demo made by hand, recorded by Copilot: both ways from the same Record screen, switched there.
  await waitFor('Record by hand', () => exists('record-start'), 60000);
  await click('mode-record');
  await waitFor('Copilot on Record', () => exists('ai-goal'), 30000);
  await click('mode-manual');
  check('Record switches between Copilot and by hand on the same screen', await waitFor('back to by hand', () => exists('record-start'), 30000) && !(await exists('ai-goal')));
  await click('mode-record');
  await type('ai-goal', 'Ask "Summarize the supplier delay on PO-450101", then open Plugins. In admin, search "alpha" and open alpha-6. Then go to chat, start a new chat and ask "What will it cost us?" with the send button.');
  await shot('15-new-record-for-me');
  await chat.goto(fx.chat); await admin.goto(fx.admin); await chat.bringToFront();
  await waitFor('the recorder to connect', async () => (await attr('recorder-state', 'data-connected')) === 'true', 60000);
  // Draft the plan checks the tabs first (it reads each start screen), the same check as Start's.
  await click('ai-plan');
  // Done, or an error (then what it said, in the failure).
  await waitFor('the plan', async () => (await exists('ai-plan-done')) || b.execute(() => !!document.querySelector('[data-region="ai-plan-progress"] [data-test="error"]')), 180000);
  check('Copilot drafts the plan', await exists('ai-plan-done'), await b.execute(() => { const e = document.querySelector('[data-region="ai-plan-progress"] [data-test="error"]'); return e ? `${e.dataset.error}: ${e.querySelector('.log')?.textContent || e.innerText}` : 'no error shown'; }));
  check('Record for me: the goal kept with the demo', /supplier delay/.test(readFileSync(join(FM, 'ai.json'), 'utf8')) && /"mode": ?"record"/.test(readFileSync(join(FM, 'ai.json'), 'utf8')));
  const planText = await b.execute(() => document.querySelector('[data-test="ai-plan-text"]').value);
  check('the plan fills the run of show, with the steps that ask first', await exists('plan-beat-1') && /asks you first/.test(await b.execute(() => document.querySelector('[data-test="run-of-show"]').innerText)));
  check('Record for me: a plan in plain words, sends asking first', /Click "Plugins"/.test(planText) && /Press Enter — ask first/.test(planText) && /Click "Send" — ask first/.test(planText), planText);
  await shot('16-plan');
  await chat.bringToFront();
  // As on a Mac with the browser in front: the covered app window gets no animation frames (found on Jessica's Mac,
  // where the app sat on "Starting…" and the "May I?" never showed). Progress and questions must show anyway.
  await b.execute(() => { window.__raf = window.requestAnimationFrame; window.requestAnimationFrame = () => 0; });
  await click('ai-record');
  // Each send waits for the presenter: Enter gets "Do it", Send "I'll click it myself" (and the person clicks it).
  const answerNext = async (how, before) => {
    const q = await waitFor('Copilot to ask', async () => { const id = await attr('ai-confirm', 'data-qid'); return id && id !== before && id; }, 300000);
    // The buttons stay put while the progress line above them updates (they were rebuilt every second).
    await b.execute(() => { window.__doIt = document.querySelector('[data-test="ai-confirm-do"]'); });
    await sleep(1200);
    check('Record for me: "May I?" buttons aren\'t rebuilt while it waits', await b.execute(() => document.querySelector('[data-test="ai-confirm-do"]') === window.__doIt));
    if (how === 'do') await shot('17-may-i');
    await click(how === 'do' ? 'ai-confirm-do' : 'ai-confirm-self');
    return q;
  };
  const q1 = await answerNext('do');
  await answerNext('self', q1);
  await sleep(1500);
  await chat.click('[aria-label="Send"]');
  await waitFor('Record for me to finish', () => exists('ai-record-done'), 600000);
  await b.execute(() => { if (window.__raf) window.requestAnimationFrame = window.__raf; });
  check('Record for me: recorded, two sends after the presenter\'s go-ahead', (await attr('ai-record-done', 'data-confirmed')) === '1' && +(await attr('ai-record-done', 'data-steps')) >= 10, await text('ai-record-done'));
  await waitFor('the demo to be ready', async () => (await exists('ai-after-done')) || (await b.execute(() => /notice bad/.test(document.querySelector('[data-region="ai-after"]')?.innerHTML || ''))), 900000);
  check('Record for me: built, the talk track on its screens, the guide, the checks pass, compared', await exists('ai-after-done') && (await attr('ai-after-done', 'data-checks')) === 'true' && (await attr('ai-after-done', 'data-compared')) === 'true', await b.execute(() => document.querySelector('[data-region="ai-after"]')?.innerText));
  check('Record for me: what was sent to Copilot, listed', await exists('ai-sent-list'));
  await shot('18-record-for-me-done');
  check('Record for me: script.md and focus points', /Kestrel moved the ship date/.test(readFileSync(join(FM, 'script.md'), 'utf8')) && JSON.parse(readFileSync(join(FM, 'focus.json'), 'utf8')).points.length > 0);
  lap('record for me');

  // ---- The library shows where it stands ----------------------------------------------------------------------
  await click('nav-library');
  await waitFor('the library row', () => exists('row-fixture-demo'), 20000);
  const row = await text('row-fixture-demo');
  check('the library: where it is, its screens, whether they match, last checked', /\d+ screens · (every screen matches|\d+ screens? to look at)/.test(row) && !/Not yet/.test(row), row);
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
  feed.close();
  await sleep(500);
  if (process.env.SCENECAST_UI_KEEP) console.log(`kept ${tmp}`);
  else try { rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }); } catch (e) { console.log(`left ${tmp}: ${e.message}`); }
}
console.log(`TIMES ${JSON.stringify(times)}`);
console.log(fails.length ? `${fails.length} FAILED` : 'all passed');
process.exit(fails.length ? 1 : 0);
