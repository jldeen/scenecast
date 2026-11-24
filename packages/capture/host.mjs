// The capture host (opt-in: demo.json "recorder": "capture"). It keeps the capture browser up for one demo, with each
// app in a window of its own off the screen, and runs the recorder in that browser over the DevTools protocol: in this
// process, polling the demo's receiver as the agent does. No extension, no debugging bar, nothing on her screen.
// Preflight starts it; by hand:
//   stunt capture start|stop|status [--demo <dir>]   (start: in the background, until stop)
//   stunt capture sign-in [--demo <dir>]             the one window on her screen: sign in to the demo's tenant there
//   stunt capture run [--demo <dir>]                 in the foreground
// demo.json "capture" (all optional): { "profile": "default" (a name under ~/.stuntdouble/capture, or a folder),
//   "channel": "chrome" | "msedge", "window": "auto" | "minimized" | "offscreen", "flags": [],
//   "tenant": the demo tenant (its domain or id): nothing is captured signed in to any other,
//   "account": the demo account (pinned at Entra's sign-in, so no account picker), "domainHint",
//   "macSso": false to turn the Mac's own single sign-on off in the profile (it's what signs a managed Mac in) }
// These name a tenant: they go in a demo's own demo.json, never in this repository.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCaptureBrowser, signInWindow, landedOn, profileDir, resolveTenant, tenantVerdict, isTenantId, hintedUrl, ownSignInPage } from './browser.mjs';
import { agentCode } from './build.mjs';
import { hostOps } from './host-ops.mjs';
import { fencePort } from '@stuntdouble/core/lib/test-fence.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

export function captureOpts(cfg) {
  const c = cfg.capture || {};
  const p = c.profile || 'default';
  const profile = /^[\w.-]+$/.test(p) ? profileDir(p) : resolve(p.replace(/^~(?=$|[\\/])/, homedir()));
  const pin = { loginHint: c.account || null, domainHint: c.domainHint || (c.tenant && !isTenantId(c.tenant) ? c.tenant : null) };
  return { profile, channel: c.channel || (cfg.chrome && cfg.chrome.browser === 'edge' ? 'msedge' : 'chrome'), window: c.window || 'auto', flags: c.flags || [],
    tenant: c.tenant || null, pin: pin.loginHint || pin.domainHint ? pin : null, ...(c.mockKeychain !== undefined ? { mockKeychain: !!c.mockKeychain } : {}),
    ...(c.macSso !== undefined ? { macSso: !!c.macSso } : {}) };
}
export const stateFile = demo => join(demo.out, 'capture.json');
export const logFile = demo => join(demo.out, 'capture.log');
export function hostState(demo) {
  try { const s = JSON.parse(readFileSync(stateFile(demo), 'utf8')); return { ...s, alive: !!s.pid && alive(s.pid) }; } catch (e) { return null; }
}

// The recorder in the capture browser, started on one of its pages: the same recorder the extension and the agent
// run, telling the receiver it's in the capture browser.
// ops: the host's own commands (host-ops.mjs), added to the recorder's.
export async function startRecorder(page, port, ops = null) {
  fencePort(port);
  const shadow = readFileSync(join(here, 'cdp-shadow.js'), 'utf8').replace(/^\/\/.*\n/gm, '');
  if (ops) globalThis.__stuntdoubleCaptureOps = ops;
  const extra = ops ? 'Object.assign(OPS, globalThis.__stuntdoubleCaptureOps || {});\n' : '';
  const agent = new Function('return ' + agentCode(port, { browser: 'capture', shadow, extra }))();
  return agent(page);
}

// Up for one demo until stopped: { ok } once the recorder runs, or { error } (and the state file says the same).
// Its messages go to stderr: in the background (start), that's the demo's capture.log.
export async function run(demo, { log = s => console.error(`${new Date().toISOString()} ${s}`) } = {}) {
  const cfg = demo.cfg, port = +(process.env.REPLICA_RX_PORT || cfg.receiverPort);
  const o = captureOpts(cfg);
  mkdirSync(demo.out, { recursive: true });
  const say = s => { writeFileSync(stateFile(demo), JSON.stringify(s, null, 1)); return s; };
  // Gone with it, unless it says why it didn't start (failed, refused): start and preflight read that.
  process.on('exit', () => { const s = hostState(demo); if (s && s.pid === process.pid && !['failed', 'refused'].includes(s.phase)) rmSync(stateFile(demo), { force: true }); });
  say({ pid: process.pid, phase: 'starting', at: new Date().toISOString(), profile: o.profile });
  let want = null;
  try { want = await resolveTenant(o.tenant); } catch (e) { return say({ pid: process.pid, phase: 'failed', error: `the demo's tenant: ${e.message}` }); }
  const cb = await openCaptureBrowser({ ...o, viewport: cfg.viewport, log });
  if (!cb) return say({ pid: process.pid, phase: 'failed', error: `the capture browser didn't start (${o.channel}, profile ${o.profile})` });
  if (o.pin) await cb.pinAccount(o.pin);
  const apps = (cfg.apps || []).filter(a => a.url);
  // Each app in a window of its own (made one at a time, loaded side by side); then where each one landed.
  const pages = await Promise.all(apps.map(a => cb.open(a)));
  await Promise.all(pages.map(p => p.waitForLoadState('load', { timeout: 60000 }).catch(() => {})));
  await sleep(3000);
  const look = async i => ({ id: apps[i].id, ...landedOn(pages[i].url(), await pages[i].evaluate(() => document.body ? document.body.innerText.slice(0, 4000) : '').catch(() => ''), apps[i].match) });
  let landed = await Promise.all(apps.map((a, i) => look(i)));
  // An app's own "which account" landing (M365 Copilot's): its address again, with the demo account as the hint.
  const again = o.pin && o.pin.loginHint ? apps.map((a, i) => i).filter(i => ownSignInPage(landed[i]) && hintedUrl(apps[i].url, o.pin.loginHint)) : [];
  if (again.length) {
    log(`capture browser: ${again.map(i => apps[i].id).join(', ')}: their own sign-in landing; with the demo account as the hint`);
    await Promise.all(again.map(i => pages[i].goto(hintedUrl(apps[i].url, o.pin.loginHint), { waitUntil: 'load', timeout: 60000 }).catch(() => {})));
    await sleep(5000);
    landed = await Promise.all(apps.map((a, i) => look(i)));
  }
  const signIn = landed.filter(l => l.at !== 'app').map(l => l.id);
  if (signIn.length) log(`capture browser: ${signIn.join(', ')} ${signIn.length > 1 ? 'need' : 'needs'} a sign-in: stunt capture sign-in`);
  // The tenant, before anything is captured: another tenant (a wrong account picked silently), or one it can't
  // see where the demo names one, and the browser closes. An app's sign-in library can take a few seconds.
  const byApp = () => Object.fromEntries(apps.map((a, i) => [a.id, pages[i]]).filter(([id]) => !signIn.includes(id)));
  let tv = tenantVerdict(await cb.tenantsOf(byApp()), want);
  for (let i = 0; i < 10 && !tv.ok && !tv.other; i++) { await sleep(2000); tv = tenantVerdict(await cb.tenantsOf(byApp()), want); }
  if (!tv.ok) {
    log(`capture browser: refusing to capture: ${tv.why}`);
    await cb.close();
    return say({ pid: process.pid, phase: 'refused', at: new Date().toISOString(), profile: o.profile, error: `refusing to capture: ${tv.why}. Sign in again with the demo tenant's account (stunt capture sign-in)` });
  }
  // And while it runs: a page signed in to another tenant stops it at once (nothing more is captured).
  if (want) setInterval(async () => {
    const now = Object.fromEntries(cb.ctx.pages().filter(p => /^https?:/.test(p.url())).map((p, i) => [`page${i}`, p]));
    const v = tenantVerdict(await cb.tenantsOf(now).catch(() => ({})), want);
    if (v.other) {
      log(`capture browser: stopped: ${v.why}`);
      say({ pid: process.pid, phase: 'refused', at: new Date().toISOString(), profile: o.profile, error: `stopped capturing: ${v.why}` });
      await cb.close(); process.exit(3);
    }
  }, 20000).unref();
  const started = pages.length ? await startRecorder(pages[0], port, hostOps(cb, { log })).catch(e => String(e.message || e)) : 'no apps';
  const info = await cb.info();
  return say({ pid: process.pid, phase: started === 'agent started' ? 'recording-ready' : 'failed', at: new Date().toISOString(), profile: o.profile,
    mode: info.mode, fellBack: info.fellBack, startMs: info.startMs, cdp: info.port, browserPid: info.pid, tenant: tv.all.length ? tv.all : null, apps: landed.map(l => ({ id: l.id, at: l.at })), ...(signIn.length ? { signIn } : {}),
    ...(started === 'agent started' ? {} : { error: started }) });
}

// The host on its own, outliving whoever started it. Windows: through Start-Process (ShellExecute), because a child
// made the usual way inherits every inheritable handle, the caller's output pipe included, and keeps it open for
// as long as it runs (measured: the selftest, which reads preflight's output to the end, waited for ever). It
// writes its own log there (--log).
function launchDetached(args, log) {
  if (process.platform === 'win32') {
    const argList = [...args, '--log'].map(a => /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a).join(' ');
    const q = v => `'${String(v).replace(/'/g, "''")}'`;
    const ps = `$p = Start-Process -FilePath ${q(process.execPath)} -ArgumentList ${q(argList)} -WindowStyle Hidden -PassThru; $p.Id`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    return +String(r.stdout || '').trim() || null;
  }
  const out = openSync(log, 'a');
  const k = spawn(process.execPath, args, { detached: true, stdio: ['ignore', out, out], env: process.env });
  k.unref();
  return k.pid;
}

// In the background, until stop: waits until the recorder runs (or it can't), and says which.
export async function start(demo, { waitS = 120 } = {}) {
  const s0 = hostState(demo);
  if (s0 && s0.alive && s0.phase === 'recording-ready') return { ok: true, already: true, ...s0 };
  rmSync(stateFile(demo), { force: true });
  mkdirSync(demo.out, { recursive: true });
  const pid = launchDetached([fileURLToPath(import.meta.url), 'run', '--demo', demo.dir], logFile(demo));
  if (!pid) return { ok: false, error: "the capture host didn't start" };
  for (let i = 0; i < waitS * 2; i++) {
    await sleep(500);
    const s = hostState(demo);
    if (s && (s.phase === 'recording-ready' || s.phase === 'failed' || s.phase === 'refused')) return { ok: s.phase === 'recording-ready', ...s };
    if (i > 10 && !alive(pid)) return { ok: false, error: 'the capture host stopped as it started' };
  }
  return { ok: false, error: `the capture browser wasn't ready in ${waitS} s` };
}

export async function stop(demo) {
  const s = hostState(demo);
  if (!s || !s.alive) { rmSync(stateFile(demo), { force: true }); return { ok: true, running: false }; }
  try { process.kill(s.pid, 'SIGTERM'); } catch (e) {}
  for (let i = 0; i < 40 && alive(s.pid); i++) await sleep(250);
  if (alive(s.pid)) try { process.kill(s.pid, 'SIGKILL'); } catch (e) {}
  // On Windows a stopped process runs none of its exit handlers: the browser it started goes too.
  if (s.browserPid && alive(s.browserPid)) { try { process.kill(s.browserPid); } catch (e) {} for (let i = 0; i < 20 && alive(s.browserPid); i++) await sleep(250); }
  rmSync(stateFile(demo), { force: true });
  return { ok: true, stopped: s.pid };
}

// The sign-in window needs the profile to itself: the host stops first, and starts again after when it was running.
export async function signIn(demo, { timeoutS = 600 } = {}) {
  const was = hostState(demo);
  if (was && was.alive) await stop(demo);
  const o = captureOpts(demo.cfg);
  const r = await signInWindow({ profile: o.profile, channel: o.channel, apps: (demo.cfg.apps || []).filter(a => a.url), timeoutS, flags: o.flags, pin: o.pin });
  // Signed in to the demo tenant, and no other.
  if (r.ok) { const v = tenantVerdict(r.tenants || {}, await resolveTenant(o.tenant).catch(() => null)); if (!v.ok) Object.assign(r, { ok: false, error: v.why }); }
  if (was && was.alive) r.restarted = await start(demo);
  return r;
}

export async function main(args, loadDemo) {
  const sub = args[0] && !args[0].startsWith('--') ? args[0] : 'status';
  const demo = loadDemo(args.filter((a, i) => i > 0 || a.startsWith('--')));
  const print = r => { console.log(JSON.stringify(r, null, 1)); return r.ok === false || r.error ? 1 : 0; };
  if (sub === 'run') {
    // --log: no output of its own (started through Start-Process on Windows), so it writes the demo's capture.log.
    const toFile = args.includes('--log');
    const log = toFile ? m => { try { appendFileSync(logFile(demo), `${new Date().toISOString()} ${m}\n`); } catch (e) {} } : undefined;
    if (toFile) for (const ev of ['uncaughtException', 'unhandledRejection']) process.on(ev, e => { log(String(e && e.stack || e)); process.exit(1); });
    const r = await run(demo, log ? { log } : {});
    if (r.phase !== 'recording-ready') { (log || console.error)(r.error || 'not ready'); process.exit(1); }
    return new Promise(() => {});
  }
  if (sub === 'start') return print(await start(demo));
  if (sub === 'stop') return print(await stop(demo));
  if (sub === 'sign-in') return print(await signIn(demo));
  if (sub === 'status') { const s = hostState(demo); return print(s ? { ok: s.alive, ...s } : { ok: false, running: false }); }
  console.error('stunt capture start|stop|status|sign-in|run [--demo <dir>]');
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { loadDemo } = await import('@stuntdouble/core/lib/demo.mjs');
  const code = await main(process.argv.slice(2), loadDemo);
  if (typeof code === 'number') process.exit(code);
}
