// Opens the replica as an app window (no tabs or address bar) on macOS and Windows, in Chrome or Edge.
// demo.json chrome: { browser: 'chrome' | 'edge', profile: 'Profile 10' }. The default browser is Chrome on the Mac
// and Edge on Windows (Edge is always there on Windows; Chrome may not be). Elsewhere it prints the URL.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAC_APP = { chrome: 'Google Chrome', edge: 'Microsoft Edge' };
const WIN_EXE = { chrome: 'chrome', edge: 'msedge' };

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
export function launchCommand(url, { browser, profile, platform = process.platform } = {}) {
  const b = browser === 'edge' || browser === 'chrome' ? browser : defaultBrowser(platform);
  const flags = [...(profile ? [`--profile-directory=${profile}`] : []), `--app=${url}`];
  if (platform === 'darwin') return ['open', ['-na', MAC_APP[b], '--args', ...flags]];
  // `start` finds chrome.exe and msedge.exe through App Paths, so neither has to be on PATH.
  // The arguments go to cmd verbatim: quote the ones with spaces ("Profile 10") ourselves.
  if (platform === 'win32') return ['cmd', ['/d', '/c', 'start', '""', WIN_EXE[b], ...flags.map(f => (/\s/.test(f) ? `"${f}"` : f))]];
  return null;
}

export function openApp(url, chrome = {}) {
  const cmd = launchCommand(url, chrome);
  const yourself = err => { if (err) console.log(`open it yourself: ${url}`); };
  if (!cmd) return yourself(true);
  if (chrome.profile && chrome.profile !== 'Default') {
    const b = chrome.browser || defaultBrowser();
    if (!existsSync(join(profileRoot(b), chrome.profile))) console.log(`note: no ${b} profile "${chrome.profile}" in ${profileRoot(b)} (demo.json chrome.profile)`);
  }
  execFile(cmd[0], cmd[1], { windowsVerbatimArguments: process.platform === 'win32' }, yourself);
}
