// One platform case: a Mac capture shown as Windows and back. Records the shortcut text it changed, which fonts
// actually paint the text before and after (CDP's platform fonts, glyph counts), the scrollbars it drew, a lossless
// check (Windows and back to Mac against the capture, pixel by pixel), and framed side-by-sides (Mac Chrome window vs
// Windows Chrome window) for the write-up.
//   node spikes/variants/platform-case.mjs <case.json> <outDir>     case.json: { name, src: {root, snap, vp}, frame?: 'browser'|'none' }
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, openScreen, closeScreen, flipPlatform, pixelScore, readJson, settle } from './harness.mjs';

const [caseFile, out] = process.argv.slice(2);
const C = readJson(caseFile);
mkdirSync(out, { recursive: true });
const browser = await launch();
// The reference: the same app rendered on the other platform (its own DOM). Its platform pack, labels and picture.
let ref = null;
if (C.ref) {
  const rp = await openScreen(browser, { ...C.ref, vp: C.src.vp });
  ref = { pack: await rp.evaluate(() => window.__sd.extractPlatformPack(document)), png: await rp.screenshot(),
    labels: await rp.evaluate(() => [...document.querySelectorAll('[aria-label]')].map(e => e.getAttribute('aria-label')).filter(s => /Command|Cmd|Ctrl|Option|Alt|Shift|⌘|⌥/.test(s))) };
  await closeScreen(rp);
}
// Segoe UI for an app that ships none: the Segoe UI Web faces from another capture of the presenter's (C.fonts:
// { root, snap }), served at /__fonts/, carried in the platform pack.
const roots = {};
if (C.fonts && ref) {
  roots['/__fonts/'] = join(C.fonts.root, 'assets');
  const html = readFileSync(join(C.fonts.root, 'snaps', C.fonts.snap + '.html'), 'utf8');
  ref.pack.fonts = [...html.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(m => m[1]).filter(b => /West European/.test(b))
    .map(b => ({ weight: (/font-weight:\s*(\d+)/.exec(b) || [])[1], src: (/src:\s*([^;]+)/.exec(b) || [])[1].replace(/\/assets\//g, '/__fonts/') }));
}
const page = await openScreen(browser, { ...C.src, roots });
const cdp = await page.context().newCDPSession(page);
await cdp.send('DOM.enable'); await cdp.send('CSS.enable');

// Fonts that paint the page's text (main document), by glyph count.
async function fonts() {
  await page.evaluate(() => { let n = 0; const w = document.createTreeWalker(document.body, 4); for (let t = w.nextNode(); t && n < 160; t = w.nextNode()) { const el = t.parentElement; if (t.data.trim().length > 2 && el && el.getBoundingClientRect().width > 0 && !el.hasAttribute('data-sd-f')) { el.setAttribute('data-sd-f', ''); n++; } } });
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
  const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: '[data-sd-f]' });
  const tally = {}; let total = 0;
  for (const id of nodeIds) { try { const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: id }); for (const f of fonts) { const k = f.familyName + (f.isCustomFont ? ' (web)' : ''); tally[k] = (tally[k] || 0) + f.glyphCount; total += f.glyphCount; } } catch (e) {} }
  return Object.fromEntries(Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, +(v / total).toFixed(3)]));
}
const chords = () => page.evaluate(() => {
  const out = new Set(); const re = /[⌘⌥⇧⌃]|\b(Command|Cmd|Option|Ctrl|Control|Alt|Shift)\s?\+/;
  const w = document.createTreeWalker(document.body, 4);
  for (let t = w.nextNode(); t; t = w.nextNode()) if (re.test(t.data) && t.parentElement && t.parentElement.getBoundingClientRect().width > 0) out.add('text: ' + t.data.trim().slice(0, 80));
  for (const el of document.querySelectorAll('[aria-label],[title],[placeholder]')) for (const a of ['aria-label', 'title', 'placeholder']) { const v = el.getAttribute(a); if (v && re.test(v)) out.add(a + ': ' + v.slice(0, 80)); }
  return [...out];
});

const pageMode = await page.evaluate(() => window.__sd.modeOf(document));
const macPng = await page.screenshot();
const macFonts = await fonts(), macChords = await chords();
const t = Date.now();
const labelsNow = () => page.evaluate(() => [...document.querySelectorAll('[aria-label]')].map(e => e.getAttribute('aria-label')).filter(s => /Command|Cmd|Ctrl|Option|Alt|Shift|⌘|⌥/.test(s)));
const win = await flipPlatform(page, 'windows', { ...(ref ? { pack: ref.pack } : {}), fonts: C.fonts !== false });
await page.evaluate(() => document.fonts.ready);
await settle(page);
const winMs = Date.now() - t;
const winPng = await page.screenshot();
const winFonts = await fonts(), winChords = await chords(), winLabels = await labelsNow();
let framedPng = null;
if (C.frame === 'app') { await flipPlatform(page, 'windows', { pack: ref && ref.pack, frame: 'app' }); framedPng = await page.screenshot(); writeFileSync(join(out, `${C.name}-windows-app-frame.png`), framedPng); await flipPlatform(page, 'windows', { pack: ref && ref.pack }); }
await flipPlatform(page, 'macos');
await page.evaluate(() => document.fonts.ready); await settle(page);
const backPng = await page.screenshot();
await closeScreen(page);
writeFileSync(join(out, `${C.name}-mac.png`), macPng);
writeFileSync(join(out, `${C.name}-windows.png`), winPng);
const back = await pixelScore(browser, macPng, backPng, { labels: ['Mac capture', 'Windows and back'] });
const diff = await pixelScore(browser, macPng, winPng, { labels: ['Mac capture', 'Windows variant'] });
writeFileSync(join(out, `${C.name}-side.png`), diff.side);

// Framed: the capture in a Mac Chrome window next to the Windows variant in a Windows Chrome window.
const { frameHtml } = await import('../../packages/player/app/variants.js');
const vp = C.src.vp, title = C.title || C.name, url = C.url || '';
const ctx = await browser.newContext({ viewport: { width: vp.w * 2 + 72, height: vp.h + 160 }, deviceScaleFactor: 1 });
const fp = await ctx.newPage();
const mode = C.mode || pageMode;
const win32 = (png, platform) => `<div style="display:inline-block;vertical-align:top;margin:16px;border-radius:${platform === 'macos' ? 10 : 8}px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,.25);border:1px solid rgba(0,0,0,.2)">${frameHtml(platform, { kind: 'browser', mode, title, url })}<img style="display:block;width:${vp.w}px;height:${vp.h}px" src="data:image/png;base64,${png.toString('base64')}"></div>`;
await fp.setContent(`<body style="margin:0;background:#e9ecef;white-space:nowrap">${win32(macPng, 'macos')}${win32(winPng, 'windows')}</body>`);
writeFileSync(join(out, `${C.name}-framed.png`), await fp.screenshot({ fullPage: true }));
await ctx.close();

let vsRef = null;
if (ref) {
  const all = await pixelScore(browser, winPng, ref.png, { labels: ['Mac capture switched to Windows', "the app's own Windows render"] });
  const band = await pixelScore(browser, winPng, ref.png, { region: { x: 0, y: 0, w: 400, h: 60 }, labels: ['switched', 'own Windows render'] });
  const base = await pixelScore(browser, macPng, ref.png, { region: { x: 0, y: 0, w: 400, h: 60 } });
  writeFileSync(join(out, `${C.name}-vs-windows.png`), all.side); writeFileSync(join(out, `${C.name}-vs-windows-header.png`), band.side);
  const want = new Set(ref.labels), got = new Set(winLabels);
  const same = [...want].filter(l => got.has(l)).length;
  vsRef = { pixel: all.match, headerBand: { baseline: base.match, switched: band.match }, labels: { want: want.size, same, misses: [...want].filter(l => !got.has(l)).slice(0, 8), extra: [...got].filter(l => !want.has(l)).slice(0, 8) } };
}
const s = win[0] ? win[0].stats : {};
const result = { name: C.name, windowsMs: winMs, changed: { shortcuts: s.shortcuts, fontRules: s.fonts, scrollers: s.scrollers }, fonts: { mac: macFonts, windows: winFonts },
  chords: { mac: macChords.slice(0, 30), windows: winChords.slice(0, 30) }, lossless: back.match, vsRef, controlsMoved: s.controls, pixelsChangedByVariant: +(1 - diff.match).toFixed(4), frames: win.length };
writeFileSync(join(out, `${C.name}-platform.json`), JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
await browser.close();
