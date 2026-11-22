// Renders processed snapshots (data/snaps/<id>.html, through the replica server) in headless system Chrome at
// 1920×1080 CSS, 2x, and compares each with its real capture (raw shots/<id>.png). Writes side-by-side PNGs.
// A quick look at one capture without the shell (to see whether a problem is in the capture or in the replay).
//   node checks/render-check.mjs --demo <dir> <id> [id...]   (scenecast serve must be running)
import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadDemo } from '@stuntdouble/core/lib/demo.mjs';

const demo = loadDemo(process.argv.slice(2));
const RAW = demo.raw;
const OUT = join(demo.out, 'render-check');
mkdirSync(OUT, { recursive: true });
const ids = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--demo');
const browser = await chromium.launch({ channel: process.env.REPLICA_CHROME_CHANNEL || 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: demo.cfg.viewport.width, height: demo.cfg.viewport.height }, deviceScaleFactor: demo.cfg.viewport.dpr });
const page = await ctx.newPage();
const errs = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.text().slice(0, 200)); });
page.on('requestfailed', r => errs.push('failed ' + r.url().slice(0, 120)));
page.on('response', r => { if (r.status() >= 400) errs.push(r.status() + ' ' + r.url().slice(0, 120)); });
const results = [];
for (const id of ids) {
  errs.length = 0;
  await page.goto(`${demo.url}snaps/${id}.html`, { waitUntil: 'load' });
  // what the shell does after load: restore scroll offsets, canvases, popovers
  await page.evaluate(() => {
    const all = [document, ...[...document.querySelectorAll('iframe')].map(f => f.contentDocument).filter(Boolean)];
    for (const d of all) for (const el of d.querySelectorAll('[data-d1-scroll]')) { const [t, l] = el.getAttribute('data-d1-scroll').split(',').map(Number); el.scrollTop = t; el.scrollLeft = l; }
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(800);
  const shot = await page.screenshot();
  writeFileSync(join(OUT, `${id}-replica.png`), shot);
  const real = readFileSync(join(RAW, 'shots', `${id}.png`));
  const diff = await page.evaluate(async ([a, b]) => {
    const load = src => new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = 'data:image/png;base64,' + src; });
    const [A, B] = await Promise.all([load(a), load(b)]);
    const w = Math.min(A.width, B.width), h = Math.min(A.height, B.height);
    const c = new OffscreenCanvas(w, h), g = c.getContext('2d');
    g.drawImage(A, 0, 0); const da = g.getImageData(0, 0, w, h).data;
    g.clearRect(0, 0, w, h); g.drawImage(B, 0, 0); const db = g.getImageData(0, 0, w, h).data;
    let bad = 0; const rows = new Array(Math.ceil(h / 40)).fill(0);
    for (let i = 0; i < da.length; i += 4) { if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 60) { bad++; rows[Math.floor((i / 4) / w / 40)]++; } }
    return { size: [A.width, A.height, B.width, B.height], pct: +(100 * bad / (w * h)).toFixed(3), worstBands: rows.map((n, i) => [i * 40, n]).sort((x, y) => y[1] - x[1]).slice(0, 4) };
  }, [shot.toString('base64'), real.toString('base64')]);
  results.push({ id, ...diff, console: [...new Set(errs)].slice(0, 8) });
}
console.log(JSON.stringify(results, null, 1));
await browser.close();
