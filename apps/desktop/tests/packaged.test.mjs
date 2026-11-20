// The installed app, as a presenter gets it: the macOS .dmg or the Windows installer from the installers job,
// installed, then started the way a person would (no WebDriver in an installer, no repo engine, no repo Node). Its
// test hook (SCENECAST_SELFTEST) runs the same code as the window's buttons. Checks, in Google Chrome on a profile
// that isn't "Default":
//   - the app starts the receiver itself (its bundled Node, port 47621), restarts it when it dies, stops it on quit
//   - the recorder extension is in Documents/Scenecast/Recorder Extension, and connects with no port to set
//   - the profile that's open is found (not "Default"); Fix opens a missing profile's window in the running browser,
//     closing and restarting nothing; Install recorder opens chrome://extensions in that browser and profile
//   - preflight says the recorder is connected; overlapping checks never leave the demo "busy"
//   - Record, through the real extension, with the system set to Dark and the pages light (as on Jessica's Mac):
//     the window's live count goes up, Stop writes recording.json with at least 3 screens
//   - a recorder older than the app: Record refuses ("Reload the recorder extension"), and Stop with nothing
//     recording is an error, never "0 screens" as a success
// It replaces Documents/Scenecast/Recorder Extension and uses port 47621: on CI, or with SCENECAST_PACKAGED_OK=1.
//   node apps/desktop/tests/packaged.test.mjs <Scenecast.dmg | Scenecast_x.y.z_x64-setup.exe>
import { execFileSync, spawn } from 'node:child_process';
import { realpathSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startFixture } from '../../../examples/fixture-app/server.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const MAC = process.platform === 'darwin', WIN = process.platform === 'win32';
const fails = [];
const check = (name, ok, detail) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? `: ${String(detail).slice(0, 1500)}` : '')); if (!ok) fails.push(name); return ok; };
const installer = resolve(process.argv[2] || '');
if (!existsSync(installer)) { console.log(`usage: packaged.test.mjs <installer> (${installer} isn't there)`); process.exit(2); }
if (!process.env.CI && !process.env.SCENECAST_PACKAGED_OK) { console.log('packaged.test.mjs replaces Documents/Scenecast/Recorder Extension and needs port 47621: it runs on CI, or set SCENECAST_PACKAGED_OK=1'); process.exit(2); }
// The real path: macOS's temp folder is under /var, a symlink, and the updater won't run an app from there.
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'scenecast-packaged-')));
const PORT = 47621;
const listening = port => new Promise(res => { const c = connect(port, '127.0.0.1').once('connect', () => { c.destroy(); res(true); }).once('error', () => res(false)); });
const ping = () => fetch(`http://127.0.0.1:${PORT}/ping`).then(r => r.json()).catch(() => null);
async function waitFor(what, fn, ms = 60000, every = 500) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = e.message; } await sleep(every); }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last)}`);
}

// ---- Install, as a person would ----------------------------------------------------------------------------------
function install() {
  if (MAC) {
    const mnt = join(tmp, 'mnt');
    execFileSync('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mnt, installer]);
    try { cpSync(join(mnt, 'Scenecast.app'), join(tmp, 'Applications', 'Scenecast.app'), { recursive: true, verbatimSymlinks: true }); }
    finally { execFileSync('hdiutil', ['detach', mnt, '-force']); }
    const bin = join(tmp, 'Applications', 'Scenecast.app', 'Contents', 'MacOS');
    return join(bin, readdirSync(bin)[0]);
  }
  if (WIN) {
    execFileSync(installer, ['/S'], { stdio: 'inherit' });
    const dir = join(process.env.LOCALAPPDATA, 'Scenecast');
    const exe = readdirSync(dir).find(f => /\.exe$/i.test(f) && !/uninstall/i.test(f));
    return join(dir, exe);
  }
  throw new Error('macOS and Windows only');
}

let app, ctx, fx, appExit = null;
const HOOK = join(tmp, 'hook'), LIB = join(tmp, 'Scenecast'), UDD = join(tmp, 'chrome-user-data');
let n = 0;
async function hook(action, args = {}, ms = 180000) {
  const name = `r${++n}`;
  mkdirSync(HOOK, { recursive: true });
  writeFileSync(join(HOOK, `${name}.tmp`), JSON.stringify({ action, ...args }));
  // Renamed into place: the app never reads half a request.
  const { renameSync } = await import('node:fs');
  renameSync(join(HOOK, `${name}.tmp`), join(HOOK, `${name}.request.json`));
  const f = join(HOOK, `${name}.response.json`);
  return waitFor(`the app's answer to ${action}`, () => { if (appExit !== null) throw new Error(`the app exited (${appExit})`); return existsSync(f) && JSON.parse(readFileSync(f, 'utf8')); }, ms, 200);
}

try {
  if (await listening(PORT)) throw new Error(`port ${PORT} is in use before the app starts`);
  const exe = install();
  check('installs', existsSync(exe), exe);
  fx = startFixture();
  const extDir = join(homedir(), 'Documents', 'Scenecast', 'Recorder Extension');
  rmSync(extDir, { recursive: true, force: true });
  const env = { ...process.env, SCENECAST_LIBRARY: LIB, SCENECAST_SELFTEST: HOOK };
  for (const k of ['SCENECAST_JS', 'SCENECAST_NODE', 'SCENECAST_EXTENSION_DIR', 'REPLICA_RX_PORT', 'REPLICA_NO_OPEN']) delete env[k];
  const log = [];
  app = spawn(exe, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  app.stdout.on('data', d => log.push(String(d))); app.stderr.on('data', d => log.push(String(d)));
  app.on('exit', c => { appExit = c; });

  const v = await hook('version', {}, 90000);
  check('the installed app starts and answers', v.ok, JSON.stringify(v) + log.join(''));
  // ---- A demo of the fixture app, recorded in Chrome ------------------------------------------------------------
  const made = await hook('create', { spec: { title: 'Fixture demo', apps: [{ id: 'chat', url: fx.chat }, { id: 'admin', url: fx.admin }], browser: 'chrome' } });
  check('creates a demo', made.ok, JSON.stringify(made));
  const id = made.value.id, DEMO = made.value.dir;
  const cfg = JSON.parse(readFileSync(join(DEMO, 'demo.json'), 'utf8'));
  cfg.raw = join(tmp, 'raw');
  cfg.chrome = { ...(cfg.chrome || {}), browser: 'chrome', userDataDir: UDD };
  writeFileSync(join(DEMO, 'demo.json'), JSON.stringify(cfg, null, 2));

  // ---- The receiver: started by the app, with its own Node ------------------------------------------------------
  const rx = await hook('receiver', { demo: id });
  const p0 = await ping();
  check('opening the demo starts the receiver on 47621, the app\'s own', rx.ok && rx.value.receiver.running && rx.value.receiver.port === PORT && p0?.owner === 'app' && resolve(p0.demo) === resolve(DEMO), JSON.stringify({ rx, p0 }));
  const node = execFileSync(WIN ? 'powershell' : 'ps', WIN ? ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${p0.pid}").ExecutablePath`] : ['-o', 'comm=', '-p', String(p0.pid)]).toString().trim();
  check('the receiver runs on the Node inside the app', /Scenecast/i.test(node) && /node(\.exe)?$/i.test(node), node);
  process.kill(p0.pid);
  const p1 = await waitFor('the receiver to come back', async () => { const p = await ping(); return p && p.pid !== p0.pid && p; }, 20000).catch(e => e.message);
  check('a receiver that dies is started again', p1?.owner === 'app', JSON.stringify(p1));

  // ---- The extension, in the visible folder; Chrome on "Profile 3" ----------------------------------------------
  await waitFor('the extension folder', () => existsSync(join(extDir, 'manifest.json')), 60000);
  check('the recorder extension is in Documents/Scenecast/Recorder Extension', existsSync(join(extDir, 'sw.js')));
  ctx = await chromium.launchPersistentContext(UDD, {
    // The system set to Dark while the pages are light (Jessica's Mac): light or dark, it records.
    channel: 'chrome', headless: false, viewport: null, colorScheme: 'dark', ignoreDefaultArgs: ['--disable-extensions', '--no-startup-window'],
    args: ['--profile-directory=Profile 3', '--enable-unsafe-extension-debugging', '--silent-debugger-extension-api', '--no-first-run', '--no-default-browser-check'],
  });
  const first = ctx.pages()[0] || await ctx.newPage();
  await first.goto(fx.chat);
  const cdp = await ctx.browser()?.newBrowserCDPSession().catch(() => null) || await ctx.newCDPSession(first);
  const { id: extId } = await cdp.send('Extensions.loadUnpacked', { path: extDir });
  check('Chrome loads the extension from that folder', !!extId);
  const t0 = Date.now();
  const st = await waitFor('the recorder to connect', async () => { const s = await hook('state'); return s.value.receiver.connected && s; }, 60000, 1000).catch(e => e.message);
  check('the extension connects by itself, no port to set', st?.value?.receiver?.connected, JSON.stringify(st));
  console.log(`connected ${((Date.now() - t0) / 1000).toFixed(1)} s after loading`);

  const pr = await hook('profiles', { demo: id });
  const prof = pr.value?.profiles?.find(p => p.dir === 'Profile 3');
  check('finds the profile that\'s open (Profile 3, not "Default")', pr.ok && pr.value.running && pr.value.picked === 'Profile 3' && prof?.open, JSON.stringify(pr).slice(0, 1500));

  // ---- Preflight: recorder connected; overlapping checks don't leave it busy ------------------------------------
  const a = hook('preflight', { demo: id, fix: false });
  await sleep(400);
  const b = await hook('preflight', { demo: id, fix: false });
  const first1 = await a;
  const item = (r, k) => (r.value?.items || []).find(i => i.id === k) || {};
  check('preflight: receiver up, Chrome found, recorder connected', b.ok && item(b, 'receiver').status === 'ok' && item(b, 'browser').status === 'ok' && item(b, 'recorder').status === 'ok', JSON.stringify(b).slice(0, 1500));
  check('a newer check replaces the one running', !first1.ok ? /replaced|took its place/.test(first1.error) : true, JSON.stringify(first1).slice(0, 400));
  const busy = await hook('busy');
  check('nothing left busy', busy.ok && !Object.keys(busy.value).length, JSON.stringify(busy));

  // ---- Fix: a profile that isn't open gets a window in the running Chrome; nothing closes ------------------------
  const pidBefore = pr.value.pid;
  writeFileSync(join(DEMO, 'demo.json'), JSON.stringify({ ...cfg, chrome: { ...cfg.chrome, profile: 'Profile 4' } }, null, 2));
  const chk = await hook('preflight', { demo: id, fix: false });
  check('Check: "Profile 4 isn\'t open" (the demo names it)', item(chk, 'browser').status === 'fail' && /Profile 4/.test(item(chk, 'browser').detail), JSON.stringify(item(chk, 'browser')));
  const fix = await hook('preflight', { demo: id, fix: true });
  check('Fix: opens a window for Profile 4 in the running Chrome', item(fix, 'browser').status === 'fixed', JSON.stringify(item(fix, 'browser')));
  await waitFor('Profile 4 to open', () => existsSync(join(UDD, 'Profile 4')), 30000).catch(() => {});
  const after = await hook('profiles', { demo: id });
  check('…in the same Chrome (not restarted), the first tab still open', existsSync(join(UDD, 'Profile 4')) && after.value.pid === pidBefore && first.url().startsWith(fx.chat) && !first.isClosed(), JSON.stringify({ pidBefore, after: after.value?.pid, url: first.url() }));

  // ---- Install recorder: chrome://extensions in the running Chrome, in the demo's profile ------------------------
  writeFileSync(join(DEMO, 'demo.json'), JSON.stringify({ ...cfg, chrome: { ...cfg.chrome, profile: 'Profile 3' } }, null, 2));
  const inst = await hook('install', { demo: id });
  check('Install recorder: the folder, and its setup page opened in Chrome (Profile 3)', inst.ok && resolve(inst.value.dir) === resolve(extDir) && inst.value.opened && inst.value.running && inst.value.profile === 'Profile 3', JSON.stringify(inst).slice(0, 1500));
  const extPage = await waitFor('the setup page', () => ctx.pages().find(p => p.url().startsWith(`http://127.0.0.1:${PORT}/setup`)), 20000).catch(() => null);
  // It turns green on its own: the recorder is connected.
  const green = extPage && await waitFor('the setup page to say connected', () => extPage.locator('.state.ok').count(), 15000).catch(() => 0);
  check('…and says the recorder is connected', !!green);
  check('…as a tab in that profile\'s window', !!extPage, ctx.pages().map(p => p.url()).join(', '));

  // ---- Record through the real extension: live count, then at least 3 screens in recording.json -----------------
  writeFileSync(join(DEMO, 'demo.json'), JSON.stringify({ ...cfg, chrome: { ...cfg.chrome, profile: 'Profile 3' }, record: { ...(cfg.record || {}), auto: false } }, null, 2));
  for (const p of ctx.pages()) if (p !== first && !p.url().startsWith(fx.chat)) await p.close().catch(() => {});
  if (!first.url().startsWith(fx.chat)) await first.goto(fx.chat);
  const adminTab = await ctx.newPage(); await adminTab.goto(fx.admin);
  await first.bringToFront();
  const RAW = join(tmp, 'raw');
  rmSync(join(RAW, 'recording.json'), { force: true });
  const started = await hook('record-start', { demo: id }, 300000);
  check('Record starts (system Dark, pages light)', started.ok && started.value?.recording, JSON.stringify(started).slice(0, 800));
  const live = await waitFor('the live count', async () => { const st2 = await hook('record-status', { demo: id }); return st2.ok && st2.value.recording && st2.value.count >= 2 && st2.value; }, 120000, 1000).catch(e => e.message);
  check('while recording, the status counts the screens captured', live?.count >= 2, JSON.stringify(live).slice(0, 600));
  if (started.ok) {
    await first.getByRole('link', { name: 'Plugins' }).click(); await sleep(4000);
    await waitFor('the third screen', async () => (await hook('record-status', { demo: id })).value?.count >= 3, 60000, 1000).catch(() => {});
  }
  const stopped = await hook('record-stop', { demo: id }, 600000);
  const recFile = join(RAW, 'recording.json');
  const states = existsSync(recFile) ? Object.keys(JSON.parse(readFileSync(recFile, 'utf8')).states || {}).length : 0;
  check('Stop: recording.json has at least 3 screens', stopped.ok && stopped.value.states >= 3 && states >= 3, `${states} screens; ${JSON.stringify(stopped).slice(0, 600)}`);
  const again = await hook('record-stop', { demo: id });
  check('Stop with nothing recording is an error (never 0 screens as a success)', !again.ok && /wasn.t recording/.test(again.error), JSON.stringify(again));

  // ---- An older recorder in the browser: Record refuses and says to reload it --------------------------------------
  const man = join(extDir, 'sw.js'), manText = readFileSync(man, 'utf8');
  writeFileSync(man, manText.replace(/const RECORDER_VERSION = "[^"]*";/, 'const RECORDER_VERSION = "0.0.9";'));
  const reload = () => fetch(`http://127.0.0.1:${PORT}/cmd`, { method: 'POST', body: JSON.stringify({ op: 'reload' }) });
  await reload();
  await sleep(3000);
  const { send } = await import('../../../packages/recorder/cli.mjs');
  await waitFor('the old recorder to answer', async () => (await send({ op: 'extension' }, 5, PORT)).value?.version === '0.0.9', 60000, 1000).catch(() => {});
  const stale = await hook('record-start', { demo: id }, 180000);
  check('a recorder older than the app: Record refuses, "Reload the recorder extension"', !stale.ok && /Reload the recorder extension/.test(stale.error) && /0\.0\.9/.test(stale.error), JSON.stringify(stale).slice(0, 600));
  writeFileSync(man, manText);
  await reload().catch(() => {});

  // ---- Quit: the receiver goes with the app ---------------------------------------------------------------------
  app.kill();
  await waitFor('the app to quit', () => appExit !== null, 20000).catch(() => {});
  const gone = await waitFor('the receiver to stop', async () => !(await listening(PORT)), 20000).then(() => true, () => false);
  check('quitting the app stops its receiver', gone);
} catch (e) {
  check('ran', false, e.stack || e);
} finally {
  if (appExit === null) try { app?.kill(); } catch { /* gone */ }
  await ctx?.close().catch(() => {});
  fx?.close?.();
  if (!process.env.SCENECAST_KEEP) rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
}
console.log(fails.length ? `${fails.length} FAILED` : 'ALL PASS');
process.exit(fails.length ? 1 : 0);
