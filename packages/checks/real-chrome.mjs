// A real Chrome (or Edge) for the checker: the installed browser, the same one a screen was recorded in, so the
// replica's text is drawn the way the real page's was (headless Chrome draws it differently: a screen of text read
// about 1% off, a zoomed one up to 5%, Nov 2026). Its own throwaway profile, at the page zoom the tab was recorded at
// (Chrome's ⌘+ / Ctrl+), and never on the presenter's screen: macOS starts it hidden in the background (open -g -j),
// Windows minimized and off-screen. Each page is its own window, so none is a background tab (those don't draw).
//   launchRealChrome({ zoom, channel }) → { browser, newPage(), close() } or null (no such browser here, or it didn't start)
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
    return existsSync(app) ? { app } : null;
  }
  if (process.platform === 'win32') {
    const rel = edge ? ['Microsoft', 'Edge', 'Application', 'msedge.exe'] : ['Google', 'Chrome', 'Application', 'chrome.exe'];
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]) {
      if (base && existsSync(join(base, ...rel))) return { exe: join(base, ...rel) };
    }
  }
  return null;
}

const freePort = () => new Promise((res, rej) => { const s = createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

// Chrome keeps page zoom as a level: zoom = 1.2^level.
export const zoomLevel = zoom => Math.log(zoom) / Math.log(1.2);

export async function launchRealChrome({ zoom = 1, channel = 'chrome', log = () => {} } = {}) {
  const where = browserApp(channel);
  if (!where) return null;
  const dir = mkdtempSync(join(tmpdir(), 'scenecast-checker-'));
  mkdirSync(join(dir, 'Default'), { recursive: true });
  writeFileSync(join(dir, 'Default', 'Preferences'), JSON.stringify({
    partition: { default_zoom_level: { x: zoomLevel(zoom) } },
    browser: { has_seen_welcome_page: true, check_default_browser: false },
  }));
  const port = await freePort();
  const flags = [`--user-data-dir=${dir}`, `--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check',
    '--disable-sync', '--disable-extensions', '--disable-background-networking', '--disable-component-update',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
    '--window-size=1600,1000', 'about:blank'];
  let child = null;
  if (where.app) child = spawn('open', ['-g', '-j', '-n', '-a', where.app, '--args', ...flags], { stdio: 'ignore' });
  else child = spawn(where.exe, ['--start-minimized', '--window-position=-32000,-32000', ...flags], { stdio: 'ignore', detached: false });
  child.on('error', e => log(`checker browser: ${e.message}`));
  let browser = null;
  for (let i = 0; i < 100 && !browser; i++) {
    await sleep(200);
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch (e) {}
  }
  const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch (e) {} };
  if (!browser) { log('checker browser: no answer on its port; using headless'); if (where.exe && child) child.kill(); cleanup(); return null; }
  const ctx = browser.contexts()[0];
  const top = await browser.newBrowserCDPSession();
  let first = ctx.pages()[0] || null, queue = Promise.resolve();
  // A window of its own for each page (the first is the one it started with), one at a time: two made at once could
  // both be handed the same page.
  const make = async () => {
    if (first) { const p = first; first = null; return p; }
    const { targetId } = await top.send('Target.createTarget', { url: 'about:blank', newWindow: true, background: true });
    for (let i = 0; i < 100; i++) {
      for (const p of ctx.pages()) { const s = await ctx.newCDPSession(p); const { targetInfo } = await s.send('Target.getTargetInfo').catch(() => ({})); await s.detach().catch(() => {}); if (targetInfo && targetInfo.targetId === targetId) return p; }
      await sleep(50);
    }
    throw new Error('the checker browser didn\'t open a window');
  };
  const newPage = () => (queue = queue.then(make, make));
  async function close() {
    await top.send('Browser.close').catch(() => {});
    await browser.close().catch(() => {});
    if (where.exe && child && child.exitCode === null) child.kill();
    for (let i = 0; i < 20; i++) { cleanup(); if (!existsSync(dir)) break; await sleep(150); }
  }
  return { browser, ctx, newPage, close };
}
