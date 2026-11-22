// The Install recorder step cards' pictures: the real chrome://extensions and edge://extensions pages, with what to
// click ringed. Run again when a browser changes its page:
//   node apps/desktop/scripts/setup-shots.mjs [chromium] [msedge]      (the repo's npm ci and Playwright's browsers)
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { buildExtension } from '../../../packages/capture/build.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '..', 'ui', 'img', 'setup');
const want = process.argv.slice(2).length ? process.argv.slice(2) : ['chromium', 'msedge'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

async function ring(page, loc, label, widen) {
  let box = await loc.boundingBox();
  if (box && widen) box = widen(box);
  if (!box) throw new Error(`not on the page: ${label}`);
  await page.evaluate(({ box, label }) => {
    for (const el of document.querySelectorAll('[data-sc-ring]')) el.remove();
    const pad = 6, r = document.createElement('div');
    r.dataset.scRing = '1';
    Object.assign(r.style, { position: 'fixed', left: `${box.x - pad}px`, top: `${box.y - pad}px`, width: `${box.width + pad * 2}px`, height: `${box.height + pad * 2}px`, border: '3px solid #d1242f', borderRadius: '10px', boxShadow: '0 0 0 4px rgba(209,36,47,.18)', zIndex: 2147483647, pointerEvents: 'none' });
    document.documentElement.append(r);
  }, { box, label });
}
async function shoot(page, name, clip) {
  await sleep(500);
  await page.screenshot({ path: join(OUT, name), clip });
  console.log(join(OUT, name));
}

for (const channel of want) {
  const tmp = mkdtempSync(join(tmpdir(), 'sc-shots-'));
  const ext = join(tmp, 'Recorder Extension');
  buildExtension(ext, 47621);
  const edge = channel === 'msedge', pre = edge ? 'edge' : 'chrome';
  // Each picture cut to what it's about (Edge puts Developer mode at the bottom of its side bar).
  const clips = edge ? [0, 1, 2].map(() => ({ x: 0, y: 0, width: 1240, height: 500 }))
    : [{ x: 0, y: 0, width: 1100, height: 440 }, { x: 0, y: 0, width: 1100, height: 440 }, { x: 0, y: 0, width: 1100, height: 440 }];
  const ctx = await chromium.launchPersistentContext(join(tmp, 'profile'), {
    channel, headless: true, viewport: edge ? { width: 1240, height: 500 } : { width: 1100, height: 640 }, deviceScaleFactor: 1, colorScheme: 'light', ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging', '--lang=en-US'],
  });
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(`${pre}://extensions`);
    await sleep(1500);
    const dev = edge ? page.getByText('Developer mode', { exact: true }).first() : page.locator('#devMode');
    // 1 · Developer mode, off (Edge's switch sits at the end of its label's row).
    await ring(page, dev, 'Developer mode', edge ? b => ({ x: b.x - 6, y: b.y - 2, width: 245, height: b.height + 4 }) : null);
    await shoot(page, `${pre}-1-developer-mode.png`, clips[0]);
    if (edge) { const b = await dev.boundingBox(); await page.mouse.click(b.x + 217, b.y + b.height / 2); } else await dev.click();
    await sleep(800);
    // 2 · Load unpacked (or drag the folder onto the page).
    const load = edge ? page.getByText('Load unpacked', { exact: true }).first() : page.locator('#loadUnpacked');
    await ring(page, load, 'Load unpacked');
    await shoot(page, `${pre}-2-load-unpacked.png`, clips[1]);
    // 3 · Loaded: the recorder's card, and its reload icon (after an update).
    const cdp = await ctx.browser()?.newBrowserCDPSession().catch(() => null) || await ctx.newCDPSession(page);
    await cdp.send('Extensions.loadUnpacked', { path: ext });
    await page.reload();
    await sleep(1500);
    const reload = edge ? page.getByText('Reload', { exact: true }).first() : page.locator('extensions-item').first().locator('#dev-reload-button');
    await ring(page, reload, 'Reload');
    await shoot(page, `${pre}-3-loaded.png`, clips[2]);
  } finally {
    await ctx.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}
