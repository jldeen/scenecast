// Many themes on one captured screen: flips it to each pack in a folder, saves each render and a contact sheet, and
// checks the round trip (to the first pack's theme and back to the capture's own) against the original, pixel by pixel.
//   node spikes/variants/theme-sheet.mjs <case.json> <packDir> <outDir>
// case.json: { name, src: {root, snap, vp} }
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, openScreen, closeScreen, extract, flipTheme, pixelScore, readJson } from './harness.mjs';

const [caseFile, packDir, out] = process.argv.slice(2);
const C = readJson(caseFile);
mkdirSync(out, { recursive: true });
const browser = await launch();
const packs = readdirSync(packDir).filter(f => f.endsWith('.json')).sort().map(f => readJson(join(packDir, f)));
const shots = [], results = [];

const first = await openScreen(browser, C.src);
const own = await extract(first, C.name);
const original = await first.screenshot();
await closeScreen(first);
shots.push({ label: `capture (${own.theme})`, png: original });

for (const pack of packs) {
  const page = await openScreen(browser, C.src);
  const t = Date.now();
  const r = await flipTheme(page, pack);
  const ms = Date.now() - t;
  const png = await page.screenshot();
  const bg = await page.evaluate(() => getComputedStyle(document.querySelector('body')).backgroundColor);
  writeFileSync(join(out, `${C.name}-${pack.theme}.png`), png);
  shots.push({ label: pack.theme, png });
  const s = r[0] ? r[0].stats : {};
  results.push({ theme: pack.theme, ms, bodyBg: bg, markers: s.markers, css: s.css, tokens: s.tokens, literal: s.literal + (s.inline || 0) + (s.svg || 0), unmapped: Object.keys(s.unmapped || {}).length });
  await closeScreen(page);
}

// Round trip: to the first dark pack and back to the capture's own theme (its pack taken from the capture itself).
const dark = packs.find(p => p.mode !== own.mode) || packs[0];
const rt = await openScreen(browser, C.src);
await flipTheme(rt, dark);
await flipTheme(rt, { ...own, css: [] });
const back = await rt.screenshot();
await closeScreen(rt);
const round = await pixelScore(browser, original, back, { labels: ['capture', `to ${dark.theme} and back`] });
writeFileSync(join(out, `${C.name}-roundtrip.png`), round.side);

// Contact sheet: thumbnails in a grid, labelled.
const ctx = await browser.newContext(); const sheet = await ctx.newPage();
const b64 = await sheet.evaluate(async items => {
  const load = s => new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = s; });
  const imgs = await Promise.all(items.map(x => load(x.src)));
  const tw = 480, th = Math.round(tw * imgs[0].height / imgs[0].width), cols = 3, pad = 16, head = 26;
  const rows = Math.ceil(imgs.length / cols);
  const c = new OffscreenCanvas(cols * (tw + pad) + pad, rows * (th + head + pad) + pad), g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.font = '600 15px -apple-system, Segoe UI, sans-serif'; g.fillStyle = '#111';
  imgs.forEach((img, i) => { const x = pad + (i % cols) * (tw + pad), y = pad + Math.floor(i / cols) * (th + head + pad); g.fillText(items[i].label, x, y + 16); g.drawImage(img, x, y + head, tw, th); g.strokeStyle = '#ccc'; g.strokeRect(x - .5, y + head - .5, tw + 1, th + 1); });
  const buf = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 32768) s += String.fromCharCode(...buf.subarray(i, i + 32768)); return btoa(s);
}, shots.map(s => ({ label: s.label, src: 'data:image/png;base64,' + s.png.toString('base64') })));
writeFileSync(join(out, `${C.name}-sheet.png`), Buffer.from(b64, 'base64'));
await ctx.close();

const summary = { name: C.name, capture: own.theme, roundTrip: { via: dark.theme, pixelMatch: round.match }, themes: results };
writeFileSync(join(out, `${C.name}-themes.json`), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
await browser.close();
