// Real vs replica, for the fidelity loop (scenecast fidelity): every captured state is rendered in the replica the way
// its real screenshot was taken, and the two are compared pixel by pixel.
//   state  each state of the flow at 100% (the demo's viewport): its real screenshot is raw shots/<snap>.png
//   zoom   each zoom capture (zoomRefs) at its zoom: raw shots/<zoom snap>.png
//   click  each click side state (a menu or pane the click audit opened) with the pointer on the control, as the
//          audit's screenshot was taken: raw hovers/click-<page>/NNNN.png
// For each: the share of pixels that differ, the regions, a side-by-side picture and a diff picture. Each state at
// 100% also gets its fonts checked: every font the real page had loaded must be loaded in the replica from the same
// file (SHA-256 of the font file), else it's reported as substituted (fallen back) or a different file.
// Fallback scenes (screenshot, video-frame) are listed and never compared: they are pictures, not pages.
//   node checks/real-vs-replica.mjs --demo <dir> [--url <replica>] [--out <dir>] [--threshold 0.5] [--only state,zoom,click]
//     [--lanes N]
// Several screens render at once (--lanes, SCENECAST_COMPARE_LANES: a third of the cores, at most 4), each in its own
// pages. A screen whose replica renders exactly as it did last time, against the same real screenshot, keeps the last
// comparison and its pictures (.out/fidelity/cache: the same pixels in can only give the same verdict). Writes <out>/compare.json (default .out/fidelity/compare): with "partial": true and the items so far after each
// one lands (Review shows them as they arrive), then whole. Prints one "@fidelity {json}" line per item as it lands.
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, renameSync, readdirSync, linkSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { diffDetail } from './compare.mjs';
import { loadDemo, arg } from '@stuntdouble/core/lib/demo.mjs';
import { openReplica } from './replica-render.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const demo = loadDemo(args);
const URL0 = arg(args, '--url', demo.url);
const OUT = arg(args, '--out', join(demo.out, 'fidelity', 'compare'));
const THRESHOLD = +arg(args, '--threshold', 0.5);
const ONLY = new Set((arg(args, '--only', '') || 'state,zoom,click').split(',').filter(Boolean));
const VP = demo.cfg.viewport;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha256 = buf => createHash('sha256').update(buf).digest('hex');
const emit = (event, data) => console.log('@fidelity ' + JSON.stringify({ event, ...data }));

const R = await openReplica(demo, URL0);
const flow = R.flow;
const S = flow.states;
const manifest = existsSync(join(demo.dir, 'manifest.json')) ? JSON.parse(readFileSync(join(demo.dir, 'manifest.json'), 'utf8')) : { graph: { scenes: [] } };
const fallback = ((manifest.graph || {}).scenes || []).filter(s => s.kind && s.kind !== 'live-page').map(s => ({ id: s.id, kind: s.kind }));

// What to compare.
const items = [];
const shot = (...p) => { const f = join(demo.raw, ...p); return existsSync(f) ? f : null; };
if (ONLY.has('state')) for (const [id, st] of Object.entries(S)) items.push({ id, kind: 'state', state: id, app: st.app, snap: st.snap, z: 100, real: shot('shots', st.snap + '.png') });
if (ONLY.has('zoom')) for (const z of flow.zoomRefs || []) if (S[z.state]) items.push({ id: `${z.state}@${z.z}`, kind: 'zoom', state: z.state, app: z.app, snap: z.snap, z: z.z, real: shot('shots', z.snap + '.png') });
if (ONLY.has('click')) for (const cp of flow.clickPages || []) {
  const f = join(demo.data, 'snaps', `hovers-${cp.app}.json`);
  const defs = existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')).clicks || []) : [];
  const state = (Object.entries(S).find(([, s]) => s.snap === cp.base) || [])[0];
  for (const d of defs.filter(x => x.page === cp.page)) {
    const n = +String(d.id).split('-').pop();
    items.push({ id: `${state || cp.base}+click:${d.name}`, kind: 'click', state, app: cp.app, snap: cp.base, z: 100, click: { name: d.name, id: d.id, ctl: d.ctl, frame: d.frame || undefined }, real: shot('hovers', 'click-' + cp.page, String(n).padStart(4, '0') + '.png') });
  }
}

// The real page's fonts (raw capture of a state): the faces it had loaded, and the file of each where a stylesheet names
// one; files the page fetched that no stylesheet names were loaded by script (the FontFace API).
const urlIndex = existsSync(join(demo.raw, 'urls.json')) ? JSON.parse(readFileSync(join(demo.raw, 'urls.json'), 'utf8')) : {};
const rawFile = url => { const e = urlIndex[url]; if (!e || !e.file) return null; const f = join(demo.raw, 'blobs', e.file); return existsSync(f) ? f : null; };
const isHtml = f => /<(!doctype html|html[\s>])/i.test(readFileSync(f).subarray(0, 600).toString('latin1'));
const fileSha = url => { const f = rawFile(url); return f && !isHtml(f) ? sha256(readFileSync(f)) : null; };
const normFamily = s => String(s || '').trim().replace(/^["']|["']$/g, '').toLowerCase();
const normWeight = w => ({ normal: '400', bold: '700' }[String(w || 'normal').trim()] || String(w).trim());
// The size a screen was recorded at (its browser window's viewport and pixel ratio, in the raw snapshot): the replica
// is shown at that size to compare like with like. A presenter's browser window is rarely the demo's 1920×1080, and its
// height changes by a little as the debugging bar comes and goes.
const recordedVp = new Map();
function recordedViewport(snap) {
  if (recordedVp.has(snap)) return recordedVp.get(snap);
  let vp = null;
  try {
    const f = join(demo.raw, 'snaps', snap + '.json');
    const main = existsSync(f) && JSON.parse(readFileSync(f, 'utf8')).docs.find(d => d.key === 'main');
    const v = main && main.meta && main.meta.viewport;
    if (v && v.w && v.h) vp = { width: v.w, height: v.h, dpr: v.dpr || VP.dpr };
  } catch (e) {}
  recordedVp.set(snap, vp);
  return vp;
}
// A zoom's own capture was taken with the page zoomed (its viewport already the zoomed size): the window it was
// recorded in is its screen's, at 100%.
const viewportOf = it => recordedViewport(it.kind === 'zoom' ? (S[it.state] || {}).snap || it.snap : it.snap) || undefined;
function realFonts(snap) {
  const f = join(demo.raw, 'snaps', snap + '.json');
  if (!existsSync(f)) return null;
  const main = JSON.parse(readFileSync(f, 'utf8')).docs.find(d => d.key === 'main');
  if (!main) return null;
  const meta = main.meta || {};
  const faces = [];
  for (const m of (main.html || '').matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const body = m[1], get = k => ((body.match(new RegExp(k + ':\\s*([^;]+)')) || [])[1] || '').trim();
    const urls = [...get('src').matchAll(/url\("?d1res:\/\/(\d+)"?\)/g)].map(x => main.urls[+x[1]]);
    faces.push({ family: normFamily(get('font-family')), weight: normWeight(get('font-weight')), style: get('font-style') || 'normal', urls });
  }
  const loaded = (meta.fonts || []).map(s => { const p = s.trim().split(' '); const style = p.pop(), weight = p.pop(); return { family: normFamily(p.join(' ')), name: p.join(' ').trim().replace(/^["']|["']$/g, ''), weight: normWeight(weight), style }; });
  const claimed = new Set(faces.flatMap(x => x.urls));
  const scriptFiles = (meta.fontFiles || []).filter(u => !claimed.has(u)).map(u => ({ url: u, sha256: fileSha(u) })).filter(x => x.sha256);
  return loaded.map(l => {
    const face = faces.find(x => x.family === l.family && x.weight === l.weight && x.style === l.style) || faces.find(x => x.family === l.family);
    const files = face ? face.urls.map(u => ({ url: u, sha256: fileSha(u) })).filter(x => x.sha256) : [];
    return { ...l, by: face ? 'stylesheet' : 'script', files, candidates: face ? [] : scriptFiles };
  });
}
// The replica's fonts on the page now: loaded faces, and each @font-face rule's files.
const replicaFontsIn = app => {
  const d = window.d1.doc(app), out = { loaded: [], faces: [] };
  for (const f of d.fonts) if (f.status === 'loaded') out.loaded.push({ family: f.family, weight: String(f.weight), style: f.style });
  const walk = rules => { for (const r of rules) { if (r.constructor.name === 'CSSFontFaceRule') out.faces.push({ family: r.style.getPropertyValue('font-family'), weight: r.style.getPropertyValue('font-weight') || 'normal', style: r.style.getPropertyValue('font-style') || 'normal', src: r.style.getPropertyValue('src') }); else if (r.cssRules) walk(r.cssRules); } };
  for (const s of d.styleSheets) { try { walk(s.cssRules); } catch (e) {} }
  return out;
};
const assetSha = src => { const m = /\/assets\/([^"')?#]+)/.exec(src || ''); if (!m) return null; const f = join(demo.data, 'assets', m[1]); return existsSync(f) && statSize(f) ? sha256(readFileSync(f)) : null; };
const statSize = f => readFileSync(f).length;
function fontVerdicts(real, rep) {
  if (!real) return [];
  return real.map(r => {
    const loaded = rep.loaded.some(x => normFamily(x.family) === r.family);
    const faces = rep.faces.filter(x => normFamily(x.family) === r.family);
    const exact = faces.find(x => normWeight(x.weight) === r.weight && x.style === r.style) || faces[0];
    const repSha = exact ? (exact.src.match(/\/assets\/[^"')]+/g) || []).map(assetSha).filter(Boolean) : [];
    const want = r.files.length ? r.files : r.candidates;
    const base = { family: r.family, name: r.name, weight: r.weight, style: r.style, loadedBy: r.by, real: want.map(x => ({ url: x.url.split('?')[0], sha256: x.sha256 })), replica: repSha };
    // Matched by its file: a face this screen doesn't use isn't loaded, but it's there, from the same file.
    base.used = loaded;
    if (!repSha.length) return { ...base, status: 'substituted', why: r.by === 'script' ? 'the real page loaded this font by script (no @font-face rule was captured); the replica falls back' : 'the replica has no file for this font and falls back' };
    if (!want.length) return { ...base, status: 'unverified', why: 'the real page\'s file for this font was not captured' };
    if (repSha.some(s => want.some(x => x.sha256 === s))) return { ...base, status: 'match' };
    return { ...base, status: 'different-file', why: 'the replica loads another file for this font than the real page did' };
  });
}

// The last comparisons, by what went in: the diff code, the item, and both pictures' bytes.
const CACHE = join(demo.out, 'fidelity', 'cache'), usedKeys = new Set();
const DIFF_CODE = sha256(readFileSync(join(here, 'compare.mjs')));
mkdirSync(CACHE, { recursive: true });
const place = (from, to) => { rmSync(to, { force: true }); try { linkSync(from, to); } catch (e) { copyFileSync(from, to); } };
function cached(key, id) {
  const f = join(CACHE, key + '.json');
  if (!existsSync(f) || !existsSync(join(CACHE, key + '.sbs.png')) || !existsSync(join(CACHE, key + '.diff.png'))) return null;
  try {
    const d = JSON.parse(readFileSync(f, 'utf8'));
    place(join(CACHE, key + '.sbs.png'), join(OUT, file(id, 'side-by-side')));
    place(join(CACHE, key + '.diff.png'), join(OUT, file(id, 'diff')));
    usedKeys.add(key); reused++;
    return d;
  } catch (e) { return null; }
}
function keep(key, id, d) {
  const { sideBySide, diff, ...rest } = d;
  place(join(OUT, file(id, 'side-by-side')), join(CACHE, key + '.sbs.png'));
  place(join(OUT, file(id, 'diff')), join(CACHE, key + '.diff.png'));
  writeFileSync(join(CACHE, key + '.json'), JSON.stringify(rest));
  usedKeys.add(key);
}
let reused = 0;

const LANES = Math.max(1, Math.min(items.length || 1, +arg(args, '--lanes', process.env.SCENECAST_COMPARE_LANES || Math.min(4, Math.max(1, Math.floor(availableParallelism() / 3))))));
const cmps = await Promise.all(Array.from({ length: LANES }, async () => (await R.browser.newContext({ viewport: { width: 800, height: 600 } })).newPage()));
async function render(it, lane) {
  const r = await R.show(it, lane);
  if (r.error) return r;
  const png = await r.page.screenshot({ animations: 'disabled', caret: 'hide' });
  const fonts = it.kind === 'state' ? await r.page.evaluate(replicaFontsIn, it.app) : null;
  return { png, fonts };
}

const file = (id, what) => `${id.replace(/[^\w@.+-]+/g, '_')}.${what}.png`;
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
const results = new Array(items.length);
// What's been compared so far, for Review while the rest renders (written aside, then put in place whole; a write that
// fails, say a reader holding the file on Windows, waits for the next one).
const writePartial = () => {
  const f = join(OUT, 'compare.json');
  try {
    writeFileSync(f + '.tmp', JSON.stringify({ demo: demo.name, partial: true, at: new Date().toISOString(), threshold: THRESHOLD, viewport: VP, url: URL0, items: results.filter(Boolean), fallback }));
    renameSync(f + '.tmp', f);
  } catch (e) {}
};
writePartial();
emit('compare-start', { items: items.length, threshold: THRESHOLD, fallback, lanes: LANES });
async function compareOne(it, lane) {
  const row = { id: it.id, kind: it.kind, state: it.state, app: it.app, snap: it.snap, z: it.z, click: it.click ? it.click.name : undefined, real: it.real, viewport: viewportOf(it) };
  if (!it.real) return Object.assign(row, { pct: null, pass: true, note: 'no real screenshot for this state' });
  if (!it.state || !S[it.state]) return Object.assign(row, { pct: null, pass: false, error: 'no state for it in the flow' });
  let r;
  try { r = await render({ ...it, viewport: viewportOf(it) }, lane); } catch (e) { r = { error: String(e.message || e).slice(0, 300) }; }
  if (r.error) return Object.assign(row, { pct: null, pass: false, error: r.error });
  const real = readFileSync(it.real);
  const key = sha256(`${DIFF_CODE}\n${it.id}\n${sha256(real)}\n${sha256(r.png)}`);
  writeFileSync(join(OUT, file(it.id, 'replica')), r.png);
  let d = cached(key, it.id);
  if (!d) {
    [d] = await diffDetail(cmps[lane], [{ real: real.toString('base64'), replica: r.png.toString('base64') }], { label: [it.id] });
    writeFileSync(join(OUT, file(it.id, 'side-by-side')), Buffer.from(d.sideBySide, 'base64'));
    writeFileSync(join(OUT, file(it.id, 'diff')), Buffer.from(d.diff, 'base64'));
    keep(key, it.id, d);
  }
  // Within a pixel or two: a window's height in CSS pixels isn't always whole (806.5 at 2×), the replica's is.
  const sizeOk = Math.abs(d.size.real[0] - d.size.replica[0]) <= 2 && Math.abs(d.size.real[1] - d.size.replica[1]) <= 2;
  Object.assign(row, { pct: d.pct, box: d.box, regions: d.regions, size: d.size, replica: join(OUT, file(it.id, 'replica')), sideBySide: join(OUT, file(it.id, 'side-by-side')), diff: join(OUT, file(it.id, 'diff')) });
  if (!sizeOk) row.sizeMismatch = true;
  if (r.fonts) row.fonts = fontVerdicts(realFonts(it.snap), r.fonts);
  row.pass = d.pct <= THRESHOLD && sizeOk;
  return row;
}
let next = 0;
await Promise.all(Array.from({ length: LANES }, async (_, lane) => {
  for (let i = next++; i < items.length; i = next++) {
    const row = await compareOne(items[i], lane);
    results[i] = row;
    writePartial();
    emit('compared', row.pct === undefined || row.regions === undefined ? row : { id: row.id, kind: row.kind, z: row.z, pct: row.pct, pass: row.pass, regions: row.regions.length, fonts: (row.fonts || []).map(f => `${f.family}: ${f.status}`) });
  }
}));
await R.close();
// Only this run's comparisons are kept.
for (const f of readdirSync(CACHE)) if (!usedKeys.has(f.split('.')[0])) rmSync(join(CACHE, f), { force: true });
const fontRows = results.flatMap(r => (r.fonts || []).map(f => ({ ...f, state: r.state })));
const fonts = Object.values(Object.fromEntries(fontRows.map(f => [`${f.family}|${f.weight}|${f.style}`, f]))).map(f => ({ ...f, states: fontRows.filter(x => x.family === f.family && x.weight === f.weight && x.style === f.style).map(x => x.state), status: fontRows.some(x => x.family === f.family && x.status !== 'match' && x.status !== 'unverified') ? fontRows.find(x => x.family === f.family && x.status !== 'match' && x.status !== 'unverified').status : f.status }));
const report = {
  demo: demo.name, at: new Date().toISOString(), threshold: THRESHOLD, viewport: VP, url: URL0,
  pass: results.every(r => r.pass) && fonts.every(f => f.status === 'match' || f.status === 'unverified'),
  worst: results.filter(r => r.pct !== null).sort((a, b) => b.pct - a.pct).slice(0, 1).map(r => ({ id: r.id, pct: r.pct }))[0] || null,
  items: results, fonts, fallback,
};
writeFileSync(join(OUT, 'compare.json'), JSON.stringify(report, null, 1));
emit('compare-done', { reused, pass: report.pass, over: results.filter(r => !r.pass).map(r => r.id), worst: report.worst, fonts: fonts.map(f => `${f.family}: ${f.status}`), file: join(OUT, 'compare.json') });
process.exit(0);
