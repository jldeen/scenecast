// Opens the replica as an app window (no tabs or address bar) on macOS and Windows, in Chrome or Edge.
// demo.json chrome: { browser: 'chrome' | 'edge', profile: 'Profile 10' }. The default browser is Chrome on the Mac
// and Edge on Windows (Edge is always there on Windows; Chrome may not be). Elsewhere it prints the URL.
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAC_APP = { chrome: 'Google Chrome', edge: 'Microsoft Edge' };
const WIN_EXE = { chrome: 'chrome.exe', edge: 'msedge.exe' };

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
export function launchCommand(url, { browser, profile, platform = process.platform, executable } = {}) {
  const b = browser === 'edge' || browser === 'chrome' ? browser : defaultBrowser(platform);
  const flags = [...(profile ? [`--profile-directory=${profile}`] : []), `--app=${url}`];
  if (platform === 'darwin') return ['open', ['-na', MAC_APP[b], '--args', ...flags]];
  if (platform === 'win32' && executable) return [executable, flags];
  return null;
}

export function registryAppPath(output) {
  return output.split(/\r?\n/).map(line => line.match(/\sREG_SZ\s+(.+)$/i)?.[1]?.trim()).find(Boolean) || null;
}

async function windowsBrowser(browser) {
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
