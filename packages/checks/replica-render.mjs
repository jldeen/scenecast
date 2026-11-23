// The replica in headless Chrome, rendered the way a real screenshot was taken: a state at its zoom (a fresh go to it,
// its app in front, the pointer parked), or a click side state (the control clicked, the pointer left on it). Shared by
// the real-vs-replica comparison and the fixer (which looks into the same rendering for causes).
import { chromium } from 'playwright-core';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { bundleFlow } from '../kit/lib/demo.mjs';
import { launchRealChrome } from './real-chrome.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// The page zoom a take was recorded at: saved with it (viewport.zoom), else read from an older recording's pixel ratio
// (2.2 on a 2x screen is 110%).
const STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
export function zoomOf(vp) {
  if (vp && vp.zoom > 0) return vp.zoom;
  const dpr = (vp && vp.dpr) || 1, z = dpr / Math.max(1, Math.round(dpr));
  const near = STEPS.reduce((a, b) => (Math.abs(b - z) < Math.abs(a - z) ? b : a), 1);
  return Math.abs(near - z) < 0.02 ? near : 1;
}

export async function openReplica(demo, url, kit) {
  const fileBase = new globalThis.URL(url).protocol === 'file:';
  const up = async () => { if (fileBase) return true; try { return (await fetch(new globalThis.URL('__replica/status', url))).ok; } catch (e) { return false; } };
  let server = null;
  if (!(await up())) {
    server = spawn(process.execPath, [join(kit, 'player/serve.mjs'), '--demo', demo.dir, '--port', String(new globalThis.URL(url).port)], { stdio: 'ignore', env: { ...process.env, REPLICA_NO_OPEN: '1' } });
    for (let i = 0; i < 80 && !(await up()); i++) await sleep(100);
  }
  const flow = await bundleFlow(url);
  const VP = demo.cfg.viewport;
  // Recorded in the presenter's Chrome or Edge: the replica is drawn in that browser too, as it was recorded (same page
  // zoom, same pixel ratio, its text drawn the same way). Chromium (the tests) stays headless. SCENECAST_CHECKER=
  // headless|real forces either.
  const mode = process.env.SCENECAST_CHECKER || (/^(chrome|msedge)$/.test(VP.browser || '') ? 'real' : 'headless');
  const zoom = zoomOf(VP);
  const real = mode === 'real' ? await launchRealChrome({ zoom, channel: VP.browser === 'msedge' ? 'msedge' : (demo.cfg.chrome && demo.cfg.chrome.channel) || 'chrome' }) : null;
  const browser = real ? real.browser : await chromium.launch({ channel: process.env.REPLICA_CHROME_CHANNEL || 'chrome', headless: true });
  // Comparing pictures needs no real browser.
  const cmpBrowser = real ? await chromium.launch({ headless: true }) : browser;
  const pages = new Map();
  // The tab's own size (before page zoom), as the recorder saw it; an older recording has only the page's width,
  // rounded down (1374 CSS px at 110% is a 1512 px tab: 1374 x 1.1 = 1511.4, up).
  const tabOf = v => v.tabWidth ? { width: v.tabWidth, height: v.tabHeight }
    : VP.tabWidth && v.width === VP.width && v.height === VP.height ? { width: VP.tabWidth, height: VP.tabHeight }
    : { width: Math.ceil(v.width * zoom - 0.01), height: Math.ceil(v.height * zoom - 0.01) };
  // A page per zoom and pixel ratio (and lane: several render at once); it.viewport (the size a screen was recorded
  // at) resizes it to match.
  async function pageAt(z, dpr = VP.dpr, lane = 0) {
    const key = real ? `#${lane}` : `${z}@${dpr}#${lane}`;
    if (pages.has(key)) return pages.get(key);
    if (real) {
      const page = await real.newPage();
      page.__cdp = await page.context().newCDPSession(page);
      // Its size before it loads (the app lays out once at the size it was recorded at, as the real page had).
      const m = { ...tabOf(VP), deviceScaleFactor: VP.dpr / zoom, mobile: false };
      await page.__cdp.send('Emulation.setDeviceMetricsOverride', m); page.__metrics = JSON.stringify(m);
      await page.goto(url);
      await page.waitForFunction(() => window.d1 && window.d1.state.active);
      pages.set(key, page);
      return page;
    }
    const zf = z / 100;
    const ctx = await browser.newContext({ viewport: { width: Math.round(VP.width / zf), height: Math.round(VP.height / zf) }, deviceScaleFactor: dpr * zf });
    const page = await ctx.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.d1 && window.d1.state.active);
    pages.set(key, page);
    return page;
  }
  const idle = page => page.evaluate(() => window.d1.idle());
  // it: { app, state, z, click?: { name, ctl, frame } } → the page, showing it (or { error }). Each lane has its own pages.
  async function show(it, lane = 0) {
    const z = it.z || 100, zf = z / 100;
    const page = await pageAt(z, it.viewport ? it.viewport.dpr : VP.dpr, lane);
    if (real) {
      // As the recorder had it: at 100% the window's own size at the screen's pixel ratio (the page zoom does the
      // rest); a zoom level by the recorder's own override (recSide zoom), with the page zoom still on.
      const v = it.viewport || VP, dpr = v.dpr || VP.dpr;
      // A zoom level: the recorder's own override (saved with it); an older recording's, worked out as it did.
      const m = z === 100 ? { ...tabOf(v), deviceScaleFactor: dpr / zoom, mobile: false } : it.ov ? { ...it.ov }
        : { width: Math.round(v.width / zf), height: Math.round(v.height / zf), deviceScaleFactor: dpr * zf, mobile: false };
      if (JSON.stringify(m) !== page.__metrics) { await page.__cdp.send('Emulation.setDeviceMetricsOverride', m); page.__metrics = JSON.stringify(m); await idle(page); }
    } else if (it.viewport) {
      const want = { width: Math.round(it.viewport.width / zf), height: Math.round(it.viewport.height / zf) }, have = page.viewportSize();
      if (!have || have.width !== want.width || have.height !== want.height) { await page.setViewportSize(want); await idle(page); }
    }
    const vp = page.viewportSize() || await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await page.mouse.move(vp.width - 1, 2);
    await page.evaluate(([a, s]) => window.d1.go(a, s), [it.app, it.state]); await idle(page);
    await page.evaluate(a => window.d1.activate(a), it.app);
    await page.mouse.move(vp.width - 1, 2); await idle(page); await sleep(120);
    if (it.click) {
      const m = { ...it.click.ctl, frame: it.click.frame };
      await page.evaluate(([m, a]) => window.d1.reveal(m, a), [m, it.app]); await sleep(150);
      const ctl = await page.evaluate(([m, a]) => window.d1.locate(m, a), [m, it.app]);
      if (!ctl || !ctl.w) return { error: `the control "${it.click.name}" isn't on ${it.state}` };
      await page.mouse.move(ctl.x, ctl.y, { steps: 3 }); await sleep(250); await page.mouse.click(ctl.x, ctl.y);
      await sleep(300); await idle(page);
    }
    return { page };
  }
  // The screen as the recorder took it (in a real browser, the tab's own capture at its pixel ratio).
  const shoot = async page => real ? Buffer.from((await page.__cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')
    : page.screenshot({ animations: 'disabled', caret: 'hide' });
  async function close() { if (real) { await real.close(); await cmpBrowser.close(); } else await browser.close(); if (server) server.kill(); }
  return { flow, browser, cmpBrowser, real: !!real, zoom, pageAt, show, shoot, close };
}

// Where an app's document sits on the page (its iframe's offset), so screenshot regions map to its coordinates.
export const appOffset = (page, app) => page.evaluate(a => {
  let w = window.d1.doc(a).defaultView, x = 0, y = 0;
  while (w.frameElement) { const r = w.frameElement.getBoundingClientRect(); x += r.x; y += r.y; w = w.parent; }
  return { x, y };
}, app);
