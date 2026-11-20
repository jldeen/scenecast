// How much of a screen a theme pack can reach, before a real capture in the other theme exists: flips the screen with
// a synthetic pack (every colour the page's own tokens resolve to, lightness inverted in OKLab) and measures what
// changed. What doesn't change is what a real pack can't reach either: literal colours no token explains, images,
// canvases. Saves the synthetic render (the parts left behind stand out) and the element shares.
//   node spikes/variants/coverage.mjs <case.json> <outDir>      case.json: { name, src: {root, snap, vp} }
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, openScreen, closeScreen, extract, paints, readJson, settle } from './harness.mjs';

const [caseFile, out] = process.argv.slice(2);
const C = readJson(caseFile);
mkdirSync(out, { recursive: true });
const browser = await launch();
const page = await openScreen(browser, C.src);
const own = await extract(page, C.name);
const toLin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const toSrgb = c => Math.round(255 * Math.min(1, Math.max(0, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)));
const invert = key => {
  const v = key.split(',').map(Number); const [r, g, b] = v.slice(0, 3).map(toLin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  let L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s; const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  L = 1.08 - L; // inverted, a little lifted so dark surfaces aren't pure black
  const l2 = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3, m2 = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3, s2 = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3;
  const out = [toSrgb(4.0767416621 * l2 - 3.3077115913 * m2 + 0.2309699292 * s2), toSrgb(-1.2684380046 * l2 + 2.6097574011 * m2 - 0.3413193965 * s2), toSrgb(-0.0041960771 * l2 - 0.7034186147 * m2 + 1.7076147010 * s2)];
  return (v.length > 3 ? out.concat(v[3]) : out).join(',');
};
const mkSynth = pk => {
  const sy = { ...pk, theme: 'synthetic', mode: pk.mode === 'dark' ? 'light' : 'dark', colors: {}, tokens: {}, css: [] };
  for (const [k, v] of Object.entries(pk.colors)) sy.colors[k] = invert(v);
  for (const [k, v] of Object.entries(pk.tokens)) sy.tokens[k] = pk.colors[k] && !/var\(/.test(v) ? `rgb${pk.colors[k].split(',').length > 3 ? 'a' : ''}(${invert(pk.colors[k])})` : v;
  return sy;
};
const before = await paints(page);
// Each document (frames too) flipped with a synthetic pack made from its own tokens.
const r = [];
for (const f of page.frames()) {
  const pk = await f.evaluate(() => window.__sd && document.body && document.body.childElementCount ? window.__sd.extractThemePack(document) : null).catch(() => null);
  if (!pk) continue;
  const stats = await f.evaluate(sy => window.__sd.applyTheme(document, sy, { force: true }), mkSynth(pk));
  r.push({ url: f.url().replace(/^https?:\/\/[^/]+/, ''), stats });
}
await settle(page);
const after = await paints(page);
writeFileSync(join(out, `${C.name}-synthetic.png`), await page.screenshot());
// Images, canvases and videos on screen: their share of the viewport (sampled on a grid, topmost element at each point).
const baked = await page.evaluate(() => {
  let n = 0, hit = 0; const kinds = {};
  for (let y = 4; y < innerHeight; y += 12) for (let x = 4; x < innerWidth; x += 12) {
    n++;
    let el = document.elementFromPoint(x, y);
    while (el && el.localName === 'iframe') { try { const r = el.getBoundingClientRect(); const d = el.contentDocument; el = d && d.elementFromPoint(x - r.left, y - r.top); } catch (e) { break; } }
    if (!el) continue;
    const cs = getComputedStyle(el);
    const k = /^(img|canvas|video|image)$/.test(el.localName) ? el.localName : /url\(/.test(cs.backgroundImage) ? 'background-image' : null;
    if (k) { hit++; kinds[k] = (kinds[k] || 0) + 1; }
  }
  return { share: +(hit / n).toFixed(3), kinds };
});
await closeScreen(page);
// Element shares: of what paints colour, how much changed (by count and by area for backgrounds).
const idx = new Map(after.map((e, i) => [e.k + '@' + Math.round(e.x) + ',' + Math.round(e.y), e]));
let total = 0, changed = 0, area = 0, areaChanged = 0;
const stuck = {};
for (const e of before) {
  const a = idx.get(e.k + '@' + Math.round(e.x) + ',' + Math.round(e.y)); if (!a) continue;
  for (const p of Object.keys(e.p)) {
    const w = p === 'bg' ? Math.min(e.w * e.h, 2e5) : 1;
    total++; area += w;
    if (a.p[p] !== e.p[p]) { changed++; areaChanged += w; } else { const k = `${p} ${e.p[p]}`; stuck[k] = (stuck[k] || 0) + w; }
  }
}
const s = r.map(x => ({ url: x.url, tokens: x.stats.tokens, literal: x.stats.literal + x.stats.inline + x.stats.svg, unmapped: Object.keys(x.stats.unmapped || {}).length }));
const result = { name: C.name, capture: own.theme, tokensInPage: Object.keys(own.colors).length, scopes: own.scopes, reach: { paints: total, changed: +(changed / total).toFixed(3), areaChanged: +(areaChanged / area).toFixed(3) }, baked, stuckTop: Object.entries(stuck).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => `${k} (${Math.round(n)})`), docs: s };
writeFileSync(join(out, `${C.name}-coverage.json`), JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
await browser.close();
