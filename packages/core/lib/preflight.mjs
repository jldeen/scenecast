// scenecast preflight: is everything ready to record? A fast check, item by item, that acts only on what fails and
// never relaunches a browser that's already running (the presenter's signed-in Edge or Chrome stays as it is).
//   receiver   up on the demo's port                          → starts it in the background
//   browser    Edge or Chrome running, with the demo's profile  → opens a window of that profile (or launches it if
//              (and the debugging port, for the agent recorder)    it isn't running at all); never restarts it
//   recorder   the extension (or agent) polling the receiver    → builds the extension folder and says how to load it
//   apps       each app's tab open (light or dark), on its start screen    → opens a missing tab, reloads one off its start
//              screen (or runs demo.json preflight.prep); with preflight.theme, a tab in the other theme fails
//   reset      demo.json preflight.reset: the demo's own check that all is as the show starts → runs preflight.resetFix
//   dock       macOS: where the Dock is and whether it hides (said, never a failure)
// Matches replica-kit's `replica preflight`. Under a minute when everything is set (each probe is bounded).
// preflight(demo, { fix, onItem }) is the library call (the desktop app shows each item as it lands).
import { at as __at } from './at.mjs';
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from 'node:net';
import { defaultBrowser, profileRoot, openInBrowser, chosenProfile } from '@stuntdouble/player/launch.mjs';
import { parseProcs, listProcs, openProfiles, browserProfiles, extensionDir } from './profiles.mjs';

export { parseProcs, openProfiles };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const NAME = { chrome: 'Chrome', edge: 'Edge' };
const PAGE = { chrome: 'chrome://extensions', edge: 'edge://extensions' };

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
async function op(port, cmd, tmoS) {
  const { send } = await import('@stuntdouble/capture/cli.mjs');
  return send(cmd, tmoS, port);
}
// A capture script of the demo's, run in the recorder as `stunt run` runs it (ARGS.apps): its value, or { error }.
async function runScript(port, file, extra, tmoS) {
  const { send, flowScript } = await import('@stuntdouble/capture/cli.mjs');
  const r = await send(flowScript(file, extra), tmoS, port);
  return r.ok ? r.value : { error: r.error };
}

// demo.json preflight.reset: the demo's check that everything is as the show starts ({ ok, detail }). When it isn't,
// preflight.resetFix (the demo's reset) runs, then the check again. run(file, seconds) runs one of the demo's scripts.
export async function checkReset(P, run, fix) {
  const said = v => String((v && (v.detail || v.error)) || '').slice(0, 300);
  let v = await run(P.reset, 120);
  if (v && v.ok) return { status: 'ok', detail: said(v) || 'as the show starts' };
  if (!fix || !P.resetFix) return { status: 'fail', detail: `${said(v) || 'not as the show starts'}: ${P.resetFix ? 'Fix runs ' + P.resetFix : "run the demo's reset"}` };
  const f = await run(P.resetFix, 900);
  v = await run(P.reset, 120);
  if (v && v.ok) return { status: 'fixed', detail: `ran ${P.resetFix}: ${said(v) || 'as the show starts'}` };
  return { status: 'fail', detail: `${P.resetFix} ran${f && f.error ? ` (${said(f)})` : ''}, and it still isn't as the show starts (${said(v) || 'no detail'}): run the demo's reset by hand` };
}
// The Dock (macOS): an app bouncing for attention peeks out of a hidden one, into a full-screen recording.
function dockNote() {
  const read = k => new Promise(res => execFile('defaults', ['read', 'com.apple.dock', k], { timeout: 5000 }, (e, out) => res(e ? '' : String(out).trim())));
  return Promise.all([read('autohide'), read('orientation')]).then(([hide, side]) => {
    side = side || 'bottom';
    return hide === '1'
      ? `auto-hidden on the ${side}: an app that bounces for attention peeks out of a full-screen recording, and macOS doesn't say which will. If one bounces, bring it to the front once`
      : `always shown on the ${side}: a full-screen browser hides it`;
  });
}

// The capture browser: running (or started by Fix), and signed in to every app; when a sign-in ran out, the fix is
// hers: Sign in again opens its one window on her screen.
async function captureBrowserItem(demo, fix) {
  const host = await import('@stuntdouble/capture/host.mjs');
  let s = host.hostState(demo);
  const was = s && s.alive;
  if (!was) {
    if (!fix) return { status: 'fail', detail: "the capture browser isn't running: Fix starts it (stunt capture start)" };
    s = await host.start(demo);
    if (!s.ok) return { status: 'fail', detail: `couldn't start the capture browser: ${s.error}` };
  }
  if (s.signIn && s.signIn.length) return { status: 'fail', detail: `the capture browser isn't signed in to ${s.signIn.join(', ')}: Sign in again (stunt capture sign-in) opens its window on your screen`, signIn: s.signIn };
  const how = `${s.mode} windows${s.fellBack && s.fellBack.to ? ` (${s.fellBack.from} ones didn't draw here: ${s.fellBack.why})` : ''}`;
  return { status: was ? 'ok' : 'fixed', detail: `${was ? 'capture browser running' : 'started the capture browser'}: ${how}, profile ${s.profile}` };
}

// An app now found at another host (its address redirects there): kept as its match in demo.json, so Record and the
// next check find the tab by it.
// An app that moved (its address redirects to another host): its new host is how its tab is found, and its new
// address where it starts, so the next check finds it there and doesn't send it through the redirect again.
export function keepMatch(demo, id, host, url) {
  const file = join(demo.dir, 'demo.json');
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  const app = (cfg.apps || []).find(a => a.id === id);
  if (!app || !host || app.match === host) return false;
  app.match = host;
  if (url) app.url = url;
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  const mine = demo.cfg.apps.find(a => a.id === id); if (mine) { mine.match = host; if (url) mine.url = url; }
  return true;
}

// Before recording: the recorder connected and running this app's version. One the browser still runs from before an
// update is reloaded (it can do that itself); when it can't, the answer says to. { ok, version } or { error }.
export async function recorderReady(demo, { waitS = 6 } = {}) {
  const cfg = demo.cfg, port = +(process.env.REPLICA_RX_PORT || cfg.receiverPort);
  // The agent, and the capture browser's recorder, are built from this engine as they start: always this version.
  if (cfg.recorder === 'agent' || cfg.recorder === 'capture') return { ok: true };
  const browser = (cfg.chrome && cfg.chrome.browser) || defaultBrowser(), bname = NAME[browser] || browser, page = PAGE[browser];
  const ver = JSON.parse(readFileSync(__at('capture', 'package.json'), 'utf8')).version;
  // Polling, or working on a command (another check's): either way it's there.
  const connected = p => p && p.agent && (p.agent.polling || p.agent.busy || (p.agent.secsAgo !== null && p.agent.secsAgo < 30));
  let up = await ping(port, 1500);
  for (let i = 0; i < waitS * 2 && !connected(up); i++) { await sleep(500); up = await ping(port, 1500); }
  if (!up) return { error: `The receiver isn't running on port ${port}. Run Check, then start again.` };
  if (!connected(up)) return { error: `The recorder isn't connected. Open ${bname} with the recorder in it (Install recorder shows how), then start again.` };
  // A recorder that just restarted (reloaded, or Chrome woke it) still counts as connected for a moment while it
  // isn't answering yet: ask again for a while before calling it old.
  const version = async () => { for (let i = 0; i < 4; i++) { const e = await op(port, { op: 'extension' }, 6); if (e.ok && e.value) return e.value.version || null; await sleep(1000); } return null; };
  const have = await version();
  if (have === ver) return { ok: true, version: have };
  const r = await op(port, { op: 'reload' }, 5);
  if (r.ok) for (let i = 0; i < 30; i++) { await sleep(500); if (connected(await ping(port, 1500)) && await version() === ver) return { ok: true, version: ver, reloaded: have || 'unknown' }; }
  return { error: `Reload the recorder extension: ${bname} is running recorder ${have || '(an old one)'}, and this app's is ${ver}. At ${page}, click Reload (↻) on Scenecast Recorder (and Remove any other Scenecast Recorder there), then start again.`, version: have, want: ver };
}

export async function preflight(demo, { fix = true, onItem = () => {}, waitAgentS = fix ? 20 : 6 } = {}) {
  const t0 = Date.now(), cfg = demo.cfg, port = +(process.env.REPLICA_RX_PORT || cfg.receiverPort);
  const P = cfg.preflight || {};
  const recorder = cfg.recorder === 'agent' || cfg.recorder === 'capture' ? cfg.recorder : 'extension';
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
    const k = spawn(process.execPath, [__at('capture', 'receiver.mjs'), '--demo', demo.dir], { detached: true, stdio: 'ignore', env: { ...process.env, REPLICA_RX_PORT: String(port) } });
    k.unref();
    for (let i = 0; i < 20 && !up; i++) { await sleep(250); up = await ping(port, 500); }
    started = !!up;
    return up ? { status: 'fixed', detail: `started on ${port} (pid ${k.pid})` } : { status: 'fail', detail: `couldn't start a receiver on ${port}` };
  });

  // Recorder connected? Then the browser is running, whatever it's called: nothing to look at there.
  // Polling, or working on a command (another check's): either way it's there.
  const connected = p => p && p.agent && (p.agent.polling || p.agent.busy || (p.agent.secsAgo !== null && p.agent.secsAgo < 30));
  const browser = cfg.chrome.browser || defaultBrowser();
  const bname = NAME[browser] || browser;
  const userDataDir = cfg.chrome.userDataDir || profileRoot(browser);
  const extDir = extensionDir();
  const chosen = chosenProfile(cfg.chrome);
  let procs = null, info = null, profile = chosen;
  const look = async () => {
    procs = await listProcs();
    info = await browserProfiles({ browser, userDataDir: cfg.chrome.userDataDir, procs, preferred: chosen, pictures: false });
    profile = chosen || info.picked;
  };
  const label = dir => { const p = info && info.profiles.find(x => x.dir === dir); return p && p.name !== dir ? `"${p.name}" (${dir})` : `"${dir}"`; };
  await item('browser', async () => {
    // The capture browser (opt-in): the engine's own Chrome, its own profile, off the screen. Nothing of hers.
    if (recorder === 'capture') return captureBrowserItem(demo, fix);
    // A receiver just started: a recorder already running in the browser connects on its next try (every 2 s). Give
    // it that, so a browser that's open isn't taken for one that isn't.
    // Not connected right now: it may be reconnecting (the browser restarted its worker, the receiver just changed
    // demo); it looks every 2 s. Give it 10 s before calling the browser closed.
    if (recorder === 'extension') for (let i = 0; i < 20 && !connected(up); i++) { await sleep(500); up = (await ping(port, 1500)) || up; }
    await look();
    const open = info.running ? info.profiles.filter(p => p.open).map(p => p.dir) : [];
    // The demo names a profile that isn't open: only then is a connected recorder not enough.
    const wantOpen = chosen && info.running && !open.includes(chosen);
    if (connected(up) && recorder === 'extension' && !wantOpen) return { status: 'ok', detail: `the recorder is connected, so ${bname} is running${info.running && profile ? `, profile ${label(profile)}` : ''} (not touched)`, profile: info.running ? profile : null };
    const b = judgeBrowser(procs, { browser, userDataDir, defaultDir: profileRoot(browser), debugPort: recorder === 'agent' ? cfg.chrome.debugPort || 9222 : null });
    const urls = cfg.apps.map(a => a.url).filter(Boolean);
    if (b.running) {
      // Never relaunched: a running browser with the wrong flags is the presenter's call.
      if (b.needsPort) return { status: 'fail', detail: `${browser} is running (pid ${b.pid}) without --remote-debugging-port=${cfg.chrome.debugPort || 9222}; the agent recorder needs it. Not restarting it: quit ${browser} yourself, or record with the extension (demo.json recorder: "extension")` };
      if (!open.includes(profile)) {
        if (!fix) return { status: 'fail', detail: `${bname} is open, but not with profile ${label(profile)}${open.length ? ` (open: ${open.map(label).join(', ')})` : ''}. Fix opens a window for it, or pick the profile you use above`, profile };
        const r = await openInBrowser(urls.length ? urls[0] : 'about:blank', { browser, profile, userDataDir: cfg.chrome.userDataDir });
        return r.ok ? { status: 'fixed', detail: `${bname} is running; opened a window for profile ${label(profile)} in it (nothing closed or restarted)`, profile } : { status: 'fail', detail: `couldn't open a window for profile ${label(profile)}: ${r.error}`, profile };
      }
      return { status: 'ok', detail: `${bname} running (pid ${b.pid}${b.debugPort ? `, debugging port ${b.debugPort}` : ''}), profile ${label(profile)} open: not relaunched`, profile };
    }
    if (!fix) return { status: 'fail', detail: `${bname} isn't running`, profile };
    if (recorder === 'agent') {
      const r = await openInBrowser([`--remote-debugging-port=${cfg.chrome.debugPort || 9222}`, urls[0] || 'about:blank'], { browser, profile, userDataDir: cfg.chrome.userDataDir });
      return r.ok ? { status: 'fixed', detail: `${bname} wasn't running: started it with profile ${label(profile)}`, profile } : { status: 'fail', detail: `start ${bname} with profile ${label(profile)} yourself (${r.error})`, profile };
    }
    const r = await openInBrowser(urls[0] || 'about:blank', { browser, profile, userDataDir: cfg.chrome.userDataDir });
    return r.ok ? { status: 'fixed', detail: `${bname} wasn't running: started it with profile ${label(profile)}`, profile } : { status: 'fail', detail: `start ${bname} with profile ${label(profile)} yourself (${r.error})`, profile };
  });

  // The recorder: connected to the receiver (the extension looks for it every 2 s; give a fresh one a moment).
  const ver = JSON.parse(readFileSync(__at('capture', 'package.json'), 'utf8')).version;
  const rec = await item('recorder', async () => {
    for (let i = 0; i < waitAgentS * 2 && !connected(up); i++) { await sleep(500); up = (await ping(port, 1500)) || up; }
    if (connected(up)) {
      if (recorder !== 'extension') return { status: 'ok', detail: `${recorder} connected` };
      // More than one browser has the recorder connected to this receiver: it records in the first; say so, plainly.
      const more = (up.agent.others || []);
      if (more.length) return { status: 'fail', detail: `the recorder is in more than one browser window or profile: it records in ${up.agent.browser || 'the first'} (${up.agent.tabs} tabs), and ${more.map(o => `${o.browser || 'another'} (${o.tabs} tabs)`).join(', ')} also has it. Remove the recorder from the one you don't record in (at ${PAGE[browser]}), or close that browser, then check again`, others: more };
      const e = await op(port, { op: 'extension' }, 8);
      const have = e.ok && e.value ? e.value.version : null;
      if (have && have !== ver) {
        // Its files were updated (the app keeps the folder current): it needs a reload, which it can do itself.
        if (!fix) return { status: 'fail', detail: `the recorder in ${bname} is ${have}; this app's is ${ver}. Fix reloads it (or click Reload (↻) on Scenecast Recorder at ${PAGE[browser]})`, version: have };
        const r = await op(port, { op: 'reload' }, 5);
        for (let i = 0; i < 30; i++) { await sleep(500); const p = await ping(port, 1500); if (connected(p)) { const e2 = await op(port, { op: 'extension' }, 8); if (e2.ok && e2.value.version === ver) return { status: 'fixed', detail: `reloaded the recorder: ${have} → ${ver}`, version: ver }; } }
        // The same words as Record's own version check (recorderReady), so the app shows the same fix for both.
        return { status: 'fail', detail: `Reload the recorder extension: ${bname} is running recorder ${have}, and this app's is ${ver}${r.ok ? '' : ' (it can\u2019t reload itself)'}. At ${PAGE[browser]}, click Reload (↻) on Scenecast Recorder`, version: have };
      }
      return { status: 'ok', detail: `extension ${have || ''} connected`.replace('  ', ' '), version: have };
    }
    if (recorder === 'agent') return { status: 'fail', detail: 'no agent polling: run scenecast agent, then start it in the browser' };
    if (recorder === 'capture') return { status: 'fail', detail: "the capture browser's recorder isn't polling: stunt capture status says why" };
    const m = existsSync(join(extDir, 'manifest.json')) && JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
    const have = m && (m.version_name || m.version);
    if (fix && have !== ver) await new Promise(r => execFile(process.execPath, [__at('capture', 'build.mjs'), '--extension', extDir, '--port', String(port)], () => r()));
    if (!info) await look();
    return { status: 'fail', detail: recorderAdvice({ info, profile, browser, extDir, other: await browserProfiles({ browser: browser === 'edge' ? 'chrome' : 'edge', procs, pictures: false }).catch(() => null) }), extensionDir: extDir };
  });

  // Each app's tab: open, on its start screen (its theme said, never a reason to stop). Only with the recorder there to look.
  if (rec.status === 'ok') {
    // Each app it opens can take up to a minute (load, its start screen, marking the tab): the wait grows with them.
    // Apps load side by side now: the wait is the slowest one's, not their sum.
    // A demo whose start screens need more than loading the app's address (a channel to open) has its own prep script
    // (demo.json preflight.prep): it runs instead of the reload, when a tab is missing or off its start screen.
    const look = f => op(port, { op: 'preflight', apps: cfg.apps, fix: f, waitS: 20, light: cfg.theme !== 'dark' }, f ? Math.max(120, 110 + 10 * cfg.apps.length) : 120);
    let r = await look(fix && !P.prep);
    const prepped = new Set(fix && P.prep && r.ok ? cfg.apps.filter(a => { const o = r.value[a.id] || {}; return o.missing || o.onStart === false; }).map(a => a.id) : []);
    if (prepped.size) {
      await runScript(port, join(demo.dir, P.prep), { apps: cfg.apps }, 300);
      r = await look(false);
    }
    const tabs = r.ok ? r.value._tabs : undefined;
    for (const a of cfg.apps) {
      const o = r.ok ? r.value[a.id] || {} : {};
      await item(`app ${a.id}`, async () => {
        if (!r.ok) return { status: 'fail', detail: r.error };
        // Not found, and nothing to open (or it didn't open): which of the open tabs is it? The app asks.
        if (o.missing) return { status: 'fail', detail: `no tab for ${a.id} (${a.match || a.url})${a.url ? '' : ': no url in demo.json to open'}`, missing: true, tabs };
        if (o.signIn) return { status: 'fail', detail: `${a.id} opened a sign-in page (${o.signIn}): sign in to it in that tab, then check again`, signIn: o.signIn };
        if (o.moved) {
          const kept = fix && keepMatch(demo, a.id, o.moved.host, o.moved.url);
          o.fixed.push(`it lives at ${o.moved.host} now${kept ? ', kept in demo.json' : ''}`);
        }
        if (o.r && o.r.error) return { status: 'fail', detail: o.r.error };
        if (o.onStart === false) return { status: 'fail', detail: `${a.id} isn't on its start screen (${o.r.url})${prepped.has(a.id) ? `: ${P.prep} didn't get it there` : ''}` };
        // Light or dark both record; demo.json "theme" only adds a word when a tab doesn't match it. preflight.theme
        // (replica-kit's light check) makes it a must: a tab in the other theme fails until its app is set to it.
        const theme = o.light === false ? 'dark' : o.light === true ? 'light' : null;
        if (P.theme && theme && theme !== P.theme) return { status: 'fail', detail: `${a.id} reads ${theme}: set ${a.title || a.id}'s theme to ${P.theme === 'dark' ? 'Dark' : 'Light'} (not System) in its settings, then check again`, theme };
        if (prepped.has(a.id)) o.fixed.push(`ran ${P.prep}`);
        const off = cfg.theme && theme && theme !== cfg.theme ? `; reads ${theme}, the demo's theme is ${cfg.theme}` : '';
        return { status: o.fixed.length ? 'fixed' : 'ok', detail: `${o.r.url}${o.fixed.length ? ` (${o.fixed.join(', ')})` : ''}${theme ? ` · ${theme}` : ''}${off}` };
      });
    }
  } else for (const a of cfg.apps) await item(`app ${a.id}`, async () => ({ status: 'skip', detail: 'needs the recorder connected' }));

  if (P.reset) await item('reset', async () => rec.status === 'ok'
    ? checkReset(P, (file, tmoS) => runScript(port, join(demo.dir, file), { apps: cfg.apps }, tmoS), fix)
    : { status: 'skip', detail: 'needs the recorder connected' });
  if (process.platform === 'darwin' && !process.env.STUNTDOUBLE_NO_DOCK) await item('dock', async () => ({ status: 'ok', detail: await dockNote() }));

  const secs = (Date.now() - t0) / 1000;
  return { ready: items.every(i => i.status === 'ok' || i.status === 'fixed'), secs: +secs.toFixed(1), items };
}

// A check that isn't ready, as one sentence: "not ready to record: <what failed>". The first failing item leads (its
// own words, so the app's error catalog can say it plainly); the rest are counted.
export function notReady(r) {
  const fails = r.items.filter(i => i.status === 'fail');
  if (!fails.length) return 'not ready to record';
  const f = fails[0];
  const what = f.id.startsWith('app ') ? f.detail : `${f.id}: ${f.detail}`;
  return `not ready to record: ${what}${fails.length > 1 ? ` (and ${fails.length - 1} more)` : ''}`;
}

// What to do when the recorder isn't connected, in plain words, from what the browser's profiles say.
export function recorderAdvice({ info, profile, browser, extDir, other }) {
  const b = NAME[browser] || browser, page = PAGE[browser];
  const profiles = (info && info.profiles) || [];
  const named = dir => { const p = profiles.find(x => x.dir === dir); return p ? `"${p.name}"` : `"${dir}"`; };
  const here = profiles.find(p => p.dir === profile);
  const withExt = profiles.filter(p => p.extension && p.extension.id);
  const old = withExt.find(p => /[\\/]\.scenecast[\\/]extension[\\/]?$/i.test(p.extension.path || ''));
  if (info && !info.running) return `${b} isn't open. Open it with profile ${named(profile)}, then check again`;
  if (here && here.extension && here.extension.id) {
    const e = here.extension;
    if (old && old.dir === profile) return `${b} has the old copy of the recorder (from the hidden .scenecast folder). At ${page}, remove "Scenecast Recorder", then click Install recorder`;
    if (e.devMode === false) return `Developer mode is off in ${b}, so the recorder is switched off. At ${page}, turn on Developer mode (top right${browser === 'edge' ? ', or bottom left in Edge' : ''})`;
    if (e.enabled === false) return `The recorder is switched off in ${b}. At ${page}, turn Scenecast Recorder on`;
    return `The recorder is in ${b} but isn't talking to Scenecast yet. At ${page}, click Reload (↻) on Scenecast Recorder`;
  }
  if (withExt.length) return `The recorder is in ${b} profile ${withExt.map(p => named(p.dir)).join(', ')}, but this demo uses ${named(profile)}. Pick ${named(withExt[0].dir)} under Profile, or click Install recorder to add it to ${named(profile)}`;
  const elsewhere = other && other.profiles.some(p => p.extension && p.extension.id);
  if (elsewhere) return `The recorder is in ${NAME[other.browser]}, but this demo records in ${b}. Switch "Record in" to ${NAME[other.browser]}, or click Install recorder to add it to ${b}`;
  return `The recorder isn't in ${b} yet. Click Install recorder: it opens ${page} and shows the folder to drag in (${extDir})`;
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
