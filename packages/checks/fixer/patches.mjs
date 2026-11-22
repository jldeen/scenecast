// The fidelity fixer's patches: flow.fixes.json in the demo folder, written by `scenecast fidelity` (never by hand,
// never product-wide). Each patch fixes one cause the loop found on this demo, with the evidence it came from:
//   font      a font the real page loaded by script (no @font-face rule captured): an @font-face rule for that family,
//             from the very file the real page fetched           { app, family, weight, style, src: ref, sha256 }
//   asset     an image whose own capture is unusable (it answered with a sign-in or error page): the same resource
//             as captured from another URL of it                 { path, use: ref }
//   clickCss  a menu or pane whose styles came and went with it in a way the click audit couldn't keep: the rules from
//             a capture that has them                            { app, page, name, from: [snap] }
//   pin       a box the page places by script over a placeholder (a fixed composer): a pin layout rule  { app, el, anchor }
//   set       a size the page sets by script from the window: a set layout rule                        { app, sel, style }
//   rows      a virtualized list whose rows in view depend on the window: the rows from a capture at another
//             size, so every size has them                       { app, snap, marker, from, sel }
// A ref names a captured resource without writing its URL into the demo (raw URLs can carry tokens): { ref: SHA-256 of
// the URL, path: its origin and path, for people }. The build finds the URL in the raw captures' index by that hash.
// The loop only ever writes these kinds. There is no patch that swaps a page for a screenshot.
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const FIXES_FILE = 'flow.fixes.json';
export const PATCH_KINDS = ['font', 'asset', 'clickCss', 'pin', 'set', 'rows'];

export function readFixes(dir) {
  const f = join(dir, FIXES_FILE);
  if (!existsSync(f)) return { version: 1, patches: [] };
  const fx = JSON.parse(readFileSync(f, 'utf8'));
  return { version: 1, ...fx, patches: (fx.patches || []).filter(p => PATCH_KINDS.includes(p.kind)) };
}
export function writeFixes(dir, fixes) {
  writeFileSync(join(dir, FIXES_FILE), JSON.stringify({ version: 1, about: 'Written by scenecast fidelity: per-demo fixes for differences between the real pages and the replica, with the evidence for each. Remove a patch to undo it.', ...fixes }, null, 1) + '\n');
}
// One key per patch: the same fix found again replaces the old one rather than adding a second.
export function patchKey(p) {
  switch (p.kind) {
    case 'font': return `font|${p.app}|${p.family}|${p.weight}|${p.style}`;
    case 'asset': return `asset|${p.path}`;
    case 'clickCss': return `clickCss|${p.app}|${p.page}|${p.name}`;
    case 'pin': return `pin|${p.app}|${p.el}`;
    case 'set': return `set|${p.app}|${p.sel}|${Object.keys(p.style || {}).sort().join(',')}`;
    case 'rows': return `rows|${p.app}|${p.snap}|${p.marker}|${p.from}`;
    default: return JSON.stringify(p);
  }
}

// The flow's side: layout rules and click CSS go where the player and build already read them; the build-time kinds
// (font, asset, rows) stay in flow.fixes for process.mjs.
export function applyFixesToFlow(flow, fixes) {
  const patches = (fixes && fixes.patches) || [];
  if (!patches.length) return flow;
  const appOf = id => flow.apps.find(a => a.id === id);
  for (const p of patches) {
    const app = appOf(p.app);
    if (p.kind === 'pin' && app) {
      app.layout = app.layout || {};
      const pins = app.layout.pin = app.layout.pin || [];
      if (!pins.some(x => x.el === p.el)) pins.push({ el: p.el, anchor: p.anchor, ...(p.sync ? { sync: true } : {}), ...(p.frame ? { frame: p.frame } : {}) });
    } else if (p.kind === 'set' && app) {
      app.layout = app.layout || {};
      const sets = app.layout.set = app.layout.set || [];
      const have = sets.find(x => x.sel === p.sel);
      if (have) Object.assign(have.style, p.style); else sets.push({ sel: p.sel, style: { ...p.style } });
    } else if (p.kind === 'clickCss') {
      const cp = (flow.clickPages || []).find(c => c.page === p.page && c.app === p.app);
      if (cp) cp.css = [...new Set([...(cp.css || []), ...p.from])];
    }
  }
  flow.fixes = patches.filter(p => ['font', 'asset', 'rows'].includes(p.kind));
  return flow;
}

// ---- build helpers (process.mjs) ----------------------------------------------------------------------------------
export const pathOf = u => { try { const x = new URL(u); return x.origin + x.pathname; } catch (e) { return null; } };
export const refOf = u => ({ ref: createHash('sha256').update(u).digest('hex'), path: pathOf(u) });
// The URL a ref names, among the raw captures' URLs (urls.json).
export function refResolver(urlIndex) {
  let map = null;
  return ref => { if (!ref) return null; if (!map) map = new Map(Object.keys(urlIndex).map(u => [createHash('sha256').update(u).digest('hex'), u])); return map.get(ref.ref || ref) || null; };
}
// asset: a URL whose own capture is unusable, pointed at the capture of the same resource from another URL.
export function assetSubstitute(patches, usable, resolve) {
  const subs = (patches || []).filter(p => p.kind === 'asset');
  if (!subs.length) return u => u;
  return u => {
    if (typeof u !== 'string' || usable(u)) return u;
    const p = subs.find(s => s.path === pathOf(u));
    const use = p && resolve(p.use);
    return use && usable(use) ? use : u;
  };
}
// font: the @font-face rule for a family, its src from the real file (resolved by the build to a local asset).
export function fontFaceCss(p, src) {
  const fam = String(p.family).replace(/["\\]/g, '');
  return `@font-face{font-family:"${fam}";src:url("${src}");font-weight:${p.weight || 'normal'};font-style:${p.style || 'normal'};font-display:block}`;
}

// rows: an element's end in an HTML string (start at its "<"), for the row merge. Void and raw-text elements aware.
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
function endOf(html, at) {
  const tagEnd = s => { let q = null; for (let i = s; i < html.length; i++) { const c = html[i]; if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === '>') return i + 1; } return html.length; };
  const name = /^<([a-zA-Z][\w-]*)/.exec(html.slice(at, at + 64))[1].toLowerCase();
  let i = tagEnd(at);
  if (VOID.has(name) || html[i - 2] === '/') return i;
  let depth = 1;
  const re = /<(\/?)([a-zA-Z][\w-]*)|<!--/g; re.lastIndex = i;
  for (let m; (m = re.exec(html));) {
    if (m[0] === '<!--') { const e = html.indexOf('-->', m.index); re.lastIndex = e < 0 ? html.length : e + 3; continue; }
    const n = m[2].toLowerCase();
    if (m[1]) { if (n === name && --depth === 0) return html.indexOf('>', m.index) + 1; continue; }
    const e = tagEnd(m.index); re.lastIndex = e;
    if (n === 'style' || n === 'script' || n === 'textarea') { const c = html.toLowerCase().indexOf('</' + n, e); re.lastIndex = c < 0 ? html.length : c; continue; }
    if (!VOID.has(n) && html[e - 2] !== '/' && n === name) depth++;
  }
  return html.length;
}
// The child elements of the element whose start tag holds marker (an attribute, as the serializer writes it):
// { at, open, close, end, kids: [{ start, end, tag }] }.
export function childrenOf(html, marker) {
  const m = html.indexOf(marker);
  if (m < 0) return null;
  const at = html.lastIndexOf('<', m);
  const end = endOf(html, at);
  const open = html.indexOf('>', at) + 1, close = html.lastIndexOf('</', end - 1);
  const kids = [];
  for (let i = open; i < close;) {
    const lt = html.indexOf('<', i);
    if (lt < 0 || lt >= close) break;
    if (html.startsWith('<!--', lt)) { i = html.indexOf('-->', lt) + 3; continue; }
    if (html[lt + 1] === '/') break;
    const e = endOf(html, lt);
    kids.push({ start: lt, end: e, tag: html.slice(lt, html.indexOf('>', lt) + 1) });
    i = e;
  }
  return { at, open, close, end, kids };
}
// A row's place in its list: its index attribute, else where it's put (style: top or transform).
export const rowKey = tag => (/\s(?:aria-rowindex|aria-posinset|data-index|data-item-index|data-row-index)="([^"]*)"/.exec(tag) || [])[1] || (/\sstyle="([^"]*)"/.exec(tag) || [])[1] || null;
// Rows the other capture has and this one doesn't, added at the end of the list. Resource tokens (d1res://N) in the
// added rows are renumbered into this capture's own list of URLs.
export function mergeRows(doc, from, marker) {
  const a = childrenOf(doc.html, marker), b = childrenOf(from.html, marker);
  if (!a || !b) return { doc, added: 0 };
  const have = new Set(a.kids.map(k => rowKey(k.tag)).filter(Boolean));
  const urls = [...doc.urls], inline = { ...(doc.inline || {}) };
  const tokenFor = n => { const u = from.urls[+n]; let i = urls.indexOf(u); if (i < 0) { i = urls.length; urls.push(u); if (from.inline && from.inline[u]) inline[u] = from.inline[u]; } return 'd1res://' + i; };
  let add = '', added = 0;
  for (const k of b.kids) {
    const key = rowKey(k.tag);
    if (!key || have.has(key)) continue;
    have.add(key); added++;
    add += from.html.slice(k.start, k.end).replace(/d1res:\/\/(\d+)/g, (m, n) => tokenFor(n));
  }
  if (!added) return { doc, added };
  return { doc: { ...doc, urls, inline, html: doc.html.slice(0, a.close) + add + doc.html.slice(a.close) }, added };
}
