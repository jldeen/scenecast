// Opens the replica as an app window (no tabs or address bar) on macOS and Windows, in Chrome or Edge.
// demo.json chrome: { browser: 'chrome' | 'edge', profile: 'Profile 10' }. The default browser is Chrome on the Mac
// and Edge on Windows (Edge is always there on Windows; Chrome may not be). Elsewhere it prints the URL.
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAC_APP = { chrome: 'Google Chrome', edge: 'Microsoft Edge' };
const WIN_EXE = { chrome: 'chrome.exe', edge: 'msedge.exe' };

// The profile the demo names, if the presenter picked it: "Default" written by 0.3.0's template (not picked) means
// "the one that's open", like no profile at all.
export function chosenProfile(chrome = {}) {
  const p = chrome.profile;
  return p && (p !== 'Default' || chrome.profilePicked) ? p : null;
}

export function defaultBrowser(platform = process.platform) {
  return platform === 'win32' ? 'edge' : 'chrome';
}

// Where the browser keeps its profiles ("User Data"), for a profile's folder name (`Default`, `Profile 10`).
export function profileRoot(browser, platform = process.platform, env = process.env, home = homedir()) {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', browser === 'edge' ? 'Microsoft Edge' : join('Google', 'Chrome'));
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return join(local, ...(browser === 'edge' ? ['Microsoft', 'Edge', 'User Data'] : ['Google', 'Chrome', 'User Data']));
  }
  return join(home, '.config', browser === 'edge' ? 'microsoft-edge' : 'google-chrome');
}

// The command that opens `url` as an app window: [file, args]. null where there is none (Linux: open it yourself).
// fullscreen: the window opens full screen (presenting). position [x, y] and size [w, h]: where the window goes (the
// presenter guide, on the laptop screen).
export function launchCommand(url, { browser, profile, platform = process.platform, executable, fullscreen, position, size } = {}) {
  const b = browser === 'edge' || browser === 'chrome' ? browser : defaultBrowser(platform);
  const flags = [...(profile ? [`--profile-directory=${profile}`] : []), ...(fullscreen ? ['--start-fullscreen'] : []),
    ...(position ? [`--window-position=${position.map(Math.round).join(',')}`] : []), ...(size ? [`--window-size=${size.map(Math.round).join(',')}`] : []), `--app=${url}`];
  if (platform === 'darwin') return ['open', ['-na', MAC_APP[b], '--args', ...flags]];
  if (platform === 'win32' && executable) return [executable, flags];
  return null;
}

export function registryAppPath(output) {
  return output.split(/\r?\n/).map(line => line.match(/\sREG_SZ\s+(.+)$/i)?.[1]?.trim()).find(Boolean) || null;
}

export async function windowsBrowser(browser) {
  const exe = WIN_EXE[browser], key = `Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`;
  for (const root of ['HKCU', 'HKLM']) {
    const output = await new Promise(resolve => execFile('reg.exe', ['query', `${root}\\${key}`, '/ve'], (err, stdout) => resolve(err ? '' : stdout)));
    const path = registryAppPath(output);
    if (path && existsSync(path)) return path;
  }
  const folder = browser === 'edge' ? ['Microsoft', 'Edge'] : ['Google', 'Chrome'];
  for (const base of [process.env.LOCALAPPDATA, process.env['ProgramFiles(x86)'], process.env.ProgramFiles]) {
    if (!base) continue;
    const path = join(base, ...folder, 'Application', exe);
    if (existsSync(path)) return path;
  }
  const found = await new Promise(resolve => execFile('where.exe', [exe], (err, stdout) => resolve(err ? '' : stdout)));
  return found.split(/\r?\n/).map(path => path.trim()).find(path => path && existsSync(path)) || null;
}

export function openApp(url, chrome = {}) {
  chrome = { ...chrome, profile: chosenProfile(chrome) || undefined };
  const yourself = err => { if (err) console.log(`open it yourself: ${url}`); };
  if (chrome.profile && chrome.profile !== 'Default') {
    const b = chrome.browser || defaultBrowser();
    if (!existsSync(join(profileRoot(b), chrome.profile))) console.log(`note: no ${b} profile "${chrome.profile}" in ${profileRoot(b)} (demo.json chrome.profile)`);
  }
  if (process.platform === 'win32') {
    const browser = chrome.browser === 'chrome' || chrome.browser === 'edge' ? chrome.browser : defaultBrowser();
    windowsBrowser(browser).then(executable => {
      const cmd = launchCommand(url, { ...chrome, executable });
      if (!cmd) return yourself(true);
      const child = spawn(cmd[0], cmd[1], { stdio: 'ignore' });
      child.once('error', yourself);
      child.once('exit', code => { if (code) yourself(true); });
      child.unref();
    }).catch(err => { console.error(`cannot locate browser: ${err.message}`); yourself(true); });
    return;
  }
  const cmd = launchCommand(url, chrome);
  if (!cmd) return yourself(true);
  execFile(cmd[0], cmd[1], { windowsVerbatimArguments: process.platform === 'win32' }, yourself);
}

const LINUX_BIN = { chrome: ['google-chrome', 'google-chrome-stable', 'chromium'], edge: ['microsoft-edge', 'microsoft-edge-stable'] };
// The command that opens `urls` as ordinary tabs in a window of `profile`: handed to the browser that's running (its
// own single-instance hand-off), so nothing is quit or restarted and no tab closes. [file, args], or null.
export function windowCommand(urls, { browser, profile, userDataDir, platform = process.platform, executable } = {}) {
  const b = browser === 'edge' || browser === 'chrome' ? browser : defaultBrowser(platform);
  const flags = [...(userDataDir ? [`--user-data-dir=${userDataDir}`] : []), ...(profile ? [`--profile-directory=${profile}`] : []), ...[].concat(urls)];
  // The Mac: the browser's own binary when it's there (it hands the window to the running browser and leaves);
  // `open -na` otherwise.
  if (platform === 'darwin') return executable ? [executable, flags] : ['open', ['-na', MAC_APP[b], '--args', ...flags]];
  if (platform === 'win32') return executable ? [executable, flags] : null;
  return [executable || LINUX_BIN[b][0], flags];
}
export function macBrowser(browser, home = homedir()) {
  const rel = join(`${MAC_APP[browser]}.app`, 'Contents', 'MacOS', MAC_APP[browser]);
  return [join('/Applications', rel), join(home, 'Applications', rel)].find(p => existsSync(p)) || null;
}
// Opens `urls` in the presenter's browser, in `profile`'s window. Resolves { ok, error }.
export async function openInBrowser(urls, opts = {}) {
  const b = opts.browser === 'edge' || opts.browser === 'chrome' ? opts.browser : defaultBrowser();
  const userDataDir = opts.userDataDir && opts.userDataDir !== profileRoot(b) ? opts.userDataDir : undefined;
  const executable = process.platform === 'win32' ? await windowsBrowser(b).catch(() => null) : process.platform === 'darwin' ? macBrowser(b) : opts.executable;
  const cmd = windowCommand(urls, { ...opts, browser: b, userDataDir, executable });
  if (!cmd) return { ok: false, error: `can't find ${b === 'edge' ? 'Microsoft Edge' : 'Google Chrome'} on this computer` };
  return new Promise(res => {
    const child = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: process.platform !== 'win32', windowsHide: false });
    let done = false;
    const end = r => { if (!done) { done = true; res(r); } };
    child.once('error', e => end({ ok: false, error: e.message }));
    // The new process hands the window to the running browser and leaves at once; a first start keeps running.
    child.once('exit', code => end(code ? { ok: false, error: `${cmd[0]} exited with ${code}` } : { ok: true }));
    setTimeout(() => { child.unref(); end({ ok: true }); }, 4000);
  });
}
