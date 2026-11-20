// Shared helpers for the variant spikes: a static server for a built demo's data folder (snaps + assets) and
// headless Chrome pages showing one captured screen at its recorded viewport. No network: the pages load only
// from the local server.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { chromium } from 'playwright-core';

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.ico': 'image/x-icon' };

// roots: { '/': dataDir, '/sd/': otherDir, ... } longest prefix wins.
export async function serve(roots) {
  const map = Object.entries(roots).sort((a, b) => b[0].length - a[0].length);
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const [prefix, dir] = map.find(([p]) => path.startsWith(p)) || [];
    if (!dir) { res.writeHead(404).end(); return; }
    const file = normalize(join(dir, path.slice(prefix.length)));
    if (!file.startsWith(normalize(dir))) { res.writeHead(403).end(); return; }
    try {
      if (!(await stat(file)).isFile()) throw new Error('dir');
      res.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'max-age=3600' });
      res.end(await readFile(file));
    } catch (e) { res.writeHead(404).end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

export const launch = () => chromium.launch({ channel: process.env.REPLICA_CHROME_CHANNEL || 'chrome', headless: true });

// vp: { w, h, dpr }. Blocks every request that isn't the local server, so a stray absolute URL can't reach a tenant.
export async function openSnap(browser, base, snap, vp, { colorScheme = 'light' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: vp.dpr || 1, colorScheme });
  await ctx.route(u => !u.href.startsWith(base) && !u.href.startsWith('data:') && !u.href.startsWith('about:'), r => r.abort());
  const page = await ctx.newPage();
  await page.goto(`${base}/snaps/${snap}.html`, { waitUntil: 'load' });
  await settle(page);
  return page;
}

// Fonts loaded, scroll offsets restored (the player does this from data-d1-scroll), two frames painted.
export async function settle(page) {
  for (const f of page.frames()) {
    await f.evaluate(async () => {
      for (const el of document.querySelectorAll('[data-d1-scroll]')) { const [t, l] = el.getAttribute('data-d1-scroll').split(',').map(Number); el.scrollTop = t; el.scrollLeft = l; }
      await document.fonts.ready;
      // A capture is a still: entrance animations (cards fading in) shown at their end.
      for (const a of document.getAnimations()) { try { a.finish(); } catch (e) {} }
    }).catch(() => {});
  }
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
