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

test('profiles: the open one with the recorder is picked, by its name; a demo\'s own choice wins', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { listProfiles, pickProfile } = await import('./profiles.mjs');
  const { recorderAdvice } = await import('./preflight.mjs');
  const root = mkdtempSync(join(tmpdir(), 'sc-profiles-'));
  const ext = join(root, 'Recorder Extension');
  mkdirSync(ext); writeFileSync(join(ext, 'manifest.json'), JSON.stringify({ name: 'Scenecast Recorder', version: '9.9.9' }));
  for (const d of ['Default', 'Profile 10', 'Profile 3']) mkdirSync(join(root, d));
  writeFileSync(join(root, 'Local State'), JSON.stringify({ profile: { last_active_profiles: ['Profile 10'], info_cache: { Default: { name: 'Person 1' }, 'Profile 10': { name: 'Work' }, 'Profile 3': { name: 'Home' } } } }));
  writeFileSync(join(root, 'Profile 10', 'Secure Preferences'), JSON.stringify({ extensions: { settings: { abc: { path: ext, location: 4, disable_reasons: [] } } } }));
  writeFileSync(join(root, 'Profile 3', 'Preferences'), JSON.stringify({ extensions: { ui: { developer_mode: false } } }));
  const profiles = listProfiles(root, { extDirs: [ext] });
  const by = d => profiles.find(p => p.dir === d);
  assert.equal(by('Profile 10').name, 'Work');
  assert.ok(by('Profile 10').open && by('Profile 10').recorder && !by('Profile 10').recorderOff);
  assert.equal(by('Default').recorder, false);
  assert.equal(by('Profile 3').devMode, false);
  assert.deepEqual(pickProfile(profiles, null), { dir: 'Profile 10', why: 'open, with the recorder' });
  assert.equal(pickProfile(profiles, 'Profile 3').dir, 'Profile 3');
  assert.equal(pickProfile([], null).dir, 'Default');
  // Plain words for what's wrong.
  const known = { running: true, profiles };
  assert.match(recorderAdvice({ browser: 'chrome', profile: 'Profile 3', named: '"Home"', known, dir: ext }), /loaded in profile "Work", not "Home"/);
  assert.match(recorderAdvice({ browser: 'chrome', profile: 'Profile 3', named: '"Home"', known: { running: true, profiles: profiles.filter(p => !p.recorder) }, dir: ext }), /Developer mode is off/);
  assert.match(recorderAdvice({ browser: 'chrome', profile: 'Default', named: '"Person 1"', known: { running: true, profiles: profiles.filter(p => !p.recorder) }, other: 'edge', dir: ext }), /loaded in Edge, but this demo records in Chrome/);
  assert.match(recorderAdvice({ browser: 'chrome', profile: 'Profile 10', named: '"Work"', known, dir: ext }), /reload button/);
});
