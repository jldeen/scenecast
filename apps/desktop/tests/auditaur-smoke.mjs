// Local smoke test of Record, observed by Auditaur (github.com/sethjuarez/auditaur): a dev build of the app (cargo
// feature `auditaur`) runs under `auditaur observe`, Auditaur's drive bridge clicks Start and Stop recording in the
// window, and a test Chrome (its own profile folder, never yours) with the recorder extension goes through the fixture
// app in between. Then Auditaur's IPC, errors and logs say what the window asked and what came back.
// Everything is isolated: a temporary HOME, library and extension folder, and its own receiver port (not 47621), so
// an installed Scenecast and its receiver are left alone. Ports: SMOKE_RX_PORT (47661), SMOKE_FIXTURE_PORT (47831, +1).
//   node apps/desktop/tests/auditaur-smoke.mjs [--auditaur <path to the auditaur binary>] [--stale] [--keep]
//     --stale   the recorder in the browser is older (0.0.9): Record must refuse, saying to reload it
// Needs: the auditaur CLI (cargo install auditaur-cli, or --auditaur), Google Chrome, and Node 20+.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startFixture } from '../../../examples/fixture-app/server.mjs';
import { selftestGuard } from '../../../packages/selftest/guard.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DESKTOP = resolve(here, '..'), REPO = resolve(DESKTOP, '..', '..');
const argv = process.argv.slice(2);
const opt = k => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
const AUDITAUR = opt('--auditaur') || process.env.AUDITAUR || 'auditaur';
const STALE = argv.includes('--stale');
const PORT = +(process.env.SMOKE_RX_PORT || 47661);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fails = [];
const check = (name, ok, detail) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? `: ${String(detail).slice(0, 1500)}` : '')); if (!ok) fails.push(name); return ok; };
async function waitFor(what, fn, ms = 60000, every = 500) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = e.message; } await sleep(every); }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last)?.slice(0, 600)}`);
}

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'scenecast-auditaur-')));
await selftestGuard({ tmp, receivers: [PORT], extensions: [PORT] });
const HOME = join(tmp, 'home'), LIB = join(tmp, 'library'), EXT = join(tmp, 'Recorder Extension'), HOOK = join(tmp, 'hook'), UDD = join(tmp, 'chrome');
for (const d of [HOME, LIB, HOOK]) mkdirSync(d, { recursive: true });
let n = 0;
async function hook(action, args = {}, ms = 120000) {
  const name = `r${++n}`;
  writeFileSync(join(HOOK, `${name}.tmp`), JSON.stringify({ action, ...args }));
  renameSync(join(HOOK, `${name}.tmp`), join(HOOK, `${name}.request.json`));
  const f = join(HOOK, `${name}.response.json`);
  return waitFor(`the app's answer to ${action}`, () => existsSync(f) && JSON.parse(readFileSync(f, 'utf8')), ms, 200);
}
// Auditaur's CLI, pinned to this run's session.
// Its data folder is this run's too (the app's HOME is temporary, and the CLI has to look where the app writes).
const SESSION = join(tmp, '.auditaur', 'session.json'), AUENV = { ...process.env, AUDITAUR_DATA_DIR: join(tmp, 'auditaur') };
function au(args, json = true) {
  const out = execFileSync(AUDITAUR, [...args, ...(json ? ['--json'] : [])], { cwd: tmp, env: AUENV, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
  return json ? JSON.parse(out) : out;
}
let sel = [];
const drive = (...a) => au(['drive', ...sel, ...a]);
const click = s => drive('click', '--selector', s);
const text = s => { const r = drive('text', '--selector', s); return String(r.payload?.text ?? ''); };
const exists = s => !!drive('exists', '--selector', s).payload?.exists;

// The record job's live status updates the window received (Auditaur's events): each one's screen count.
const liveCounts = () => au(['events', '--session-file', SESSION]).map(e => JSON.stringify(e))
  .map(t => /\\?"type\\?":\\?"record\\?".*?\\?"count\\?":(\d+)/.exec(t)).filter(Boolean).map(m => +m[1]);

let obs, ctx, fx, appPid;
try {
  // ---- The dev app, with Auditaur's collector, under `auditaur observe` --------------------------------------------
  execFileSync('npm', ['run', '-s', 'build'], { cwd: join(DESKTOP, 'auditaur'), stdio: 'inherit', shell: process.platform === 'win32' });
  execFileSync('cargo', ['build', '--features', 'auditaur', '--manifest-path', join(DESKTOP, 'src-tauri', 'Cargo.toml')], { stdio: 'inherit' });
  const exe = join(DESKTOP, 'src-tauri', 'target', 'debug', process.platform === 'win32' ? 'scenecast-desktop.exe' : 'scenecast-desktop');
  fx = startFixture({ chatPort: +(process.env.SMOKE_FIXTURE_PORT || 47831), adminPort: +(process.env.SMOKE_FIXTURE_PORT || 47831) + 1 });
  const env = { ...AUENV, HOME, USERPROFILE: HOME, SCENECAST_LIBRARY: LIB, SCENECAST_EXTENSION_DIR: EXT, SCENECAST_SELFTEST: HOOK, REPLICA_RX_PORT: String(PORT), REPLICA_NO_OPEN: '1' };
  obs = spawn(AUDITAUR, ['observe', '--app', 'scenecast-desktop', '--', exe], { cwd: tmp, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const obsLog = []; obs.stdout.on('data', d => obsLog.push(String(d))); obs.stderr.on('data', d => obsLog.push(String(d)));
  await waitFor('auditaur observe to write its session', () => existsSync(SESSION), 180000).catch(e => { throw new Error(e.message + obsLog.join('')); });
  const s = JSON.parse(readFileSync(SESSION, 'utf8'));
  const pick = (...ks) => { for (const k of ks) { const v = k.split('.').reduce((o, x) => o?.[x], s); if (v !== undefined && v !== null) return String(v); } return null; };
  const sid = pick('app.sessionId', 'sessionId'), iid = pick('app.instanceId', 'instanceId'), pid = pick('app.pid', 'pid');
  appPid = +pid || null;
  sel = [...(sid ? ['--session-id', sid] : []), ...(iid ? ['--instance-id', iid] : []), ...(pid ? ['--pid', pid] : [])];
  check('auditaur observes the app', !!sid, JSON.stringify(s));
  const v = await hook('version', {}, 90000);
  check('the app answers', v.ok, JSON.stringify(v));
  await waitFor('the drive bridge', () => { try { return exists('#main'); } catch (e) { return void (globalThis.lastDrive = String(e.stderr || e.message).slice(0, 400)); } }, 60000, 1000).catch(e => { throw new Error(e.message + ' ' + globalThis.lastDrive); });

  // ---- A demo of the fixture, and Chrome with the recorder on the fixture's two tabs -------------------------------
  const made = await hook('create', { spec: { title: 'Smoke', apps: [{ id: 'chat', url: fx.chat }, { id: 'admin', url: fx.admin }], browser: 'chrome' } });
  const id = made.value.id, DEMO = made.value.dir, RAW = join(tmp, 'raw');
  const cfg = JSON.parse(readFileSync(join(DEMO, 'demo.json'), 'utf8'));
  writeFileSync(join(DEMO, 'demo.json'), JSON.stringify({ ...cfg, raw: RAW, record: { ...(cfg.record || {}), auto: false }, chrome: { ...(cfg.chrome || {}), browser: 'chrome', userDataDir: UDD } }, null, 2));
  const rx = await hook('receiver', { demo: id });
  check(`the app's receiver is on ${PORT} (not 47621)`, rx.ok && rx.value.receiver.port === PORT, JSON.stringify(rx));
  await waitFor('the extension folder', () => existsSync(join(EXT, 'sw.js')), 60000);
  ctx = await chromium.launchPersistentContext(UDD, {
    // The system set to Dark (as on Jessica's Mac) while the apps themselves are light: that's no reason to refuse.
    channel: 'chrome', headless: false, viewport: null, colorScheme: 'dark', ignoreDefaultArgs: ['--disable-extensions', '--no-startup-window'],
    args: ['--enable-unsafe-extension-debugging', '--silent-debugger-extension-api', '--no-first-run', '--no-default-browser-check'],
  });
  const chat = ctx.pages()[0] || await ctx.newPage();
  await chat.goto(fx.chat);
  const admin = await ctx.newPage(); await admin.goto(fx.admin);
  const cdp = await ctx.browser()?.newBrowserCDPSession().catch(() => null) || await ctx.newCDPSession(chat);
  await cdp.send('Extensions.loadUnpacked', { path: EXT });
  await waitFor('the recorder to connect', async () => (await hook('state')).value.receiver.connected, 60000, 1000);
  if (STALE) {
    // An older recorder in the browser (as one never reloaded after an update): its code says 0.0.9, and it reloads.
    const sw = join(EXT, 'sw.js');
    writeFileSync(sw, readFileSync(sw, 'utf8').replace(/const RECORDER_VERSION = "[^"]*";/, 'const RECORDER_VERSION = "0.0.9";'));
    await fetch(`http://127.0.0.1:${PORT}/cmd`, { method: 'POST', body: JSON.stringify({ op: 'reload' }) });
    await sleep(3000);
    await waitFor('the old recorder to connect', async () => (await hook('state')).value.receiver.connected, 60000, 1000);
    const { send } = await import('../../../packages/capture/cli.mjs');
    const v = await send({ op: 'extension' }, 10, PORT);
    console.log('the recorder in the browser says', JSON.stringify(v.value?.version ?? v));
  }
  await chat.bringToFront();

  // ---- Record, through the window -----------------------------------------------------------------------------------
  click('#nav-library');
  await waitFor('the demo in the library', () => exists(`[data-open="${id}"]`), 30000, 500);
  click(`[data-open="${id}"]`);
  await waitFor('the Record tab', () => exists('[data-test="record-start"]'), 30000, 500);
  click('[data-test="record-start"]');
  if (STALE) {
    const msg = await waitFor('Record to refuse', () => { const t = text('#main'); return /Reload the recorder/i.test(t) && t; }, 120000, 1000).catch(e => e.message);
    check('a stale recorder: Record refuses, saying to reload it', /Reload the recorder/i.test(msg), msg);
    check('…and records nothing', !existsSync(join(RAW, 'recording.json')));
  } else {
    // Live: the screens captured so far, as the window gets them (its job events, as Auditaur saw them), before Stop.
    // (Not read off the page: a window in the background may not redraw.)
    const live = await waitFor('the live count', () => { const c = liveCounts(); return c.some(n => n >= 2) && c; }, 120000, 1000).catch(e => e.message);
    check('while recording, the window gets the screens captured so far (2 start screens)', Array.isArray(live), live);
    await chat.getByRole('link', { name: 'Plugins' }).click(); await sleep(4000);
    await chat.getByRole('link', { name: 'New' }).click(); await sleep(4000);
    await waitFor('the third screen', () => +text('[data-test="screens"]') >= 3, 60000, 1000).catch(() => {});
    click('[data-test="record-stop"]');
    const done = await waitFor('the result', () => (exists('[data-test="record-done"]') || exists('[data-test="record-failed"]')) && text('#main'), 180000, 1000).catch(e => e.message);
    const rec = existsSync(join(RAW, 'recording.json')) && JSON.parse(readFileSync(join(RAW, 'recording.json'), 'utf8'));
    const states = rec ? Object.keys(rec.states || {}).length : 0;
    check('recording.json has at least 3 screens', states >= 3, `${states} screens; window said: ${String(done).slice(0, 400)}`);
    check('the window says so', exists('[data-test="record-done"]') && /Recorded/.test(done), done);
  }

  // ---- What Auditaur saw ------------------------------------------------------------------------------------------
  await sleep(3000); // the window sends its telemetry every second
  const calls = au(['ipc', '--session-file', SESSION]);
  const rec = calls.filter(c => /^record_/.test(c.command));
  console.log('auditaur ipc (record_*):'); for (const c of rec) console.log(`  ${c.command} ${c.status} ${String(c.errorMessage || c.resultSummary || '').slice(0, 300)}`);
  const counts = liveCounts();
  console.log(`auditaur events: live screen counts ${JSON.stringify([...new Set(counts)])}`);
  check('auditaur saw record_start', rec.some(c => c.command === 'record_start'), JSON.stringify(calls.map(c => c.command)));
  const errs = au(['errors', '--session-file', SESSION]);
  const list = Array.isArray(errs) ? errs : [];
  check('no frontend errors', list.length === 0, JSON.stringify(list).slice(0, 1500));
} catch (e) {
  check('ran', false, e.stack || e);
} finally {
  try { if (existsSync(SESSION)) execFileSync(AUDITAUR, ['stop', '--session-file', SESSION], { cwd: tmp, env: AUENV, stdio: 'ignore' }); } catch { /* gone */ }
  try { obs?.kill(); } catch { /* gone */ }
  try { if (appPid) process.kill(appPid); } catch { /* gone */ }
  await ctx?.close().catch(() => {});
  fx?.close?.();
  if (!argv.includes('--keep')) rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }); else console.log('kept', tmp);
}
console.log(fails.length ? `${fails.length} FAILED` : 'ALL PASS');
process.exit(fails.length ? 1 : 0);
