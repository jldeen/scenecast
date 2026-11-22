// The replica in headless Chrome, rendered the way a real screenshot was taken: a state at its zoom (a fresh go to it,
// its app in front, the pointer parked), or a click side state (the control clicked, the pointer left on it). Shared by
// the real-vs-replica comparison and the fixer (which looks into the same rendering for causes).
import { at as __at } from '@stuntdouble/core/lib/at.mjs';
import { chromium } from 'playwright-core';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { bundleFlow } from '@stuntdouble/core/lib/demo.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function openReplica(demo, url) {
  const fileBase = new globalThis.URL(url).protocol === 'file:';
  const up = async () => { if (fileBase) return true; try { return (await fetch(new globalThis.URL('__replica/status', url))).ok; } catch (e) { return false; } };
  let server = null;
  if (!(await up())) {
    server = spawn(process.execPath, [__at('player/serve.mjs'), '--demo', demo.dir, '--port', String(new globalThis.URL(url).port)], { stdio: 'ignore', env: { ...process.env, REPLICA_NO_OPEN: '1' } });
    for (let i = 0; i < 80 && !(await up()); i++) await sleep(100);
  }
  const flow = await bundleFlow(url);
  const VP = demo.cfg.viewport;
  const browser = await chromium.launch({ channel: process.env.REPLICA_CHROME_CHANNEL || 'chrome', headless: true });
  const pages = new Map();
  // A page per zoom and pixel ratio (and lane: several render at once); it.viewport (the size a screen was recorded
  // at) resizes it to match.
  async function pageAt(z, dpr = VP.dpr, lane = 0) {
    const key = `${z}@${dpr}#${lane}`;
    if (pages.has(key)) return pages.get(key);
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
    if (it.viewport) {
      const want = { width: Math.round(it.viewport.width / zf), height: Math.round(it.viewport.height / zf) }, have = page.viewportSize();
      if (!have || have.width !== want.width || have.height !== want.height) { await page.setViewportSize(want); await idle(page); }
    }
    const vp = page.viewportSize();
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
  async function close() { await browser.close(); if (server) server.kill(); }
  return { flow, browser, pageAt, show, close };
}

// Where an app's document sits on the page (its iframe's offset), so screenshot regions map to its coordinates.
export const appOffset = (page, app) => page.evaluate(a => {
  let w = window.d1.doc(a).defaultView, x = 0, y = 0;
  while (w.frameElement) { const r = w.frameElement.getBoundingClientRect(); x += r.x; y += r.y; w = w.parent; }
  return { x, y };
}, app);
