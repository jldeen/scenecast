// Screenshots of each screen from the preview (serve.mjs + mock.js), in headless WebKit (what the Mac app renders
// with) or Chromium (Windows' WebView2): no app, no window on screen. Also a quick look-check per screen: exactly one
// primary button, no engine words on the default view.
//   node apps/desktop/tests/preview/shots.mjs <out-folder> [--browser webkit|chromium] [--only record,review]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { webkit, chromium } from 'playwright-core';
import { startPreview } from './serve.mjs';

const args = process.argv.slice(2);
const OUT = resolve(args.find(a => !a.startsWith('--')) || 'preview-shots');
const pick = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const ENGINE = pick('--browser', 'webkit') === 'chromium' ? chromium : webkit;
const ONLY = pick('--only', '') ? pick('--only', '').split(',') : null;
// 'details' is the Record screen with Details open: the one place engine words belong.
const SCENARIOS = ['empty', 'library', 'new', 'new-typed', 'record', 'record-pick', 'copilot', 'copilot-plan', 'copilot-separate', 'recording', 'paused', 'record-error', 'recorded', 'making', 'review', 'review-ok', 'present', 'presenting', 'share', 'details'];
// The capture window (on top while recording), at its own size.
const CAPTURE = ['ready', 'busy', 'early', 'paused', 'bar', 'off', 'copilot', 'ask'];
const ENGINE_WORDS = /\b(port \d+|receiver|preflight|scrub|manifest|unpacked|developer mode|headless|side states?|streamed answers?|threshold|localhost|127\.0\.0\.1|profile \d+)\b|\/Users\/|\b[A-Z]:\\/i;

mkdirSync(OUT, { recursive: true });
const server = await startPreview(0);
const port = server.address().port;
const browser = await ENGINE.launch();
const report = [];
for (const os of ['macos', 'windows']) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  for (const s of SCENARIOS.filter(x => !ONLY || ONLY.includes(x))) {
    await page.goto(`http://127.0.0.1:${port}/?s=${s === 'details' ? 'record&details=1' : s}&os=${os}`);
    await page.waitForFunction(() => document.documentElement.dataset.previewReady === '1', null, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(700);
    const look = await page.evaluate(re => {
      const main = document.querySelector('#main');
      const vis = e => e.offsetParent !== null && getComputedStyle(e).visibility !== 'hidden';
      const primaries = [...main.querySelectorAll('.btn.primary')].filter(vis).map(b => b.textContent.trim());
      const words = (main.innerText.match(new RegExp(re, 'gi')) || []);
      return { primaries, words };
    }, ENGINE_WORDS.source);
    const file = join(OUT, `${s}-${os}.png`);
    await page.screenshot({ path: file });
    // An error on the screen: its own picture too (it may be below the fold).
    const err = page.locator('[data-test="error"]').first();
    if (await err.count()) { await err.scrollIntoViewIfNeeded(); await err.screenshot({ path: join(OUT, `${s}-${os}-error.png`) }); }
    report.push({ scenario: s, os, file, ...look });
    console.log(`${s} (${os}): ${look.primaries.length} primary [${look.primaries.join(' | ')}]${look.words.length ? `; engine words: ${[...new Set(look.words)].join(', ')}` : ''}`);
  }
  await page.close();
  const cap = await browser.newPage({ viewport: { width: 340, height: 240 }, deviceScaleFactor: 2 });
  for (const c of CAPTURE.filter(x => !ONLY || ONLY.includes('capture') || ONLY.includes(`capture-${x}`))) {
    await cap.goto(`http://127.0.0.1:${port}/capture.html?cap=${c}&os=${os}`);
    await cap.waitForFunction(() => document.documentElement.dataset.previewReady === '1', null, { timeout: 10000 }).catch(() => {});
    await cap.waitForTimeout(500);
    const look = await cap.evaluate(re => {
      const vis = e => e.offsetParent !== null;
      const primaries = [...document.querySelectorAll('.btn.primary')].filter(vis).map(b => b.textContent.trim());
      const words = (document.body.innerText.match(new RegExp(re, 'gi')) || []);
      const clipped = [...document.querySelectorAll('.cap-body > *, .cap-foot > *')].some(e => e.getBoundingClientRect().bottom > innerHeight + 1);
      return { primaries, words, clipped };
    }, ENGINE_WORDS.source);
    const file = join(OUT, `capture-${c}-${os}.png`);
    await cap.screenshot({ path: file });
    report.push({ scenario: `capture-${c}`, os, file, ...look });
    console.log(`capture-${c} (${os}): ${look.primaries.length} primary [${look.primaries.join(' | ')}]${look.clipped ? '; CLIPPED' : ''}${look.words.length ? `; engine words: ${[...new Set(look.words)].join(', ')}` : ''}`);
  }
  await cap.close();
}
await browser.close();
server.close();
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
