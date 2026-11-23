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
//           launch ('auto' | 'open' | 'direct': on macOS, through open unless on CI), log
//   cb.open(app | url, { light, viewport, window, width, height }) → Page   a window of its own, loaded
//   cb.twins(app | url, n, opts) → Page[]          n windows of one app at once, for side sweeps in parallel
//   cb.probe(page) → { raf, timer250, fonts, dark, hidden, size, screen, dpr }
//   cb.signedIn(apps) → { apps: [{ id, at: 'app' | 'signin' | 'blocked', host, secs }], cookies }
//   cb.guard({ hosts, allow, mode }) → { pass(fn, { hosts }), counts(), held(), stop() }
//   cb.info(), cb.cpu(), cb.close()
//   signInWindow({ profile, apps, timeoutS }) → { ok, secs, apps, cookies }   the one window that shows on her screen
//   launchRealChrome({ zoom, channel, log }) → { browser, ctx, newPage(), close() }   the checker's shape (Phase 6)
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';

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
export const platformWindow = (platform = process.platform) => platform === 'win32' ? 'offscreen' : 'minimized';
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
export const BLOCKED_TEXT = /can.t get there from here|you can.t access this|set up your device|device (?:is|isn.t|must be) (?:compliant|managed|registered)|help us keep your device secure|approve sign.in request/i;
export function landedOn(url, text = '', match = null) {
  let host = ''; try { host = new URL(url).host; } catch (e) {}
  if (BLOCKED_TEXT.test(text)) return { at: 'blocked', host };
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
// ('host/path-prefix', any method) or regular expressions over 'METHOD host/path'.
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:\d+)?$/i;
const hostIs = (host, h) => { const bare = host.replace(/:\d+$/, ''); return host === h || bare === h || bare.endsWith('.' + h); };
export function guardVerdict({ method, url }, { hosts = null, allow = [], local = false } = {}) {
  const m = String(method || 'GET').toUpperCase();
  if (READS.has(m)) return 'pass';
  let u; try { u = new URL(url); } catch (e) { return 'pass'; }
  if (!/^(https?|wss?):$/.test(u.protocol)) return 'pass';
  if (!local && LOOPBACK.test(u.host)) return 'pass';
  if (hosts && !hosts.some(h => hostIs(u.host, h))) return 'pass';
  const at = u.host + u.pathname;
  for (const a of allow) {
    const re = a instanceof RegExp ? a : typeof a === 'string' && /^\/.+\/[a-z]*$/.test(a) ? new RegExp(a.slice(1, a.lastIndexOf('/')), a.slice(a.lastIndexOf('/') + 1)) : null;
    if (re ? re.test(`${m} ${at}`) : at.startsWith(a)) return 'pass';
  }
  return 'hold';
}

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
  flags: extraFlags = [], extension = null, mockKeychain, launch = 'auto', width = 1600, height = 1000, log = () => {} } = {}) {
  const where = browserApp(channel);
  if (!where) { log(`capture browser: no ${channel} installed here`); return null; }
  const throwaway = !profile;
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
  const viaOpen = !!where.app && (launch === 'open' || (launch === 'auto' && !process.env.CI));
  const startDirect = () => {
    direct = true;
    const out = openSync(chromeLog, 'a');
    child = spawn(where.exe, [...(mode === 'visible' || where.app ? [] : ['--start-minimized', `--window-position=${OFF.left},${OFF.top}`]), ...flags], { stdio: ['ignore', out, out], detached: false });
    child.on('error', e => log(`capture browser: ${e.message}`));
  };
  if (viaOpen) {
    child = spawn('open', [...(mode === 'visible' ? [] : ['-g', '-j']), '-n', '--stdout', chromeLog, '--stderr', chromeLog, '-a', where.app, '--args', ...flags], { stdio: 'ignore' });
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
  const killAll = () => {
    if (process.platform === 'win32') { try { if (child) child.kill(); } catch (e) {} return; }
    const pids = (spawnSync('pgrep', ['-f', `user-data-dir=${dir}`], { encoding: 'utf8' }).stdout || '').split(/\s+/).filter(Boolean).map(Number);
    for (const pid of pids) try { process.kill(pid); } catch (e) {}
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

  // Read-only steps: every request that isn't a read, to a guarded host, held before it leaves (Fetch, on the browser:
  // every page and frame). pass(fn) lets them through while fn runs (a planned write). mode 'watch' only counts.
  // WebSocket messages don't go through Fetch: a guard doesn't cover them.
  let guarding = null;
  async function guard({ hosts = null, allow = [], mode: gm = 'hold', local = false } = {}) {
    if (guarding) await guarding.stop();
    const st = { open: [], counts: {}, held: [] };
    const passing = u => st.open.some(o => !o || o.some(h => hostIs(u.host, h)));
    const onPaused = async e => {
      const { method, url } = e.request;
      let u = null; try { u = new URL(url); } catch (x) {}
      let v = guardVerdict({ method, url }, { hosts, allow, local });
      if (v === 'hold' && u && passing(u)) v = 'pass';
      const k = `${v === 'hold' ? (gm === 'hold' ? 'held' : 'would hold') : 'passed'} ${method} ${u ? u.host : '?'}`;
      st.counts[k] = (st.counts[k] || 0) + 1;
      if (v === 'hold' && gm === 'hold') {
        st.held.push({ method, host: u && u.host, at: new Date().toISOString() });
        await top.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
      } else await top.send('Fetch.continueRequest', { requestId: e.requestId }).catch(() => {});
    };
    top.on('Fetch.requestPaused', onPaused);
    await top.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    guarding = {
      async pass(fn, { hosts: only = null } = {}) { const o = only; st.open.push(o); try { return await fn(); } finally { st.open.splice(st.open.indexOf(o), 1); } },
      counts: () => ({ ...st.counts }),
      held: () => st.held.slice(),
      async stop() { top.off('Fetch.requestPaused', onPaused); await top.send('Fetch.disable').catch(() => {}); guarding = null; },
    };
    return guarding;
  }

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
    if (guarding) await guarding.stop();
    await top.send('Browser.close').catch(() => {});
    await browser.close().catch(() => {});
    if (bpid) for (let i = 0; i < 30; i++) { if (!alive(bpid.id)) break; await sleep(150); if (i === 29) try { process.kill(bpid.id, 'SIGKILL'); } catch (e) {} }
    if (child && direct && child.exitCode === null) child.kill();
    killAll();
    for (let i = 0; i < 20; i++) { cleanup(); if (!throwaway || !existsSync(dir)) break; await sleep(150); }
  }
  return { browser, ctx, top, mode, port: at, open, twins, probe, signedIn, guard, info, cpu, close, dir };
}

// The one window that shows on her screen: the capture profile, visible, on the first app that needs a sign-in. She
// signs in there (and says Yes to staying signed in); it closes itself once every app lands on its own host.
export async function signInWindow({ profile, apps, channel = 'chrome', timeoutS = 600, viewport = { width: 1280, height: 800 }, flags = [], onState = () => {}, log = () => {} } = {}) {
  const cb = await openCaptureBrowser({ profile, channel, window: 'visible', light: false, flags, width: viewport.width, height: viewport.height, log });
  if (!cb) return { ok: false, error: 'the capture browser did not start' };
  const t0 = Date.now(), states = {};
  try {
    const p = await cb.open('about:blank', { window: 'visible', viewport: null, ...viewport, focus: false });
    // This one window comes to the front: it's hers to sign in on.
    await (await cb.ctx.newCDPSession(p)).send('Page.bringToFront').catch(() => {});
    for (;;) {
      for (const a of apps) {
        if (states[a.id] && states[a.id].at === 'app') continue;
        if (p.url().split('#')[0] !== a.url.split('#')[0]) await p.goto(a.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await p.waitForLoadState('load', { timeout: 30000 }).catch(() => {}); await sleep(4000);
        const text = await p.evaluate(() => document.body ? document.body.innerText.slice(0, 4000) : '').catch(() => '');
        states[a.id] = { ...landedOn(p.url(), text, a.match), secs: Math.round((Date.now() - t0) / 1000) };
        if (states[a.id].at !== 'app') break;
      }
      onState(apps.map(a => ({ id: a.id, at: states[a.id] ? states[a.id].at : null })));
      if (apps.every(a => states[a.id] && states[a.id].at === 'app') || Date.now() - t0 > timeoutS * 1000) break;
      await sleep(3000);
    }
    const ok = apps.every(a => states[a.id] && states[a.id].at === 'app');
    return { ok, secs: Math.round((Date.now() - t0) / 1000), apps: apps.map(a => ({ id: a.id, ...states[a.id] })), cookies: cookieExpiries(await cb.ctx.cookies()) };
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
