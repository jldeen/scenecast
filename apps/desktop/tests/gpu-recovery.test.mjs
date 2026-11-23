// The window recovery on a real Mac (CI's virtual Macs have no WebKit GPU process), with the window never shown: a test
// build of the app (built with its window hidden, its own library, Copilot folder, WebKit data and ports) started as
// its own launchd job, so the GPU processes WebKit starts for it are responsible to it and to nothing else.
//   1. stopped: its GPU process stopped (SIGSTOP) until WebKit gives up on it ("gpuProcessDidExit: PID=n"), as on
//      Nov 23; the app must end it and its web process, and the page load again.
//   2. alive, not stopped: stopped until WebKit gives up and macOS refuses its signal, then let go (SIGCONT): a
//      sleeping process WebKit thinks exited, as on Nov 22. The same.
// Only a GPU process named com.apple.WebKit.GPU, started after the app and responsible to the app's own process is
// ever signalled; if a GPU process started since is responsible to anything else, nothing is signalled and it fails.
//   node apps/desktop/tests/gpu-recovery.test.mjs <test build (cargo build --features webdriver, window hidden)>
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { remote } from 'webdriverio';

if (process.platform !== 'darwin') { console.log('macOS only'); process.exit(0); }
const BIN = resolve(process.argv[2] || '');
if (!existsSync(BIN)) { console.log('usage: gpu-recovery.test.mjs <test build>'); process.exit(2); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fails = [];
const check = (name, ok, detail) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? `: ${String(detail).slice(0, 1500)}` : '')); if (!ok) fails.push(name); return ok; };
const tmp = mkdtempSync(join(tmpdir(), 'scenecast-gpu-'));
const LABEL = `com.github.jldeen.scenecast.gpu-test.${process.pid}`, WD = 4467;
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });

// pid, state, start (s since 1970), responsible pid, name: for every WebKit GPU process.
function gpus() {
  const out = sh('python3', ['-c', `
import ctypes, subprocess, json
lib = ctypes.CDLL(None); f = lib.responsibility_get_pid_responsible_for_pid; f.argtypes = [ctypes.c_int]; f.restype = ctypes.c_int
rows = []
for l in subprocess.run(['ps', '-axo', 'pid=,stat=,lstart=,comm='], capture_output=True, text=True).stdout.splitlines():
    p = l.split(None, 7)
    if len(p) < 8 or not p[7].endswith('com.apple.WebKit.GPU'): continue
    import time; t = time.mktime(time.strptime(' '.join(p[2:7]), '%a %b %d %H:%M:%S %Y'))
    rows.append({'pid': int(p[0]), 'stat': p[1], 'start': t, 'responsible': f(int(p[0])), 'name': 'com.apple.WebKit.GPU'})
print(json.dumps(rows))`]);
  return JSON.parse(out);
}
const responsible = pid => +sh('python3', ['-c', `import ctypes; l=ctypes.CDLL(None); f=l.responsibility_get_pid_responsible_for_pid; f.argtypes=[ctypes.c_int]; f.restype=ctypes.c_int; print(f(${pid}))`]).trim();
const started = pid => { const s = sh('ps', ['-o', 'lstart=', '-p', String(pid)]).trim(); return Date.parse(s) / 1000; };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

let b, appPid = 0;
const stoppedByUs = new Set();
try {
  for (const d of ['home', 'lib', 'ai', 'ext']) mkdirSync(join(tmp, d));
  const env = { CFFIXED_USER_HOME: join(tmp, 'home'), SCENECAST_LIBRARY: join(tmp, 'lib'), SCENECAST_AI_HOME: join(tmp, 'ai'), SCENECAST_EXTENSION_DIR: join(tmp, 'ext'), TAURI_WEBDRIVER_PORT: String(WD), REPLICA_RX_PORT: '47697', SCENECAST_AI_MODEL: 'stub', PATH: process.env.PATH };
  sh('launchctl', ['submit', '-l', LABEL, '-o', join(tmp, 'out.log'), '-e', join(tmp, 'err.log'), '--', '/usr/bin/env', ...Object.entries(env).map(([k, v]) => `${k}=${v}`), BIN]);
  for (let i = 0; i < 60 && !appPid; i++) { await sleep(500); try { appPid = +sh('pgrep', ['-f', `^${BIN}$`]).trim().split('\n')[0] || 0; } catch {} }
  check('the test build runs as its own launchd job', appPid > 0 && responsible(appPid) === appPid, `pid ${appPid}, responsible ${appPid && responsible(appPid)}`);
  const appStart = started(appPid);
  for (let t0 = Date.now(); !b && Date.now() - t0 < 90000;) { try { b = await remote({ hostname: '127.0.0.1', port: WD, logLevel: 'error', connectionRetryCount: 0, capabilities: { browserName: 'tauri' } }); } catch { await sleep(1000); } }
  let up = false;
  for (let i = 0; i < 60 && b && !up; i++) { up = await b.execute(() => !!document.querySelector('[data-test]')).catch(() => false); if (!up) await sleep(500); }
  check('its window answers (never shown)', up);
  // Work that needs the GPU process: a canvas drawn every frame, and the page's own changes.
  const work = () => b.execute(() => { if (window.__work) return; const c = document.createElement('canvas'); c.width = c.height = 512; c.style.cssText = 'position:fixed;left:0;top:0;opacity:.01;pointer-events:none'; document.body.appendChild(c); const g = c.getContext('2d'); let n = 0; window.__work = setInterval(() => { g.fillStyle = `hsl(${n++ % 360},50%,50%)`; g.fillRect(0, 0, 512, 512); c.style.transform = `translateX(${n % 2}px)`; }, 16); }).catch(() => {});
  await work();
  const mine = async () => {
    for (let i = 0; i < 40; i++) {
      const all = gpus().filter(g => g.start >= appStart - 1);
      const others = all.filter(g => g.responsible !== appPid);
      if (others.length) return { others };
      const ours = all.filter(g => g.responsible === appPid && alive(g.pid));
      if (ours.length) return { ours };
      await sleep(500);
    }
    return { ours: [] };
  };
  for (const [kind, letGo] of [['stopped', false], ['alive, not stopped (Nov 22)', true]]) {
    const m = await mine();
    if (m.others) { check(`${kind}: only the app's GPU processes are candidates`, false, `responsible to another process, nothing signalled: ${JSON.stringify(m.others)}`); break; }
    if (!m.ours.length) { check(`${kind}: WebKit started a GPU process for the hidden window`, false, JSON.stringify(gpus().filter(g => g.start >= appStart - 1))); break; }
    const target = m.ours[0];
    console.log(`${kind}: target ${JSON.stringify(target)} (app ${appPid})`);
    await b.execute(() => { window.__before = 1; });
    const t0 = Date.now();
    // The app's log as it happens: the moment macOS refuses WebKit's signal, the process is let go (case 2).
    const stream = spawn('log', ['stream', '--style', 'compact', '--predicate', `processID == ${appPid} AND (eventMessage CONTAINS "Could not signal service com.apple.WebKit.GPU" OR eventMessage CONTAINS "gpuProcessDidExit")`]);
    let refusedAt = 0, exitedAt = 0, letGoState = '';
    stream.stdout.on('data', d => {
      const t = String(d);
      if (!exitedAt && t.includes(`gpuProcessDidExit: PID=${target.pid}`)) exitedAt = Date.now();
      if (!refusedAt && t.includes('Could not signal service')) {
        refusedAt = Date.now();
        if (letGo && alive(target.pid)) { process.kill(target.pid, 'SIGCONT'); stoppedByUs.delete(target.pid); letGoState = sh('ps', ['-o', 'pid=,stat=', '-p', String(target.pid)]).trim(); }
      }
    });
    await sleep(1500);
    process.kill(target.pid, 'SIGSTOP'); stoppedByUs.add(target.pid);
    for (let i = 0; i < 60 && !exitedAt; i++) { await sleep(1000); await work(); }
    const gaveUp = exitedAt ? Math.round((exitedAt - t0) / 1000) : 0;
    console.log(`  WebKit gave up after ${gaveUp} s; macOS refused its signal: ${!!refusedAt}${letGo ? `; let go right then: ${letGoState || 'not running'}` : ''}`);
    check(`${kind}: WebKit gives up on it${letGo ? ', and it runs on (asleep, not stopped)' : ''}`, !!exitedAt && (!letGo || /^\d+\s+S/.test(letGoState)), JSON.stringify({ exitedAt, refusedAt, letGoState }));
    let back = false;
    for (let i = 0; i < 60 && !back; i++) { await sleep(1000); back = await b.execute(() => window.__before !== 1 && !!document.querySelector('[data-test]')).catch(() => false); }
    const said = readFileSync(join(tmp, 'err.log'), 'utf8').split('\n').filter(l => /gpu-watch/.test(l)).slice(-1)[0] || '';
    console.log(`  the app: ${said}`);
    check(`${kind}: the app ends it and its web process, and the page loads again (${Math.round((Date.now() - t0) / 1000)} s)`, back && !alive(target.pid) && said.includes(String(target.pid)), JSON.stringify({ back, alive: alive(target.pid), said }));
    stoppedByUs.delete(target.pid);
    stream.kill();
    await work();
  }
} catch (e) {
  check('ran', false, e.stack || e);
} finally {
  for (const pid of stoppedByUs) if (alive(pid)) try { process.kill(pid, 'SIGCONT'); } catch {}
  await b?.deleteSession().catch(() => {});
  try { sh('launchctl', ['remove', LABEL]); } catch {}
  for (let i = 0; i < 20 && appPid && alive(appPid); i++) await sleep(250);
  const left = gpus().filter(g => /T/.test(g.stat));
  check('nothing left stopped, the test build gone', !left.length && !(appPid && alive(appPid)), JSON.stringify({ stopped: left, app: appPid && alive(appPid) }));
  if (!process.env.SCENECAST_KEEP) rmSync(tmp, { recursive: true, force: true });
}
console.log(fails.length ? `${fails.length} FAILED` : 'ALL PASS');
process.exit(fails.length ? 1 : 0);
