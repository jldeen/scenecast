import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProcs, judgeBrowser } from './preflight.mjs';

test('main browser processes on the Mac, with their flags; helpers left out', () => {
  const ps = [
    '  501 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --profile-directory=Profile 10',
    '  502 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer',
    '  503 /Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge --remote-debugging-port=9222 --user-data-dir=/tmp/edge',
  ].join('\n');
  assert.deepEqual(parseProcs(ps, 'darwin'), [
    { pid: 501, browser: 'chrome', userDataDir: null, profile: 'Profile 10', debugPort: null },
    { pid: 503, browser: 'edge', userDataDir: '/tmp/edge', profile: null, debugPort: 9222 },
  ]);
});

test('main browser processes on Windows, quoted paths and flags', () => {
  const ps = [
    '7100 "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --profile-directory="Profile 1" --remote-debugging-port=9333',
    '7101 "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --type=gpu-process',
    '7200 "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --user-data-dir="C:\\Users\\j\\AppData\\Local\\Google\\Chrome\\User Data"',
  ].join('\r\n');
  assert.deepEqual(parseProcs(ps, 'win32'), [
    { pid: 7100, browser: 'edge', userDataDir: null, profile: 'Profile 1', debugPort: 9333 },
    { pid: 7200, browser: 'chrome', userDataDir: 'C:\\Users\\j\\AppData\\Local\\Google\\Chrome\\User Data', profile: null, debugPort: null },
  ]);
});

test('a running browser is judged, never restarted: same user data folder, debugging port when needed', () => {
  const procs = [{ pid: 1, browser: 'edge', userDataDir: null, debugPort: null }];
  const want = { browser: 'edge', userDataDir: '/d', defaultDir: '/d' };
  assert.deepEqual(judgeBrowser(procs, want), { running: true, pid: 1, debugPort: null, needsPort: false });
  assert.equal(judgeBrowser(procs, { ...want, debugPort: 9222 }).needsPort, true);
  assert.equal(judgeBrowser(procs, { ...want, userDataDir: '/other' }).running, false);
  assert.equal(judgeBrowser(procs, { ...want, browser: 'chrome' }).running, false);
});
