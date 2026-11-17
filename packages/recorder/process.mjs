// Turns raw captures (receiver output, outside the repo) into the demo's replica data in <demo>/data:
//   snaps/<id>.html (+ <id>.<frame>.html), streams/<name>.json, assets/<hash>.<ext>
// Every d1res:// token becomes a local /assets/ path, so the replica makes no network calls. Sign-in tokens, JWTs
// and signed-URL parameters are scrubbed from whatever text is left, and the result is checked for them.
//   node capture/process.mjs --demo <dir> [--raw <rawDir>] [--only=id,id] [--force]
// Incremental: it skips the build when nothing it reads has changed (data/build.json), builds into data/.next, then
// writes only the files that changed and deletes the ones no longer made. data/build.json lists what changed (the
// quick check uses it) and which text edits are built in (the server applies the rest as it serves).
import { readFileSync, readSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { compose as composeJs, cssFor as cssForJs, elementEnd, isolateClasses as isolateClassesJs, ancestorsAt, around } from './compose.mjs';
import { loadDemo, arg, KIT_VERSION } from '../kit/lib/demo.mjs';
import { compileEdits, applyEdits } from '../kit/lib/edits.mjs';
import { buildInputs, buildKey } from '../kit/lib/buildkey.mjs';

const args = process.argv.slice(2);
const demo = loadDemo(args);
const RAW = arg(args, '--raw', demo.raw);
const DATA = demo.data;
const OUT = join(DATA, '.next');
const FINAL_ASSETS = join(DATA, 'assets');
let ASSETS = process.env.SCENECAST_RUST_PUBLISH === '1' ? join(OUT, 'assets') : FINAL_ASSETS;
const flow = JSON.parse(readFileSync(demo.flowPath, 'utf8'));
const T0 = Date.now();
const INPUTS = buildInputs({ ...demo, raw: RAW }, flow), KEY = buildKey(INPUTS);
const MANIFEST = join(DATA, 'build.json');
const last = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : null;
if (last && last.key === KEY && existsSync(join(DATA, 'snaps')) && !args.includes('--force') && !args.some(a => a.startsWith('--only'))) {
  console.log(JSON.stringify({ upToDate: true, key: KEY, ms: Date.now() - T0 }));
  process.exit(0);
}
const urlIndex = JSON.parse(readFileSync(join(RAW, 'urls.json'), 'utf8'));
rmSync(OUT, { recursive: true, force: true });
for (const d of ['snaps', 'streams']) mkdirSync(join(OUT, d), { recursive: true });
mkdirSync(ASSETS, { recursive: true });

const used = new Set();
const missing = new Map();
let assetReply = Buffer.alloc(0);
function rustAsset(op, value, inline) {
  writeFileSync(1, 'SCENECAST_ASSET_V1 ' + JSON.stringify({ op, value, inline }) + '\n');
  const chunks = [];
  for (;;) {
    if (!assetReply.length) {
      const chunk = Buffer.allocUnsafe(65536);
      const n = readSync(0, chunk, 0, chunk.length, null);
      if (!n) throw new Error('asset resolver closed without a response');
      assetReply = chunk.subarray(0, n);
    }
    const end = assetReply.indexOf(10);
    if (end >= 0) {
      chunks.push(assetReply.subarray(0, end));
      assetReply = assetReply.subarray(end + 1);
      break;
    }
    chunks.push(assetReply);
    assetReply = Buffer.alloc(0);
  }
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (result.error) throw new Error(result.error);
  if (!Array.isArray(result.used) || !Array.isArray(result.missing)) throw new Error('invalid asset resolver response');
  for (const name of result.used) used.add(name);
  for (const [url, reason] of result.missing) missing.set(url, reason);
  return result.value;
}
const cssFor = (part, source, target) => process.env.SCENECAST_RUST_ASSETS === '1'
  ? rustAsset('css-for', JSON.stringify([part, source, target]))
  : cssForJs(part, source, target);
const compose = (html, step, part, css) => process.env.SCENECAST_RUST_ASSETS === '1'
  ? rustAsset('compose', JSON.stringify([html, step.anchor, step.tag, part, css]))
  : composeJs(html, step, part, css);
const isolateClasses = (html, prefix = 'd1v-') => process.env.SCENECAST_RUST_ASSETS === '1'
  ? rustAsset('isolate-classes', JSON.stringify([html, prefix, false]))
  : isolateClassesJs(html, prefix);
const EMPTY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
function asset(buf, ext) {
  const f = createHash('sha256').update(buf).digest('hex').slice(0, 24) + '.' + ext;
  const p = join(ASSETS, f);
  if (!existsSync(p)) writeFileSync(p, buf);
  used.add(f);
  return '/assets/' + f;
}
const emptyAsset = () => asset(EMPTY_PNG, 'png');
function fromData(d) {
  if (process.env.SCENECAST_RUST_ASSETS === '1') return rustAsset('data', d || '');
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(d || '');
  if (!m) return null;
  const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg', 'image/gif': 'gif', 'image/webp': 'webp' }[m[1]] || 'bin';
  return asset(buf, ext);
}
function cssFile(url, depth = 0) {
  if (process.env.SCENECAST_RUST_ASSETS === '1' && typeof url === 'string') return rustAsset('css', url);
  const e = urlIndex[url];
  if (!e || !e.file) return null;
  const text = readFileSync(join(RAW, 'blobs', e.file), 'utf8');
  return rewriteCss(text, url, depth);
}
// url(...) in fetched CSS, resolved against the stylesheet's own URL.
function rewriteCss(text, base, depth = 0) {
  return text
    .replace(/@import\s+(?:url\()?\s*["']([^"']+)["']\s*\)?\s*([^;]*);/g, (m, u, media) => {
      const abs = new URL(u, base).href; const t = depth < 4 ? cssFile(abs, depth + 1) : null;
      return t === null ? '' : (media.trim() ? `@media ${media.trim()}{${t}}` : t);
    })
    .replace(/url\(\s*("([^"]*)"|'([^']*)'|[^)]*)\s*\)/g, (m, all, a, b) => {
      const v = (a !== undefined ? a : b !== undefined ? b : all).trim();
      if (/^(data:|#|\/assets\/)/i.test(v) || !v) return m;
      let abs; try { abs = new URL(v, base).href; } catch (e) { return m; }
      return `url("${local(abs)}")`;
    });
}
function local(abs, inline) {
  if (process.env.SCENECAST_RUST_ASSETS === '1' && typeof abs === 'string') return rustAsset('local', abs, inline && inline[abs]);
  if (inline && inline[abs]) return fromData(inline[abs]) || emptyAsset();
  const e = urlIndex[abs];
  if (!e || !e.file) { missing.set(abs.split('?')[0].slice(0, 140), (e && e.error) || 'not fetched'); return /\.(woff2?|ttf|otf)(\?|$)/i.test(abs) ? '/assets/missing.woff2' : emptyAsset(); }
  const src = join(RAW, 'blobs', e.file);
  const dst = join(ASSETS, e.file);
  // An image or font URL that answered with a web page (a sign-in shell or an error page, with live scripts) is
  // not kept: the page shows what the browser showed for it, nothing.
  if (!e.file.endsWith('.css') && /<(!doctype html|html[\s>])/i.test(readFileSync(src).subarray(0, 600).toString('latin1'))) {
    missing.set(abs.split('?')[0].slice(0, 140), 'answered with an HTML page');
    return /\.(woff2?|ttf|otf|eot)(\?|$)/i.test(abs) ? '/assets/missing.woff2' : emptyAsset();
  }
  used.add(e.file);
  if (e.file.endsWith('.css')) { return asset(Buffer.from(dropMissingFonts(rewriteCss(readFileSync(src, 'utf8'), abs))), 'css'); }
  if (!existsSync(dst)) copyFileSync(src, dst);
  return '/assets/' + e.file;
}

// JWTs and two-part signed tokens (payload.signature), e.g. Copilot's file preview links.
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]{8,})?/g;
const SECRET_PARAMS = /([?&;](?:access_token|id_token|token|sig|signature|code|skypetoken|authorization|auth|session_state|client_info|sv|se|sp|spr|srt|ss|st|skoid|sktid|skt|ske|sks|skv)=)[^&"'\s<>]*/gi;
const scrub = s => s.replace(JWT, '').replace(SECRET_PARAMS, '$1').replace(/Bearer\s+[A-Za-z0-9._-]{20,}/g, 'Bearer');

// flow.edits: sentences removed from the captured text, with any apostrophe form and the space that follows.
// { replace: [a, b] } without `in` replaces a text the same way, everywhere. Edits limited to some captures (e.in) are
// further down.
// (lib/edits.mjs, shared with the server)
const ALL_EDITS = compileEdits(flow.edits);
const EDITS = ALL_EDITS.filter(e => !e.in);
// demo.json build.hook: a demo's own text pass (a module whose default export takes { elementEnd } and returns
// { html(text, ctx, opt), plain(text, ctx), leftovers(text, ctx), unused(), report() }), run after the edits on every
// page (ctx: its snap id), stream frame (ctx 'stream:<name>', opt.partial: frames cut mid-sentence), and hover and click
// part (ctx 'hover:<app>' / 'click:<app>'). The build fails on anything it reports left over or unused.
const HOOK_SPEC = (demo.cfg.build || {}).hook;
const HOOK = HOOK_SPEC ? (await import(pathToFileURL(join(demo.dir, HOOK_SPEC)).href)).default({ elementEnd }) : null;
const edit = (s, ctx = '', opt) => { s = applyEdits(s, EDITS); return HOOK ? HOOK.html(s, ctx, opt) : s; };

function rewriteDoc(doc, snapId, docsByKey) {
  if (process.env.SCENECAST_RUST_ASSETS === '1') return edit(rustAsset('document', snapId, JSON.stringify({ doc, keys: Object.keys(docsByKey) })), snapId);
  let h = doc.html;
  h = h.replace(/<style([^>]*) data-d1-fetch="d1res:\/\/(\d+)"([^>]*)><\/style>/g, (m, a, n, b) => {
    const url = doc.urls[+n]; const t = cssFile(url);
    if (t === null) missing.set(url.split('?')[0], 'stylesheet');
    return `<style${a}${b}>${(t || '').replace(/<\/style/gi, '<\\/style')}</style>`;
  });
  h = h.replace(/\/\* d1-import d1res:\/\/(\d+) \*\//g, (m, n) => cssFile(doc.urls[+n]) || '');
  h = h.replace(/d1res:\/\/(\d+)/g, (m, n) => local(doc.urls[+n], doc.inline));
  h = h.replace(/data-d1-canvas="(canvas\d+)"/g, (m, k) => `data-d1-canvas="${doc.inline[k] ? fromData(doc.inline[k]) : ''}"`);
  h = h.replace(/(<iframe\b[^>]*?)\s(?:sandbox|csp)="[^"]*"/g, '$1').replace(/(<iframe\b[^>]*?)\s(?:sandbox|csp)="[^"]*"/g, '$1');
  h = h.replace(/d1frame:\/\/(f\d+)/g, (m, k) => docsByKey[k] ? `/snaps/${snapId}.${k}.html` : 'about:blank');
  return edit(scrub(quiet(dropMissingFonts(h))), snapId);
}
// Declarations Chrome warns about in the console (deprecated values the real apps still ship).
// focusgroup (an experimental attribute): Chrome warns whenever a morph changes or removes it.
const quiet = text => text.replace(/(-webkit-)?appearance:\s*slider-vertical\s*;?/g, '').replace(/\sfocusgroup="[^"]*"/g, '');
const rewritePart = (html, rec) => process.env.SCENECAST_RUST_ASSETS === '1'
  ? rustAsset('fragment', JSON.stringify({ html, urls: rec.urls, inline: rec.inline }))
  : scrub(quiet(html.replace(/d1res:\/\/(\d+)/g, (m, n) => local(rec.urls[+n], rec.inline))));
// @font-face sources that never loaded in the real page (404, dead host) are dropped, and a rule left with no
// source goes too: the browser falls back the same way, without a failed request in the console.
function dropMissingFonts(text) {
  return text.replace(/@font-face\s*\{[^}]*\}/g, rule => {
    if (!rule.includes('/assets/missing.woff2')) return rule;
    const fixed = rule.replace(/url\("\/assets\/missing\.woff2"\)(\s*format\([^)]*\))?\s*,?\s*/g, '').replace(/,\s*;/g, ';').replace(/src:\s*,/g, 'src: ');
    return /src:\s*(;|\})/.test(fixed) || !/url\(/.test(fixed) ? '' : fixed;
  });
}

// Only the snapshots the flow uses are written.
// variants: captures used only as sources for part of a page (a collapsed sidebar, an expanded list, a card).
const want = new Set([...Object.values(flow.states).map(s => s.snap), ...(flow.variants || [])]);
const only = (args.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const snapsDir = join(RAW, 'snaps');
const report = { snaps: [], streams: [] };
for (const f of readdirSync(snapsDir)) {
  const id = f.replace(/\.json$/, '');
  if (id.startsWith('x-') || (want.size && !want.has(id))) continue;
  if (only.length && !only.includes(id)) continue;
  const s = JSON.parse(readFileSync(join(snapsDir, f), 'utf8'));
  const byKey = Object.fromEntries(s.docs.map(d => [d.key, d]));
  for (const d of s.docs) {
    const name = d.key === 'main' ? `${id}.html` : `${id}.${d.key}.html`;
    writeFileSync(join(OUT, 'snaps', name), rewriteDoc(d, id, byKey));
  }
  const main = byKey.main;
  writeFileSync(join(OUT, 'snaps', `${id}.json`), JSON.stringify({ id, title: main.meta.title, url: scrub(main.meta.url).split('?')[0], viewport: main.meta.viewport, colorScheme: main.meta.colorScheme, customElements: [...new Set(s.docs.flatMap(d => d.meta.customElements || []))], frames: s.docs.filter(d => d.key !== 'main').map(d => ({ key: d.key, parent: d.parent, origin: (d.frameUrl || '').split('/').slice(0, 3).join('/') })) }, null, 1));
  report.snaps.push(id);
}
// Streams: one <body> file per frame (git delta-compresses them well), plus an index with the real timings.
// def.frames [first, last] trims the run to the frames that matter (inclusive); identical neighbours are dropped.
for (const [name, def] of Object.entries(flow.streams || {})) {
  const dir = join(RAW, 'streams', def.raw || name);
  if (!existsSync(dir)) { console.log(`stream ${name}: no raw frames (${def.raw || name})`); continue; }
  const all = readdirSync(dir).sort().map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')));
  const [first, last] = def.frames || [0, all.length - 1];
  const frames = all.filter(fr => fr.n >= first && fr.n <= last);
  mkdirSync(join(OUT, 'streams', name), { recursive: true });
  const index = []; let prev = '';
  for (const fr of frames) {
    const rawHtml = process.env.SCENECAST_RUST_ASSETS === '1' ? rustAsset('frame', JSON.stringify(fr))
      : scrub(quiet(fr.html.replace(/d1res:\/\/(\d+)/g, (m, n) => local(fr.urls[+n], fr.inline))
        .replace(/data-d1-canvas="(canvas\d+)"/g, (m, k) => `data-d1-canvas="${fr.inline && fr.inline[k] ? fromData(fr.inline[k]) : ''}"`)));
    const html = edit(rawHtml, 'stream:' + name, { partial: true });
    if (html === prev) continue;
    prev = html;
    const file = String(index.length).padStart(3, '0') + '.html';
    writeFileSync(join(OUT, 'streams', name, file), html);
    index.push({ file, t: fr.t, raw: fr.n });
  }
  writeFileSync(join(OUT, 'streams', `${name}.json`), JSON.stringify({ name, frames: index }, null, 1));
  report.streams.push(`${name} ${index.length} frames`);
}
// Edits limited to some captures: a tooltip that came along, or a text that differs only by when it was captured.
for (const e of (flow.edits || []).filter(e => e.in)) for (const id of e.in) {
  const f = join(OUT, 'snaps', id + '.html'); if (!existsSync(f)) continue;
  let html = readFileSync(f, 'utf8');
  if (e.replace || e.remove) html = applyEdits(html, compileEdits([e]), id);
  if (e.dropTooltip) {
    const at = html.indexOf(`>${e.dropTooltip}</div>`);
    if (at >= 0) { const st = html.lastIndexOf('<div', at); const s0 = html.slice(st, at); if (/role="tooltip"/.test(s0)) html = html.slice(0, st) + html.slice(elementEnd(html, st)); }
  }
  writeFileSync(f, html);
}
// flow.compose: parts of one capture placed into others (see compose.mjs).
for (const step of flow.compose || []) {
  const src = readFileSync(join(OUT, 'snaps', step.from + '.html'), 'utf8');
  const at = src.indexOf(step.marker);
  if (at < 0) throw new Error('compose: marker not found in ' + step.from);
  const start = src.lastIndexOf('<' + step.tag, at);
  let part = src.slice(start, elementEnd(src, start));
  for (const [a, b] of step.text || []) { if (!part.includes(a)) throw new Error('compose: text not in part: ' + a); part = part.split(a).join(b); }
  const files = [...readdirSync(join(OUT, 'snaps')).filter(f => f.endsWith('.html')).map(f => join(OUT, 'snaps', f)), ...readdirSync(join(OUT, 'streams'), { recursive: true }).filter(f => f.endsWith('.html')).map(f => join(OUT, 'streams', f))];
  step.n = 0;
  for (const f of files) {
    const html = readFileSync(f, 'utf8');
    if (!html.includes(step.anchor)) continue;
    const out = compose(html, step, part, html.includes('</head>') ? cssFor(part, src, html) : '');
    writeFileSync(f, out); step.n++;
    report.composed = (report.composed || []).concat(f.replace(/\\/g, '/').split('/').slice(-2).join('/'));
  }
  if (!step.n) throw new Error('compose: anchor not found anywhere: ' + step.anchor);
}
// Parts the layout rules borrow from a capture (the "+N" chip): every screen of the app gets their CSS.
for (const app of flow.apps) for (const r of ((app.layout || {}).chips || [])) {
  const vhtml = readFileSync(join(OUT, 'snaps', r.plus.from + '.html'), 'utf8');
  const m = vhtml.indexOf(r.plus.marker);
  if (m < 0) throw new Error('chips: plus not found in ' + r.plus.from);
  const [st, en] = around(vhtml, m, r.plus.tag || 'li');
  const part = vhtml.slice(st, en);
  for (const snap of new Set(Object.values(flow.states).filter(st => st.app === app.id).map(st => st.snap))) {
    const f = join(OUT, 'snaps', snap + '.html'); const html = readFileSync(f, 'utf8');
    const css = cssFor(part, vhtml, html);
    if (css) writeFileSync(f, html.replace('</head>', `<style data-d1-part="plus">${css}</style></head>`));
  }
}
// Responsive variants (a part of a page captured at another width): their merge-styles classes are made their own,
// and every screen of the app gets the CSS that part needs and doesn't already have.
// A band's variant can be one capture for every state, or one per state ({ default, <state>: capture }): then only
// the screens it stands in for get its CSS.
for (const app of flow.apps) for (const r of ((app.layout || {}).responsive || [])) {
  const appStates = Object.entries(flow.states).filter(([, st]) => st.app === app.id);
  const servedBy = new Map();
  const serve = (v, ids) => { if (!v) return; if (!servedBy.has(v)) servedBy.set(v, new Set()); ids.forEach(i => servedBy.get(v).add(i)); };
  const each = v => { if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) serve(x, k === 'default' ? appStates.map(([i]) => i) : [k]); } else serve(v, appStates.map(([i]) => i)); };
  if (r.bands) r.bands.forEach(b => each(b.variant)); else each(r.variant);
  if (r.flagVariant) each(r.flagVariant);
  const variants = [...servedBy.keys()];
  for (const v of variants) {
    const states = appStates.filter(([i]) => servedBy.get(v).has(i)).map(([, st]) => st.snap);
    const vf = join(OUT, 'snaps', v + '.html');
    const vhtml = isolateClasses(readFileSync(vf, 'utf8'));
    writeFileSync(vf, vhtml);
    // The part: the element r.part.css names (a start-tag pattern), then r.part.up ancestors up.
    const at = vhtml.search(new RegExp(r.part.css));
    if (at < 0) throw new Error('responsive: part not found in ' + v);
    const anc = ancestorsAt(vhtml, at);
    const start = r.part.up ? anc[anc.length - r.part.up] : at;
    const part = vhtml.slice(start, elementEnd(vhtml, start));
    for (const snap of new Set(states)) {
      const f = join(OUT, 'snaps', snap + '.html');
      const html = readFileSync(f, 'utf8');
      const css = cssFor(part, vhtml, html);
      if (css) writeFileSync(f, html.replace('</head>', `<style data-d1-variant="${v}">${css.replace(/<\/style/gi, '<\\/style')}</style></head>`));
    }
    report.variants = (report.variants || []).concat(`${v}: part ${Math.round(part.length / 1024)}KB`);
  }
}
writeFileSync(join(ASSETS, 'missing.woff2'), Buffer.alloc(0));

// Hovers from the hover audit (capture/flow/hover-audit.js): for each app, data/snaps/hovers-<app>.json holds what
// hovering each element shows on the real page (in-place changes and portals), its CSS, and when it appears.
// Merge-styles and React-id class names are made the audit's own (they mean something else in other captures).
// Griffel's atomic (f…) and reset (r…) classes, and every capture's rules for them, read once on first use.
const GRIFFEL_CLASS = /^[fr][a-z0-9]{5,8}$/;
let griffelIndex = null;
function griffelRules() {
  if (griffelIndex) return griffelIndex;
  griffelIndex = new Map();
  const seen = new Set();
  const take = (css, wrap) => {
    const sel = css.slice(0, css.indexOf('{'));
    const classes = [...sel.matchAll(/\.([A-Za-z0-9_-]+)/g)].map(m => m[1]);
    const g = classes.filter(c => GRIFFEL_CLASS.test(c));
    if (!g.length || !classes.every(c => GRIFFEL_CLASS.test(c))) return;
    const full = wrap ? wrap + '{' + css + '}' : css;
    if (seen.has(full)) return; seen.add(full);
    for (const c of g) (griffelIndex.get(c) || griffelIndex.set(c, []).get(c)).push({ css: full, classes });
  };
  for (const f of readdirSync(join(RAW, 'snaps')).filter(f => f.endsWith('.json'))) {
    const texts = [];
    (function walk(o) { if (typeof o === 'string') { if (o.length > 40 && o.includes('{') && /\.[fr][a-z0-9]{5,8}[{:.\s,>\[]/.test(o)) texts.push(o); } else if (o && typeof o === 'object') for (const v of Object.values(o)) walk(v); })(JSON.parse(readFileSync(join(RAW, 'snaps', f), 'utf8')));
    for (const t of texts) {
      let depth = 0, start = 0;
      for (let i = 0; i < t.length; i++) {
        if (t[i] === '{') depth++;
        else if (t[i] === '}' && --depth === 0) {
          const r = t.slice(start, i + 1).trim().replace(/\s*\n\s*/g, ' '); start = i + 1;
          if (r.startsWith('@media') || r.startsWith('@supports')) { const w = r.slice(0, r.indexOf('{')).trim(); for (const m of r.slice(r.indexOf('{') + 1, -1).matchAll(/[^{}]+\{[^{}]*\}/g)) take(m[0].trim(), w); }
          else if (!r.startsWith('@')) take(r, '');
        }
      }
    }
  }
  return griffelIndex;
}
const REACT_ID_CLASS = /_r_[0-9a-z]+_/;
// A style change that only touches script bookkeeping (CSS anchor names, custom properties): what's on screen is
// the same before and after. (A change that also removes display: none is not.)
const visibleDecl = v => String(v || '').split(';').map(x => x.trim()).filter(x => x && !/^(anchor-name|--[\w-]+)\s*:/.test(x)).sort().join(';');
const styleBookkeeping = o => visibleDecl(o.set.style) === visibleDecl(o.was && o.was.style);
function isolateHoverJs(html, prefix) {
  const fix = v => v.split(/(\s+)/).map(t => /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(t) || REACT_ID_CLASS.test(t) ? prefix + t : t).join('');
  html = html.replace(/class="([^"]*)"/g, (m, v) => 'class="' + fix(v) + '"');
  return html.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/g, (m, a, css, b) => a + css.replace(/\.([A-Za-z][A-Za-z0-9]*-\d+|[A-Za-z0-9_-]*_r_[0-9a-z]+_[A-Za-z0-9_-]*)(?![\w-])/g, '.' + prefix + '$1') + b);
}
const isolateHover = (html, prefix) => process.env.SCENECAST_RUST_ASSETS === '1'
  ? rustAsset('isolate-classes', JSON.stringify([html, prefix, true]))
  : isolateHoverJs(html, prefix);
const fixClassValue = (v, prefix) => v == null ? v : process.env.SCENECAST_RUST_ASSETS === '1'
  ? rustAsset('isolate-class-value', JSON.stringify([v, prefix, true]))
  : v.split(/(\s+)/).map(t => /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(t) || REACT_ID_CLASS.test(t) ? prefix + t : t).join('');
report.hovers = {};
const hoverOut = Object.fromEntries(flow.apps.map(a => [a.id, { css: {}, defs: [] }]));
const appSeenOf = Object.fromEntries(flow.apps.map(a => [a.id, new Map()]));
(flow.hoverPages || []).forEach((hp, k) => {
  const dir = join(RAW, 'hovers', hp.page);
  if (!existsSync(dir)) { report.hovers[hp.page] = 'no capture'; return; }
  const prefix = `d1h${k}-`;
  const snapFile = join(RAW, 'snaps', `hov-${hp.cssFrom || hp.page}.json`);
  // Hover records only (a click audit folder also holds its clicks); hp.only picks records by name.
  const recs = readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => JSON.parse(readFileSync(join(dir, f), 'utf8'))).filter(r => (!r.kind || r.kind === 'send-hover') && (!hp.only || hp.only.includes(r.cand.text)));
  for (const r of recs) if (r.kind === 'send-hover' && hp.delayMs) r.firstMs = hp.delayMs;
  if (!recs.length) { report.hovers[hp.page] = 'empty'; return; }
  let srcHtml = '';
  if (existsSync(snapFile)) {
    const snap = JSON.parse(readFileSync(snapFile, 'utf8'));
    const fu = recs[0].frameUrl;
    const d = snap.docs.find(x => (x.frameUrl || '').split('?')[0] === fu) || snap.docs.find(x => x.key === 'main');
    srcHtml = isolateHover(rewriteDoc(d, 'hov-' + hp.page, {}), prefix);
  }
  const fixPart = (h, rec) => isolateHover(edit(rewritePart(h, rec), 'hover:' + hp.app).replace(/\sdata-d1-hpart="\d+"/g, '').replace(/\sdata-d1-scroll="[^"]*"/g, ''), prefix);
  const seen = new Map(); const appSeen = appSeenOf[hp.app]; const used = []; let n = 0;
  // Old audits (Teams) didn't time the tooltip itself: use the page's usual tooltip delay (the median time of
  // hovers that showed only a tooltip).
  const ms = v => Math.max(0, Math.min(1500, (v || 0) - 40));
  const tipOnly = recs.filter(r => r.res.portals && !(r.res.ops || []).some(o => o.kind === 'attr')).map(r => r.farMs != null ? r.farMs : r.firstMs).sort((a, b) => a - b);
  const tipMs = tipOnly.length ? tipOnly[Math.floor(tipOnly.length / 2)] : 300;
  // An anchor is kept if it picks out its element: it has text, or a data-testid/data-tid only one element has.
  const clean = a => { const { count, ...rest } = a || {}; if (count === 1 && /\[data-(testid|tid)=/.test(rest.sel || '')) { delete rest.text; delete rest.textStarts; } return rest; };
  const usable = a => a && (a.count === 1 || a.text || a.textStarts);
  // The same hover seen on two pages of an app (the sidebar on Home and on a task) is kept once: ids, React ids and
  // the per-page class prefix don't count.
  const plain = h => (h || '').replace(/\s(id|aria-describedby|aria-labelledby|aria-owns|aria-controls)="[^"]*"/g, '').replace(/d1h\d+-/g, '').replace(/_r_[0-9a-z]+_/g, '');
  const add = (def, rec) => {
    const sig = JSON.stringify([def.frame, def.scope, (def.ops || []).map(o => ({ ...o, html: plain(o.html), set: o.set && plain(JSON.stringify(o.set)), was: undefined })), (def.portals || []).map(q => [q.text, q.pos && q.pos.placement, q.trigger && q.trigger.sel, q.trigger && q.trigger.text])]);
    if (appSeen.has(sig) && !seen.has(sig)) { const t = appSeen.get(sig); if (!t.anchors.some(a => JSON.stringify(a) === JSON.stringify(def.anchor))) t.anchors.push(def.anchor); return; }
    const twin = seen.get(sig);
    const anchor = def.anchor;
    if (twin) { if (!twin.anchors.some(a => JSON.stringify(a) === JSON.stringify(anchor))) twin.anchors.push(anchor); return; }
    def.anchors = [anchor];
    def.shot = rec.res.shotClip ? `${hp.page}/${String(rec.n).padStart(4, '0')}.png` : null;
    seen.set(sig, def); appSeen.set(sig, def); hoverOut[hp.app].defs.push(def); n++;
  };
  for (const rec of recs) {
    const r = rec.res;
    // What changes in place belongs to the element that holds the changes (a row, a header); a tooltip or card
    // belongs to the element it's attached to. They are two hovers, each with its own delay.
    // An empty placeholder the previous hover left behind (Fluent's hidden tooltip <span>) going away is not part of
    // this hover: the replica never had it.
    if (r.ops) r.ops = r.ops.filter(o => !(o.kind === 'remove' && o.restTag !== '#text' && !o.restText));
    // Likewise an empty hidden placeholder this hover leaves somewhere (Fluent puts one next to each tooltip).
    if (r.ops) r.ops = r.ops.filter(o => !(o.kind === 'add' && /^<([a-z]+)[^>]*\shidden=""[^>]*><\/\1>$/.test((rec.parts[o.part] || '').replace(/\sdata-d1-hpart="\d+"/g, ''))));
    // Script bookkeeping in inline styles (CSS anchor names, custom properties, a style emptied on the item hovered
    // before) changes nothing on screen by itself and would replay on fixed items in a list.
    if (r.ops) r.ops = r.ops.filter(o => !(o.kind === 'attr' && Object.keys(o.set).every(k => k === 'style') && styleBookkeeping(o)));
    // Style ticks on SVG parts are an animation running on the page, not the hover.
    if (r.ops) r.ops = r.ops.filter(o => !(o.kind === 'attr' && /^(g|svg|path|circle|rect|ellipse|line|polygon|polyline|stop|lineargradient|radialgradient)$/i.test(o.tag || '') && Object.keys(o.set).every(k => k === 'style')));
    // An anchor with no name of its own (a plain div around a rail button) is found by its size, next to a target
    // that has a name.
    const bySize = r.ops && r.ops.length && !usable(r.anchor) && usable(r.target) && r.anchor && r.anchor.sel;
    if (r.ops && r.ops.length && (usable(r.anchor) || bySize)) {
      // The hover belongs to the smallest part that holds all its changes (scope: its path from the anchor), not
      // to the whole anchor: the Activity button's hover must not happen when the pointer is elsewhere in Teams.
      // (An op's path leads to the element it changes, or for added/removed children, to their parent.)
      let scope = r.ops[0].path || [];
      for (const o of r.ops) { const p2 = o.path || []; let k = 0; while (k < scope.length && k < p2.length && scope[k] === p2[k]) k++; scope = scope.slice(0, k); }
      // Changes in unrelated places of a big part of the page (not around the pointer) aren't a hover of this element.
      const vp = rec.viewport || [1920, 1080];
      // (A change on the part itself, like Microsoft IQ's title area showing its actions, is a hover of that part.)
      if (!scope.length && !r.ops.some(o => !(o.path || []).length) && new Set(r.ops.map(o => o.path[0])).size > 1 && r.anchorRect.w * r.anchorRect.h > 0.05 * vp[0] * vp[1]) { report.dropped = (report.dropped || 0) + 1; r.ops = []; }
      const ops = r.ops.map(o => {
        const op = { ...o, path: (o.path || []).slice(scope.length) };
        if (o.kind === 'add') { op.html = fixPart(rec.parts[o.part], rec); used.push(op.html); delete op.part; }
        if (o.kind === 'attr' && o.set.class !== undefined) { op.set = { ...o.set, class: fixClassValue(o.set.class, prefix) }; op.was = { ...o.was, class: fixClassValue(o.was.class, prefix) }; used.push(`<i class="${op.set.class}">`); }
        return op;
      });
      if (ops.length) add({ id: `${hp.page}-${rec.n}`, page: hp.page, frame: hp.frame || null, delay: ms(rec.firstMs), anchor: clean(r.anchor), anchorRect: r.anchorRect, scope, ops, bySize: bySize ? { w: r.anchorRect.w, h: r.anchorRect.h, target: clean(r.target) } : undefined }, rec);
    }
    for (const [i, q] of (r.portals || []).entries()) {
      const trig = q.trigger;
      const html = fixPart(rec.parts[q.part], rec);
      const shells = q.shells.map(t => isolateHover(scrub(t.replace(/d1res:\/\/(\d+)/g, (m, n2) => local(rec.urls[+n2], rec.inline))), prefix));
      // Not a popup: a part of the page that changed far from the pointer (a whole section), with no position.
      if (!q.pos || q.text.length > 400) { report.dropped = (report.dropped || 0) + 1; continue; }
      // An icon with no text of its own, one of several alike, whose popup the element around it already has
      // (a chip's icon inside the chip's button): the element around it carries it.
      if (!usable(trig) && recs.some(o => o !== rec && (o.res.portals || []).some(x => x.text === q.text && usable(x.trigger)))) { report.dropped = (report.dropped || 0) + 1; continue; }
      used.push(html, ...shells);
      add({ id: `${hp.page}-${rec.n}-p${i}`, page: hp.page, frame: hp.frame || null, delay: ms(rec.farMs != null ? rec.farMs : Math.max(rec.firstMs, tipMs)), anchor: clean(trig), anchorRect: q.triggerRect, loose: !usable(trig) || undefined,
        portals: [{ html, shells, trigger: clean(trig), triggerRect: q.triggerRect, pos: q.pos, rect: q.rect, text: q.text, vp: rec.viewport }] }, rec);
    }
  }
  hoverOut[hp.app].css[hp.page] = srcHtml ? cssFor(used.join('\n'), srcHtml, readFileSync(join(OUT, 'snaps', (hp.base || '') + (hp.frame ? '.' + hp.frame : '') + '.html'), 'utf8')) : '';
  report.hovers[hp.page] = `${n} hovers from ${recs.length} records, css ${Math.round(hoverOut[hp.app].css[hp.page].length / 1024)}KB`;
});
// Workspace chip cards for chips the audit couldn't hover (SharePoint, Skill Management are only on other tasks).
// Copilot builds each card from the chip's own name, description and "Built-in", a blank line apart; the card
// around the text is a real one (the audit's, else the Work IQ card captured on Nov 14 in cop-ask-workiq).
for (const cc of flow.chipCards || []) {
  const out = hoverOut[cc.app];
  const CHIP = 'li[role="listitem"][data-chip-item=""][data-list-row=""]';
  // Name (the chip's Caption1 text), then the description and "Built-in" (the spans its aria-describedby names).
  const chipText = li => { const name = /<span class="fui-Caption1[^"]*"[^>]*>([^<]*)<\/span>/.exec(li); return [name && name[1], ...[...li.matchAll(/<span aria-hidden="true"[^>]*\sid="[^"]*"[^>]*>([^<]*)<\/span>/g)].map(m => m[1])].filter(t => t && t.trim()); };
  const decode = t => t.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  // A real chip card from the audit: a tooltip in the Workspace pane whose text has blank-line-separated parts.
  let tpl = out.defs.find(d => !d.composed && d.portals && d.anchors.some(a => a.in === 'aside') && /role="tooltip"/.test(d.portals[0].html) && /\n\n/.test(d.portals[0].html));
  let tplPortal = tpl && tpl.portals[0];
  if (!tplPortal) {
    const html = readFileSync(join(OUT, 'snaps', cc.fallback.snap + '.html'), 'utf8');
    const at = html.lastIndexOf('<div role="tooltip"', html.indexOf(cc.fallback.marker));
    const anc = ancestorsAt(html, at);
    const rootAt = anc.reverse().find(i => /data-portal-node="true"/.test(html.slice(i, html.indexOf('>', i))));
    const outer = ancestorsAt(html, rootAt).filter(i => !/^<(html|body)[\s>]/.test(html.slice(i, i + 6)));
    tplPortal = { html: html.slice(rootAt, elementEnd(html, rootAt)), shells: outer.map(i => html.slice(i, html.indexOf('>', i) + 1)), trigger: { sel: 'span[role="group"]', in: 'aside' }, ...cc.fallback.geometry };
  }
  const tplText = /(<span[^>]*>)([^<]*\n\n[^<]*)(<\/span>)/.exec(tplPortal.html);
  if (!tplText) throw new Error('chipCards: no card text in the template');
  const normT = t => (t || '').replace(/\s+/g, ' ').trim();
  const have = new Set(out.defs.flatMap(d => (d.portals || []).map(q => normT(q.text))));
  let made = 0;
  for (const snap of new Set(Object.values(flow.states).filter(st => st.app === cc.app).map(st => st.snap))) {
    const html = readFileSync(join(OUT, 'snaps', snap + '.html'), 'utf8');
    const aside = html.indexOf('<aside'); if (aside < 0) continue;
    for (const m of html.slice(aside, html.indexOf('</aside>', aside)).matchAll(/<li role="listitem"[^>]*data-chip-item=""[\s\S]*?<\/li>/g)) {
      const parts = chipText(m[0]);
      if (parts.length < 2) continue;
      const text = decode(parts.join(' ')).replace(/\s+/g, ' ').trim();
      if (have.has(text)) continue;
      have.add(text);
      const card = tplPortal.html.replace(tplText[0], tplText[1] + parts.join('\n\n') + tplText[3]);
      const trigger = m[0].includes('<button') ? { sel: 'button', in: 'aside' } : { sel: 'span[role="group"]', in: 'aside' };
      out.defs.push({ id: `chip-${++made}`, page: tpl ? tpl.page : null, frame: null, delay: tpl ? tpl.delay : cc.fallback.delay, anchor: { sel: CHIP, text, in: 'aside' }, anchors: [{ sel: CHIP, text, in: 'aside' }], portals: [{ ...tplPortal, trigger, html: card, text: decode(parts.join(' ')) }], composed: true });
    }
  }
  report.chipCards = made;
}
// Clicks from the click audit (capture/flows/click-audit.js): what clicking a control does on the real page (in
// place, from an ancestor of the control; and popups) and how the page undoes it. Stored with the hovers.
// flow.clickPages[]: { page, app, base, frame?, sticky: [names], restore: { name: how }, reopen: { name: matcher },
// drop: [names], copies: { name: [other names] }, css: [snap ids], vendorCss: [files in the demo folder] }.
report.clicks = {};
(flow.clickPages || []).forEach((cp, k) => {
  const dir = join(RAW, 'hovers', 'click-' + cp.page);
  if (!existsSync(dir)) { report.clicks[cp.page] = 'no capture'; return; }
  const prefix = `d1c${k}-`;
  const recs = readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => JSON.parse(readFileSync(join(dir, f), 'utf8'))).filter(r => r.kind === 'click');
  const out = hoverOut[cp.app]; out.clicks = out.clicks || []; out.css = out.css || {};
  const fixPart = (h, rec) => isolateHover(edit(rewritePart(h, rec), 'click:' + cp.app).replace(/\sdata-d1-(hpart|ctl)="[^"]*"/g, '').replace(/\sdata-d1-scroll="[^"]*"/g, '').replace(/\sfocusgroup="[^"]*"/g, ''), prefix);
  const used = []; let n = 0; let lazy = '';
  for (const rec of recs) {
    const r = rec.res;
    const name = rec.cand.text;
    if (!r || (cp.drop || []).includes(name)) continue;
    // Stylesheets that came with the click (styles a menu loads when it first opens): their rules are CSS sources.
    if (rec.css && rec.css.parts) lazy += rec.css.parts.map(h => isolateHover(scrub(h.replace(/d1res:\/\/(\d+)/g, (m, n2) => local(rec.css.urls[+n2], rec.css.inline))).replace(/\sdata-d1-hcss="[^"]*"/g, ''), prefix)).join('\n');
    // How it closes: as the flow says; a menu or popup closes like one (Escape, a click elsewhere); else as audited.
    let restore = (cp.restore || {})[name] || rec.restore;
    const popup = (r.portals || []).length || /^(menu|dialog|true|listbox)$/.test((rec.ctl.attrs || {})['aria-haspopup'] || '');
    if (restore === 'stuck' && popup) restore = 'escape';
    if (restore === 'stuck') { report.clicks[cp.page + ':' + name] = 'skipped: stuck'; continue; }
    let ops = (r.ops || []).filter(o => !(o.kind === 'remove' && o.restTag !== '#text' && !o.restText) && !(o.kind === 'attr' && Object.keys(o.set).every(k2 => k2 === 'style') && styleBookkeeping(o)) && !(o.kind === 'attr' && /^(g|svg|path|circle|rect)$/i.test(o.tag || '') && Object.keys(o.set).every(k2 => k2 === 'style')));
    ops = ops.map(o => {
      const op = { ...o };
      if (o.kind === 'add') { op.html = fixPart(rec.parts[o.part], rec); used.push(op.html); delete op.part; }
      if (o.kind === 'attr' && o.set.class !== undefined) { op.set = { ...o.set, class: fixClassValue(o.set.class, prefix) }; op.was = { ...o.was, class: fixClassValue(o.was.class, prefix) }; used.push(`<i class="${op.set.class}">`); }
      return op;
    }).filter(o => !(o.kind === 'add' && /^<([a-z]+)[^>]*\shidden=""[^>]*><\/\1>$/.test(o.html)));
    const portals = (r.portals || []).map(q => {
      const html = fixPart(rec.parts[q.part], rec);
      const shells = q.shells.map(t => isolateHover(scrub(t.replace(/d1res:\/\/(\d+)/g, (m, n2) => local(rec.urls[+n2], rec.inline))), prefix).replace(/\sdata-d1-[a-z]+="[^"]*"/g, ''));
      used.push(html, ...shells);
      return { html, shells, trigger: null, triggerRect: rec.ctl.rect, pos: q.pos, rect: q.rect, text: q.text, modal: q.modal, vp: rec.viewport };
    });
    if (!ops.length && !portals.length) continue;
    const { count, ...ctl } = rec.ctl.spec;
    // A narrower anchor: the smallest part holding what changes on screen. Left out of it: screen-reader
    // announcements (text), and what layout rules redo (a fixed composer's position, its placeholder's height).
    const layoutOnly = o => o.kind === 'attr' && Object.keys(o.set).every(k2 => k2 === 'style') && /position: fixed|^min-height: [\d.]+px; width: 100%;?$/.test(o.set.style || '');
    const core = ops.filter(o => o.kind !== 'text' && !layoutOnly(o));
    let pre = core.length ? core[0].path : [];
    for (const o of core) { let k2 = 0; while (k2 < pre.length && k2 < o.path.length && pre[k2] === o.path[k2]) k2++; pre = pre.slice(0, k2); }
    const sops = pre.length && core.length ? ops.filter(o => !layoutOnly(o) && o.path.length >= pre.length && pre.every((v, i) => o.path[i] === v)).map(o => ({ ...o, path: o.path.slice(pre.length) })) : null;
    const sticky = (cp.sticky || []).includes(name);
    const reopen = (cp.reopen || {})[name] || (rec.reopen ? (({ count, ...x }) => x)(rec.reopen) : undefined);
    const def = { id: `click-${cp.page}-${rec.n}`, name, page: cp.page, frame: cp.frame || null, ctl, ctlRect: rec.ctl.rect, ctlAttrs: rec.ctl.attrs, up: r.up, anchorTag: r.anchorTag, ops: ops.length ? ops : undefined, sops: sops || undefined, sup: sops ? r.up - pre.length : undefined, portals: portals.length ? portals : undefined, restore, reopen, revertMs: rec.revertMs || undefined, sticky: sticky || undefined, popup: !!popup || undefined, copy: /^copy\b/i.test(name) || undefined, shot: `click-${cp.page}/${String(rec.n).padStart(4, '0')}.png` };
    out.clicks.push(def); n++;
    // Controls that work the same way on another element: the same changes, with its own name in them.
    for (const other of ((cp.copies || {})[name] || [])) {
      const from = name.replace(/^(Collapse|Expand|Open|Close|Show|Hide) /, '');
      const swap = v => typeof v === 'string' ? v.split(from).join(other) : v;
      const copy = JSON.parse(JSON.stringify(def), (k2, v) => swap(v));
      copy.id = def.id + '-' + other.replace(/\W+/g, '');
      out.clicks.push(copy); n++;
    }
  }
  // CSS: from the page at the end of the click audit (its lazy styles have loaded by then), the hover audit's copy,
  // the snapshots cp.css names, and the stylesheets the clicks brought in.
  const fu = (recs[0] || {}).frameUrl;
  let srcHtml = '';
  for (const id of ['hov-click-' + cp.page, 'hov-' + cp.page, ...(cp.css || [])]) {
    const snapFile = join(RAW, 'snaps', id + '.json');
    if (!existsSync(snapFile)) continue;
    const snap = JSON.parse(readFileSync(snapFile, 'utf8'));
    const d = (cp.frame && (snap.docs.find(x => fu && (x.frameUrl || '').split('?')[0] === fu) || snap.docs.find(x => x.key === cp.frame))) || snap.docs.find(x => x.key === 'main') || snap.docs[0];
    srcHtml += isolateHover(rewriteDoc(d, id, {}), prefix);
  }
  srcHtml += lazy;
  const baseFile = join(OUT, 'snaps', cp.base + (cp.frame ? '.' + cp.frame : '') + '.html');
  if (srcHtml && used.length) out.css['click-' + cp.page] = cssFor(used.join('\n'), srcHtml, readFileSync(baseFile, 'utf8'));
  // Griffel names each atomic and reset class after its declarations, so a class whose component mounts only after
  // the click (and was never on this page) has the same rules wherever another capture loaded it.
  if (used.length) {
    const classes = new Set([...used.join('\n').matchAll(/class="([^"]*)"/g)].flatMap(m => m[1].split(/\s+/)));
    const have = new Set([...(readFileSync(baseFile, 'utf8') + (out.css['click-' + cp.page] || '')).matchAll(/\.([A-Za-z0-9_-]+)/g)].map(m => m[1]));
    const need = [...classes].filter(c => GRIFFEL_CLASS.test(c) && !have.has(c));
    const add = new Set();
    for (const c of need) for (const r of griffelRules().get(c) || []) if (r.classes.every(x => classes.has(x))) add.add(r.css);
    if (add.size) out.css['click-' + cp.page] = (out.css['click-' + cp.page] || '') + '\n' + [...add].join('\n');
    report.griffelCss = (report.griffelCss || 0) + add.size;
  }
  // Library and measured CSS for parts whose rules no capture has (cp.vendorCss: files of plain rules, one per line,
  // in the demo folder; the rules whose classes the parts use are added last, so they win over captured rules).
  for (const vf of cp.vendorCss || []) {
    const classes = new Set(used.join(' ').match(/[A-Za-z0-9_-]+/g));
    const rules = readFileSync(join(demo.dir, vf), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(r => r.trim());
    const keep = rules.filter(r => { const u = [...r.matchAll(/\.([A-Za-z0-9_-]+)/g)].map(m => m[1]); return u.length && u.every(c => classes.has(c)); });
    out.css['click-' + cp.page] = (out.css['click-' + cp.page] || '') + '\n' + keep.join('\n');
    report.vendorCss = (report.vendorCss || 0) + keep.length;
  }
  report.clicks[cp.page] = `${n} clicks from ${recs.length} records${lazy ? ', lazy CSS' : ''}`;
});
// flow.lateItems: a menu caught while one of its items was still loading shows that item as it finished loading in
// another capture. { placeholder: 'data-testid="…-loading"', role: 'menuitem', text: 'Give feedback' }.
for (const li of flow.lateItems || []) for (const h of Object.values(hoverOut)) {
  const parts = (h.clicks || []).flatMap(d => [...(d.portals || []), ...(d.ops || [])]).filter(x => x.html);
  let loaded = null;
  for (const x of parts) {
    const re = new RegExp(`<[a-zA-Z][a-zA-Z0-9-]*\\b[^>]*role="${li.role || 'menuitem'}"`, 'g'); let m;
    // (An <img role="menuitem"> has no end tag to find: not the item.)
    while (!loaded && (m = re.exec(x.html))) { let end; try { end = elementEnd(x.html, m.index); } catch (e) { continue; } const el = x.html.slice(m.index, end); if (el.replace(/<[^>]+>/g, '').includes(li.text) && !el.includes(li.placeholder)) loaded = el; }
    if (loaded) break;
  }
  if (!loaded) continue;
  for (const x of parts) for (let at = x.html.indexOf(li.placeholder); at >= 0; at = x.html.indexOf(li.placeholder)) {
    const st = x.html.lastIndexOf('<', at);
    x.html = x.html.slice(0, st) + loaded + x.html.slice(elementEnd(x.html, st));
    report.loadedItems = (report.loadedItems || 0) + 1;
  }
}
// Step groups (flow.groups: one per app): what each group's list shows when it's open, and how its button and region
// change. The product can drop a list group's list when it closes, so lists come from real open captures
// (open: [{ open, closed }], from record side groups), else from the run's frames where the group was still filled
// (streams; dropLines takes out lines the product only shows while it runs). How the button, its chevron and the
// region change comes from a real closed/open pair (template). button, label and chevron are simple selectors
// (a tag, [attributes], .classes; commas for more than one; no spaces).
{
  const attrOf = (tag, n) => { const m = new RegExp('\\s' + n.replace(/[-]/g, '\\-') + '="([^"]*)"').exec(tag); return m ? m[1] : null; };
  const attrsOf = tag => Object.fromEntries([...tag.matchAll(/\s([^\s="'<>\/]+)(?:="([^"]*)")?/g)].map(m => [m[1], m[2] === undefined ? '' : m[2]]));
  const tagName = tag => /^<([a-zA-Z][\w-]*)/.exec(tag)[1].toLowerCase();
  // One simple selector against one start tag.
  const simpleMatch = (tag, sel) => {
    const m = /^([a-zA-Z][\w-]*|\*)?((?:\[[^\]]+\]|\.[\w-]+)*)$/.exec(sel.trim());
    if (!m) throw new Error('groups: not a simple selector: ' + sel);
    if (m[1] && m[1] !== '*' && tagName(tag) !== m[1].toLowerCase()) return false;
    for (const part of m[2].match(/\[[^\]]+\]|\.[\w-]+/g) || []) {
      if (part[0] === '.') { if (!(attrOf(tag, 'class') || '').split(/\s+/).includes(part.slice(1))) return false; continue; }
      const a = /^\[\s*([\w:-]+)\s*(?:([*^$~]?=)\s*["']?([^"'\]]*)["']?)?\s*\]$/.exec(part);
      const v = attrOf(tag, a[1]);
      if (v === null) return false;
      if (!a[2]) continue;
      if (a[2] === '=' && v !== a[3]) return false;
      if (a[2] === '^=' && !v.startsWith(a[3])) return false;
      if (a[2] === '$=' && !v.endsWith(a[3])) return false;
      if (a[2] === '*=' && !v.includes(a[3])) return false;
      if (a[2] === '~=' && !v.split(/\s+/).includes(a[3])) return false;
    }
    return true;
  };
  const tagMatches = (tag, sel) => sel.split(',').some(x => simpleMatch(tag, x));
  const decode = t => t.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const VOIDS = /^(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)$/;
  const endOf = (html, at) => { const tag = html.slice(at, html.indexOf('>', at) + 1); return VOIDS.test(tagName(tag)) || /\/>$/.test(tag) ? at + tag.length : elementEnd(html, at); };
  // Direct element children of the element at `at`: [start, end] pairs.
  const kidsOf = (html, at) => {
    const out = []; const end = endOf(html, at); let i = html.indexOf('>', at) + 1;
    while (i < end) {
      const j = html.indexOf('<', i); if (j < 0 || j >= end) break;
      if (html.startsWith('</', j)) break;
      if (html.startsWith('<!--', j)) { i = html.indexOf('-->', j) + 3; continue; }
      const e = endOf(html, j); out.push([j, e]); i = e;
    }
    return out;
  };
  // Text without aria-hidden parts (what the engine reads as a group's label).
  const textOf = h => { let s = h; for (let k = s.search(/<[a-zA-Z][^>]*\saria-hidden="true"/); k >= 0; k = s.search(/<[a-zA-Z][^>]*\saria-hidden="true"/)) s = s.slice(0, k) + s.slice(endOf(s, k)); return decode(s.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim(); };
  const groupsIn = (html, G) => {
    const out = [];
    for (const m of html.matchAll(/<[a-zA-Z][\w-]*\b[^>]*\saria-controls="[^"]*"[^>]*>/g)) {
      const tag = m[0]; if (!tagMatches(tag, G.sel.button)) continue;
      const b0 = m.index, b1 = endOf(html, b0), inside = html.slice(b0, b1);
      let label = null;
      if (G.sel.label) { for (const t of inside.slice(tag.length).matchAll(/<[a-zA-Z][\w-]*\b[^>]*>/g)) if (tagMatches(t[0], G.sel.label)) { const s0 = tag.length + t.index; label = textOf(inside.slice(s0, endOf(inside, s0))); break; } }
      if (label === null) label = textOf(inside);
      const id = attrOf(tag, 'aria-controls'); const at = html.indexOf(` id="${id}"`); const r0 = at < 0 ? -1 : html.lastIndexOf('<', at);
      if (!label || r0 < 0) continue;
      const kids = kidsOf(html, r0);
      const inner = kids.length ? { tag: html.slice(kids[0][0], html.indexOf('>', kids[0][0]) + 1), html: html.slice(html.indexOf('>', kids[0][0]) + 1, kids[0][1] - `</${tagName(html.slice(kids[0][0]))}>`.length) } : null;
      let chevron = null;
      if (G.sel.chevron) for (const t of inside.matchAll(/<[a-zA-Z][\w-]*\b[^>]*>/g)) if (t.index && tagMatches(t[0], G.sel.chevron)) { chevron = t[0]; break; }
      out.push({ label, id, open: attrOf(tag, 'aria-expanded') === 'true', tag, kids: kidsOf(html, b0).map(([s, e]) => html.slice(s, html.indexOf('>', s) + 1)), region: html.slice(r0, html.indexOf('>', r0) + 1), inner, chevron });
    }
    return out;
  };
  const cls = tag => new Set((attrOf(tag || '', 'class') || '').split(/\s+/).filter(Boolean));
  const diff = (closed, open) => ({ add: [...cls(open)].filter(c => !cls(closed).has(c)), remove: [...cls(closed)].filter(c => !cls(open).has(c)) });
  const sigOf = tag => tagName(tag) + (attrOf(tag, 'aria-hidden') !== null ? `[aria-hidden="${attrOf(tag, 'aria-hidden')}"]` : '');
  const snapHtml = id => readFileSync(join(OUT, 'snaps', id + '.html'), 'utf8');
  for (const G0 of [].concat(flow.groups || [])) {
    const G = { ...G0, sel: { button: G0.button || 'button[aria-expanded][aria-controls]', label: G0.label || null, chevron: G0.chevron || 'svg' } };
    const t = G.template;
    const closed = groupsIn(snapHtml(t.closed), G).find(g => g.label === t.label), open = groupsIn(snapHtml(t.open), G).find(g => g.label === t.label);
    if (!closed || !open || closed.open || !open.open) throw new Error(`groups: the template pair (${t.closed}, ${t.open}) has no closed and open "${t.label}"`);
    // The button: attributes (the label written as {label}), classes, and children it drops when it opens.
    const ca = attrsOf(closed.tag), oa = attrsOf(open.tag), set = {};
    for (const k of new Set([...Object.keys(ca), ...Object.keys(oa)])) {
      if (/^(aria-expanded|aria-controls|class|style|id)$/.test(k) || ca[k] === oa[k]) continue;
      set[k] = oa[k] === undefined ? null : oa[k].split(t.label).join('{label}');
    }
    const count = list => list.reduce((m, k) => (m[sigOf(k)] = (m[sigOf(k)] || 0) + 1, m), {});
    const cc = count(closed.kids), oc = count(open.kids);
    const drop = Object.keys(cc).filter(k => !oc[k]);
    const lists = {};
    const put = (label, entry) => { (lists[label] = lists[label] || []).push(entry); };
    // Real open captures first: their lists are for the screen they were opened on.
    for (const o of [].concat(G.open || [])) {
      const { open: snap, closed: forSnap } = typeof o === 'string' ? { open: o, closed: null } : o;
      for (const g of groupsIn(snapHtml(snap), G)) if (g.open && g.inner && g.inner.html.trim()) put(g.label, { html: g.inner.html, snaps: forSnap ? [forSnap] : [], from: snap });
    }
    // Then the runs: the last frame where a closed group was still filled, for the screen the run ends on.
    const drop1 = G.dropLines ? new RegExp(G.dropLines, 'g') : null;
    for (const s of G.streams || []) {
      const def = (flow.streams || {})[s]; if (!def || !existsSync(join(OUT, 'streams', s + '.json'))) continue;
      const got = {};
      for (const fr of JSON.parse(readFileSync(join(OUT, 'streams', s + '.json'), 'utf8')).frames) for (const g of groupsIn(readFileSync(join(OUT, 'streams', s, fr.file), 'utf8'), G)) {
        if (!g.open && g.inner && g.inner.html.trim()) got[g.label] = drop1 ? g.inner.html.replace(drop1, '') : g.inner.html;
      }
      for (const [label, html] of Object.entries(got)) put(label, { html, snaps: [flow.states[def.to].snap], stream: s });
    }
    hoverOut[G.app].groups = { sel: G.sel, btn: { set, cls: diff(closed.tag, open.tag), drop }, chevron: closed.chevron && open.chevron ? diff(closed.chevron, open.chevron) : null, region: diff(closed.region, open.region), grid: G.grid || null, lists };
    report.groups = (report.groups || []).concat(Object.entries(lists).map(([k, v]) => `${G.app} · ${k}: ${v.map(e => e.from || 'stream ' + e.stream).join(', ')}`));
  }
}
// The hook's changes in hovers' and clicks' plain text too (the text that finds a control, a portal's text), so they
// still find what the page now says.
if (HOOK) for (const [app, h] of Object.entries(hoverOut)) {
  const walk = (o, key) => { if (typeof o === 'string') return key === 'html' ? o : HOOK.plain(o, 'hover:' + app); if (Array.isArray(o)) return o.map(x => walk(x, key)); if (o && typeof o === 'object') { for (const k of Object.keys(o)) o[k] = walk(o[k], k); } return o; };
  for (const k of ['defs', 'clicks']) if (h[k]) h[k] = walk(h[k], k);
}
for (const [app, h] of Object.entries(hoverOut)) writeFileSync(join(OUT, 'snaps', `hovers-${app}.json`), JSON.stringify(h));

// Into data/: only the files that changed are written, and the ones no longer made go.
const changed = [], files0 = {};
if (process.env.SCENECAST_RUST_PUBLISH === '1') {
  const result = await new Promise((resolve, reject) => {
    const input = createInterface({ input: process.stdin });
    let received = false;
    input.once('line', line => {
      received = true;
      input.close();
      process.stdin.destroy();
      try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
    });
    input.once('close', () => { if (!received) reject(new Error('capture publisher closed without a response')); });
    input.once('error', reject);
    console.log('SCENECAST_PUBLISH_V3');
  });
  if (result.error) throw new Error(result.error);
  if (!Array.isArray(result.changed) || !result.files || typeof result.files !== 'object' || !Number.isInteger(result.prunedAssets)) throw new Error('invalid capture publisher response');
  changed.push(...result.changed);
  Object.assign(files0, result.files);
  report.changed = changed.length;
  report.prunedAssets = result.prunedAssets;
} else {
  const fileHash = buf => createHash('sha256').update(buf).digest('hex').slice(0, 16);
  const list = dir => existsSync(dir) ? readdirSync(dir, { recursive: true }).map(f => String(f).replace(/\\/g, '/')).filter(f => statSync(join(dir, f)).isFile()) : [];
  for (const d of ['snaps', 'streams']) {
    const from = join(OUT, d), to = join(DATA, d);
    mkdirSync(to, { recursive: true });
    const next = new Set(list(from)), prev = new Set(list(to));
    for (const f of next) {
      const buf = readFileSync(join(from, f)), h = fileHash(buf);
      files0[d + '/' + f] = h;
      const dst = join(to, f);
      if (prev.has(f) && fileHash(readFileSync(dst)) === h) continue;
      mkdirSync(dirname(dst), { recursive: true }); writeFileSync(dst, buf); changed.push(d + '/' + f);
    }
    // (A partial build, --only, leaves the rest as it is.)
    if (!args.some(a => a.startsWith('--only'))) for (const f of prev) if (!next.has(f)) { rmSync(join(to, f), { force: true }); changed.push(d + '/' + f + ' (removed)'); }
    // Stream folders left empty.
    if (existsSync(to)) for (const f of readdirSync(to)) { const p = join(to, f); if (statSync(p).isDirectory() && !readdirSync(p).length) rmSync(p, { recursive: true }); }
  }
  rmSync(OUT, { recursive: true, force: true });
  report.changed = changed.length;
}
ASSETS = FINAL_ASSETS;
// Assets nothing refers to any more (the hover audit's full-page snapshots are read only for their CSS) go.
if (process.env.SCENECAST_RUST_PUBLISH !== '1') {
  const refs = new Set();
  const scan = t => { for (const m of t.matchAll(/\/assets\/([0-9a-f]{24}\.[a-z0-9]+|missing\.woff2)/g)) refs.add(m[1]); };
  for (const f of readdirSync(join(DATA, 'snaps'))) scan(readFileSync(join(DATA, 'snaps', f), 'utf8'));
  for (const f of readdirSync(join(DATA, 'streams'), { recursive: true })) if (/\.(html|json)$/.test(f)) scan(readFileSync(join(DATA, 'streams', f), 'utf8'));
  let grew = true;
  while (grew) { grew = false; for (const f of [...refs]) if (f.endsWith('.css') && existsSync(join(ASSETS, f))) { const n = refs.size; scan(readFileSync(join(ASSETS, f), 'utf8')); if (refs.size > n) grew = true; } }
  let pruned = 0;
  for (const f of readdirSync(ASSETS)) if (!refs.has(f) && f !== 'missing.woff2') { rmSync(join(ASSETS, f)); pruned++; }
  report.prunedAssets = pruned;
}
// Nothing secret may be left: no JWTs, no signed-URL parameters with values, no bearer tokens.
const leaks = [];
const files = [...readdirSync(join(DATA, 'snaps')).map(f => join(DATA, 'snaps', f)), ...readdirSync(join(DATA, 'streams'), { recursive: true }).map(f => join(DATA, 'streams', f)).filter(f => /\.(html|json)$/.test(f))];
for (const file of files) {
  const f = file.replace(/\\/g, '/').split('/').slice(-2).join('/');
  const t = readFileSync(file, 'utf8');
  if (JWT.test(t)) leaks.push(f + ' jwt');
  if (/Bearer\s+[A-Za-z0-9._-]{20,}/.test(t)) leaks.push(f + ' bearer');
  if (/<script/i.test(t)) leaks.push(f + ' script');
  for (const e of EDITS) { if (e.to && new RegExp(e.re.source).test(e.to)) continue; e.re.lastIndex = 0; if (e.re.test(t)) leaks.push(f + ' still has: ' + e.what.slice(0, 40)); e.re.lastIndex = 0; }
  if (HOOK) {
    const ctx = f.startsWith('streams/') || /^[^/]+\/\d{3}\.html$/.test(f) ? 'stream:' + f.split('/').slice(-2)[0] : /hovers-/.test(f) ? 'hover:' + f.replace(/.*hovers-|\.json$/g, '') : f.split('/').pop().replace(/(\.f\d+)?\.(html|json)$/, '');
    if (!/\.json$/.test(f) || /hovers-/.test(f)) for (const left of HOOK.leftovers(t, ctx)) leaks.push(f + ' still has: ' + left);
  }
  JWT.lastIndex = 0;
}
for (const f of readdirSync(ASSETS)) if (/<script/i.test(readFileSync(join(ASSETS, f)).toString('latin1'))) leaks.push('assets/' + f + ' script');
if (HOOK) { for (const u of HOOK.unused()) leaks.push('build hook: matched nothing: ' + u); report.hook = HOOK.report(); }
const ms = Date.now() - T0;
console.log(JSON.stringify({ ...report, edits: EDITS.map(e => `${e.n}× ${e.what.slice(0, 50)}`), assets: used.size, missing: [...missing].slice(0, 40), missingCount: missing.size, leaks, ms }, null, 1));
if (leaks.length) process.exit(1);
// The manifest: what this build read (so an unchanged build is skipped and the server knows what's built in), and
// what changed (for the quick check). Not written when --only built part of it.
if (!args.some(a => a.startsWith('--only'))) writeFileSync(MANIFEST, JSON.stringify({ kit: KIT_VERSION, at: new Date().toISOString(), key: KEY, inputs: INPUTS, ms, changed, files: files0 }, null, 1));
