// The capture browser: the installed Chrome (or Edge) with a profile of its own, never the presenter's, and never on
// her screen. Recording runs in it over direct CDP: no extension, no debugging bar, unattended. It's opt-in (demo.json
// recorder: 'capture'); the presenter's own browser with the recorder extension stays the default.
// What it rests on (stage C, Nov 2026, measured on her Mac and on CI's Windows):
//   - Every page gets a window of its own: a background tab doesn't draw (0 rAF; a 250 ms timer fired at 1096 ms).
//   - With backgrounding off, a window off the screen draws exactly as one on it (0.000% apart), at full rAF, with
//     timers on time. macOS: minimized windows. Windows: a minimized window shrinks to a title bar and slows to
//     about 3 fps under work, so a normal window placed off every display. 'auto' picks by OS, probes a window, and
//     switches when it doesn't draw.
//   - A window can't be bigger than the display (her laptop's is 1512 × 982 points; a demo is 1920 × 1080), so each
//     page's viewport is emulated at the demo's size and pixel ratio.
//   - Recent Chrome ignores the debugging switches on its default profile folder: the profile is a folder of its own
//     (~/.stuntdouble/capture/<name>), signed in to the demo tenant once and kept; or a throwaway one.
//
//   openCaptureBrowser(opts) → CaptureBrowser, or null (no such browser here, or it didn't start; opts.log says why)
//     opts: profile (folder; null = throwaway), channel ('chrome' | 'msedge'),
//           window ('auto' | 'minimized' | 'offscreen' | 'visible'), viewport ({ width, height, dpr }: emulated),
//           light (true: pages draw light, as captures are), zoom (page zoom, throwaway profiles only),
//           flags (more Chrome switches, e.g. an app pack's), extension (an unpacked folder), mockKeychain,
//           launch ('auto' | 'open' | 'direct': on macOS, through open unless on CI),
//           macSso (true: the Mac's own single sign-on, as Chrome has it; false: off in this profile), log
//   cb.open(app | url, { light, viewport, window, width, height }) → Page   a window of its own, loaded
//   cb.twins(app | url, n, opts) → Page[]          n windows of one app at once, for side sweeps in parallel
//   cb.probe(page) → { raf, timer250, fonts, dark, hidden, size, screen, dpr }
//   cb.signedIn(apps) → { apps: [{ id, at: 'app' | 'signin' | 'blocked', host, secs }], cookies }
//   cb.guard({ hosts, allow, stayHeld, mode }) → { pass(fn, { hosts, method?, url? }), counts(), held(), stop() }
//   cb.pinAccount({ loginHint, domainHint }) → { pinned(), stop() }   no account picker at Entra's sign-in
//   cb.tenantsOf({ id: page }) → { id: [tenant ids] }                 what each page is signed in to
//   cb.info(), cb.cpu(), cb.close()
//   signInWindow({ profile, apps, timeoutS }) → { ok, secs, apps, cookies }   the one window that shows on her screen
//   launchRealChrome({ zoom, channel, log }) → { browser, ctx, newPage(), close() }   the checker's shape (Phase 6)
import { presenceBody } from './presence.mjs';
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { fencePath } from '@stuntdouble/core/lib/test-fence.mjs';
import { fetchEveryTarget } from './fetch-all.mjs';
import { filterBody } from './leave-out.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Where capture profiles live: outside every repository (a signed-in profile holds a tenant's cookies).
export const PROFILES = join(homedir(), '.stuntdouble', 'capture');
export const profileDir = name => join(PROFILES, name || 'default');

export function browserApp(channel = 'chrome') {
  const edge = /edge/i.test(channel);
  if (process.platform === 'darwin') {
    const app = edge ? '/Applications/Microsoft Edge.app' : '/Applications/Google Chrome.app';
    return existsSync(app) ? { app, exe: join(app, 'Contents', 'MacOS', edge ? 'Microsoft Edge' : 'Google Chrome') } : null;
  }
  if (process.platform === 'win32') {
    const rel = edge ? ['Microsoft', 'Edge', 'Application', 'msedge.exe'] : ['Google', 'Chrome', 'Application', 'chrome.exe'];
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]) {
      if (base && existsSync(join(base, ...rel))) return { exe: join(base, ...rel) };
    }
  }
  if (process.platform === 'linux') for (const exe of edge ? ['/usr/bin/microsoft-edge'] : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']) if (existsSync(exe)) return { exe };
  return null;
}

// The window mode that draws off the screen on this OS.
// Linux (a CI runner, no display): Chrome's own headless mode, the same browser and the same DevTools protocol, for
// what doesn't depend on drawing (the run, its writes and guard, the recorder's output).
export const platformWindow = (platform = process.platform) => platform === 'win32' ? 'offscreen' : platform === 'linux' ? 'headless' : 'minimized';
// The mode to try when this one doesn't draw here. Windows has none: a minimized window there passes a short probe
// and then barely draws under work (measured: 3 fps, screenshots timing out).
export const otherWindow = (mode, platform = process.platform) => mode === 'minimized' ? 'offscreen' : mode === 'offscreen' && platform !== 'win32' ? 'minimized' : null;
// Far off every display: macOS and Windows both keep a window there when the program places it.
const OFF = { left: -32000, top: -32000 };

// Why a window in this mode won't do for capture (from a probe of a page in it), or null when it draws as on screen.
export function windowTrouble(mode, p, want = null) {
  if (!p) return "its page didn't answer";
  if (p.hidden) return 'its page says it is hidden';
  if (p.raf < 30) return `its page drew ${p.raf} frames a second`;
  if (want && p.size && (p.size[0] < want.width * 0.9 || p.size[1] < want.height * 0.9)) return `its page was ${p.size[0]}×${p.size[1]}, not ${want.width}×${want.height}`;
  if (mode === 'offscreen' && p.screen && p.screen[0] > -10000 && p.screen[1] > -10000) return 'the system moved it onto a display';
  return null;
}

// Where an app's page landed: on the app, on a sign-in page, or stopped by a sign-in policy (conditional access).
// The sign-in hosts are flows/preflight.js's SIGN_IN; the policy words, the pages Entra shows for a device it won't let in.
export const SIGN_IN_HOST = /(^|\.)(login|signin|sign-in|auth|sso|accounts|adfs)[.-]|login\.microsoftonline\.com|login\.live\.com|accounts\.google\.com/i;
export const BLOCKED_TEXT = /can.t get there from here|you can.t access this|set up your device|device (?:is|isn.t|must be) (?:compliant|managed|registered)|help us keep your device secure/i;
// Pages on the way that aren't a block: a second factor, and "Stay signed in?" (what keeps the profile signed in).
export const MFA_TEXT = /approve (?:the )?sign.in request|verify your identity|enter (?:the )?code|authenticator app|number (?:shown|you see)/i;
export const KMSI_TEXT = /stay signed in\?/i;
// A signed-out page on the app's own host: its account picker, or a "sign in to start" landing (measured: M365
// Copilot shows one when the profile has more than one work account, as a managed Mac's single sign-on gives it).
export const SIGNED_OUT_TEXT = /\bpick an account\b|\bsign in to (?:start|continue|get started)\b/i;
export function landedOn(url, text = '', match = null) {
  let host = ''; try { host = new URL(url).host; } catch (e) {}
  if (BLOCKED_TEXT.test(text)) return { at: 'blocked', host };
  if (SIGNED_OUT_TEXT.test(text)) return { at: 'signin', host };
  if (match && host.includes(match)) return { at: 'app', host };
  if (SIGN_IN_HOST.test(host)) return { at: 'signin', host };
  return { at: 'app', host };
}

// The sign-in cookies' names, sites and expiry dates (never their values): how long the profile stays signed in.
const AUTH_COOKIE = /ESTSAUTH|SignInStateCookie|buid|fpc|x-ms-gateway|MSISAuth|AADSSO|user_session|_gh_sess|logged_in/i;
export const cookieExpiries = cookies => cookies.filter(c => AUTH_COOKIE.test(c.name)).map(c => ({
  name: c.name, domain: String(c.domain || '').replace(/^\./, '').split('.').slice(-2).join('.'),
  session: c.expires === -1, expires: c.expires > 0 ? new Date(c.expires * 1000).toISOString().slice(0, 10) : null,
}));

// The read-only guard's call on one request: a read (GET, HEAD, OPTIONS) passes; anything else to a guarded host is
// held, unless the allow-list names it. hosts: null guards every web host but this machine's own. allow: strings
// ('host/path-prefix', any method) or regular expressions over 'METHOD host/path', either with ' when body /regex/'
// after it for a request that only reads when its body says so (a listing with nothing typed in it): no body seen, no
// pass.
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:\d+)?$/i;
const hostIs = (host, h) => { const bare = host.replace(/:\d+$/, ''); return host === h || bare === h || bare.endsWith('.' + h); };
// What a planned write or an API undo opened, for one request: its hosts, and when given its method and exact address
// (an API undo opens that one call, not its host). Never every host.
export function openFor(open, u, method) {
  return (open || []).some(o => Array.isArray(o.hosts) && o.hosts.some(h => hostIs(u.host, h)) && (!o.method || o.method === String(method).toUpperCase()) && (!o.url || o.url === u.href));
}
// The origin of the page or frame that sent a request: its Origin, else its Referer's (a same-origin GET has no Origin).
const hostOfOrigin = o => { try { return new URL(o).host; } catch (e) { return null; } };
export function senderOrigin(headers) {
  const get = k => headers && (headers[k] || headers[k.toLowerCase()]);
  const o = get('Origin');
  if (o && o !== 'null') return o;
  try { return new URL(get('Referer')).origin; } catch (e) { return null; }
}
const reOf = s => s instanceof RegExp ? s : typeof s === 'string' && /^\/.+\/[a-z]*$/.test(s) ? new RegExp(s.slice(1, s.lastIndexOf('/')), s.slice(s.lastIndexOf('/') + 1)) : null;
// One guard entry (an allow entry, or a stay-held one) against a request: a regex over "METHOD host/path", else a
// host/path prefix; "… when body /regex/" also needs its body to match (a body it can't see doesn't).
function entryMatches(a, m, at, body) {
  const [req, when] = typeof a === 'string' && a.includes(' when body ') ? a.split(' when body ') : [a, null];
  const re = reOf(req);
  if (!(re ? re.test(`${m} ${at}`) : at.startsWith(req))) return false;
  if (when === null) return true;
  const bre = reOf(when);
  return !!(bre && typeof body === 'string' && bre.test(body));
}
export function guardVerdict({ method, url, body = null }, { hosts = null, allow = [], local = false } = {}) {
  const m = String(method || 'GET').toUpperCase();
  if (READS.has(m)) return 'pass';
  let u; try { u = new URL(url); } catch (e) { return 'pass'; }
  if (!/^(https?|wss?):$/.test(u.protocol)) return 'pass';
  if (!local && LOOPBACK.test(u.host)) return 'pass';
  if (hosts && !hosts.some(h => hostIs(u.host, h))) return 'pass';
  const at = u.host + u.pathname;
  return allow.some(a => entryMatches(a, m, at, body)) ? 'pass' : 'hold';
}
// A GraphQL call's operation, by name, from its body (for the record of what passed): its operationName, else the
// name after its first keyword. null for anything else.
export function graphqlOperation(body) {
  if (typeof body !== 'string' || !/"query"\s*:|"operationName"\s*:/.test(body)) return null;
  const n = /"operationName"\s*:\s*"([\w.-]{1,120})"/.exec(body) || /"query"\s*:\s*"\s*(?:query|mutation|subscription)\s+([A-Za-z_]\w{0,119})/.exec(body);
  return n ? n[1] : /"query"\s*:\s*"\s*(query|mutation|subscription)?/.test(body) ? '(anonymous)' : null;
}
// The allow entry that let a request through (for the record: passed non-reads by entry), or null.
export function allowedBy({ method, url, body = null }, allow = []) {
  let u; try { u = new URL(url); } catch (e) { return null; }
  const m = String(method || 'GET').toUpperCase();
  return (allow || []).find(a => entryMatches(a, m, u.host + u.pathname, body)) || null;
}
// A pack's stay-held entries: what an app sends by itself to a host its writes use (a refresh, a subscription), held
// even while a planned write opens that host. Same form as allow entries.
export function staysHeld({ method, url, body = null }, stayHeld = []) {
  let u; try { u = new URL(url); } catch (e) { return false; }
  const m = String(method || 'GET').toUpperCase();
  return (stayHeld || []).some(a => entryMatches(a, m, u.host + u.pathname, body));
}

// Entra's sign-in page asked for an account (authorize) gets the demo's account pinned: login_hint and domain_hint
// added, and an app's "pick an account" (prompt=select_account) dropped, so a profile holding more than one work
// account (a managed Mac's single sign-on offers its own) never stops on the picker. null when it isn't one.
const ENTRA = /^(login\.microsoftonline\.com|login\.microsoft\.com|login\.windows\.net)$/i;
export function pinnedAuthorizeUrl(url, { loginHint = null, domainHint = null } = {}) {
  let u; try { u = new URL(url); } catch (e) { return null; }
  if (!ENTRA.test(u.host) || !/\/oauth2(?:\/v2\.0)?\/authorize$/i.test(u.pathname)) return null;
  const q = u.searchParams; let changed = false;
  if (loginHint && !q.get('login_hint')) { q.set('login_hint', loginHint); changed = true; }
  if (domainHint && !q.get('domain_hint')) { q.set('domain_hint', domainHint); changed = true; }
  if (loginHint && q.get('prompt') === 'select_account') { q.delete('prompt'); changed = true; }
  return changed ? u.toString() : null;
}

// The tenants an app's sign-in library holds accounts for, from the names of what it keeps in the page's storage
// (MSAL's account and token keys: "<object id>.<tenant id>" then the sign-in host, "-login.windows.net-…" or
// "|login.windows.net|…"), never their values beyond MSAL's own key lists. Only that shape: Teams also keeps
// "tmp.<tenant id>.<object id>.…", where the second id is the user (measured: read as a second tenant otherwise).
const GUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const HOME_ACCOUNT = new RegExp(`(${GUID})\\.(${GUID})(?=[-|]login\\.)`, 'gi');
export const isTenantId = v => new RegExp(`^${GUID}$`, 'i').test(String(v || ''));
// The signed-in accounts' own object ids, from the same keys (the first id of "<object id>.<tenant id>"): who "she" is
// in an app's presence answers (presence.mjs). Never written anywhere but the log's count.
export function selfIdsInKeys(keys) {
  const out = new Set();
  for (const k of keys) for (const m of String(k).matchAll(HOME_ACCOUNT)) out.add(m[1].toLowerCase());
  return [...out];
}
export function tenantsInKeys(keys) {
  const out = new Set();
  for (const k of keys) for (const m of String(k).matchAll(HOME_ACCOUNT)) out.add(m[2].toLowerCase());
  return [...out];
}
// The verdict on what the pages are signed in to. want: the demo tenant's id. Any other tenant, or none to be seen
// where a tenant is wanted, is a refusal: a wrong account picked silently must never be recorded.
export function tenantVerdict(seen, want) {
  const all = [...new Set(Object.values(seen).flat())];
  if (!want) return all.length ? { ok: false, why: `signed in to ${all.length > 1 ? `${all.length} tenants` : 'a tenant'}, and the demo doesn't name its own (capture.tenant in demo.json)`, all } : { ok: true, all };
  const other = all.filter(t => t !== want.toLowerCase());
  if (other.length) return { ok: false, why: `signed in to another tenant (${other.join(', ')}), not the demo's`, all, other };
  const unseen = Object.entries(seen).filter(([, t]) => !t.length).map(([id]) => id);
  if (unseen.length) return { ok: false, why: `couldn't tell which tenant ${unseen.join(', ')} ${unseen.length > 1 ? 'are' : 'is'} signed in to`, all, unseen };
  return { ok: true, all };
}
// An app's own address with the demo account as its login_hint: for an app whose own landing asks which account
// (M365 Copilot's "Sign in to start"), which never reaches Entra's sign-in by itself. Measured: it signs straight in.
export function hintedUrl(url, loginHint) {
  if (!loginHint) return null;
  let u; try { u = new URL(url); } catch (e) { return null; }
  if (u.searchParams.get('login_hint')) return null;
  u.searchParams.set('login_hint', loginHint);
  return u.toString();
}
// An app's own signed-out landing (not Entra's sign-in page): where hintedUrl helps.
export const ownSignInPage = l => l.at === 'signin' && !!l.host && !SIGN_IN_HOST.test(l.host);

// A tenant named by its domain, as its id (Entra's public sign-in metadata says it).
export async function resolveTenant(nameOrId) {
  if (!nameOrId || isTenantId(nameOrId)) return nameOrId ? nameOrId.toLowerCase() : null;
  const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(nameOrId)}/v2.0/.well-known/openid-configuration`);
  const m = r.ok && new RegExp(`/(${GUID})/`, 'i').exec((await r.json()).issuer || '');
  if (!m) throw new Error(`no tenant called ${nameOrId}`);
  return m[1].toLowerCase();
}
// What a page's frames keep (key names; MSAL's own lists of its account keys), for tenantsInKeys.
export async function storageKeys(page) {
  const out = [];
  for (const f of page.frames()) {
    const ks = await f.evaluate(() => {
      const r = [];
      for (const st of [localStorage, sessionStorage]) {
        try { for (let i = 0; i < st.length; i++) { const k = st.key(i); r.push(k); if (/account\.keys$|\.account\.keys\b/i.test(k)) r.push(String(st.getItem(k) || '').slice(0, 20000)); } } catch (e) {}
      }
      return r;
    }).catch(() => []);
    out.push(...ks);
  }
  return out;
}

// A request's path as a shape, for the guard's log and a pack's allow-list: ids and long numbers as {id}, never a
// query string or a body.
export const pathShape = path => String(path || '/').split('/').map(seg => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) || /^\d{4,}$/.test(seg) || /^[A-Za-z0-9_-]{24,}$/.test(seg) && /\d/.test(seg) || /^[0-9a-f]{16,}$/i.test(seg) || /@/.test(seg) ? '{id}' : seg).join('/');

const freePort = () => new Promise((res, rej) => { const s = createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// A profile a running browser has open (Chrome hands a second start on it to the first, which never answers us).
export function profileInUse(dir) {
  if (process.platform === 'win32') {
    const f = join(dir, 'lockfile');
    if (!existsSync(f)) return null;
    try { rmSync(f); return null; } catch (e) { return 'in use'; }
  }
  try { const pid = +readlinkSync(join(dir, 'SingletonLock')).split('-').pop(); return pid && alive(pid) ? pid : null; } catch (e) { return null; }
}

// What a page is doing, from inside it: does it draw (rAF in a second), do timers run on time, is it visible and
// focused, light or dark, its size and where its window is, its fonts.
export const probe = page => page.evaluate(async () => {
  const r = { vis: document.visibilityState, hidden: document.hidden, focus: document.hasFocus(), dark: matchMedia('(prefers-color-scheme: dark)').matches,
    dpr: devicePixelRatio, size: [innerWidth, innerHeight], screen: [screenX, screenY] };
  r.raf = await new Promise(res => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else res(n); }; requestAnimationFrame(f); setTimeout(() => res(n), 2500); });
  const t1 = performance.now(); await new Promise(res => setTimeout(res, 250)); r.timer250 = Math.round(performance.now() - t1);
  await Promise.race([document.fonts.ready, new Promise(res => setTimeout(res, 3000))]);
  r.fonts = document.fonts.status; r.faces = [...document.fonts].filter(f => f.status === 'loaded').length; r.facesFailed = [...document.fonts].filter(f => f.status === 'error').length;
  return r;
});

const urlOf = t => typeof t === 'string' ? t : t && t.url || 'about:blank';
const PROBE_URL = 'data:text/html,<title>capture probe</title><body style="margin:0;background:%23fff">';

export async function openCaptureBrowser({ profile = null, channel = 'chrome', window: win = 'auto', viewport = null, light = true, zoom = 1,
  flags: extraFlags = [], extension = null, mockKeychain, launch = 'auto', macSso = true, activate = false, width = 1600, height = 1000, log = () => {} } = {}) {
  const where = browserApp(channel);
  if (!where) { log(`capture browser: no ${channel} installed here`); return null; }
  const throwaway = !profile;
  // A capture profile is signed in to a tenant: a selftest only ever uses one of its own.
  if (!throwaway) fencePath(profile, 'capture profile');
  const dir = throwaway ? mkdtempSync(join(tmpdir(), 'stuntdouble-capture-')) : resolve(profile);
  if (!throwaway) {
    mkdirSync(dir, { recursive: true });
    const busy = profileInUse(dir);
    if (busy) { log(`capture browser: the profile ${dir} is open in another browser (${busy}); close that one first`); return null; }
  }
  if (!existsSync(join(dir, 'Default', 'Preferences'))) {
    mkdirSync(join(dir, 'Default'), { recursive: true });
    writeFileSync(join(dir, 'Default', 'Preferences'), JSON.stringify({
      browser: { has_seen_welcome_page: true, check_default_browser: false },
      ...(throwaway && zoom !== 1 ? { partition: { default_zoom_level: { x: Math.log(zoom) / Math.log(1.2) } } } : {}),
    }));
  }
  // macOS single sign-on (Chrome's Extensible Enterprise SSO). It offers the Mac's own work accounts to every sign-in
  // page (Entra then shows its account picker), and it's also what signs a managed Mac's apps in at all: measured,
  // with it off the demo profile's own cookies signed in none of Copilot, the admin center and IQ. So it stays on,
  // and the demo's account is pinned (pinAccount, hintedUrl) and its tenant checked (tenantVerdict). Off (macSso:
  // false) is a Local State pref, this profile alone (the ExtensibleEnterpriseSSOBlocklist policy sets it
  // device-wide, where IT does; a policy still wins).
  // macSso: true puts Chrome's own default back (on), taking out a switch written before.
  if (process.platform === 'darwin') {
    const f = join(dir, 'Local State');
    let ls = null; try { ls = JSON.parse(readFileSync(f, 'utf8')); } catch (e) {}
    if (!macSso) {
      ls = ls || {};
      ls.extensible_enterprise_sso = { ...(ls.extensible_enterprise_sso || {}), enabled: 0, enabled_idps: [] };
      writeFileSync(f, JSON.stringify(ls));
    } else if (ls && ls.extensible_enterprise_sso && ('enabled' in ls.extensible_enterprise_sso || 'enabled_idps' in ls.extensible_enterprise_sso)) {
      delete ls.extensible_enterprise_sso.enabled; delete ls.extensible_enterprise_sso.enabled_idps;
      writeFileSync(f, JSON.stringify(ls));
    }
  }
  // A port the last run wrote must not be taken for this one's (another program could be on it now).
  rmSync(join(dir, 'DevToolsActivePort'), { force: true });
  let mode = win === 'auto' ? platformWindow() : win;
  const port = await freePort();
  const flags = [`--user-data-dir=${dir}`, `--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check',
    '--disable-sync', '--disable-background-networking', '--disable-component-update',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
    ...(extension ? ['--enable-unsafe-extension-debugging'] : ['--disable-extensions']),
    // A CI Mac's login keychain is locked: a new profile waits on it for its cookie key. Only throwaway profiles;
    // a signed-in one keeps the real keychain, so its cookies stay encrypted with it.
    ...(process.platform === 'darwin' && (mockKeychain ?? (throwaway && !!process.env.CI)) ? ['--use-mock-keychain'] : []),
    // The window it starts with is only an anchor: small, so the system never opens it maximized (one bigger than
    // the display does, and a maximized window won't minimize).
    ...extraFlags, '--window-size=800,600', 'about:blank'];
  const t0 = Date.now();
  const chromeLog = join(dir, 'chrome.log');
  let child = null, direct = false;
  // macOS: through open, hidden (-g: not brought forward, -j: launched hidden), so it never takes her screen. On CI
  // (and when open gets no answer) the browser's own binary instead: a CI Mac's first start through open waits on a
  // dialog no one can answer (measured: open never answered; the binary answered in 1 to 3 s).
  const viaOpen = !!where.app && mode !== 'headless' && (launch === 'open' || (launch === 'auto' && !process.env.CI));
  const startDirect = () => {
    direct = true;
    const out = openSync(chromeLog, 'a');
    const placed = mode === 'headless' ? ['--headless=new'] : mode === 'visible' || where.app ? [] : ['--start-minimized', `--window-position=${OFF.left},${OFF.top}`];
    child = spawn(where.exe, [...placed, ...flags], { stdio: ['ignore', out, out], detached: false });
    child.on('error', e => log(`capture browser: ${e.message}`));
  };
  if (viaOpen) {
    // Visible windows never take focus either (-g), unless asked (the sign-in window: hers to type in).
    child = spawn('open', [...(mode === 'visible' ? (activate ? [] : ['-g']) : ['-g', '-j']), '-n', '--stdout', chromeLog, '--stderr', chromeLog, '-a', where.app, '--args', ...flags], { stdio: 'ignore' });
    child.on('error', e => log(`capture browser: ${e.message}`));
  } else startDirect();
  let browser = null, at = port;
  const answer = async ms => {
    for (const end = Date.now() + ms; !browser && Date.now() < end;) {
      await sleep(200);
      try { const f = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0]; if (+f) at = +f; } catch (e) {}
      try { if ((await fetch(`http://127.0.0.1:${at}/json/version`)).ok) browser = await chromium.connectOverCDP(`http://127.0.0.1:${at}`); } catch (e) {}
    }
  };
  const cleanup = () => { if (throwaway) try { rmSync(dir, { recursive: true, force: true }); } catch (e) {} };
  // Every process of this browser: its profile folder is in each one's command line.
  const killAll = (sig = 'SIGTERM') => {
    if (process.platform === 'win32') { try { if (child) child.kill(); } catch (e) {} return 0; }
    const pids = (spawnSync('pgrep', ['-f', `user-data-dir=${dir}`], { encoding: 'utf8' }).stdout || '').split(/\s+/).filter(Boolean).map(Number);
    for (const pid of pids) try { process.kill(pid, sig); } catch (e) {}
    return pids.length;
  };
  // Up to 90 s: a browser's first start on a machine can take a while. The port it says it opened counts too.
  await answer(viaOpen ? 30000 : 90000);
  if (!browser && viaOpen) {
    log('capture browser: no answer through open in 30 s; starting its binary instead');
    killAll(); await sleep(500); rmSync(join(dir, 'DevToolsActivePort'), { force: true }); at = port;
    startDirect(); await answer(60000);
  }
  if (!browser) {
    let said = ''; try { said = readFileSync(chromeLog, 'utf8').trim().split('\n').slice(-12).join('\n'); } catch (e) {}
    log(`capture browser: no answer on port ${at} in 90 s${said ? `; it said:\n${said}` : ''}`);
    killAll(); if (child && direct) child.kill(); cleanup(); return null;
  }
  const startMs = Date.now() - t0;
  const ctx = browser.contexts()[0];
  const top = await browser.newBrowserCDPSession();
  if (extension) await top.send('Extensions.loadUnpacked', { path: extension });
  const place = async (targetId, st) => {
    const w = await top.send('Browser.getWindowForTarget', { targetId }).catch(() => null);
    if (!w) return null;
    // Maximized or full screen goes to normal first: from there it minimizes, or moves.
    if (st !== 'visible' && /maximized|fullscreen/.test(w.bounds.windowState)) await top.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: 'normal' } }).catch(() => {});
    if (st === 'minimized') await top.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: 'minimized' } }).catch(() => {});
    if (st === 'offscreen') await top.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: 'normal', ...OFF } }).catch(() => {});
    return w.windowId;
  };
  const anchor = ctx.pages()[0] || null;
  for (const t of (await top.send('Target.getTargets')).targetInfos.filter(t => t.type === 'page')) await place(t.targetId, mode === 'visible' ? 'minimized' : mode);
  const pageOf = async targetId => {
    for (let i = 0; i < 200; i++) {
      for (const p of ctx.pages()) {
        if (p.__sdTarget === targetId) return p;
        if (p.__sdTarget) continue;
        const s = await ctx.newCDPSession(p); const { targetInfo } = await s.send('Target.getTargetInfo').catch(() => ({})); await s.detach().catch(() => {});
        if (targetInfo) p.__sdTarget = targetInfo.targetId;
        if (targetInfo && targetInfo.targetId === targetId) return p;
      }
      await sleep(50);
    }
    throw new Error("the capture browser didn't open a window");
  };
  if (anchor) { anchor.bringToFront = async () => {}; }
  // A window's own bars, measured once on the anchor (an empty window that keeps the browser up): a page's window is
  // its viewport plus them.
  let bars = { x: 0, y: 0 };
  if (anchor) { const [ow, oh, iw, ih] = await anchor.evaluate(() => [outerWidth, outerHeight, innerWidth, innerHeight]).catch(() => [0, 0, 0, 0]); bars = { x: Math.max(0, ow - iw), y: Math.max(0, oh - ih) }; }

  // A page as capture wants it: light (Playwright emulates light on every page it attaches to; null clears it),
  // focused as far as it can tell, at the demo's viewport, and never raised (in real Chrome bringToFront raises and
  // un-minimizes the window: onto her screen).
  const raw = ctx.newCDPSession.bind(ctx);
  const prepare = async (p, { light: lt, focus = true, emulate }) => {
    const s = await raw(p);
    await p.emulateMedia({ colorScheme: lt ? 'light' : null });
    if (focus) await s.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    const base = emulate && { width: emulate.width, height: emulate.height, deviceScaleFactor: emulate.dpr || 0, mobile: false };
    if (base) await s.send('Emulation.setDeviceMetricsOverride', base);
    p.__sd = { session: s, base };
    p.bringToFront = async () => {};
    // Shots as the extension takes them (the page's surface, the text caret hidden), at the page's pixel ratio
    // whatever the display's (a window's surface is drawn at the display's: 2 on her Mac, 1 on a Windows laptop at
    // 100%). Measured: a shot re-applies the emulation of the session it's taken through (Playwright's own put the
    // display's ratio back), so it's taken through the session that set the page's metrics last, at its size.
    if (base) {
      p.__sd.cur = { send: s.send.bind(s), params: base };
      p.screenshot = async (o = {}) => {
        const own = p.__sd.cur;
        const hide = '(() => { if (document.getElementById("__sc_caret")) return; const s = document.createElement("style"); s.id = "__sc_caret"; s.textContent = "*,*::before,*::after{caret-color:transparent !important}"; (document.head || document.documentElement).appendChild(s); })()';
        await own.send('Runtime.evaluate', { expression: hide }).catch(() => {});
        try {
          const shoot = params => Promise.race([own.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false, ...params }),
            sleep(o.timeout || 60000).then(() => { throw new Error('screenshot timed out'); })]);
          // A shot comes out at CSS size × clip scale × the display's ratio × the emulated one (measured), so the
          // display's ratio is measured once and divided out; with no ratio emulated, the display's is the page's.
          const dsf = own.params.deviceScaleFactor || 0;
          if (!p.__sd.display) { const t = Buffer.from((await shoot({ clip: { x: 0, y: 0, width: 10, height: 10, scale: 1 } })).data, 'base64'); p.__sd.display = (t.readUInt32BE(16) / 10) / (dsf || 1) || 1; }
          const scale = dsf ? 1 / p.__sd.display : 1;
          const c = o.clip || { x: 0, y: 0, width: own.params.width, height: own.params.height };
          const r = await shoot({ clip: { x: c.x, y: c.y, width: c.width, height: c.height, scale } });
          return Buffer.from(r.data, 'base64');
        } finally { await own.send('Runtime.evaluate', { expression: 'document.getElementById("__sc_caret")?.remove()' }).catch(() => {}); }
      };
    }
    return p;
  };
  let queue = Promise.resolve();
  const make = async ({ light: lt = light, viewport: vp = viewport, window: st = mode, focus = true, width: w, height: h } = {}) => {
    const size = vp ? { width: vp.width, height: vp.height } : { width: w || width, height: h || height };
    const { targetId } = await top.send('Target.createTarget', { url: 'about:blank', newWindow: true, background: true, width: size.width + bars.x, height: size.height + bars.y,
      ...(st === 'minimized' ? { windowState: 'minimized' } : st === 'offscreen' ? OFF : {}) });
    await place(targetId, st);
    const p = await prepare(await pageOf(targetId), { light: lt, focus, emulate: vp });
    // A page at its window's size: the window fitted from its own bars (the anchor's are wrong where it starts
    // minimized, as on Windows). A minimized window can't be sized; it keeps the size it was made at.
    if (!vp && st !== 'minimized') {
      const [ow, oh, iw, ih] = await p.evaluate(() => [outerWidth, outerHeight, innerWidth, innerHeight]).catch(() => [0, 0, 0, 0]);
      if (iw && (Math.abs(iw - size.width) > 1 || Math.abs(ih - size.height) > 1)) {
        const w = await top.send('Browser.getWindowForTarget', { targetId }).catch(() => null);
        if (w) await top.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { width: size.width + ow - iw, height: size.height + oh - ih } }).catch(() => {});
      }
    }
    return p;
  };
  // One window made at a time (two made at once could both be handed the same page); they load side by side.
  const open = async (target, opts) => {
    const r = queue.then(() => make(opts)); queue = r.catch(() => {});
    const p = await r, url = urlOf(target);
    if (url !== 'about:blank') await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(e => log(`capture browser: ${url}: ${e.message.split('\n')[0]}`));
    return p;
  };

  // 'auto': a probe page in a window of the OS's mode; one that doesn't draw (or isn't the size asked, or the system
  // moved onto a display) switches to the other mode.
  let fellBack = null;
  if (win === 'auto') {
    const want = { width: 800, height: 600 };
    // Up to three probes: a browser still starting draws slowly at first (measured: 11 fps on a busy CI runner).
    const trial = async m => {
      const p = await open(PROBE_URL, { window: m, viewport: null, ...want });
      let why = null;
      for (let i = 0; i < 3; i++) { why = windowTrouble(m, await probe(p).catch(() => null), want); if (!why) break; await sleep(700); }
      await p.close().catch(() => {});
      return why;
    };
    const why = await trial(mode);
    if (why) {
      const alt = otherWindow(mode), why2 = alt ? await trial(alt) : 'no other mode here';
      fellBack = { from: mode, to: why2 ? null : alt, why, ...(why2 ? { altWhy: why2 } : {}) };
      log(`capture browser: ${mode} windows won't do here (${why})${why2 ? `; ${alt} won't either (${why2})` : `: using ${alt} windows`}`);
      if (!why2) mode = alt;
    }
  }

  // The base an emulated viewport goes back to. The recorder's zoom and chip sweeps end by clearing the override (in
  // the presenter's browser that's the window's own size again); here the demo's viewport comes back. Measured: the
  // base set again on the session that cleared takes; after a detach, the page's own session has to clear and set
  // (setting what it had set before is ignored). Only a session that changed the metrics: one that didn't (closed
  // shadow roots, a snapshot's) detaching mid-zoom must leave the zoom as it is.
  ctx.newCDPSession = async p => {
    const s = await raw(p);
    const base = () => p.__sd && p.__sd.base;
    const send = s.send.bind(s), detach = s.detach.bind(s);
    let touched = false;
    s.send = async (m, params) => {
      if (m === 'Emulation.setDeviceMetricsOverride' || m === 'Emulation.clearDeviceMetricsOverride') touched = true;
      const r = await send(m, params);
      if (m === 'Emulation.setDeviceMetricsOverride' && p.__sd) p.__sd.cur = { send, params };
      if (m === 'Emulation.clearDeviceMetricsOverride' && base()) { await send('Emulation.setDeviceMetricsOverride', base()).catch(() => {}); p.__sd.cur = { send, params: base() }; }
      return r;
    };
    s.detach = async () => {
      const r = await detach();
      if (touched && base()) {
        const own = p.__sd.session;
        await own.send('Emulation.clearDeviceMetricsOverride').catch(() => {}); await own.send('Emulation.setDeviceMetricsOverride', base()).catch(() => {});
        p.__sd.cur = { send: own.send.bind(own), params: base() };
      }
      return r;
    };
    return s;
  };
  // A page the recorder (or anything else) opens through the context gets a window of its own too.
  ctx.newPage = () => open('about:blank');

  const twins = (target, n, opts) => Promise.all(Array.from({ length: n }, () => open(target, opts)));
  const procs = async () => (await top.send('SystemInfo.getProcessInfo').catch(() => ({ processInfo: [] }))).processInfo;
  const bpid = (await procs()).find(x => x.type === 'browser');
  const kill = () => { try { if (bpid) process.kill(bpid.id); else if (child && child.pid) child.kill(); } catch (e) {} killAll(); cleanup(); };
  process.once('exit', kill);
  const onSignal = () => { kill(); process.exit(1); };
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, onSignal);

  // Signed in? Each app in a window of its own, side by side: where it lands.
  async function signedIn(apps, { settleMs = 5000 } = {}) {
    const t0 = Date.now();
    const out = await Promise.all(apps.map(async a => {
      const t = Date.now(); const p = await open(a);
      await p.waitForLoadState('load', { timeout: 60000 }).catch(() => {}); await sleep(settleMs);
      const text = await p.evaluate(() => document.body ? document.body.innerText.slice(0, 4000) : '').catch(() => '');
      const r = { id: a.id, ...landedOn(p.url(), text, a.match), secs: +((Date.now() - t) / 1000).toFixed(1) };
      await p.close().catch(() => {});
      return r;
    }));
    return { ok: out.every(r => r.at === 'app'), apps: out, cookies: cookieExpiries(await ctx.cookies()), secs: +((Date.now() - t0) / 1000).toFixed(1) };
  }

  // One Fetch dispatcher on every target (fetch-all.mjs: each page, frame and worker, now and new): the read-only
  // guard and the pinned account each add a hook with the requests it wants; a hook may change the address or fail
  // the request. A response hook (response: true, Leave out) sees what comes back and may give the page another body.
  const hooks = new Set();
  let everyTarget = null;
  const onPaused = async (e, from = {}) => {
    let url = e.request.url;
    for (const h of hooks) {
      if (h.response) continue;
      const r = await h.on(e.request, url, from).catch(() => null);
      if (r && r.fail) return { fail: true };
      if (r && r.url) url = r.url;
    }
    return url !== e.request.url ? { url } : null;
  };
  const onResponse = async (e, from = {}) => {
    for (const h of hooks) {
      if (!h.response) continue;
      const r = await h.on(e, from);
      if (r && typeof r.body === 'string') return r;
    }
    return null;
  };
  const refetch = async () => {
    const req = [...hooks].filter(h => !h.response).flatMap(h => h.patterns), res = [...hooks].filter(h => h.response).flatMap(h => h.patterns);
    if (!req.length && !res.length) { if (everyTarget) await everyTarget.set(null); return; }
    if (!everyTarget) everyTarget = await fetchEveryTarget(at, { onPaused, onResponse, log });
    // A request that matches both is paused twice: before it goes (the guard), and at its response (Leave out).
    await everyTarget.set([...(req.some(p => p.urlPattern === '*' && !p.resourceType) ? [{ urlPattern: '*', requestStage: 'Request' }] : req), ...res]);
  };
  const addHook = async h => { hooks.add(h); await refetch(); return async () => { hooks.delete(h); await refetch(); }; };

  // Read-only steps: every request that isn't a read, to a guarded host, held before it leaves. pass(fn) lets them
  // through while fn runs (a planned write). mode 'watch' only counts. WebSocket messages don't go through Fetch:
  // a guard doesn't cover them. A new guard replaces the one on: its hook goes in before the old one comes out, so no
  // request ever goes by with neither.
  let guarding = null;
  // keepBodies: entries (as allow's) whose held requests' bodies it keeps, for a person to review (local only).
  async function guard({ hosts = null, allow = [], stayHeld = [], keepBodies = [], mode: gm = 'hold', local = false } = {}) {
    const prev = guarding;
    const st = { open: [], counts: {}, held: [], passed: [], bodies: [], authFor: null, authFrom: null, auth: null };
    // What's open: a planned write's hosts, or one call (its method and exact address). Never every host.
    const passing = (u, method) => openFor(st.open, u, method);
    const remove = await addHook({ patterns: [{ urlPattern: '*', requestStage: 'Request' }], on: async ({ method, postData, headers }, url, from = {}) => {
      let u = null; try { u = new URL(url); } catch (x) {}
      // Who sent it: the tab (its page's host) and the frame (the document's origin, from its Origin or Referer; else
      // the target's own address), not the time it came: a background tab sends during another app's step.
      const hostOfUrl = x => { try { return new URL(x).host || null; } catch (y) { return null; } };
      const sender = { tab: hostOfUrl(from.page), frame: hostOfOrigin(senderOrigin(headers)) || hostOfUrl(from.target && from.target.url), ...(from.target && from.target.type !== 'page' && from.target.type !== 'iframe' ? { by: from.target.type } : {}) };
      // An API undo's session: the Authorization the page itself sends to that host, kept in memory for the one call,
      // and which page or frame sent it (the call goes from there: the API's CORS rules allow the app's own frame).
      if (st.authFor && u && st.authFor.test(u.host)) {
        const a = headers && (headers.Authorization || headers.authorization), from = senderOrigin(headers);
        if (a && (!st.authFrom || (from && hostOfOrigin(from) === st.authFrom))) st.auth = { origin: u.origin, host: u.host, value: a, from };
      }
      let v = guardVerdict({ method, url, body: postData }, { hosts, allow, local }), by = v === 'pass' ? 'allowed' : null;
      // Open for a planned write, unless it's one of the app's own background calls a pack keeps held (stay).
      let stay = false;
      if (v === 'hold' && u && passing(u, method)) { if (staysHeld({ method, url, body: postData }, stayHeld)) stay = true; else { v = 'pass'; by = 'a planned write'; } }
      const k = `${v === 'hold' ? (gm === 'hold' ? 'held' : 'would hold') : 'passed'} ${method} ${u ? u.host : '?'}`;
      st.counts[k] = (st.counts[k] || 0) + 1;
      if (v === 'hold') {
        st.held.push({ method, host: u && u.host, path: u ? pathShape(u.pathname) : '', at: new Date().toISOString(), held: gm === 'hold', ...sender, ...(stay ? { duringWrite: true } : {}) });
        if (u && keepBodies.length && staysHeld({ method, url, body: postData }, keepBodies)) st.bodies.push({ method, host: u.host, path: u.pathname, at: new Date().toISOString(), body: postData == null ? null : String(postData).slice(0, 4000) });
      }
      // Every non-read that went out, and why: the allow-list (or a read, a local or an unguarded host), or a planned
      // write's opening.
      else if (!READS.has(String(method).toUpperCase()) && u && /^(https?|wss?):$/.test(u.protocol)) st.passed.push({ method, host: u.host, path: pathShape(u.pathname), at: new Date().toISOString(), by, ...sender, ...(by === 'allowed' && /graphql/i.test(u.pathname) && graphqlOperation(postData) ? { operation: graphqlOperation(postData) } : {}), ...(by === 'allowed' ? { entry: allowedBy({ method, url, body: postData }, allow) } : {}) });
      if (v === 'hold' && gm === 'hold') return { fail: true };
      return null;
    } });
    guarding = {
      // Open for fn's while: those hosts (a planned write), or with method and url, that one call only. No hosts: refused.
      async pass(fn, { hosts = null, method = null, url = null } = {}) {
        if (!Array.isArray(hosts) || !hosts.length) throw new Error('the guard opens only for named hosts');
        const o = { hosts, method: method ? String(method).toUpperCase() : null, url };
        st.open.push(o);
        try { return await fn(); } finally { st.open.splice(st.open.indexOf(o), 1); }
      },
      counts: () => ({ ...st.counts }),
      held: () => st.held.slice(),
      passed: () => st.passed.slice(),
      bodies: () => st.bodies.slice(),
      // Arm (a host pattern) or disarm (null) catching an API's session; take() hands it over once and forgets it.
      // from: only a call sent by the page or frame on that host (IQ's Power BI frame, not the portal around it).
      watchAuth(re, from = null) { st.authFor = re; st.authFrom = from; st.auth = null; },
      takeAuth() { const a = st.auth; st.auth = null; st.authFor = null; st.authFrom = null; return a; },
      peekAuth() { return !!st.auth; },
      async stop() { await remove(); if (guarding === me) guarding = null; },
    };
    const me = guarding;
    if (prev) await prev.stop();
    return me;
  }

  // Notifications "denied" for these sites, never "granted" (one granted would pop up on her screen): a fresh profile's
  // "ask" makes an app nag for it (Teams' "Turn on desktop notifications" banner), and no recording had that banner.
  async function denyNotifications(origins) {
    const out = [];
    for (const origin of origins) {
      const r = await top.send('Browser.setPermission', { permission: { name: 'notifications' }, setting: 'denied', origin }).then(() => 'denied', e => e.message);
      out.push({ origin, r });
    }
    return out;
  }

  // Leave out (reset.md, leave-out.mjs): each rule's responses (url: where they come from, for the browser; match: as a
  // guard entry over "METHOD host/path") filtered before the page has them, in every tab, frame and worker. The request
  // goes as it was; the page gets the body without the items. One that can't be read or no longer has its list goes on
  // as it came, and is logged as a failure (the run stops before that app's screens). A new set replaces the one on.
  let leaving = null;
  async function leaveOut(rules = []) {
    const prev = leaving;
    const st = { rules: rules.map(r => ({ id: r.id, app: r.app || null, requests: [], removed: [], failures: [] })) };
    const ruleLog = id => st.rules.find(x => x.id === id);
    const at2 = () => new Date().toISOString();
    const remove = rules.length ? await addHook({ response: true, patterns: rules.map(r => ({ urlPattern: r.url, requestStage: 'Response' })), on: async (e, from) => {
      if (e.responseStatusCode < 200 || e.responseStatusCode >= 300) return null;
      const mine = rules.filter(r => allowedBy({ method: e.request.method, url: e.request.url }, [r.match]));
      if (!mine.length) return null;
      let u = null; try { u = new URL(e.request.url); } catch (x) {}
      const where = { method: e.request.method, host: u ? u.host : '?', path: u ? pathShape(u.pathname) : '' };
      let text;
      try { text = await from.body(); } catch (x) { for (const r of mine) ruleLog(r.id).failures.push({ at: at2(), ...where, why: `its body couldn't be read (${String(x.message || x).split('\n')[0]})` }); return null; }
      const f = filterBody(text, mine);
      if (!f.ok) { for (const r of mine) ruleLog(r.id).failures.push({ at: at2(), ...where, why: f.why }); log(`leave out: ${where.method} ${where.host}${where.path}: ${f.why}`); return null; }
      for (const r of mine) {
        const gone = f.removed.filter(x => x.rule === r.id), l = ruleLog(r.id);
        l.requests.push({ at: at2(), ...where, removed: gone.length, kept: f.kept[r.id] || 0, ...(gone.length ? { refs: f.refs } : {}) });
        for (const x of gone) if (!l.removed.some(y => y.value === x.value && y.field === x.field && y.shows === x.shows)) l.removed.push({ field: x.field, value: x.value, shows: x.shows });
      }
      if (f.removed.length) log(`leave out: ${where.method} ${where.host}${where.path}: ${f.removed.length} left out${f.refs ? `, ${f.refs} references` : ''}`);
      return f.removed.length ? { body: f.body } : null;
    } }) : async () => {};
    leaving = { log: () => JSON.parse(JSON.stringify(st.rules)), async stop() { await remove(); if (leaving === me) leaving = null; } };
    const me = leaving;
    if (prev) await prev.stop();
    return me;
  }

  // Her own presence (presence.mjs): in each rule's answers (url, a browser request pattern; match, a guard entry over
  // "METHOD host/path"), the entries naming one of ids read as status. Requests go out unchanged; only the body the
  // page is given changes. → { log(), stop() }
  let presencing = null;
  async function presence(rules = []) {
    const prev = presencing;
    const st = { rules: rules.map(r => ({ id: r.id, app: r.app || null, answers: 0, changed: 0, failures: [] })) };
    const remove = rules.length ? await addHook({ response: true, patterns: rules.map(r => ({ urlPattern: r.url, requestStage: 'Response' })), on: async (e, from) => {
      if (e.responseStatusCode < 200 || e.responseStatusCode >= 300) return null;
      const r = rules.find(x => allowedBy({ method: e.request.method, url: e.request.url }, [x.match]));
      if (!r) return null;
      const l = st.rules.find(x => x.id === r.id);
      let text; try { text = await from.body(); } catch (x) { l.failures.push({ at: new Date().toISOString(), why: `its body couldn't be read (${String(x.message || x).split('\n')[0]})` }); return null; }
      const ids = typeof r.ids === 'function' ? await r.ids().catch(() => []) : r.ids;
      const f = presenceBody(text, ids, r.status);
      l.answers++;
      if (!f.ok) { l.failures.push({ at: new Date().toISOString(), why: f.why }); return null; }
      if (!f.changed) return null;
      l.changed++;
      return { body: f.body };
    } }) : async () => {};
    presencing = { log: () => JSON.parse(JSON.stringify(st.rules)), async stop() { await remove(); if (presencing === me) presencing = null; } };
    const me = presencing;
    if (prev) await prev.stop();
    return me;
  }
  const selfIdsOf = async p => selfIdsInKeys(await storageKeys(p));

  // The demo's account, pinned at Entra's sign-in (pinnedAuthorizeUrl): no account picker, whatever else the
  // profile holds. Counts how often it pinned.
  async function pinAccount({ loginHint = null, domainHint = null } = {}) {
    let n = 0;
    const remove = await addHook({ patterns: ['login.microsoftonline.com', 'login.microsoft.com', 'login.windows.net'].map(h => ({ urlPattern: `*://${h}/*authorize*`, resourceType: 'Document', requestStage: 'Request' })),
      on: async (req, url) => { const to = pinnedAuthorizeUrl(url, { loginHint, domainHint }); if (to) n++; return to ? { url: to } : null; } });
    return { pinned: () => n, stop: remove };
  }

  // Which tenants each page is signed in to (tenantsInKeys over its storage's key names, every frame).
  const tenantsOf = async pages => Object.fromEntries(await Promise.all(Object.entries(pages).map(async ([id, p]) => [id, tenantsInKeys(await storageKeys(p))])));

  const info = async () => {
    const wins = [];
    for (const t of (await top.send('Target.getTargets')).targetInfos.filter(t => t.type === 'page')) {
      const w = await top.send('Browser.getWindowForTarget', { targetId: t.targetId }).catch(() => null);
      if (w) wins.push({ state: w.bounds.windowState, left: w.bounds.left, top: w.bounds.top, width: w.bounds.width, height: w.bounds.height });
    }
    return { mode, fellBack, startMs, port: at, pid: bpid && bpid.id, profile: throwaway ? null : dir, wins };
  };
  // CPU seconds the browser's processes have used so far (browser, GPU, renderers).
  const cpu = async () => (await procs()).reduce((n, x) => n + (x.cpuTime || 0), 0);
  async function close() {
    process.removeListener('exit', kill);
    for (const sig of ['SIGINT', 'SIGTERM']) process.removeListener(sig, onSignal);
    hooks.clear(); if (everyTarget) await everyTarget.close().catch(() => {});
    await top.send('Browser.close').catch(() => {});
    await browser.close().catch(() => {});
    if (bpid) for (let i = 0; i < 30; i++) { if (!alive(bpid.id)) break; await sleep(150); if (i === 29) try { process.kill(bpid.id, 'SIGKILL'); } catch (e) {} }
    if (child && direct && child.exitCode === null) child.kill();
    // Every helper of this browser gone before it returns (one slow to exit under load outlived it).
    for (let i = 0; i < 20 && killAll(); i++) await sleep(150);
    killAll('SIGKILL');
    for (let i = 0; i < 20; i++) { cleanup(); if (!throwaway || !existsSync(dir)) break; await sleep(150); }
  }
  return { browser, ctx, top, mode, port: at, open, twins, probe, signedIn, guard, leaveOut, presence, selfIdsOf, pinAccount, denyNotifications, tenantsOf, info, cpu, close, dir };
}

// The one window that shows on her screen: the capture profile, visible, on the first app that needs a sign-in. She
// signs in there (and says Yes to staying signed in); it closes itself once every app lands on its own host.
export async function signInWindow({ profile, apps, channel = 'chrome', timeoutS = 600, viewport = { width: 1280, height: 800 }, flags = [], pin = null, onState = () => {}, log = () => {} } = {}) {
  const cb = await openCaptureBrowser({ profile, channel, window: 'visible', activate: true, light: false, flags, width: viewport.width, height: viewport.height, log });
  if (!cb) return { ok: false, error: 'the capture browser did not start' };
  if (pin) await cb.pinAccount(pin);
  const t0 = Date.now(), states = {}, tenants = {};
  try {
    const p = await cb.open('about:blank', { window: 'visible', viewport: null, ...viewport, focus: false });
    // This one window comes to the front: it's hers to sign in on.
    await (await cb.ctx.newCDPSession(p)).send('Page.bringToFront').catch(() => {});
    const seen = new Set();
    const read = async a => {
      const text = await p.evaluate(() => document.body ? document.body.innerText.slice(0, 4000) : '').catch(() => '');
      const l = landedOn(p.url(), text, a.match);
      if (l.at === 'signin' && MFA_TEXT.test(text)) seen.add('mfa');
      if (l.at === 'signin' && KMSI_TEXT.test(text)) seen.add('stay-signed-in');
      if (l.at === 'blocked') seen.add('blocked');
      return l;
    };
    // Each app in turn: opened once, then only watched. While it's on a sign-in or policy page the page is hers:
    // nothing navigates under her. It counts as signed in once it's been on the app for three looks in a row.
    for (const a of apps) {
      await p.goto(a.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      let onApp = 0, last = null, hinted = false;
      while (Date.now() - t0 < timeoutS * 1000) {
        await p.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
        await sleep(3000);
        const l = await read(a);
        if (!last || l.at !== last.at) { states[a.id] = { ...l, secs: Math.round((Date.now() - t0) / 1000) }; onState(apps.map(x => ({ id: x.id, at: states[x.id] ? states[x.id].at : null }))); }
        last = l;
        // The app's own "which account" landing: once, its address with the demo account as the hint.
        if (!hinted && pin && ownSignInPage(l)) { hinted = true; const to = hintedUrl(a.url, pin.loginHint); if (to) { await p.goto(to, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}); continue; } }
        // Three looks in a row: an app can redirect to its sign-in seconds after it loads.
        if (l.at === 'app') { if (++onApp >= 3) { tenants[a.id] = tenantsInKeys(await storageKeys(p)); break; } } else onApp = 0;
      }
      if (!(states[a.id] && states[a.id].at === 'app')) break;
    }
    const ok = apps.every(a => states[a.id] && states[a.id].at === 'app');
    return { ok, secs: Math.round((Date.now() - t0) / 1000), seen: [...seen], tenants, apps: apps.map(a => ({ id: a.id, ...states[a.id] })), cookies: cookieExpiries(await cb.ctx.cookies()) };
  } finally { await cb.close(); }
}

// The checker's real Chrome (packages/checks/real-chrome.mjs, Phase 6), from this launcher: a throwaway profile at a
// page zoom, every window off the screen (on Windows too, where a minimized one barely draws), newPage() a window of
// its own at 1600 × 1000, light as Playwright makes every page it attaches to.
export async function launchRealChrome({ zoom = 1, channel = 'chrome', log = () => {} } = {}) {
  const cb = await openCaptureBrowser({ channel, zoom, width: 1600, height: 1000, log: s => log(s.replace('capture browser', 'checker browser')) });
  if (!cb) return null;
  return { browser: cb.browser, ctx: cb.ctx, newPage: () => cb.open('about:blank', { focus: false }), close: cb.close };
}
