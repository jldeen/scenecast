import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { parseProcs, judgeBrowser, preflight } from './preflight.mjs';

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

test('a receiver slow to answer is the one running: not started again', async () => {
  // Answers its ping in 1.2 s (a loaded machine): longer than the first ping waits.
  const srv = createServer((req, res) => setTimeout(() => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, raw: '/slow', agent: { polling: false, secsAgo: null } })); }, 1200));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port, stop = new Error('stop');
  let got = null;
  try {
    await preflight({ dir: '.', cfg: { receiverPort: port, recorder: 'extension', chrome: {}, apps: [] } }, { onItem: r => { if (r.id === 'receiver') { got = r; throw stop; } } }).catch(e => { if (e !== stop) throw e; });
  } finally { srv.close(); }
  assert.equal(got.status, 'ok', JSON.stringify(got));
  assert.match(got.detail, /\/slow/);
});
