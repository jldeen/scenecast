// The capture host (opt-in: demo.json "recorder": "capture"). It keeps the capture browser up for one demo, with each
// app in a window of its own off the screen, and runs the recorder in that browser over the DevTools protocol: in this
// process, polling the demo's receiver as the agent does. No extension, no debugging bar, nothing on her screen.
// Preflight starts it; by hand:
//   stunt capture start|stop|status [--demo <dir>]   (start: in the background, until stop)
//   stunt capture sign-in [--demo <dir>]             the one window on her screen: sign in to the demo's tenant there
//   stunt capture run [--demo <dir>]                 in the foreground
// demo.json "capture" (all optional): { "profile": "default" (a name under ~/.stuntdouble/capture, or a folder),
//   "channel": "chrome" | "msedge", "window": "auto" | "minimized" | "offscreen", "flags": [] }
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCaptureBrowser, signInWindow, landedOn, profileDir } from './browser.mjs';
import { agentCode } from './build.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

export function captureOpts(cfg) {
  const c = cfg.capture || {};
  const p = c.profile || 'default';
  const profile = /^[\w.-]+$/.test(p) ? profileDir(p) : resolve(p.replace(/^~(?=$|[\\/])/, homedir()));
  return { profile, channel: c.channel || (cfg.chrome && cfg.chrome.browser === 'edge' ? 'msedge' : 'chrome'), window: c.window || 'auto', flags: c.flags || [], ...(c.mockKeychain !== undefined ? { mockKeychain: !!c.mockKeychain } : {}) };
}
export const stateFile = demo => join(demo.out, 'capture.json');
export const logFile = demo => join(demo.out, 'capture.log');
export function hostState(demo) {
  try { const s = JSON.parse(readFileSync(stateFile(demo), 'utf8')); return { ...s, alive: !!s.pid && alive(s.pid) }; } catch (e) { return null; }
}

// The recorder in the capture browser, started on one of its pages: the same recorder the extension and the agent
// run, telling the receiver it's in the capture browser.
export async function startRecorder(page, port) {
  const shadow = readFileSync(join(here, 'cdp-shadow.js'), 'utf8').replace(/^\/\/.*\n/gm, '');
  const agent = new Function('return ' + agentCode(port, { browser: 'capture', shadow }))();
  return agent(page);
}

// Up for one demo until stopped: { ok } once the recorder runs, or { error } (and the state file says the same).
// Its messages go to stderr: in the background (start), that's the demo's capture.log.
export async function run(demo, { log = s => console.error(`${new Date().toISOString()} ${s}`) } = {}) {
  const cfg = demo.cfg, port = +(process.env.REPLICA_RX_PORT || cfg.receiverPort);
  const o = captureOpts(cfg);
  mkdirSync(demo.out, { recursive: true });
  const say = s => { writeFileSync(stateFile(demo), JSON.stringify(s, null, 1)); return s; };
  process.on('exit', () => { const s = hostState(demo); if (s && s.pid === process.pid) rmSync(stateFile(demo), { force: true }); });
  say({ pid: process.pid, phase: 'starting', at: new Date().toISOString(), profile: o.profile });
  const cb = await openCaptureBrowser({ ...o, viewport: cfg.viewport, log });
  if (!cb) return say({ pid: process.pid, phase: 'failed', error: `the capture browser didn't start (${o.channel}, profile ${o.profile})` });
  const apps = (cfg.apps || []).filter(a => a.url);
  // Each app in a window of its own (made one at a time, loaded side by side); then where each one landed.
  const pages = await Promise.all(apps.map(a => cb.open(a)));
  await Promise.all(pages.map(p => p.waitForLoadState('load', { timeout: 60000 }).catch(() => {})));
  await sleep(3000);
  const landed = await Promise.all(apps.map(async (a, i) => ({ id: a.id, ...landedOn(pages[i].url(), await pages[i].evaluate(() => document.body ? document.body.innerText.slice(0, 4000) : '').catch(() => ''), a.match) })));
  const signIn = landed.filter(l => l.at !== 'app').map(l => l.id);
  if (signIn.length) log(`capture browser: ${signIn.join(', ')} ${signIn.length > 1 ? 'need' : 'needs'} a sign-in: stunt capture sign-in`);
  const started = pages.length ? await startRecorder(pages[0], port).catch(e => String(e.message || e)) : 'no apps';
  const info = await cb.info();
  return say({ pid: process.pid, phase: started === 'agent started' ? 'recording-ready' : 'failed', at: new Date().toISOString(), profile: o.profile,
    mode: info.mode, fellBack: info.fellBack, startMs: info.startMs, cdp: info.port, apps: landed.map(l => ({ id: l.id, at: l.at })), ...(signIn.length ? { signIn } : {}),
    ...(started === 'agent started' ? {} : { error: started }) });
}

// In the background, until stop: waits until the recorder runs (or it can't), and says which.
export async function start(demo, { waitS = 120 } = {}) {
  const s0 = hostState(demo);
  if (s0 && s0.alive) return { ok: true, already: true, ...s0 };
  rmSync(stateFile(demo), { force: true });
  mkdirSync(demo.out, { recursive: true });
  const out = openSync(logFile(demo), 'a');
  const k = spawn(process.execPath, [fileURLToPath(import.meta.url), 'run', '--demo', demo.dir], { detached: true, stdio: ['ignore', out, out], env: process.env });
  k.unref();
  for (let i = 0; i < waitS * 2; i++) {
    await sleep(500);
    const s = hostState(demo);
    if (s && (s.phase === 'recording-ready' || s.phase === 'failed')) return { ok: s.phase === 'recording-ready', ...s };
    if (i > 10 && !alive(k.pid)) return { ok: false, error: 'the capture host stopped as it started' };
  }
  return { ok: false, error: `the capture browser wasn't ready in ${waitS} s` };
}

export async function stop(demo) {
  const s = hostState(demo);
  if (!s || !s.alive) { rmSync(stateFile(demo), { force: true }); return { ok: true, running: false }; }
  try { process.kill(s.pid, 'SIGTERM'); } catch (e) {}
  for (let i = 0; i < 40 && alive(s.pid); i++) await sleep(250);
  if (alive(s.pid)) try { process.kill(s.pid, 'SIGKILL'); } catch (e) {}
  rmSync(stateFile(demo), { force: true });
  return { ok: true, stopped: s.pid };
}

// The sign-in window needs the profile to itself: the host stops first, and starts again after when it was running.
export async function signIn(demo, { timeoutS = 600 } = {}) {
  const was = hostState(demo);
  if (was && was.alive) await stop(demo);
  const o = captureOpts(demo.cfg);
  const r = await signInWindow({ profile: o.profile, channel: o.channel, apps: (demo.cfg.apps || []).filter(a => a.url), timeoutS, flags: o.flags });
  if (was && was.alive) r.restarted = await start(demo);
  return r;
}

export async function main(args, loadDemo) {
  const sub = args[0] && !args[0].startsWith('--') ? args[0] : 'status';
  const demo = loadDemo(args.filter((a, i) => i > 0 || a.startsWith('--')));
  const print = r => { console.log(JSON.stringify(r, null, 1)); return r.ok === false || r.error ? 1 : 0; };
  if (sub === 'run') { const r = await run(demo); if (r.phase !== 'recording-ready') { console.error(r.error || 'not ready'); process.exit(1); } return new Promise(() => {}); }
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
