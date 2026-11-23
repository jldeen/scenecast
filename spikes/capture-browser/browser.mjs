// Spike (stage C): the capture browser. The installed Chrome (or Edge) with a profile of its own, never the
// presenter's, every window off her screen, throttling off, each page in a window of its own (a background tab
// doesn't draw). From v0.5.3's packages/checks/real-chrome.mjs (Phase 6), with what capture needs on top:
//   - a persistent profile (signed in to the demo tenant once), or a throwaway one
//   - mode: 'minimized' (every window minimized at birth), 'offscreen' (a normal window placed off every display),
//     'visible' (on screen: baselines only, on CI or in a sitting), 'headless' (Chrome's headless, for comparison)
//   - per page: light (prefers-color-scheme emulated), focus emulated, bringToFront inert (in real Chrome it raises
//     and un-minimizes the window: onto her screen), and the context's newPage gives a window of its own too
//   - the recorder extension loaded unpacked, for comparing the two recorders in the same browser
//   launchCaptureBrowser(opts) → { browser, ctx, newPage({ url, light, width, height }), info(), close() } or null
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  if (process.platform === 'linux') for (const exe of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']) if (existsSync(exe)) return { exe };
  return null;
}

const freePort = () => new Promise((res, rej) => { const s = createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

// Far off every display: macOS and Windows both keep a window there when it's placed by the program.
const OFF = { left: -32000, top: -32000 };

export async function launchCaptureBrowser({ profile = null, mode = 'minimized', channel = 'chrome', extension = null, width = 1600, height = 1000, log = () => {} } = {}) {
  if (mode === 'headless') {
    const browser = await chromium.launch({ channel, headless: true, args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
    const ctx = await browser.newContext({ viewport: null, deviceScaleFactor: undefined });
    const newPage = async ({ url = 'about:blank', light = true, width: w = width, height: h = height } = {}) => {
      const p = await ctx.newPage(); await p.setViewportSize({ width: w, height: h });
      if (light) await p.emulateMedia({ colorScheme: 'light' });
      if (url !== 'about:blank') await p.goto(url);
      return p;
    };
    return { browser, ctx, newPage, info: async () => ({ mode }), close: () => browser.close() };
  }
  const where = browserApp(channel);
  if (!where) return null;
  const throwaway = !profile;
  const dir = profile || mkdtempSync(join(tmpdir(), 'stuntdouble-capture-'));
  if (!existsSync(join(dir, 'Default', 'Preferences'))) {
    mkdirSync(join(dir, 'Default'), { recursive: true });
    writeFileSync(join(dir, 'Default', 'Preferences'), JSON.stringify({ browser: { has_seen_welcome_page: true, check_default_browser: false } }));
  }
  const port = await freePort();
  const flags = [`--user-data-dir=${dir}`, `--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check',
    '--disable-sync', '--disable-background-networking', '--disable-component-update',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
    ...(extension ? ['--enable-unsafe-extension-debugging'] : ['--disable-extensions']),
    `--window-size=${width},${height}`, 'about:blank'];
  let child = null;
  const t0 = Date.now();
  if (where.app && mode !== 'visible') child = spawn('open', ['-g', '-j', '-n', '-a', where.app, '--args', ...flags], { stdio: 'ignore' });
  else if (where.app) child = spawn('open', ['-n', '-a', where.app, '--args', ...flags], { stdio: 'ignore' });
  else child = spawn(where.exe, [...(mode === 'visible' ? [] : ['--start-minimized', `--window-position=${OFF.left},${OFF.top}`]), ...flags], { stdio: 'ignore', detached: false });
  child.on('error', e => log(`capture browser: ${e.message}`));
  let browser = null;
  for (let i = 0; i < 150 && !browser; i++) {
    await sleep(200);
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch (e) {}
  }
  const cleanup = () => { if (throwaway) try { rmSync(dir, { recursive: true, force: true }); } catch (e) {} };
  if (!browser) { log('capture browser: no answer on its port'); if (child && !where.app) child.kill(); cleanup(); return null; }
  const startMs = Date.now() - t0;
  const ctx = browser.contexts()[0];
  const top = await browser.newBrowserCDPSession();
  if (extension) await top.send('Extensions.loadUnpacked', { path: extension });
  const place = async targetId => {
    const w = await top.send('Browser.getWindowForTarget', { targetId }).catch(() => null);
    if (!w) return null;
    if (mode === 'minimized') await top.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: 'minimized' } }).catch(() => {});
    if (mode === 'offscreen') await top.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: 'normal', ...OFF } }).catch(() => {});
    return w.windowId;
  };
  const first = ctx.pages()[0] || null;
  for (const t of (await top.send('Target.getTargets')).targetInfos.filter(t => t.type === 'page')) await place(t.targetId);
  const pageOf = async targetId => {
    for (let i = 0; i < 200; i++) {
      for (const p of ctx.pages()) { if (p.__sdTarget === targetId) return p; const s = await ctx.newCDPSession(p); const { targetInfo } = await s.send('Target.getTargetInfo').catch(() => ({})); await s.detach().catch(() => {}); if (targetInfo) p.__sdTarget = targetInfo.targetId; if (targetInfo && targetInfo.targetId === targetId) return p; }
      await sleep(50);
    }
    throw new Error('the capture browser didn\'t open a window');
  };
  // A page as capture wants it: light, focused as far as it can tell, never raised onto the screen.
  // Playwright already emulates light (and focus) on every page it attaches to; light: false clears it (the OS's).
  // viewport 'emulated': the page is laid out at exactly width × height × dpr whatever the window (a window can't be
  // bigger than the display: her laptop's is 1512 × 982 points, a demo is 1920 × 1080).
  const prepare = async (p, { light = true, focus = true, emulate = null } = {}) => {
    const s = await rawSession(p);
    await p.emulateMedia({ colorScheme: light ? 'light' : null });
    if (focus) await s.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    const base = emulate && { width: emulate.width, height: emulate.height, deviceScaleFactor: emulate.dpr || 0, mobile: false };
    if (base) await s.send('Emulation.setDeviceMetricsOverride', base);
    p.__sd = { session: s, base };
    p.bringToFront = async () => {};
    return p;
  };
  // The window Chrome started with stays an empty anchor (minimized): it measures a window's own bars and keeps the
  // browser up; every page gets a new window, sized so its viewport is exactly what was asked.
  let queue = Promise.resolve(), firstFree = null;
  if (first) { first.bringToFront = async () => {}; }
  // The page's viewport is exactly width × height: a window's own bars are measured once and added.
  let bars = null;
  if (first) { const [ow, oh, iw, ih] = await first.evaluate(() => [outerWidth, outerHeight, innerWidth, innerHeight]); bars = { x: ow - iw, y: oh - ih }; }
  const make = async ({ url = 'about:blank', light = true, focus = true, width: w = width, height: h = height, viewport = 'window', dpr = 0 } = {}) => {
    let p;
    const emulate = viewport === 'emulated' ? { width: w, height: h, dpr } : null;
    if (firstFree) { p = firstFree; firstFree = null; await prepare(p, { light, focus, emulate }); }
    else {
      const extra = bars || { x: 0, y: 0 };
      const { targetId } = await top.send('Target.createTarget', { url: 'about:blank', newWindow: true, background: true, width: w + extra.x, height: h + extra.y,
        ...(mode === 'minimized' ? { windowState: 'minimized' } : mode === 'offscreen' ? OFF : {}) });
      await place(targetId);
      p = await prepare(await pageOf(targetId), { light, focus, emulate });
    }

    if (url !== 'about:blank') await p.goto(url, { waitUntil: 'domcontentloaded' });
    return p;
  };
  const newPage = opts => (queue = queue.then(() => make(opts), () => make(opts)));
  // An emulated viewport is the page's base: the recorder's zoom and chip sweeps end by clearing the override (in her
  // Chrome that's the window's own size again); here the base comes back. (Build: the recorder restores the page's
  // base metrics instead of clearing them.)
  const rawSession = ctx.newCDPSession.bind(ctx);
  ctx.newCDPSession = async p => {
    const s = await rawSession(p);
    const restore = () => p.__sd && p.__sd.base ? p.__sd.session.send('Emulation.setDeviceMetricsOverride', p.__sd.base).catch(() => {}) : null;
    const send = s.send.bind(s), detach = s.detach.bind(s);
    s.send = async (m, params) => { const r = await send(m, params); if (m === 'Emulation.clearDeviceMetricsOverride') await restore(); return r; };
    s.detach = async () => { const r = await detach(); await restore(); return r; };
    return s;
  };
  // The recorder (and anything else) opening a page through the context gets a window of its own too.
  const ctxNewPage = ctx.newPage.bind(ctx);
  ctx.newPage = (url, o) => newPage(typeof url === 'string' ? { url } : {});
  ctx.__sdNewPageRaw = ctxNewPage;
  const procs = async () => (await top.send('SystemInfo.getProcessInfo').catch(() => ({ processInfo: [] }))).processInfo;
  const bpid = (await procs()).find(x => x.type === 'browser');
  const kill = () => { try { if (bpid) process.kill(bpid.id); else if (child && child.pid) child.kill(); } catch (e) {} cleanup(); };
  process.once('exit', kill);
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { kill(); process.exit(1); });
  const info = async () => {
    const wins = [];
    for (const t of (await top.send('Target.getTargets')).targetInfos.filter(t => t.type === 'page')) {
      const w = await top.send('Browser.getWindowForTarget', { targetId: t.targetId }).catch(() => null);
      if (w) wins.push({ url: t.url.slice(0, 80), state: w.bounds.windowState, left: w.bounds.left, top: w.bounds.top, width: w.bounds.width, height: w.bounds.height });
    }
    return { mode, startMs, pid: bpid && bpid.id, dir, wins };
  };
  // CPU seconds the browser's processes have used so far (all of them: browser, GPU, renderers).
  const cpu = async () => (await procs()).reduce((n, x) => n + (x.cpuTime || 0), 0);
  async function close() {
    process.removeListener('exit', kill);
    await top.send('Browser.close').catch(() => {});
    await browser.close().catch(() => {});
    if (bpid) for (let i = 0; i < 30; i++) { try { process.kill(bpid.id, 0); } catch (e) { break; } await sleep(150); if (i === 29) try { process.kill(bpid.id, 'SIGKILL'); } catch (e) {} }
    if (child && !where.app && child.exitCode === null) child.kill();
    for (let i = 0; i < 20; i++) { cleanup(); if (!throwaway || !existsSync(dir)) break; await sleep(150); }
  }
  return { browser, ctx, top, newPage, info, cpu, close, dir };
}

// What a page is doing, from inside it: does it draw (rAF in a second), do timers run on time, is it visible and
// focused, light or dark, its fonts.
export const probe = page => page.evaluate(async () => {
  const r = { vis: document.visibilityState, hidden: document.hidden, focus: document.hasFocus(), dark: matchMedia('(prefers-color-scheme: dark)').matches,
    dpr: devicePixelRatio, size: [innerWidth, innerHeight], screen: [screenX, screenY] };
  r.raf = await new Promise(res => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else res(n); }; requestAnimationFrame(f); setTimeout(() => res(n), 2500); });
  const t1 = performance.now(); await new Promise(res => setTimeout(res, 250)); r.timer250 = Math.round(performance.now() - t1);
  await Promise.race([document.fonts.ready, new Promise(res => setTimeout(res, 3000))]);
  r.fonts = document.fonts.status; r.faces = [...document.fonts].filter(f => f.status === 'loaded').length; r.facesFailed = [...document.fonts].filter(f => f.status === 'error').length;
  return r;
});
