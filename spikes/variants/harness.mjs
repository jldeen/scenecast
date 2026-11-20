// Spike harness: theme packs, flips and scores on captured screens, in headless Chrome. Outputs go wherever --out
// points (keep them outside the repo: captures carry tenant data).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, launch, openSnap, settle } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '../../packages/player/app');

// A captured screen served from its demo's data folder, with variants.js reachable at /__sd/variants.js.
export async function openScreen(browser, { root, snap, vp, colorScheme, roots = {} }) {
  const srv = await serve({ '/': root, '/__sd/': APP, ...roots });
  const page = await openSnap(browser, srv.url, snap, vp, { colorScheme });
  await inject(page, srv.url);
  page.__srv = srv;
  return page;
}
export async function inject(page, base) {
  for (const f of page.frames()) {
    await f.evaluate(async src => { if (!window.__sd) window.__sd = await import(src); }, base + '/__sd/variants.js').catch(() => {});
  }
}
export const closeScreen = async page => { await page.context().close(); page.__srv.close(); };

// Every same-origin document of the page (frames included), each with a function run in it.
export async function eachDoc(page, fn, arg) {
  const out = [];
  for (const f of page.frames()) {
    const r = await f.evaluate(([src, a]) => { if (!window.__sd || !document.body || !document.body.childElementCount) return null; return (0, eval)(src)(window.__sd, document, a); }, [fn.toString(), arg]).catch(e => ({ error: String(e).slice(0, 200) }));
    if (r) out.push({ url: f.url().replace(/^https?:\/\/[^/]+/, ''), ...r });
  }
  return out;
}
export const extract = (page, app) => page.evaluate(a => window.__sd.extractThemePack(document, a), app);
export const flipTheme = (page, pack) => eachDoc(page, (sd, doc, p) => ({ stats: sd.applyTheme(doc, p) }), pack).then(async r => { await settle(page); return r; });
export const flipPlatform = (page, platform, opts) => eachDoc(page, (sd, doc, a) => ({ stats: sd.applyPlatform(doc, a[0], a[1]) }), [platform, opts || {}]).then(async r => { await settle(page); return r; });

// Element records for the element-by-element score: visible elements with a stable key and the colours they paint.
export async function paints(page) {
  return page.evaluate(() => {
    const out = [], W = window, vw = innerWidth, vh = innerHeight;
    const own = el => { let s = ''; for (const c of el.childNodes) if (c.nodeType === 3) s += c.data; return s.replace(/\s+/g, ' ').trim(); };
    const keyOf = el => [el.localName, el.getAttribute('data-tid') || el.id || el.getAttribute('role') || '', (el.getAttribute('aria-label') || '').slice(0, 40), own(el).slice(0, 40)].join('|');
    const walk = (root, dx, dy) => {
      for (const el of root.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1 || r.right + dx < 0 || r.bottom + dy < 0 || r.left + dx > vw || r.top + dy > vh) continue;
        const cs = W.getComputedStyle(el);
        if (cs.visibility !== 'visible' || +cs.opacity === 0) continue;
        const p = {};
        if (!/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor)) p.bg = cs.backgroundColor;
        if (own(el)) p.fg = cs.color;
        if (parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth) > 0 && cs.borderTopStyle !== 'none') p.border = cs.borderTopColor + ' ' + cs.borderLeftColor;
        if (el instanceof SVGElement && cs.fill && cs.fill !== 'none' && !/^url/.test(cs.fill)) p.fill = cs.fill;
        if (!Object.keys(p).length) continue;
        out.push({ k: keyOf(el), x: r.left + dx, y: r.top + dy, w: r.width, h: r.height, p });
      }
      for (const f of root.querySelectorAll('iframe')) { try { const r = f.getBoundingClientRect(); if (f.contentDocument) walk(f.contentDocument, dx + r.left, dy + r.top); } catch (e) {} }
    };
    walk(document, 0, 0);
    return out;
  });
}
const rgba = s => { const m = /rgba?\(([^)]*)\)/.exec(s || ''); if (!m) return null; const v = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return [v[0], v[1], v[2], v.length > 3 ? v[3] : 1]; };
const close = (a, b, tol) => {
  const pa = String(a).match(/rgba?\([^)]*\)/g) || [], pb = String(b).match(/rgba?\([^)]*\)/g) || [];
  if (pa.length !== pb.length) return false;
  return pa.every((x, i) => { const u = rgba(x), v = rgba(pb[i]); if (!u || !v) return x === pb[i];
    const ua = u[3], va = v[3]; // compare as composited on mid-grey so alpha differences count proportionally
    const c = (q, a) => q * a + 128 * (1 - a);
    return Math.hypot(c(u[0], ua) - c(v[0], va), c(u[1], ua) - c(v[1], va), c(u[2], ua) - c(v[2], va)) <= tol; });
};
// Pairs elements of two renders (same key, nearest centre within maxDist) and compares what each paints.
// Returns per-paint and area-weighted match shares, and the worst offenders.
export function elementScore(a, b, { maxDist = 24, tol = 18 } = {}) {
  const byKey = new Map();
  for (const e of b) { if (!byKey.has(e.k)) byKey.set(e.k, []); byKey.get(e.k).push(e); }
  let total = 0, ok = 0, area = 0, areaOk = 0, paired = 0;
  const misses = {};
  for (const e of a) {
    const cands = byKey.get(e.k); if (!cands) continue;
    let best = null, d = Infinity;
    for (const c of cands) { const dd = Math.hypot(c.x + c.w / 2 - e.x - e.w / 2, c.y + c.h / 2 - e.y - e.h / 2); if (dd < d) { d = dd; best = c; } }
    if (!best || d > maxDist) continue;
    paired++;
    for (const prop of new Set([...Object.keys(e.p), ...Object.keys(best.p)])) {
      const wgt = prop === 'bg' ? Math.min(e.w * e.h, 2e5) : 1;
      total++; area += wgt;
      const va = e.p[prop] || (prop === 'bg' ? 'rgba(0, 0, 0, 0)' : ''), vb = best.p[prop] || (prop === 'bg' ? 'rgba(0, 0, 0, 0)' : '');
      if (close(va, vb, tol)) { ok++; areaOk += wgt; }
      else { const k = `${prop}: ${va} -> want ${vb}`; misses[k] = (misses[k] || 0) + wgt; }
    }
  }
  const top = Object.entries(misses).sort((x, y) => y[1] - x[1]).slice(0, 12).map(([k, n]) => `${k} (${Math.round(n)})`);
  return { elements: a.length, paired, paints: total, match: total ? +(ok / total).toFixed(3) : null, areaMatch: area ? +(areaOk / area).toFixed(3) : null, top };
}

// Pixel score in the browser: share of pixels within tol (max channel difference), a heat map and a side-by-side.
export async function pixelScore(browser, pngA, pngB, { tol = 24, labels = ['A', 'B'], region } = {}) {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  const r = await page.evaluate(async ([a, b, tol, labels, region]) => {
    const load = src => new Promise(res => { const i = new Image(); i.onload = () => res(i); i.src = src; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const R = region || { x: 0, y: 0, w: Math.min(ia.width, ib.width), h: Math.min(ia.height, ib.height) };
    const get = img => { const c = new OffscreenCanvas(R.w, R.h), g = c.getContext('2d'); g.drawImage(img, -R.x, -R.y); return g.getImageData(0, 0, R.w, R.h); };
    const da = get(ia), db = get(ib), heat = new ImageData(R.w, R.h);
    let same = 0; const n = R.w * R.h;
    for (let i = 0; i < n * 4; i += 4) {
      const d = Math.max(Math.abs(da.data[i] - db.data[i]), Math.abs(da.data[i + 1] - db.data[i + 1]), Math.abs(da.data[i + 2] - db.data[i + 2]));
      if (d <= tol) { same++; const g = 255 - (da.data[i] + da.data[i + 1] + da.data[i + 2]) / 12; heat.data.set([g, g, g, 255], i); }
      else heat.data.set([255, Math.max(0, 200 - d), 0, 255], i);
    }
    const pad = 24, head = 34, c = new OffscreenCanvas(R.w * 3 + pad * 4, R.h + head + pad), g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#111'; g.font = '600 20px -apple-system, Segoe UI, sans-serif';
    const hc = new OffscreenCanvas(R.w, R.h); hc.getContext('2d').putImageData(heat, 0, 0);
    [[ia, labels[0]], [ib, labels[1]], [hc, 'difference (red)']].forEach(([img, label], k) => {
      const x = pad + k * (R.w + pad); g.fillText(label, x, 24);
      if (img === hc) g.drawImage(hc, x, head); else g.drawImage(img, R.x, R.y, R.w, R.h, x, head, R.w, R.h);
      g.strokeStyle = '#d0d0d0'; g.strokeRect(x - .5, head - .5, R.w + 1, R.h + 1);
    });
    const blob = await c.convertToBlob({ type: 'image/png' });
    const buf = new Uint8Array(await blob.arrayBuffer()); let bin = ''; for (let i = 0; i < buf.length; i += 32768) bin += String.fromCharCode(...buf.subarray(i, i + 32768));
    return { match: +(same / n).toFixed(4), side: btoa(bin) };
  }, ['data:image/png;base64,' + pngA.toString('base64'), 'data:image/png;base64,' + pngB.toString('base64'), tol, labels, region]);
  await ctx.close();
  return { match: r.match, side: Buffer.from(r.side, 'base64') };
}

export const readJson = f => JSON.parse(readFileSync(f, 'utf8'));
export { launch, settle };
