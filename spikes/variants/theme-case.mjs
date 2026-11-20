// One theme case: flip a captured screen to the other theme with a pack taken from another capture of the same app,
// then score it against a real capture in that theme (pixels and element by element), next to the unflipped baseline.
//   node spikes/variants/theme-case.mjs <case.json> <outDir>
// case.json: { name, src: {root, snap, vp}, pack: {root, snap, vp}, ref: {root, snap, vp}, regions?: {name: {x,y,w,h}} }
// vp: { w, h } (rendered at dpr 1). ref may be the same screen (a real capture in the other theme) or another screen
// of the same app (then only the shared chrome is comparable: give regions).
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, openScreen, closeScreen, extract, flipTheme, paints, elementScore, pixelScore, readJson } from './harness.mjs';

const [caseFile, out] = process.argv.slice(2);
const C = readJson(caseFile);
mkdirSync(out, { recursive: true });
const browser = await launch();
const vp = C.src.vp;
const T0 = Date.now();

const packPage = await openScreen(browser, { ...C.pack, vp: C.pack.vp || vp });
const pack = await extract(packPage, C.app || C.name);
await closeScreen(packPage);
writeFileSync(join(out, `pack-${C.name}-${pack.mode}.json`), JSON.stringify(pack, null, 1));

const ref = await openScreen(browser, { ...C.ref, vp });
const refPng = await ref.screenshot(); const refPaints = await paints(ref);
await closeScreen(ref);

const src = await openScreen(browser, { ...C.src, vp });
const beforePng = await src.screenshot(); const beforePaints = await paints(src);
const t1 = Date.now();
const flip = await flipTheme(src, pack);
const flipMs = Date.now() - t1;
const afterPng = await src.screenshot(); const afterPaints = await paints(src);
await closeScreen(src);

writeFileSync(join(out, `${C.name}-before.png`), beforePng);
writeFileSync(join(out, `${C.name}-flipped.png`), afterPng);
writeFileSync(join(out, `${C.name}-real.png`), refPng);

const opts = { maxDist: C.sameScreen ? 12 : 24 };
const result = { name: C.name, sameScreen: !!C.sameScreen, from: flip[0] && flip[0].stats.from, to: pack.mode, tokensInPack: Object.keys(pack.tokens).length, markers: pack.markers, flipMs,
  flip: flip.map(f => ({ url: f.url, ...f.stats, unmapped: Object.keys(f.stats.unmapped || {}).length, unmappedTop: Object.entries(f.stats.unmapped || {}).sort((a, b) => b[1] - a[1]).slice(0, 8) })),
  element: { baseline: elementScore(beforePaints, refPaints, opts), flipped: elementScore(afterPaints, refPaints, opts) }, pixel: {} };
const regions = { screen: null, ...(C.regions || {}) };
for (const [name, region] of Object.entries(regions)) {
  const base = await pixelScore(browser, beforePng, refPng, { region });
  const flipped = await pixelScore(browser, afterPng, refPng, { region, labels: [`flipped to ${pack.mode} (from a ${result.from} capture)`, `real ${pack.mode} capture`] });
  result.pixel[name] = { baseline: base.match, flipped: flipped.match };
  writeFileSync(join(out, `${C.name}-side-${name}.png`), flipped.side);
}
result.ms = Date.now() - T0;
writeFileSync(join(out, `${C.name}-score.json`), JSON.stringify(result, null, 1));
console.log(JSON.stringify({ name: result.name, from: result.from, to: result.to, pixel: result.pixel, element: { baseline: result.element.baseline.match, flipped: result.element.flipped.match, flippedArea: result.element.flipped.areaMatch, paired: result.element.flipped.paired }, flip: result.flip.map(f => ({ url: f.url, tokens: f.tokens, literal: f.literal, inline: f.inline, svg: f.svg, unmapped: f.unmapped })) }, null, 1));
await browser.close();
