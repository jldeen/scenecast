import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { windowTrouble, otherWindow, platformWindow, landedOn, cookieExpiries, guardVerdict, profileInUse, SIGN_IN_HOST, profileDir } from './browser.mjs';
import { captureOpts } from './host.mjs';
import { agentCode } from './build.mjs';

const ok = { raf: 120, hidden: false, size: [800, 600], screen: [44, 77] };

test('a window that draws at size is fine; Windows minimized (a title bar, a few frames) is not', () => {
  assert.equal(windowTrouble('minimized', ok, { width: 800, height: 600 }), null);
  assert.match(windowTrouble('minimized', { ...ok, size: [500, 28] }, { width: 800, height: 600 }), /500×28/);
  assert.match(windowTrouble('minimized', { ...ok, raf: 3 }, null), /3 frames/);
  assert.match(windowTrouble('minimized', { ...ok, hidden: true }), /hidden/);
  assert.match(windowTrouble('minimized', null), /didn't answer/);
});

test("an off-screen window the system moved onto a display won't do", () => {
  assert.equal(windowTrouble('offscreen', { ...ok, screen: [-32000, -32000] }), null);
  assert.match(windowTrouble('offscreen', { ...ok, screen: [0, 25] }), /onto a display/);
});

test('each OS starts with the mode that draws off the screen there, and falls back to the other', () => {
  assert.equal(platformWindow('darwin'), 'minimized');
  assert.equal(platformWindow('win32'), 'offscreen');
  assert.equal(otherWindow('minimized'), 'offscreen');
  assert.equal(otherWindow('offscreen'), 'minimized');
  assert.equal(otherWindow('visible'), null);
});

test('where an app landed: the app, a sign-in page, or a sign-in policy', () => {
  assert.equal(landedOn('https://teams.example.com/v2/', 'Chat').at, 'app');
  assert.equal(landedOn('https://login.microsoftonline.com/common/oauth2', 'Pick an account').at, 'signin');
  assert.equal(landedOn('https://login.microsoftonline.com/x', "You can't get there from here").at, 'blocked');
  // An app whose own host looks like a sign-in host is the app, by its match.
  assert.equal(landedOn('https://accounts.example.com/home', '', 'accounts.example.com').at, 'app');
  assert.equal(landedOn('not a url').at, 'app');
});

test('the sign-in hosts are the preflight flow\'s', () => {
  const flow = readFileSync(new URL('./flows/preflight.js', import.meta.url), 'utf8');
  assert.ok(flow.includes(SIGN_IN_HOST.source), 'flows/preflight.js SIGN_IN and browser.mjs SIGN_IN_HOST differ');
});

test('cookie report: sign-in cookies only, never their values', () => {
  const r = cookieExpiries([
    { name: 'ESTSAUTHPERSISTENT', value: 'secret', domain: '.login.microsoftonline.com', expires: 1798761600 },
    { name: 'theme', value: 'dark', domain: 'example.com', expires: -1 },
    { name: 'buid', value: 'x', domain: 'login.live.com', expires: -1 },
  ]);
  assert.deepEqual(r, [
    { name: 'ESTSAUTHPERSISTENT', domain: 'microsoftonline.com', session: false, expires: '2027-01-01' },
    { name: 'buid', domain: 'live.com', session: true, expires: null },
  ]);
  assert.ok(!JSON.stringify(r).includes('secret'));
});

test('the read-only guard holds what could write, and only that', () => {
  const T = { hosts: ['tenant.example.com'] };
  assert.equal(guardVerdict({ method: 'GET', url: 'https://tenant.example.com/api' }, T), 'pass');
  assert.equal(guardVerdict({ method: 'OPTIONS', url: 'https://tenant.example.com/api' }, T), 'pass');
  assert.equal(guardVerdict({ method: 'POST', url: 'https://tenant.example.com/api/send' }, T), 'hold');
  assert.equal(guardVerdict({ method: 'DELETE', url: 'https://sub.tenant.example.com/x' }, T), 'hold');
  assert.equal(guardVerdict({ method: 'POST', url: 'https://other.example.org/x' }, T), 'pass');
  // Every web host when none are named; this machine's own never, unless asked.
  assert.equal(guardVerdict({ method: 'PATCH', url: 'https://other.example.org/x' }), 'hold');
  assert.equal(guardVerdict({ method: 'POST', url: 'http://127.0.0.1:47621/cmd/result' }), 'pass');
  assert.equal(guardVerdict({ method: 'POST', url: 'http://127.0.0.1:47621/x' }, { local: true }), 'hold');
  assert.equal(guardVerdict({ method: 'POST', url: 'data:text/plain,x' }), 'pass');
  // The allow-list: a host/path prefix, or a pattern over "METHOD host/path".
  assert.equal(guardVerdict({ method: 'POST', url: 'https://tenant.example.com/search/query?q=1' }, { ...T, allow: ['tenant.example.com/search/'] }), 'pass');
  assert.equal(guardVerdict({ method: 'POST', url: 'https://tenant.example.com/telemetry' }, { ...T, allow: ['/^POST [^/]+\\/telemetry$/'] }), 'pass');
  assert.equal(guardVerdict({ method: 'PUT', url: 'https://tenant.example.com/telemetry' }, { ...T, allow: ['/^POST [^/]+\\/telemetry$/'] }), 'hold');
});

test('a profile another browser has open is in use; a stale lock is not', { skip: process.platform === 'win32' }, () => {
  const d = mkdtempSync(join(tmpdir(), 'sd-profile-'));
  try {
    assert.equal(profileInUse(d), null);
    symlinkSync(`somehost-${process.pid}`, join(d, 'SingletonLock'));
    assert.equal(profileInUse(d), process.pid);
    rmSync(join(d, 'SingletonLock'));
    symlinkSync('somehost-999999', join(d, 'SingletonLock'));
    assert.equal(profileInUse(d), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('capture options: a profile by name lives under ~/.stuntdouble/capture; the channel follows the demo\'s browser', () => {
  assert.equal(captureOpts({}).profile, profileDir('default'));
  assert.equal(captureOpts({ capture: { profile: 'demo-tenant' } }).profile, profileDir('demo-tenant'));
  assert.equal(captureOpts({ capture: { profile: '/tmp/x' } }).profile, '/tmp/x');
  assert.equal(captureOpts({ chrome: { browser: 'edge' } }).channel, 'msedge');
  assert.equal(captureOpts({}).window, 'auto');
});

test("the capture browser's recorder tells the receiver where it runs, and hands closed shadow roots over", () => {
  const code = agentCode(47621, { browser: 'capture', shadow: 'async function EXPOSE_SHADOW(p) { return 0; }\n' });
  assert.match(code, /&browser=capture&/);
  assert.match(code, /async function EXPOSE_SHADOW/);
  assert.equal(typeof new Function('return ' + code)(), 'function');
  assert.match(agentCode(47621), /&browser=agent&/);
});
