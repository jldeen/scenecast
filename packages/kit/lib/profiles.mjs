// The presenter's browser profiles, as the browser itself knows them: names and pictures (Local State), which are
// open now (the running browser's --profile-directory and Local State's active profiles), which last used, and in
// which the recorder extension is loaded (each profile's Preferences), with Developer mode on or off. Nothing here
// changes a profile or touches a running browser.
//   scenecast profiles [--browser chrome|edge] [--demo <dir>] --json
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultBrowser, profileRoot, chosenProfile } from '../../player/launch.mjs';

// Where the app puts the recorder extension for the presenter to load: a folder they can see, not a hidden one.
export function extensionDir(env = process.env, home = homedir()) {
  return env.SCENECAST_EXTENSION_DIR || join(home, 'Documents', 'Scenecast', 'Recorder Extension');
}
// Where 0.3.0 and earlier put it.
export const OLD_EXTENSION_DIR = join(homedir(), '.scenecast', 'extension');
// The recorder's IDs in the Chrome Web Store and Edge Add-ons (packages/recorder/store.json; docs/store/listing.md),
// once it's published there: a recorder added from a store lives in the profile's own Extensions folder.
export function storeIds(file = new URL('../../recorder/store.json', import.meta.url)) {
  try { return Object.values(JSON.parse(readFileSync(file, 'utf8'))).map(s => s && s.id).filter(Boolean); } catch (e) { return []; }
}

const BIN = { darwin: { chrome: /\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome( |$)/, edge: /\/Microsoft Edge\.app\/Contents\/MacOS\/Microsoft Edge( |$)/ }, win32: { chrome: /\\chrome\.exe"?( |$)/i, edge: /\\msedge\.exe"?( |$)/i }, linux: { chrome: /\/(google-chrome|chrome)( |$)/, edge: /\/(microsoft-edge|msedge)( |$)/ } };

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
    // Windows quotes either the value (--k="a b") or the whole flag ("--k=a b").
    const flag = k => { const f = new RegExp(`(?:^|\\s)("?)--${k}=(?:"([^"]*)"|(.*?))\\1(?=\\s+"?--|\\s*$)`).exec(cmd); return f ? (f[2] !== undefined ? f[2] : f[3].trim()) : null; };
    out.push({ pid: +m[1], browser: browser[0], userDataDir: flag('user-data-dir'), profile: flag('profile-directory'), debugPort: flag('remote-debugging-port') && +flag('remote-debugging-port') });
  }
  return out;
}
export function listProcs() {
  return new Promise(res => {
    if (process.platform === 'win32') {
      const ps = "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='msedge.exe'\" | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }";
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 15000, maxBuffer: 1 << 24, windowsHide: true }, (e, so) => res(parseProcs(so || '', 'win32')));
    } else execFile('ps', ['-axww', '-o', 'pid=,args='], { timeout: 10000, maxBuffer: 1 << 24 }, (e, so) => res(parseProcs(so || '', process.platform)));
  });
}

const readJson = f => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch (e) { return null; } };
export function localState(userDataDir) { return readJson(join(userDataDir, 'Local State')); }
// Which profiles a running browser has open: its Local State (written as it runs).
export function openProfiles(userDataDir) {
  const s = localState(userDataDir);
  return s ? (s.profile && s.profile.last_active_profiles) || [] : null;
}

const samePath = (a, b) => {
  const n = p => resolve(String(p)).replace(/[\\/]+$/, '');
  return process.platform === 'linux' ? n(a) === n(b) : n(a).toLowerCase() === n(b).toLowerCase();
};
// The recorder in one profile: loaded from which folder (or added from a store), on or off, and whether Developer
// mode is on.
export function extensionIn(profileDir, dirs, ids = storeIds()) {
  const prefs = readJson(join(profileDir, 'Preferences')) || {};
  const secure = readJson(join(profileDir, 'Secure Preferences')) || {};
  const settings = { ...((prefs.extensions || {}).settings || {}), ...((secure.extensions || {}).settings || {}) };
  const devMode = ((prefs.extensions || {}).ui || {}).developer_mode;
  for (const [id, e] of Object.entries(settings)) {
    if (!e || !e.path) continue;
    const which = dirs.find(d => d && samePath(e.path, d));
    if (!which && !ids.includes(id)) continue;
    const reasons = e.disable_reasons;
    const off = e.state === 0 || (Array.isArray(reasons) ? reasons.length > 0 : !!reasons);
    return { id, path: e.path, enabled: !off, devMode: devMode === undefined ? null : !!devMode };
  }
  return { id: null, devMode: devMode === undefined ? null : !!devMode };
}

const hex = n => typeof n === 'number' ? '#' + ((n >>> 0) & 0xffffff).toString(16).padStart(6, '0') : null;
function picture(dir) {
  try {
    const f = readdirSync(dir).find(n => / Profile Picture\.png$/i.test(n));
    if (!f) return null;
    const buf = readFileSync(join(dir, f));
    return buf.length < 400000 ? `data:image/png;base64,${buf.toString('base64')}` : null;
  } catch (e) { return null; }
}

// The profile to use: the demo's, else an open one with the recorder in it, else the one used last, else Default.
export function pickProfile(profiles, preferred) {
  if (preferred && profiles.some(p => p.dir === preferred)) return preferred;
  const rank = p => (p.open ? 8 : 0) + (p.extension && p.extension.id && p.extension.enabled !== false ? 4 : 0) + (p.lastUsed ? 2 : 0) + (p.dir === 'Default' ? 1 : 0);
  const best = [...profiles].sort((a, b) => rank(b) - rank(a))[0];
  return best ? best.dir : preferred || 'Default';
}

export async function browserProfiles({ browser = defaultBrowser(), userDataDir, procs, extDirs = [extensionDir(), OLD_EXTENSION_DIR], preferred, pictures = true } = {}) {
  userDataDir = userDataDir || profileRoot(browser);
  procs = procs || await listProcs();
  const defaultDir = profileRoot(browser);
  const mine = procs.filter(p => p.browser === browser && samePath(p.userDataDir || defaultDir, userDataDir));
  const running = mine.length > 0;
  const state = localState(userDataDir) || {};
  const prof = state.profile || {};
  const cache = prof.info_cache || {};
  const active = new Set(running ? [...(prof.last_active_profiles || []), ...mine.map(p => p.profile).filter(Boolean)] : []);
  // Local State lags a new profile (it's written in batches): the profile folders, and the running browser's own
  // --profile-directory, count too.
  const dirs = new Set(Object.keys(cache));
  try { for (const n of readdirSync(userDataDir)) if (/^(Default|Profile \d+)$/.test(n) && existsSync(join(userDataDir, n, 'Preferences'))) dirs.add(n); } catch (e) { /* no such folder */ }
  for (const p of mine) if (p.profile) dirs.add(p.profile);
  const order = prof.profiles_order || [];
  const profiles = [...dirs].sort((a, b) => (order.indexOf(a) + 1 || 999) - (order.indexOf(b) + 1 || 999) || a.localeCompare(b)).map(dir => {
    const c = cache[dir] || {};
    const folder = join(userDataDir, dir);
    return {
      dir, name: c.name || c.gaia_name || dir, email: c.user_name || null, gaiaName: c.gaia_name || null,
      color: hex(c.profile_highlight_color ?? c.default_avatar_fill_color), picture: pictures ? picture(folder) : null,
      open: active.has(dir), lastUsed: prof.last_used === dir, exists: existsSync(folder),
      extension: extensionIn(folder, extDirs),
    };
  });
  // Running but no profile known open (a browser started without --profile-directory, Local State not written yet):
  // the one used last is the one open.
  if (running && !profiles.some(p => p.open)) { const last = profiles.find(p => p.lastUsed) || profiles.find(p => p.dir === 'Default'); if (last) last.open = true; }
  return { browser, userDataDir, running, pid: running ? mine[0].pid : null, profiles, picked: pickProfile(profiles, preferred) };
}

// Install recorder's browser step. Browsers don't open their extensions page from outside (a chrome:// address given
// to a running Chrome opens a new tab instead), so: a window of the demo's profile in the running browser, on the
// receiver's setup page (the steps, chrome://extensions to copy, and a tick when the recorder connects); the app puts
// chrome://extensions on the clipboard too. Prints what it did and what the profile already has, as JSON.
export async function openExtensionsPage(demo) {
  const { openInBrowser } = await import('../../player/launch.mjs');
  const ch = demo.cfg.chrome || {};
  const browser = ch.browser || defaultBrowser();
  const info = await browserProfiles({ browser, userDataDir: ch.userDataDir, preferred: chosenProfile(ch), pictures: false });
  const p = info.profiles.find(x => x.dir === info.picked);
  const page = browser === 'edge' ? 'edge://extensions' : 'chrome://extensions';
  const port = +(process.env.REPLICA_RX_PORT || demo.cfg.receiverPort || 47621);
  const setup = `http://127.0.0.1:${port}/setup?browser=${browser}&dir=${encodeURIComponent(extensionDir())}`;
  // REPLICA_NO_OPEN (the UI test): say what would open, open nothing.
  const r = process.env.REPLICA_NO_OPEN ? { ok: false, error: 'not opening (REPLICA_NO_OPEN)' } : await openInBrowser(setup, { browser, profile: info.picked, userDataDir: ch.userDataDir });
  const oldLoaded = info.profiles.some(x => /[\\/]\.scenecast[\\/]extension[\\/]?$/i.test((x.extension && x.extension.path) || ''));
  return { ok: r.ok, error: r.error || null, browser, page, setup, running: info.running, profile: info.picked, profileName: p ? p.name : info.picked,
    loaded: !!(p && p.extension.id && !/\.scenecast/.test(p.extension.path || '')), devMode: p ? p.extension.devMode : null, oldLoaded };
}

export async function main(args, loadDemo) {
  let demo = null;
  try { demo = loadDemo(args); } catch (e) { /* no demo: the browser's own */ }
  const ch = (demo && demo.cfg.chrome) || {};
  const i = args.indexOf('--browser');
  const browser = i >= 0 ? args[i + 1] : ch.browser || defaultBrowser();
  const r = await browserProfiles({ browser, userDataDir: i >= 0 ? undefined : ch.userDataDir, preferred: chosenProfile(ch), pictures: !args.includes('--no-pictures') });
  if (args.includes('--json')) console.log(JSON.stringify(r));
  else {
    console.log(`${browser} (${r.userDataDir})${r.running ? `, running (pid ${r.pid})` : ', not running'}`);
    for (const p of r.profiles) console.log(`${p.dir === r.picked ? '→' : ' '} ${p.dir.padEnd(12)} ${p.name}${p.email ? ` <${p.email}>` : ''}${p.open ? '  open' : ''}${p.lastUsed ? '  last used' : ''}${p.extension.id ? `  recorder ${p.extension.enabled ? 'on' : 'off'}` : ''}`);
  }
  return 0;
}
