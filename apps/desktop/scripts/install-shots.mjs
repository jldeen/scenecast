// The guided install's pictures (ui/install/*.png): the real extensions page in a test Chromium of its own (never the
// presenter's browser), with the recorder built and loaded unpacked.
//   node apps/desktop/scripts/install-shots.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { buildExtension } from '../../../packages/recorder/build.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'install');
const tmp = mkdtempSync(join(tmpdir(), 'sc-shots-'));
const ext = join(tmp, 'Recorder Extension');
buildExtension(ext, 47621);
const ctx = await chromium.launchPersistentContext(join(tmp, 'profile'), {
  channel: 'chromium', headless: true, viewport: { width: 1100, height: 640 }, deviceScaleFactor: 2, colorScheme: 'light',
  ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--disable-features=DisableLoadExtensionCommandLineSwitch', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto('chrome://extensions');
await page.waitForSelector('extensions-item');
const dev = page.locator('#devMode');
if ((await dev.getAttribute('aria-pressed')) !== 'true') await dev.click();
await page.waitForSelector('#loadUnpacked', { state: 'visible' });
await page.waitForTimeout(500);
// Developer mode: the toolbar, its switch on (top right).
await page.screenshot({ path: join(OUT, 'developer-mode.png'), clip: { x: 760, y: 0, width: 340, height: 64 } });
// Load unpacked, and the recorder's card once it's in.
await page.locator('#loadUnpacked').hover();
await page.screenshot({ path: join(OUT, 'load-unpacked.png'), clip: { x: 0, y: 0, width: 1000, height: 330 } });
await ctx.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`pictures in ${OUT}`);
