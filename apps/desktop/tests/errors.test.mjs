// The error catalog (ui/errors.js): every message the app and the engine are known to show maps to a plain-words
// entry, and no entry's title or sentence uses the engine's own words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, explain } from '../ui/errors.js';

// Real messages, as the engine and the app word them (packages/recorder/recorder.js, packages/kit/lib/preflight.mjs,
// crates/scenecast-app, apps/desktop/src-tauri, packages/ai).
const KNOWN = [
  ['not open: teams (a tab whose address has teams.cloud.microsoft), copilot (a tab whose address has copilot.cloud.microsoft). Open them in the browser the recorder is in, then start again', 'tabs-not-open'],
  ['no tab for admin (admin.cloud.microsoft)', 'tabs-not-open'],
  ['not ready to record: no tab for admin (admin.cloud.microsoft)', 'tabs-not-open'],
  ['not ready to record: admin opened a sign-in page (login.microsoftonline.com): sign in to it in that tab, then check again', 'app-signed-out'],
  ['not ready to record: browser: Chrome isn\u2019t open. Open it with profile "Jessica", then check again (and 2 more)', 'browser-closed'],
  ['not ready to record: recorder: The recorder isn\u2019t in Chrome yet. Click Install recorder: it opens chrome://extensions and shows the folder to drag in (/x)', 'recorder-missing'],
  ['not ready to record: something we have no words for', 'not-ready'],
  ['the recorder is in more than one browser window or profile: it records in chrome (12 tabs), and chrome (3 tabs) also has it. Remove the recorder from the one you don\u2019t record in (at chrome://extensions), or close that browser, then check again', 'two-recorders'],
  ['Reload the recorder extension: Chrome is running recorder 0.4.0, and this app\u2019s is 0.4.1. At chrome://extensions, click Reload (↻) on Scenecast Recorder', 'recorder-old'],
  ['the recorder in Chrome is 0.4.0; this app\u2019s is 0.4.1. Fix reloads it (or click Reload (↻) on Scenecast Recorder at chrome://extensions)', 'recorder-old'],
  ['Developer mode is off in Chrome, so the recorder is switched off. At chrome://extensions, turn on Developer mode (top right)', 'recorder-off'],
  ['The recorder isn\u2019t connected. Open Chrome with the recorder in it (Install recorder shows how), then start again.', 'recorder-missing'],
  ['The recorder isn\u2019t in Chrome yet. Click Install recorder: it opens chrome://extensions and shows the folder to drag in (/x)', 'recorder-missing'],
  ['The recorder is in Chrome but isn\u2019t talking to Scenecast yet. At chrome://extensions, click Reload (↻) on Scenecast Recorder', 'recorder-missing'],
  ['Chrome isn\u2019t open. Open it with profile "Jessica", then check again', 'browser-closed'],
  ['The receiver isn\u2019t running on port 47621. Run Check, then start again.', 'receiver-down'],
  ['nothing on 47621: run scenecast receiver', 'receiver-down'],
  ['something on 47621 isn\u2019t answering as a receiver: stop it, or set another receiverPort in demo.json', 'receiver-down'],
  ['teams isn\u2019t on its start screen (https://login.microsoftonline.com/common/oauth2)', 'app-sign-in'],
  ['teams isn\u2019t on its start screen (https://teams.cloud.microsoft/v2/chat)', 'app-off-start'],
  ['already recording', 'already-recording'],
  ['not recording', 'not-recording'],
  ['nothing to resume (no checkpoint in the raw folder)', 'nothing-to-resume'],
  ['record stop: 0 states, 0 steps', 'nothing-recorded'],
  ['the demo has no apps to record', 'no-apps'],
  ['no recording: /Users/j/.scenecast/x/raw (record the demo first: scenecast record start)', 'no-recording'],
  ['1 credential found: the build stopped', 'credential'],
  ['this demo is busy (fidelity): wait for it to finish', 'busy-comparing'],
  ['this demo is busy (build): wait for it to finish', 'busy'],
  ['paste or open the script first', 'script-empty'],
  ['the script is empty', 'script-empty'],
  ['start presenting first: the guide follows the stage', 'guide-before-stage'],
  ['couldn\u2019t read the browser\u2019s profiles', 'profiles-unreadable'],
  ['couldn\'t read the browser\'s profiles', 'profiles-unreadable'],
  ['two apps have the id `teams`', 'duplicate-app'],
  ['give the demo a name', 'no-name'],
  ['device flow: expired_token after 900 s', 'sign-in-expired'],
  ['access_denied', 'sign-in-denied'],
  ['getaddrinfo ENOTFOUND github.com', 'offline'],
  ['not opening https://github.com/login/device', 'cant-open-url'],
  ['can\u2019t show /Users/j/Documents/Scenecast/x: No such file', 'cant-open-file'],
  ['update: error sending request for url', 'update-check'],
  ['Node.js 20 or later is needed (https://nodejs.org); `node` was not found', 'node-missing'],
  ['ENOSPC: no space left on device, write', 'disk-full'],
  ['EACCES: permission denied, open /x', 'no-permission'],
  ['the engine\u2019s build stopped with exit code 1', 'step-stopped'],
  ['the engine\'s `record start` failed (exit 1): boom', 'step-stopped'],
  ['the fidelity loop ran but wrote no report', 'step-stopped'],
];
const ENGINE_WORDS = /\b(port|receiver|preflight|scrub|manifest|unpacked|developer mode|headless|side states?|streamed|threshold|localhost|exit code|stderr|stdout|raw folder|checkpoint|chrome:\/\/|edge:\/\/|demo\.json|profile \d+)\b/i;
const ctx = { browser: 'Chrome', appName: id => ({ teams: 'Teams', admin: 'the admin center' })[id] || id };

test('after Record\u2019s own check, a missing tab is picked, not opened again', () => {
  const x = explain('not ready to record: no tab for admin (admin.cloud.microsoft)', { browser: 'Chrome' });
  assert.equal(x.title, 'Scenecast can\u2019t find the admin tab');
  assert.equal(x.action, null);
  assert.equal(explain('no tab for admin (admin.cloud.microsoft)', { browser: 'Chrome' }).action.action, 'preflight-fix');
  assert.equal(explain('not ready to record: admin opened a sign-in page (login.live.com): sign in', {}).title, 'Sign in to admin first');
});

test('every known message has a plain-words entry', () => {
  for (const [message, id] of KNOWN) assert.equal(explain(message, ctx).id, id, message);
});

test('titles and sentences are short and never in the engine\u2019s words', () => {
  for (const [message] of KNOWN) {
    const e = explain(message, ctx);
    assert.doesNotMatch(`${e.title} ${e.body}`, ENGINE_WORDS, message);
    assert.ok(e.title.length <= 60, `title too long: ${e.title}`);
    assert.ok(e.body.length <= 180, `sentence too long: ${e.body}`);
    assert.equal(e.detail, message, 'the engine\u2019s words are kept for Details');
  }
});

test('at most one action, and only ones the window knows', () => {
  const known = new Set(['preflight', 'preflight-fix', 'install', 'receiver-fix', 'record-start', 'record-stop', 'ai-sign-in', 'present-start', 'show-logs']);
  for (const [message] of KNOWN) {
    const a = explain(message, { ...ctx, retry: 'ai-sign-in' }).action;
    if (a) assert.ok(a.label && (known.has(a.action) || a.goto || a.copy), `${message}: ${JSON.stringify(a)}`);
  }
});

test('a newer run taking over is not an error to show', () => {
  assert.equal(explain('replaced by a newer check'), null);
  assert.equal(explain('stopped: a newer run took its place'), null);
});

test('anything unknown still reads as a sentence, with the engine\u2019s words kept', () => {
  const e = explain('ZeroDivisionError at frobnicate()', { job: 'build' });
  assert.equal(e.id, 'unknown');
  assert.match(e.title, /^Building the replica: something went wrong$/);
  assert.doesNotMatch(e.title + e.body, /frobnicate/);
  assert.equal(e.detail, 'ZeroDivisionError at frobnicate()');
});

test('the tab entry names the app, or says "some" for several', () => {
  assert.equal(explain('no tab for teams (teams.cloud.microsoft)', ctx).title, 'The Teams tab isn\u2019t open');
  assert.equal(explain(KNOWN[0][0], ctx).title, 'Some app tabs aren\u2019t open');
  assert.equal(CATALOG.filter(e => !e.quiet).every(e => typeof e.title === 'function' && typeof e.body === 'function'), true);
});
