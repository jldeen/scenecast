// scenecast preflight: is everything ready to record? A fast check, item by item, that acts only on what fails and
// never relaunches a browser that's already running (the presenter's signed-in Edge or Chrome stays as it is).
//   receiver   up on the demo's port                          → starts it in the background
//   browser    Edge or Chrome running, with the demo's profile  → opens a window of that profile (or launches it if
//              (and the debugging port, for the agent recorder)    it isn't running at all); never restarts it
//   recorder   the extension (or agent) polling the receiver    → builds the extension folder and says how to load it
//   apps       each app's tab open, light, on its start screen    → opens a missing tab, reloads one off its start
// Matches replica-kit's `replica preflight`. Under a minute when everything is set (each probe is bounded).
// preflight(demo, { fix, onItem }) is the library call (the desktop app shows each item as it lands).
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from 'node:net';
import { KIT } from './demo.mjs';
import { defaultBrowser, profileRoot, launchCommand, windowsBrowser } from '../../player/launch.mjs';
import { listProfiles, pickProfile, extensionDir, OLD_EXTENSION_DIR } from './profiles.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const BIN = { darwin: { chrome: /\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome( |$)/, edge: /\/Microsoft Edge\.app\/Contents\/MacOS\/Microsoft Edge( |$)/ }, win32: { chrome: /\\chrome\.exe"?( |$)/i, edge: /\\msedge\.exe"?( |$)/i } };

// The browser's main processes (not its renderers and helpers), from `ps` or Win32_Process command lines.
export function parseProcs(text, platform = process.platform) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line); if (!m) continue;
    const cmd = m[2];
    if (/ --type=/.test(cmd)) continue;
    const browser = Object.entries(BIN[platform] || {}).find(([, re]) => re.test(cmd));
    if (!browser) continue;
    // ps doesn't quote: an unquoted value runs to the next flag (--profile-directory=Profile 10 --…).
    const flag = k => { const f = new RegExp(`--${k}=("([^"]*)"|(.*?))(?= --|$)`).exec(cmd); return f ? (f[2] !== undefined ? f[2] : f[3].trim()) : null; };
    out.push({ pid: +m[1], browser: browser[0], userDataDir: flag('user-data-dir'), profile: flag('profile-directory'), debugPort: flag('remote-debugging-port') && +flag('remote-debugging-port') });
  }
  return out;
}
function listProcs() {
  return new Promise(res => {
    if (process.platform === 'win32') {
      const ps = "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='msedge.exe'\" | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }";
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 15000, maxBuffer: 1 << 24 }, (e, so) => res(parseProcs(so || '', 'win32')));
    } else execFile('ps', ['-axww', '-o', 'pid=,args='], { timeout: 10000, maxBuffer: 1 << 24 }, (e, so) => res(parseProcs(so || '', process.platform)));
  });
}
// Which profiles a running browser has open: its Local State (written as it runs).
export function openProfiles(userDataDir) {
  try { const s = JSON.parse(readFileSync(join(userDataDir, 'Local State'), 'utf8')); return (s.profile && s.profile.last_active_profiles) || []; } catch (e) { return null; }
}
// The browser for this demo, and whether the one running is it: same browser, same user data folder, the demo's
// profile open, and the debugging port when the recorder needs one.
export function judgeBrowser(procs, want) {
  const mine = procs.filter(p => p.browser === want.browser && (p.userDataDir || want.defaultDir) === want.userDataDir);
  if (!mine.length) return { running: false };
  const p = mine[0];
  return { running: true, pid: p.pid, debugPort: p.debugPort, needsPort: !!want.debugPort && !mine.some(x => x.debugPort === want.debugPort) };
}

async function ping(port, ms = 1500) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { return await (await fetch(`http://127.0.0.1:${port}/ping`, { signal: ac.signal })).json(); } catch (e) { return null; } finally { clearTimeout(t); }
}
// Whether anything is listening on the port: refused at once when nothing is, whatever the machine's load.
function listening(port) {
  return new Promise(res => { const c = connect(port, '127.0.0.1'); c.once('connect', () => { c.destroy(); res(true); }); c.once('error', () => res(false)); });
}
// Opens url in a window of `profile` in the browser, running or not: a running one gets a new window (the command
// line is handed to it), never a restart.
export async function openInBrowser(url, { browser, profile }) {
  // Tests set REPLICA_NO_OPEN: the browser on the machine running them is never touched.
  if (process.env.REPLICA_NO_OPEN) return false;
  const executable = process.platform === 'win32' ? await windowsBrowser(browser) : undefined;
  const c = launchCommand(url, { browser, profile, executable });
  if (!c) return false;
  c[1] = c[1].map(a => a.startsWith('--app=') ? a.slice(6) : a);
  await new Promise(r => execFile(c[0], c[1], { windowsVerbatimArguments: process.platform === 'win32' }, () => r()));
  return true;
}
// The demo's own choice of profile (demo.json chrome.profile), not the default filled in.
function chosenProfile(demo) {
  try { return (JSON.parse(readFileSync(join(demo.dir, 'demo.json'), 'utf8')).chrome || {}).profile || null; } catch (e) { return null; }
}
// The browser's profiles, and the one this demo records in.
export async function demoProfiles(demo, { pictures = true } = {}) {
  const browser = demo.cfg.chrome.browser || defaultBrowser();
  const userDataDir = demo.cfg.chrome.userDataDir || profileRoot(browser);
  const procs = (await listProcs()).filter(p => p.browser === browser && (p.userDataDir || profileRoot(browser)) === userDataDir);
  const profiles = listProfiles(userDataDir, { openDirs: procs.map(p => p.profile).filter(Boolean), pictures });
  const chosen = chosenProfile(demo);
  return { browser, userDataDir, running: procs.length > 0, chosen, pick: pickProfile(profiles, chosen), profiles };
}
async function op(port, cmd, tmoS) {
  const { send } = await import('../../recorder/cli.mjs');
  return send(cmd, tmoS, port);
}

// Why the recorder isn't connected, in plain words, from what the browser's own files say.
export function recorderAdvice({ browser, profile, named, known, other, dir }) {
  const B = browser === 'edge' ? 'Edge' : 'Chrome', page = `${browser}://extensions`;
  const p = known && known.profiles.find(x => x.dir === profile);
  const elsewhere = known && known.profiles.filter(x => x.recorder && x.dir !== profile);
  if (known && !known.running) return `${B} isn't running: open it (profile ${named}), and the recorder connects by itself`;
  if (p && p.recorder && p.recorderOff) return `the recorder is loaded in profile ${named} but turned off: in ${page}, switch Scenecast Recorder on`;
  if (p && p.recorder) return `the recorder is loaded in profile ${named} but isn't answering: in ${page}, click Scenecast Recorder's reload button (↻)`;
  if (elsewhere && elsewhere.length) return `the recorder is loaded in profile "${elsewhere[0].name}", not ${named}: record in "${elsewhere[0].name}" (pick it above), or load it in ${named} too`;
  if (other) return `the recorder is loaded in ${other === 'edge' ? 'Edge' : 'Chrome'}, but this demo records in ${B}: switch the demo to ${other === 'edge' ? 'Edge' : 'Chrome'}, or load it in ${B} too`;
  if (p && p.devMode === false) return `the recorder isn't loaded in ${B} (profile ${named}), and Developer mode is off there: use Install recorder, turn on Developer mode in ${page}, then drag in the folder ${dir}`;
  return `the recorder isn't loaded in ${B} (profile ${named}): use Install recorder, or in ${page} choose Load unpacked → ${dir}`;
}
async function otherBrowserHasIt(browser) {
  const other = browser === 'edge' ? 'chrome' : 'edge';
  try { return listProfiles(profileRoot(other), { pictures: false }).some(p => p.recorder) ? other : null; } catch (e) { return null; }
}

export async function preflight(demo, { fix = true, onItem = () => {}, waitAgentS = 25 } = {}) {
  const t0 = Date.now(), cfg = demo.cfg, port = +(process.env.REPLICA_RX_PORT || cfg.receiverPort);
  const recorder = cfg.recorder === 'agent' ? 'agent' : 'extension';
  const items = [];
  const item = async (id, fn) => {
    const t = Date.now(); let r;
    try { r = await fn(); } catch (e) { r = { status: 'fail', detail: String(e.message || e) }; }
    r = { id, ...r, ms: Date.now() - t }; items.push(r); onItem(r); return r;
  };

  // Receiver: the recorder posts to it.
  // A receiver slow to answer (a loaded machine, the recorder sending it a capture) is still running: one is started
  // only when nothing is listening on its port, never because a ping took too long.
  let up = await ping(port, 800);
  if (!up && await listening(port)) up = await ping(port, 10000);
  let started = false;
  await item('receiver', async () => {
    if (up) return { status: 'ok', detail: `up on ${port} → ${up.raw}` };
    if (await listening(port)) return { status: 'fail', detail: `something on ${port} isn't answering as a receiver: stop it, or set another receiverPort in demo.json` };
    if (!fix) return { status: 'fail', detail: `nothing on ${port}: run scenecast receiver` };
    const k = spawn(process.execPath, [join(KIT, 'recorder', 'receiver.mjs'), '--demo', demo.dir], { detached: true, stdio: 'ignore', env: { ...process.env, REPLICA_RX_PORT: String(port) } });
    k.unref();
    for (let i = 0; i < 20 && !up; i++) { await sleep(250); up = await ping(port, 500); }
    started = !!up;
    return up ? { status: 'fixed', detail: `started on ${port} (pid ${k.pid})` } : { status: 'fail', detail: `couldn't start a receiver on ${port}` };
  });

  // Recorder connected? Then the browser is running, whatever it's called: nothing to look at there.
  const connected = p => p && p.agent && (p.agent.polling || (p.agent.secsAgo !== null && p.agent.secsAgo < 30));
  const browser = cfg.chrome.browser || defaultBrowser();
  const userDataDir = cfg.chrome.userDataDir || profileRoot(browser);
  const known = await demoProfiles(demo, { pictures: false }).catch(() => null);
  const profile = known ? known.pick.dir : (cfg.chrome.profile || 'Default');
  const profileName = (known && (known.profiles.find(p => p.dir === profile) || {}).name) || profile;
  const named = profileName === profile ? `"${profile}"` : `"${profileName}" (${profile})`;
  await item('browser', async () => {
    // A receiver just started: a recorder already running in the browser connects on its next try (every 2 s). Give
    // it that, so a browser that's open isn't taken for one that isn't.
    if (started && recorder === 'extension') for (let i = 0; i < 12 && !connected(up); i++) { await sleep(500); up = (await ping(port, 1500)) || up; }
    if (connected(up) && recorder === 'extension') return { status: 'ok', detail: 'the recorder extension is connected, so the browser is running (not touched)' };
    const procs = await listProcs();
    const b = judgeBrowser(procs, { browser, userDataDir, defaultDir: profileRoot(browser), debugPort: recorder === 'agent' ? cfg.chrome.debugPort || 9222 : null });
    const open = b.running ? openProfiles(userDataDir) : null;
    const urls = cfg.apps.map(a => a.url).filter(Boolean);
    if (b.running) {
      // Never relaunched: a running browser with the wrong flags is the presenter's call.
      if (b.needsPort) return { status: 'fail', detail: `${browser} is running (pid ${b.pid}) without --remote-debugging-port=${cfg.chrome.debugPort || 9222}; the agent recorder needs it. Not restarting it: quit ${browser} yourself, or record with the extension (demo.json recorder: "extension")` };
      const isOpen = (open && open.includes(profile)) || (known && known.profiles.some(p => p.dir === profile && p.open));
      if (open && !isOpen) {
        if (!fix) return { status: 'fail', detail: `${browser} is running, but profile ${named} isn't open` };
        await openInBrowser(urls[0] || 'about:blank', { browser, profile });
        return { status: 'fixed', detail: `${browser} is running; opened a window of profile ${named} in it (not relaunched)` };
      }
      return { status: 'ok', detail: `${browser} running (pid ${b.pid}${b.debugPort ? `, debugging port ${b.debugPort}` : ''}), profile ${named}${known ? ` (${known.pick.why})` : ''}: not relaunched` };
    }
    if (!fix) return { status: 'fail', detail: `${browser} isn't running` };
    if (process.env.REPLICA_NO_OPEN) return { status: 'fail', detail: `${browser} isn't running (not started: REPLICA_NO_OPEN)` };
    const executable = process.platform === 'win32' ? await windowsBrowser(browser) : undefined;
    const c = launchCommand(urls[0] || 'about:blank', { browser, profile, executable });
    if (!c) return { status: 'fail', detail: `start ${browser} with profile ${named} yourself` };
    c[1] = c[1].map(a => a.startsWith('--app=') ? a.slice(6) : a);
    if (recorder === 'agent') c[1].splice(c[1].length - 1, 0, `--remote-debugging-port=${cfg.chrome.debugPort || 9222}`);
    await new Promise(r => execFile(c[0], c[1], { windowsVerbatimArguments: process.platform === 'win32' }, () => r()));
    return { status: 'fixed', detail: `${browser} wasn't running: started it with profile ${named}` };
  });

  // The recorder: connected to the receiver (the extension retries every 2 s; give a fresh one a moment).
  const rec = await item('recorder', async () => {
    // A check only looks; a fix gives a recorder that's just been started (or a window just opened) time to connect.
    const waitS = fix ? waitAgentS : Math.min(waitAgentS, 4);
    for (let i = 0; i < waitS * 2 && !connected(up); i++) { await sleep(500); up = (await ping(port, 1500)) || up; }
    if (connected(up)) {
      const e = recorder === 'extension' ? await op(port, { op: 'extension' }, 8) : { ok: true };
      return { status: 'ok', detail: recorder === 'extension' && e.ok ? `extension ${e.value.version} connected` : `${recorder} connected` };
    }
    if (recorder === 'agent') return { status: 'fail', detail: 'no agent polling: run scenecast agent, then start it in the browser' };
    const dir = extensionDir();
    const ver = JSON.parse(readFileSync(join(KIT, 'recorder', 'package.json'), 'utf8')).version;
    const old = !process.env.SCENECAST_EXTENSION_DIR && existsSync(join(OLD_EXTENSION_DIR, 'manifest.json')) ? [OLD_EXTENSION_DIR] : [];
    for (const d of [dir, ...old]) {
      const have = existsSync(join(d, 'manifest.json')) && JSON.parse(readFileSync(join(d, 'manifest.json'), 'utf8')).version;
      if (fix && have !== ver) await new Promise(r => execFile(process.execPath, [join(KIT, 'recorder', 'build.mjs'), '--extension', d, '--port', String(cfg.receiverPort || port)], () => r()));
    }
    return { status: 'fail', detail: recorderAdvice({ browser, profile, named, known, other: await otherBrowserHasIt(browser), dir }) };
  });

  // Each app's tab: open, light, on its start screen. Only with the recorder there to look.
  if (rec.status === 'ok') {
    const r = await op(port, { op: 'preflight', apps: cfg.apps, fix, waitS: 20 }, 120);
    for (const a of cfg.apps) {
      const o = r.ok ? r.value[a.id] || {} : {};
      await item(`app ${a.id}`, async () => {
        if (!r.ok) return { status: 'fail', detail: r.error };
        if (o.missing) return { status: 'fail', detail: `no tab for ${a.id} (${a.match || a.url})${a.url ? '' : ': no url in demo.json to open'}` };
        if (o.r && o.r.error) return { status: 'fail', detail: o.r.error };
        if (o.light === false) return { status: 'fail', detail: `${a.id} reads dark: set its theme to Light (not System)` };
        if (o.onStart === false) return { status: 'fail', detail: `${a.id} isn't on its start screen (${o.r.url})` };
        return { status: o.fixed.length ? 'fixed' : 'ok', detail: `${o.r.url}${o.fixed.length ? ` (${o.fixed.join(', ')})` : ''}` };
      });
    }
  } else for (const a of cfg.apps) await item(`app ${a.id}`, async () => ({ status: 'skip', detail: 'needs the recorder connected' }));

  const secs = (Date.now() - t0) / 1000;
  return { ready: items.every(i => i.status === 'ok' || i.status === 'fixed'), secs: +secs.toFixed(1), items };
}

export async function main(args, loadDemo) {
  const demo = loadDemo(args);
  const json = args.includes('--json'), ndjson = args.includes('--ndjson');
  const mark = { ok: 'ok   ', fixed: 'FIXED', fail: 'FAIL ', skip: 'skip ' };
  // --ndjson: one JSON line per item as it lands, then the result (for the desktop app's live checklist).
  const r = await preflight(demo, { fix: !args.includes('--check'), onItem: ndjson ? i => console.log(JSON.stringify({ item: i })) : json ? undefined : i => console.log(`${mark[i.status]} ${i.id.padEnd(12)} ${i.detail}  (${(i.ms / 1000).toFixed(1)} s)`) });
  if (ndjson) console.log(JSON.stringify({ result: r }));
  else if (json) console.log(JSON.stringify(r, null, 1));
  else console.log(`${r.ready ? 'ready to record' : 'NOT READY: fix what FAIL says, then run scenecast preflight again'} (${r.secs} s)`);
  return r.ready ? 0 : 1;
}
