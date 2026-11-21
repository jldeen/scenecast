// The rule-based diagnoser: the causes the Demo 1 replica taught (docs/engine/lessons.md), each found from evidence in
// the raw captures and in the replica as rendered, with the per-demo patch that fixes it. No model, so CI runs it.
//   font-substituted  a font the real page loaded is missing from the replica (loaded by script: the FontFace API)
//   missing-asset     an image in a region that differs is blank: its capture answered with an HTML page or failed
//   late-style        a menu or pane opened by a click is unstyled: its classes have no rules (styles that came and
//                     went with it)
//   script-pinned     at another zoom, a fixed box isn't where the real page put it: the page places it by script over a
//                     placeholder
//   script-sized      at another zoom, an element's size isn't the real page's: the page sizes it by script from the window
//   virtualized       at another zoom, a scrolling list shows blank space where the real page had rows: only the rows in
//                     view existed when it was captured
//   size              the screenshots aren't the same size (recorded at another window size)
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { childrenOf, rowKey, pathOf } from './patches.mjs';

const norm = s => String(s || '').trim().replace(/^["']|["']$/g, '').toLowerCase();

// Helpers in the replica's page, for an app's document: a stable selector, attribute markers as the serializer writes
// them, and whether an element is in a region.
const HELPERS = `
const H = {
  uniq: s => { try { return d.querySelectorAll(s).length === 1; } catch (e) { return false; } },
  q: v => v.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"'),
  stable: v => v && !/\\d{4,}|[0-9a-f]{8,}/i.test(v),
  sel(el) {
    const tag = el.localName;
    for (const a of ['data-testid', 'id', 'aria-label', 'role', 'name']) {
      const v = el.getAttribute(a);
      if (!H.stable(v)) continue;
      const s = a === 'id' ? '#' + CSS.escape(v) : tag + '[' + a + '="' + H.q(v) + '"]';
      if (H.uniq(s)) return s;
    }
    const cls = [...el.classList].filter(c => H.stable(c) && !/^(d1|sc-)/.test(c));
    if (cls.length) { const s = tag + cls.map(c => '.' + CSS.escape(c)).join(''); if (H.uniq(s)) return s; }
    const p = el.parentElement;
    if (!p || p === d.documentElement) return tag;
    return H.sel(p) + ' > ' + tag + ':nth-child(' + ([...p.children].indexOf(el) + 1) + ')';
  },
  esc: v => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\\u00a0/g, '&nbsp;'),
  markers(el) {
    const out = [];
    for (const a of ['data-testid', 'id', 'aria-label', 'class']) { const v = el.getAttribute(a); if (v) out.push(a + '="' + H.esc(v) + '"'); }
    return out;
  },
  hits(el, regs) { const r = el.getBoundingClientRect(); return regs.some(g => r.left < g.x + g.w && r.right > g.x && r.top < g.y + g.h && r.bottom > g.y); },
};`;
const inApp = (page, app, fn, arg) => page.evaluate(`(() => { const d = window.d1.doc(${JSON.stringify(app)}); ${HELPERS}; return (${fn.toString()})(d, ${JSON.stringify(arg)}, H); })()`);

// A start tag in raw HTML holding marker exactly once: its inline style, as { prop: px }.
function styleAt(html, marker) {
  const i = html.indexOf(marker);
  if (i < 0 || html.indexOf(marker, i + 1) >= 0) return null;
  const at = html.lastIndexOf('<', i), tag = html.slice(at, html.indexOf('>', i) + 1);
  const st = (/\sstyle="([^"]*)"/.exec(tag) || [])[1] || '';
  return Object.fromEntries(st.split(';').map(x => x.split(':').map(y => y.trim())).filter(x => x.length === 2 && /^-?[\d.]+px$/.test(x[1])).map(([k, v]) => [k, parseFloat(v)]));
}
const once = (html, m) => { const i = html.indexOf(m); return i >= 0 && html.indexOf(m, i + 1) < 0; };

// A font file's family name (its name table), for TrueType, OpenType and WOFF; null for WOFF2.
export function fontFamilyName(buf) {
  try {
    const sig = buf.toString('latin1', 0, 4);
    let name = null;
    if (sig === 'wOFF') {
      const n = buf.readUInt16BE(12);
      for (let i = 0; i < n; i++) {
        const o = 44 + i * 20;
        if (buf.toString('latin1', o, o + 4) !== 'name') continue;
        const off = buf.readUInt32BE(o + 4), comp = buf.readUInt32BE(o + 8), orig = buf.readUInt32BE(o + 12);
        name = comp < orig ? inflateSync(buf.subarray(off, off + comp)) : buf.subarray(off, off + orig);
      }
    } else if (sig === 'OTTO' || sig === 'true' || buf.readUInt32BE(0) === 0x00010000) {
      const n = buf.readUInt16BE(4);
      for (let i = 0; i < n; i++) {
        const o = 12 + i * 16;
        if (buf.toString('latin1', o, o + 4) === 'name') { const off = buf.readUInt32BE(o + 8); name = buf.subarray(off, off + buf.readUInt32BE(o + 12)); }
      }
    }
    if (!name) return null;
    const count = name.readUInt16BE(2), strings = name.readUInt16BE(4);
    let best = null;
    for (let i = 0; i < count; i++) {
      const r = 6 + i * 12, platform = name.readUInt16BE(r), id = name.readUInt16BE(r + 6), len = name.readUInt16BE(r + 8), off = name.readUInt16BE(r + 10);
      if (id !== 1 && id !== 16) continue;
      const raw = name.subarray(strings + off, strings + off + len);
      const s = platform === 3 || platform === 0 ? Buffer.from(raw).swap16().toString('utf16le') : raw.toString('latin1');
      if (id === 16 || !best) best = s;
    }
    return best;
  } catch (e) { return null; }
}

const fontRule = {
  name: 'font',
  async diagnose(f, ctx) {
    if (f.kind !== 'state') return [];
    const out = [];
    for (const v of (f.fonts || []).filter(x => x.status === 'substituted' || x.status === 'different-file')) {
      const base = { cause: 'font-substituted', evidence: { family: v.name, weight: v.weight, style: v.style, loadedBy: v.loadedBy, status: v.status } };
      if (v.loadedBy !== 'script') { out.push({ ...base, confidence: 0.6, summary: `${v.name}: ${v.status === 'different-file' ? 'the replica loads another file for it' : 'the replica falls back'}; its file wasn't captured (record the screen again with the font loaded)` }); continue; }
      const main = ctx.raw.main(f.snap);
      const claimed = new Set([...(main.html || '').matchAll(/@font-face\s*\{[^}]*\}/g)].flatMap(m => [...m[0].matchAll(/d1res:\/\/(\d+)/g)].map(x => main.urls[+x[1]])));
      const files = ((main.meta || {}).fontFiles || []).filter(u => !claimed.has(u)).map(u => ({ u, b: ctx.raw.blob(u) })).filter(x => x.b && !x.b.html)
        .map(x => ({ ...x, name: fontFamilyName(readFileSync(x.b.file)) }));
      const tokens = norm(v.name).split(/\s+/);
      const pick = files.find(x => x.name && norm(x.name) === norm(v.name))
        || (files.length === 1 && !files[0].name ? files[0] : null)
        || files.filter(x => !x.name).sort((a, b) => tokens.filter(t => b.u.toLowerCase().includes(t)).length - tokens.filter(t => a.u.toLowerCase().includes(t)).length)[0];
      if (!pick) { out.push({ ...base, confidence: 0.7, summary: `${v.name}: loaded by script on the real page, and none of the font files it fetched is that family` }); continue; }
      out.push({
        ...base, confidence: pick.name ? 0.95 : 0.7,
        summary: `${v.name} was loaded by script (the FontFace API), so no @font-face rule was captured and the replica fell back: adding one for the file the real page fetched`,
        evidence: { ...base.evidence, file: pathOf(pick.u), nameTable: pick.name, sha256: pick.b.sha256 },
        patch: { kind: 'font', app: f.app, family: v.name, weight: v.weight, style: v.style, src: ctx.refOf(pick.u), sha256: pick.b.sha256 },
      });
    }
    return out;
  },
};

const assetRule = {
  name: 'asset',
  async diagnose(f, ctx) {
    if (f.kind === 'zoom' && !f.regions.length) return [];
    const { page, error } = await ctx.show(f); if (error) return [];
    const regs = await ctx.regionsCss(f, page);
    const broken = await inApp(page, f.app, (d, regs, H) => [...d.images].filter(i => i.complete && i.naturalWidth <= 1 && i.getBoundingClientRect().width > 4 && H.hits(i, regs)).map(i => ({ sel: H.sel(i), alt: i.alt, w: Math.round(i.getBoundingClientRect().width), h: Math.round(i.getBoundingClientRect().height) })), regs);
    if (!broken.length) return [];
    const main = ctx.raw.main(f.snap);
    const imgs = [...new Set([...(main.html || '').matchAll(/<img\b[^>]*?\ssrc="d1res:\/\/(\d+)"/g)].map(m => main.urls[+m[1]]))];
    const bad = imgs.filter(u => { const b = ctx.raw.blob(u); return !b || b.html; });
    const out = [];
    for (const u of bad) {
      const b = ctx.raw.blob(u), path = pathOf(u);
      const why = b ? 'answered with an HTML page (a sign-in or error page)' : 'could not be fetched';
      const subs = Object.keys(ctx.raw.urls).filter(x => x !== u && pathOf(x) === path).map(x => ({ x, b: ctx.raw.blob(x) })).filter(c => c.b && !c.b.html && /^image\//.test(c.b.type || 'image/'));
      const base = { cause: 'missing-asset', evidence: { elements: broken, url: path, capture: why } };
      if (!subs.length) { out.push({ ...base, confidence: 0.8, summary: `${path} ${why} when captured, and no other capture has it: record the screen again` }); continue; }
      const c = subs.sort((a, b2) => a.x.length - b2.x.length)[0];
      out.push({ ...base, confidence: 0.8, summary: `${path} ${why} when captured (a one-time or signed link); the same image was captured from ${pathOf(c.x)}${c.x.includes('?') ? ' (another link)' : ''}`, evidence: { ...base.evidence, use: pathOf(c.x), sha256: c.b.sha256 }, patch: { kind: 'asset', path, use: ctx.refOf(c.x) } });
    }
    return out;
  },
};

const lateStyleRule = {
  name: 'late-style',
  async diagnose(f, ctx) {
    if (f.kind !== 'click') return [];
    const cp = (ctx.flow.clickPages || []).find(c => c.app === f.app && c.base === f.snap);
    const rec = cp && ctx.raw.clickRecords(cp.page).find(r => r.cand && r.cand.text === f.click);
    if (!rec) return [];
    const classes = [...new Set((rec.parts || []).flatMap(h => [...h.matchAll(/\sclass="([^"]*)"/g)].flatMap(m => m[1].split(/\s+/))).filter(Boolean))];
    if (!classes.length) return [];
    const { page, error } = await ctx.show(f); if (error) return [];
    const have = await inApp(page, f.app, d => {
      const out = new Set();
      const walk = rules => { for (const r of rules) { if (r.selectorText) for (const m of r.selectorText.matchAll(/\.([A-Za-z0-9_-]+)/g)) out.add(m[1]); if (r.cssRules) walk(r.cssRules); } };
      for (const s of [...d.styleSheets, ...(d.adoptedStyleSheets || [])]) { try { walk(s.cssRules); } catch (e) {} }
      return [...out];
    });
    const missing = classes.filter(c => !have.some(h => h === c || h.endsWith('-' + c)));
    if (!missing.length) return [];
    const re = c => new RegExp('\\.' + c.replace(/[-\\]/g, '\\$&') + '(?![\\w-])');
    const found = [];
    for (const id of ctx.raw.snaps()) {
      if ((cp.css || []).includes(id)) continue;
      const css = ctx.raw.styles(id);
      const n = missing.filter(c => re(c).test(css)).length;
      if (n) found.push({ id, n });
    }
    found.sort((a, b) => b.n - a.n || a.id.localeCompare(b.id));
    const base = { cause: 'late-style', evidence: { control: f.click, classes: missing } };
    if (!found.length) return [{ ...base, confidence: 0.7, summary: `"${f.click}" opens unstyled: no capture has rules for ${missing.join(', ')}; record a screen with it open, or add its rules as vendorCss` }];
    return [{
      ...base, confidence: 0.85,
      summary: `"${f.click}" brings its styles when it opens and drops them when it closes (the click audit kept none): its rules are in the capture ${found[0].id}`,
      evidence: { ...base.evidence, from: found[0].id, covers: `${found[0].n} of ${missing.length}` },
      patch: { kind: 'clickCss', app: f.app, page: cp.page, name: f.click, from: [found[0].id] },
    }];
  },
};

// At another zoom: fixed boxes the page placed by script (pin), and sizes it set from the window (set).
const layoutRule = {
  name: 'layout',
  async diagnose(f, ctx) {
    if (f.kind !== 'zoom' || !f.regions.length) return [];
    const st = ctx.flow.states[f.state]; if (!st) return [];
    const zoomHtml = ctx.raw.main(f.snap).html, baseHtml = ctx.raw.main(st.snap).html;
    const { page, error } = await ctx.show(f); if (error) return [];
    const regs = await ctx.regionsCss(f, page);
    const els = await inApp(page, f.app, (d, regs, H) => [...d.body.querySelectorAll('*')].filter(e => (e.style.left || e.style.top || e.style.width || e.style.height) && H.hits(e, regs))
      .map(e => ({ sel: H.sel(e), markers: H.markers(e), fixed: getComputedStyle(e).position === 'fixed', vw: d.defaultView.innerWidth, vh: d.defaultView.innerHeight })), regs);
    const out = [];
    const VP = ctx.demo.cfg.viewport;
    for (const e of els) {
      const m = e.markers.find(x => once(zoomHtml, x) && once(baseHtml, x));
      if (!m) continue;
      const real = styleAt(zoomHtml, m), cap = styleAt(baseHtml, m);
      const moved = Object.keys(real).filter(k => ['left', 'top', 'width', 'height'].includes(k) && cap[k] !== undefined && Math.abs(real[k] - cap[k]) > 1);
      if (!moved.length) continue;
      if (e.fixed && (moved.includes('left') || moved.includes('top'))) {
        // The placeholder: what's where the real page put the box, at this zoom, in the replica's own layout.
        const anchor = await inApp(page, f.app, (d, a, H) => {
          const el = d.querySelector(a.sel), near = (x, y) => Math.abs(x - y) <= 2;
          const hit = [...d.body.querySelectorAll('*')].filter(x => el && x !== el && !el.contains(x) && !x.contains(el) && getComputedStyle(x).position !== 'fixed').filter(x => {
            const r = x.getBoundingClientRect();
            return (a.real.left === undefined || near(r.left, a.real.left)) && (a.real.top === undefined || near(r.top, a.real.top)) && (a.real.width === undefined || near(r.width, a.real.width));
          });
          return hit.length ? H.sel(hit[hit.length - 1]) : null;
        }, { sel: e.sel, real });
        const base = { cause: 'script-pinned', evidence: { element: e.sel, captured: cap, real } };
        if (!anchor) { out.push({ ...base, confidence: 0.6, summary: `${e.sel} is placed by script (the real page moved it at ${f.z}%) but nothing in the replica is where it went` }); continue; }
        out.push({ ...base, confidence: 0.9, summary: `${e.sel} is fixed and placed by script over ${anchor}; the capture holds its place at 100% only: pinning it to that placeholder`, evidence: { ...base.evidence, anchor }, patch: { kind: 'pin', app: f.app, el: e.sel, anchor } });
        continue;
      }
      // A size from the window: value = a × (window size) + b, from the two captures.
      const style = {};
      for (const k of moved.filter(x => x === 'width' || x === 'height')) {
        const W1 = k === 'width' ? VP.width : VP.height, W2 = k === 'width' ? e.vw : e.vh;
        const a = (real[k] - cap[k]) / (W2 - W1), b = cap[k] - a * W1;
        if (!isFinite(a)) continue;
        style[k] = `calc(${+(a * 100).toFixed(3)}${k === 'width' ? 'vw' : 'vh'} + ${+b.toFixed(1)}px)`;
      }
      if (Object.keys(style).length) out.push({ cause: 'script-sized', confidence: 0.75, summary: `${e.sel} is sized by script from the window (${Object.keys(style).join(', ')}): setting it the same way`, evidence: { element: e.sel, captured: cap, real }, patch: { kind: 'set', app: f.app, sel: e.sel, style } });
    }
    return out;
  },
};

const rowsRule = {
  name: 'virtualized',
  async diagnose(f, ctx) {
    if (f.kind !== 'zoom' || !f.regions.length) return [];
    const st = ctx.flow.states[f.state]; if (!st) return [];
    const { page, error } = await ctx.show(f); if (error) return [];
    const regs = await ctx.regionsCss(f, page);
    const lists = await inApp(page, f.app, (d, regs, H) => {
      const out = [];
      for (const sc of d.body.querySelectorAll('*')) {
        const cs = getComputedStyle(sc);
        if (!/(auto|scroll)/.test(cs.overflowY) || sc.scrollHeight <= sc.clientHeight + 50 || !H.hits(sc, regs)) continue;
        let best = null, n = 0;
        for (const p of [sc, ...sc.querySelectorAll('*')]) {
          const k = [...p.children].filter(c => /translate|matrix/.test(c.style.transform) || (getComputedStyle(c).position === 'absolute' && c.style.top)).length;
          if (k > n) { n = k; best = p; }
        }
        if (!best || n < 3) continue;
        const box = sc.getBoundingClientRect(); let bottom = 0, rowH = 0;
        for (const c of best.children) { const r = c.getBoundingClientRect(); bottom = Math.max(bottom, r.bottom); rowH = Math.max(rowH, r.height); }
        if (box.bottom - bottom >= rowH) out.push({ list: H.sel(sc), rows: H.sel(best), markers: H.markers(best), rendered: n, blank: Math.round(box.bottom - bottom) });
      }
      return out;
    }, regs);
    const zoomHtml = ctx.raw.main(f.snap).html, baseHtml = ctx.raw.main(st.snap).html;
    const out = [];
    for (const l of lists) {
      const base = { cause: 'virtualized', evidence: { list: l.list, rendered: l.rendered, blankPx: l.blank } };
      const m = l.markers.find(x => once(zoomHtml, x) && once(baseHtml, x));
      const a = m && childrenOf(baseHtml, m), b = m && childrenOf(zoomHtml, m);
      const have = new Set(a ? a.kids.map(k => rowKey(k.tag)) : []);
      const extra = b ? b.kids.filter(k => rowKey(k.tag) && !have.has(rowKey(k.tag))).length : 0;
      if (!extra) { out.push({ ...base, confidence: 0.6, summary: `${l.list} is virtualized (only the rows in view were captured) and no capture has the rows this size shows: record side list on ${f.state}` }); continue; }
      out.push({
        ...base, confidence: 0.85,
        summary: `${l.list} is virtualized: only the rows in view at 100% were captured, so at ${f.z}% it ends ${l.blank} px early; adding the ${extra} rows the real page had at ${f.z}%`,
        evidence: { ...base.evidence, rows: l.rows, added: extra, from: f.snap },
        patch: { kind: 'rows', app: f.app, snap: st.snap, marker: m, from: f.snap, sel: l.rows },
      });
    }
    return out;
  },
};

const sizeRule = {
  name: 'size',
  async diagnose(f) {
    if (!f.sizeMismatch) return [];
    return [{ cause: 'size', confidence: 0.9, summary: `The replica showed this screen at a different size from the one you recorded (${f.size.replica.join('×')} pixels, not ${f.size.real.join('×')}).`, evidence: f.size }];
  },
};

export const rules = [sizeRule, fontRule, assetRule, lateStyleRule, layoutRule, rowsRule].map(r => ({ ...r, name: 'rules/' + r.name }));
