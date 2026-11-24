import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { windowTrouble, otherWindow, platformWindow, landedOn, cookieExpiries, guardVerdict, profileInUse, SIGN_IN_HOST, profileDir, pinnedAuthorizeUrl, tenantsInKeys, tenantVerdict, hintedUrl, ownSignInPage, openFor, senderOrigin, staysHeld, allowedBy } from './browser.mjs';
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
  assert.equal(otherWindow('minimized', 'darwin'), 'offscreen');
  assert.equal(otherWindow('offscreen', 'darwin'), 'minimized');
  // Windows: a minimized window passes a short probe and then barely draws; never the fallback there.
  assert.equal(otherWindow('offscreen', 'win32'), null);
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
  // A listing that only reads when nothing is typed in it: the body has to say so, and no body seen holds it.
  const list = { ...T, allow: ['/^POST tenant\\.example\\.com\\/catalog\\/search$/ when body /^\\{"search":"","filter":"[^"]*"\\}$/'] };
  const url = 'https://tenant.example.com/catalog/search';
  assert.equal(guardVerdict({ method: 'POST', url, body: '{"search":"","filter":"Type eq \'Model\'"}' }, list), 'pass');
  assert.equal(guardVerdict({ method: 'POST', url, body: '{"search":"Supply chain","filter":"Type eq \'Model\'"}' }, list), 'hold');
  assert.equal(guardVerdict({ method: 'POST', url }, list), 'hold');
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
  assert.equal(captureOpts({ capture: { profile: '/tmp/x' } }).profile, resolve('/tmp/x'));
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

test('the demo account is pinned at Entra\'s sign-in: hints added, the app\'s account picker dropped', () => {
  const pin = { loginHint: 'demo@contoso.example', domainHint: 'contoso.example' };
  const u = new URL(pinnedAuthorizeUrl('https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?client_id=x&prompt=select_account&scope=openid', pin));
  assert.equal(u.searchParams.get('login_hint'), 'demo@contoso.example');
  assert.equal(u.searchParams.get('domain_hint'), 'contoso.example');
  assert.equal(u.searchParams.get('prompt'), null);
  assert.equal(u.searchParams.get('client_id'), 'x');
  // An app's own hint stays; anything but Entra's authorize is left alone.
  assert.equal(new URL(pinnedAuthorizeUrl('https://login.microsoftonline.com/common/oauth2/authorize?login_hint=a@b.example', pin)).searchParams.get('login_hint'), 'a@b.example');
  assert.equal(pinnedAuthorizeUrl('https://login.microsoftonline.com/common/oauth2/v2.0/token', pin), null);
  assert.equal(pinnedAuthorizeUrl('https://teams.example.com/oauth2/v2.0/authorize', pin), null);
  assert.equal(pinnedAuthorizeUrl('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?login_hint=x&domain_hint=y', pin), null);
});

test('tenants from an app\'s storage key names (MSAL: object id.tenant id)', () => {
  const oid = '11111111-1111-1111-1111-111111111111', t1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', t2 = 'BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB';
  assert.deepEqual(tenantsInKeys([`${oid}.${t1}-login.windows.net-${t1}`, `msal.token.keys.x`, `${oid}.${t1}-login.windows.net-accesstoken-c-${t1}-scope`, 'theme']), [t1]);
  assert.deepEqual(tenantsInKeys([`["${oid}.${t2}-login.windows.net-${t2}"]`]), [t2.toLowerCase()]);
  assert.deepEqual(tenantsInKeys(['nothing', 'here']), []);
  // MSAL's newer keys, and Teams' own tenant-first keys (the second id is the user, not a tenant).
  assert.deepEqual(tenantsInKeys([`msal.2|${oid}.${t1}|login.windows.net|accesstoken|c|${t1}|scope`, `tmp.${t1}.${oid}.react-web-client.x`, `tmp.auth.v1.${oid}.Token.X`]), [t1]);
});

test('the tenant guard: only the demo tenant, and never a page it can\'t read when a tenant is named', () => {
  const demo = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', work = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  assert.equal(tenantVerdict({ teams: [demo], admin: [demo] }, demo).ok, true);
  const other = tenantVerdict({ teams: [demo], copilot: [work] }, demo);
  assert.equal(other.ok, false); assert.deepEqual(other.other, [work]);
  assert.match(tenantVerdict({ teams: [demo], iq: [] }, demo).why, /couldn't tell .* iq/);
  // No tenant named: an app signed in to any tenant isn't captured; one with none (a test page) is.
  assert.match(tenantVerdict({ teams: [demo] }, null).why, /doesn't name its own/);
  assert.equal(tenantVerdict({ chat: [], admin: [] }, null).ok, true);
});

test('capture options: the tenant and the pinned account come from demo.json', () => {
  const o = captureOpts({ capture: { tenant: 'contoso.example', account: 'demo@contoso.example' } });
  assert.equal(o.tenant, 'contoso.example');
  assert.deepEqual(o.pin, { loginHint: 'demo@contoso.example', domainHint: 'contoso.example' });
  assert.equal(captureOpts({ capture: { tenant: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' } }).pin, null);
  assert.equal(captureOpts({}).pin, null);
});

test('an app\'s own "which account" landing gets the demo account in its address; Entra\'s own page doesn\'t', () => {
  assert.equal(hintedUrl('https://app.example.com/', 'demo@contoso.example'), 'https://app.example.com/?login_hint=demo%40contoso.example');
  assert.equal(hintedUrl('https://app.example.com/?login_hint=x', 'demo@contoso.example'), null);
  assert.equal(hintedUrl('https://app.example.com/', null), null);
  assert.equal(ownSignInPage(landedOn('https://app.example.com/', 'Welcome. Sign in to start chatting', 'app.example.com')), true);
  assert.equal(ownSignInPage(landedOn('https://login.microsoftonline.com/x', 'Pick an account')), false);
  assert.equal(ownSignInPage(landedOn('https://app.example.com/', 'Hello', 'app.example.com')), false);
});

test("what a write or an API undo opened: its hosts, or its one call (method and exact address)", () => {
  const u = x => new URL(x);
  const call = [{ hosts: ['api.example.com'], method: 'DELETE', url: 'https://api.example.com/v1/a?x=1' }];
  assert.equal(openFor(call, u('https://api.example.com/v1/a?x=1'), 'delete'), true);
  assert.equal(openFor(call, u('https://api.example.com/v1/b'), 'POST'), false);
  assert.equal(openFor(call, u('https://api.example.com/v1/a?x=1'), 'PUT'), false);
  assert.equal(openFor([{ hosts: ['example.com'] }], u('https://api.example.com/v1/b'), 'POST'), true);
  assert.equal(openFor([{ hosts: [] }, { method: 'POST' }], u('https://api.example.com/v1/b'), 'POST'), false);
});

test("which page or frame sent a request: its Origin, else its Referer's", () => {
  assert.equal(senderOrigin({ Origin: 'https://frame.example.com' }), 'https://frame.example.com');
  assert.equal(senderOrigin({ origin: 'null', referer: 'https://frame.example.com/app?x=1' }), 'https://frame.example.com');
  assert.equal(senderOrigin({}), null);
});

test("a pack's stay-held entries: its own background calls, matched as allow entries are", () => {
  const list = ['/^POST api\\.example\\.com\\/v1\\/refresh$/', 'api.example.com/v1/subscribe', '/^POST api\\.example\\.com\\/v1\\/search$/ when body /^\\{"q":""\\}$/'];
  assert.equal(staysHeld({ method: 'post', url: 'https://api.example.com/v1/refresh' }, list), true);
  assert.equal(staysHeld({ method: 'POST', url: 'https://api.example.com/v1/subscribe/x' }, list), true);
  assert.equal(staysHeld({ method: 'POST', url: 'https://api.example.com/v1/items' }, list), false);
  assert.equal(staysHeld({ method: 'POST', url: 'https://api.example.com/v1/search', body: '{"q":""}' }, list), true);
  assert.equal(staysHeld({ method: 'POST', url: 'https://api.example.com/v1/search', body: '{"q":"x"}' }, list), false);
  assert.equal(staysHeld({ method: 'POST', url: 'https://api.example.com/v1/refresh' }, []), false);
});

test('the allow entry that let a request through', () => {
  const allow = ['api.example.com/v1/telemetry', '/^POST api\\.example\\.com\\/v1\\/search$/ when body /^\\{"q":""\\}$/'];
  assert.equal(allowedBy({ method: 'POST', url: 'https://api.example.com/v1/telemetry/x' }, allow), allow[0]);
  assert.equal(allowedBy({ method: 'POST', url: 'https://api.example.com/v1/search', body: '{"q":""}' }, allow), allow[1]);
  assert.equal(allowedBy({ method: 'POST', url: 'https://api.example.com/v1/search', body: '{"q":"x"}' }, allow), null);
});

test("IQ's picker suggestions: its own scenario, nothing typed (public) or exactly the demo's search (private)", () => {
  const PUB = '/^POST substrate\\.office\\.com\\/search\\/api\\/v1\\/suggestions$/ when body /^\\{"Scenario":\\{"Name":"MicrosoftIQ\\.Web\\.Copilot_Peek"(?![\\s\\S]*"(?:Display)?QueryString"\\s*:\\s*"(?!"))/';
  const PRIV = '/^POST substrate\\.office\\.com\\/search\\/api\\/v1\\/suggestions$/ when body /^\\{"Scenario":\\{"Name":"MicrosoftIQ\\.Web\\.Copilot_Peek"(?![\\s\\S]*"(?:Display)?QueryString"\\s*:\\s*"(?!"|Supply chain"))/';
  const url = 'https://substrate.office.com/search/api/v1/suggestions';
  const v = (allow, body) => guardVerdict({ method: 'POST', url, body }, { allow: [allow] });
  const peek = reqs => JSON.stringify({ Scenario: { Name: 'MicrosoftIQ.Web.Copilot_Peek', Dimensions: [] }, EntityRequests: reqs, TimeZone: 'UTC', LogicalId: 'x', Cvid: 'y' });
  const q = (t, s) => ({ EntityType: t, Query: { QueryString: s } });
  const empty = peek([q('People', ''), q('Chat', ''), q('TeamsChannel', '')]), typed = peek([q('People', 'Supply chain'), q('File', 'Supply chain')]);
  for (const a of [PUB, PRIV]) assert.equal(v(a, empty), 'pass');
  assert.equal(v(PRIV, typed), 'pass');
  assert.equal(v(PUB, typed), 'hold');
  const held = [
    peek([q('People', 'Supply chains')]),
    peek([q('People', ''), q('File', 'x')]),
    JSON.stringify(JSON.parse(empty), null, 1).replace('"Name":', '"Name": '),
    peek([q('People', '')]).replace('"QueryString":""', '"QueryString": "x"'),
    peek([{ EntityType: 'People', Query: { QueryString: '', DisplayQueryString: 'x' } }]),
    peek([q('People', 'Supply chain\\" or x')]),
    JSON.stringify({ Scenario: { Name: 'peoplecache' }, EntityRequests: [q('People', '')] }),
    null,
  ];
  for (const b of held) for (const a of [PUB, PRIV]) assert.equal(v(a, b), 'hold', String(b));
  assert.equal(v(PUB, peek([{ EntityType: 'People', Query: { QueryString: null } }])), 'pass');
});
