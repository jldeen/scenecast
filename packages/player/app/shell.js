// Replica shell (scenecast, from replica-kit). Each app in the bundle is a frame holding a real captured page. Clicks, hovers,
// typing and Enter move an app between captured states by morphing the live page into the next capture (morph.js).
// Streamed answers replay the real run's frames, then its final page, at the flow's pace. Everything is local and
// fixed, so it runs the same way every time. Presenter keys are hidden (see docs/flow-format.md).
import { morphDocument, morphNode, morphChildren, pathOf, atPath, wasInserted } from './morph.js';
import { presenterKey } from './presenter-key.js';
import { flowFromBundle, applyFlowOverrides } from './bundle-flow.js';

const baseUrl = new URL('.', location.href);
const local = path => new URL(path.replace(/^\//, ''), baseUrl).href;
const manifestResponse = await fetch(local('/manifest.json'), { cache: 'no-store' });
if (!manifestResponse.ok) throw new Error(`manifest.json ${manifestResponse.status}`);
const manifest = await manifestResponse.json();
const flow = applyFlowOverrides(flowFromBundle(manifest), manifest.development_overrides);
const stage = document.getElementById('stage');
const fav = document.getElementById('d1-fav');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const texts = new Map();
const getText = url => { if (!texts.has(url)) texts.set(url, fetch(url).then(r => { if (!r.ok) throw new Error(url + ' ' + r.status); return r.text(); })); return texts.get(url); };
const getJson = url => getText(url).then(t => JSON.parse(t));
const parse = html => (Document.parseHTMLUnsafe ? Document.parseHTMLUnsafe(html) : new DOMParser().parseFromString(html, 'text/html'));
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\u00a0/g, '&nbsp;');
const S = flow.states;
const snapshots = Object.fromEntries(Object.values(S).filter(s => s.snap.startsWith('@scene:')).map(s => [s.snap, s.snapshot]));
const bundlePath = path => local('/bundle/' + path.split('/').map(encodeURIComponent).join('/'));
const snapUrl = id => snapshots[id] ? bundlePath(snapshots[id]) : local(`/snaps/${id}.html`);
const snapRelated = (id, suffix) => snapshots[id] ? bundlePath(snapshots[id].replace(/\.html$/i, '') + suffix) : local(`/snaps/${id}${suffix}`);
// Replay pace (seconds per prompt): flow.pace, or ?pace= in the URL. Stream timings are written for pace 5.
const PACE = (q => q > 0 ? q : flow.pace || 5)(+new URLSearchParams(location.search).get('pace'));
// ?speed=N runs every timer N times faster (answers, hover delays, slides): the checks' virtual clock. The order of
// everything, and so every screen, is the same as at speed 1.
const SPEED = Math.max(1, +new URLSearchParams(location.search).get('speed') || 1);
const T = ms => ms / SPEED;
const paced = ms => T(ms * PACE / 5);

const apps = {};
// ⌥ + an app's key switches to it, like clicking its Chrome tab (flow.apps[].key, a letter).
const APP_KEYS = Object.fromEntries(flow.apps.filter(a => a.key).map(a => ['Key' + a.key.toUpperCase(), a.id]));
const order = flow.apps.map(a => a.id);
let active = null;
let busy = 0;
let gen = 0;
// Demo modules (flow.modules, from demo.json engine.modules): extra presenter features a demo brings, loaded at start.
const hooks = { key: [], activate: [], jump: [] };
const errors = [];
const note = e => { errors.push(String(e && e.stack || e)); };

// ---- loading and preparing documents -------------------------------------------------------------------------
let loads = 0;
function loadFrame(iframe, url) {
  return new Promise(res => {
    iframe.addEventListener('load', () => res(), { once: true });
    iframe.src = url + (url.includes('?') ? '&' : '?') + 'v=' + (++loads);
  });
}
function docsOf(doc, out = []) {
  out.push(doc);
  for (const f of doc.querySelectorAll('iframe')) { try { if (f.contentDocument && f.contentDocument.body) docsOf(f.contentDocument, out); } catch (e) {} }
  return out;
}
function frameKeyOf(doc) { const fe = doc.defaultView && doc.defaultView.frameElement; return fe && fe.closest('#stage') ? null : fe ? fe.getAttribute('data-d1-frame') : null; }

function prepare(doc, app) {
  if (!doc || doc.__d1) return;
  doc.__d1 = true;
  const W = doc.defaultView;
  W.console && Object.assign(W.console, { log() {}, warn() {}, error() {}, info() {}, debug() {} });
  W.addEventListener('error', e => { e.preventDefault(); }, true);
  doc.addEventListener('click', e => onClick(e, app, doc), true);
  doc.addEventListener('auxclick', e => { if (e.target.closest && e.target.closest('a')) e.preventDefault(); }, true);
  doc.addEventListener('submit', e => e.preventDefault(), true);
  doc.addEventListener('keydown', e => onKey(e, app, doc), true);
  doc.addEventListener('input', e => onInput(e, app, doc), true);
  doc.addEventListener('change', e => { const t = e.target; if (t && t.type === 'checkbox') t.toggleAttribute('checked', t.checked); }, true);
  doc.addEventListener('mouseover', e => onOver(e, app, doc), true);
  doc.addEventListener('mouseout', e => onOut(e, app, doc), true);
  doc.addEventListener('mousedown', e => onDown(e, app, doc), true);
  doc.addEventListener('dragstart', e => e.preventDefault(), true);
  W.addEventListener('resize', () => queueLayout(app));
  doc.addEventListener('scroll', () => queueLayout(app), true);
  try { new W.ResizeObserver(() => queueLayout(app)).observe(doc.documentElement); } catch (e) {}
  for (const name of (app.customElements || [])) { try { if (!W.customElements.get(name)) W.customElements.define(name, class extends W.HTMLElement {}); } catch (e) {} }
  post(doc, 'target', []);
  hvCssAll(doc, app);
  for (const f of doc.querySelectorAll('iframe')) {
    f.__d1src = f.getAttribute('src');
    f.addEventListener('load', () => { try { prepare(f.contentDocument, app); } catch (e) { note(e); } });
    try { if (f.contentDocument && f.contentDocument.readyState === 'complete' && f.contentDocument.body && f.contentDocument.body.childElementCount) prepare(f.contentDocument, app); } catch (e) {}
  }
}

// Web fonts arrive after a page is first laid out. Captured scroll offsets set before they do land on the fallback
// font's layout: clamped when the text is shorter, or moved by scroll anchoring when the fonts swap in. Chrome also
// draws fallback fonts while loading whenever it judges the network slow ("Slow network is detected"), which it can
// do even on localhost, on a cold start or on a second run in the same browser. So when a load or a morph leaves
// fonts loading, the scroll offsets and layout rules are applied again once they've arrived (and idle() waits).
const fontWaits = new Set();
async function afterFonts(app, redo) {
  const docs = docsOf(app.iframe.contentDocument);
  for (const d of docs) { try { d.documentElement.getBoundingClientRect(); } catch (e) {} }
  const loadingNow = () => { for (const d of docs) { try { d.documentElement.getBoundingClientRect(); } catch (e) {} } return docs.filter(d => d.fonts && d.fonts.status === 'loading'); };
  let loading = loadingNow();
  if (!loading.length) return;
  const k = {}; fontWaits.add(k);
  try {
    // Until the fonts stay loaded: the redo's own layout can start more of them (a chip row, a bolder label).
    for (let round = 0; round < 6 && loading.length; round++) {
      for (let i = 0; i < 20 && loading.some(d => d.fonts.status === 'loading'); i++) await Promise.all(loading.map(d => d.fonts.ready));
      redo(docs);
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      loading = loadingNow();
    }
  } finally { fontWaits.delete(k); }
}
function scrolled(doc) { const out = []; for (const el of doc.querySelectorAll('*')) if (el.scrollTop || el.scrollLeft) out.push(el); return out; }
function post(doc, scroll, before) {
  for (const el of doc.querySelectorAll('[data-d1-scroll]')) {
    if (scroll === 'target' || wasInserted(el)) { const [t, l] = el.getAttribute('data-d1-scroll').split(',').map(Number); el.scrollTop = t; el.scrollLeft = l; }
  }
  if (scroll === 'target') for (const el of before) if (el.isConnected && !el.hasAttribute('data-d1-scroll')) { el.scrollTop = 0; el.scrollLeft = 0; }
  for (const c of doc.querySelectorAll('canvas[data-d1-canvas]')) {
    const src = c.getAttribute('data-d1-canvas');
    if (!src || !/^(?:\/|\.\.\/)assets\//.test(src) || c.__d1drawn === src) continue;
    c.__d1drawn = src;
    const img = new doc.defaultView.Image();
    img.onload = () => { const g = c.getContext('2d'); g.clearRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0); };
    img.src = src;
  }
  for (const el of doc.querySelectorAll('[data-d1-popover]')) { try { if (!el.matches(':popover-open')) el.showPopover(); } catch (e) {} }
  for (const el of doc.querySelectorAll('dialog[data-d1-modal]')) { try { if (!el.matches(':modal')) { el.removeAttribute('open'); el.showModal(); } } catch (e) {} }
  for (const el of doc.querySelectorAll('input[data-d1-indeterminate]')) el.indeterminate = true;
}

// ---- matching ------------------------------------------------------------------------------------------------
const norm = s => (s || '').replace(/\s+/g, ' ').trim();
function matches(el, m) {
  if (!el || el.nodeType !== 1) return false;
  if (m.sel && !el.matches(m.sel)) return false;
  if (m.in && !el.closest(m.in)) return false;
  if (m.label !== undefined && el.getAttribute('aria-label') !== m.label) return false;
  if (m.labelStarts !== undefined && !(el.getAttribute('aria-label') || '').startsWith(m.labelStarts)) return false;
  if (m.testid !== undefined && el.getAttribute('data-testid') !== m.testid) return false;
  if (m.text !== undefined && norm(el.innerText) !== m.text) return false;
  if (m.textStarts !== undefined && !norm(el.innerText).startsWith(m.textStarts)) return false;
  if (m.textRe !== undefined && !new RegExp(m.textRe).test(norm(el.innerText))) return false;
  return true;
}
function matchUp(target, m) {
  let el = target && target.nodeType === 1 ? target : target && target.parentElement;
  for (let i = 0; el && i < (m.up || 14); i++) {
    if (matches(el, m)) return el;
    el = el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
  }
  return null;
}
function findEl(doc, m) {
  for (const d of docsOf(doc)) {
    if (m.frame !== undefined && frameKeyOf(d) !== m.frame) continue;
    const els = [...d.querySelectorAll(m.sel || '*')].filter(e => matches(e, m));
    els.sort((a, b) => { const A = a.getBoundingClientRect(), B = b.getBoundingClientRect(); return (A.width * A.height) - (B.width * B.height); });
    const vis = els.filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    const e = vis[m.nth || 0] || els[m.nth || 0];
    if (e) return e;
  }
  return null;
}
function transitions(app, kind) {
  const st = S[app.state] || {};
  return [...(st.on || []), ...((flow.apps.find(a => a.id === app.id) || {}).on || [])].filter(t => t[kind]);
}
function findTransition(app, kind, target, doc) {
  const fk = frameKeyOf(doc);
  for (const t of transitions(app, kind)) {
    if ((t[kind].frame || null) !== fk) continue;
    if (t.when && !t.when.includes(app.state)) continue;
    const el = matchUp(target, t[kind]);
    if (el && t[kind].nth !== undefined && findEl(doc, t[kind]) !== el) continue;
    if (el) return { t, el };
  }
  return null;
}

// ---- events --------------------------------------------------------------------------------------------------
function onClick(e, app, doc) {
  const a = e.target.closest && e.target.closest('a[href]');
  if (a) e.preventDefault();
  const isBox = e.target.type === 'checkbox' || e.target.type === 'radio';
  // A "+N" chip (layout chips): shows the hidden chips and becomes "Show less", at any time, as in the product.
  const plus = e.target.closest && e.target.closest('[data-d1-plus]');
  if (plus) {
    e.preventDefault(); e.stopPropagation(); hvClear(app);
    const k = 'chips' + plus.getAttribute('data-d1-plus');
    app.flags = { ...(app.flags || {}), [k]: !(app.flags || {})[k] };
    applyLayout(app); hvRehover(app); return;
  }
  // A step group opens and closes even while an answer is still coming in. A recorded click on the same button (the
  // path opened it as its own screen) wins when nothing is playing.
  const gsel = grpBtnSel(app), gb = gsel && e.target.closest && e.target.closest(gsel);
  if (gb && (gb.getAttribute('aria-expanded') === 'true' ? grpState(app).live.some(r => r.btn === gb) : grpCanOpen(app, gb)) && (busy || !findTransition(app, 'click', e.target, doc))) {
    e.preventDefault(); e.stopPropagation(); hvClear(app); grpToggle(app, gb); hvRehover(app); return;
  }
  if (busy) { if (!isBox) { e.preventDefault(); e.stopPropagation(); } return; }
  if (clkOnOpen(app, doc, e.target)) { e.preventDefault(); e.stopPropagation(); return; }
  const hit = findTransition(app, 'click', e.target, doc);
  if (!hit) {
    // Not on the recorded path: a pane, menu or expander the click audit recorded opens and closes in place.
    // Recorded clicks fit the page as it rests, so the control's own hover changes come off first (they can move
    // what the click changes), and go back if the click does nothing.
    hvClear(app);
    const c = clkFind(app, doc, e.target);
    if (c) { e.preventDefault(); e.stopPropagation(); clkApply(app, doc, c.d, c.el, c.anc, c.ops); }
    else hvRehover(app);
    return;
  }
  if (!isBox) { e.preventDefault(); e.stopPropagation(); }
  // A button that sends what's in a field (the send arrow) carries the field's text, as Enter does.
  const field = hit.t.typedFrom && findEl(doc, hit.t.typedFrom);
  if (hit.t.typedFrom && !(field && textOf(field))) return;
  setTimeout(() => run(app, hit.t, { el: hit.el, doc, typed: field ? textOf(field) : undefined }), 0);
}

function onKey(e, app, doc) {
  for (const h of hooks.key) if (h(e, app, doc)) { e.preventDefault(); e.stopPropagation(); return; }
  // Presenter keys: ⌥ on the Mac; Ctrl+Alt too, on any OS (Windows and Edge keep Alt alone for their menus).
  if (presenterKey(e)) {
    const c = e.code;
    let handled = true;
    if (/^Digit\d$/.test(c)) jump(+c.slice(5));
    else if (c === 'ArrowRight') switchApp(1);
    else if (c === 'ArrowLeft') switchApp(-1);
    else if (APP_KEYS[c]) activate(APP_KEYS[c]);
    else if (c === 'KeyP') fill(app);
    else if (c === 'KeyN') next(app);
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); return; }
  }
  // Escape closes what's open (a menu, a flyout, a pane that closes that way), or goes to the screen's esc state.
  if (e.key === 'Escape' && !busy && app) {
    if (clkEscape(app) || ((S[app.state] || {}).esc && (run(app, { to: S[app.state].esc, scroll: 'keep' }, {}), true))) { e.preventDefault(); e.stopPropagation(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !busy && app) {
    const hit = findTransition(app, 'enter', e.target, doc);
    if (hit) { e.preventDefault(); e.stopPropagation(); run(app, hit.t, { el: hit.el, doc, typed: textOf(hit.el) }); }
  }
}
const textOf = el => norm(el.localName === 'input' || el.localName === 'textarea' ? el.value : el.innerText);

function onInput(e, app, doc) {
  if (busy) return;
  const hit = findTransition(app, 'type', e.target, doc);
  if (!hit) return;
  const keep = [hit.t.type, ...(hit.t.keepAlso ? [hit.t.keepAlso] : [])];
  if (!textOf(hit.el) && hit.t.empty) return run(app, { to: hit.t.empty, keep, scroll: 'keep' }, { el: hit.el, doc });
  if (textOf(hit.el) && hit.t.to && hit.t.to !== app.state) run(app, { to: hit.t.to, keep, scroll: 'keep' }, { el: hit.el, doc });
}

let hoverTimer = null;
function onOver(e, app, doc) {
  hvOver(e, app, doc);
  if (busy || app.hover) return;
  const hit = findTransition(app, 'hover', e.target, doc);
  if (!hit) return;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    if (busy || app.hover) return;
    app.hover = { base: app.state, el: hit.el, within: hit.t.within, doc };
    run(app, { to: hit.t.to, scroll: 'keep' }, { el: hit.el, doc });
  }, T(hit.t.delay === undefined ? 350 : hit.t.delay));
}
function onOut(e, app, doc) {
  hvOut(app);
  const h = app.hover;
  if (!h) { if (hoverTimer && !(e.relatedTarget && findTransition(app, 'hover', e.relatedTarget, doc))) { clearTimeout(hoverTimer); hoverTimer = null; } return; }
  const to = e.relatedTarget;
  if (to && (h.el.contains(to) || (h.within && to.closest && to.closest(h.within)))) return;
  if (busy) return;
  app.hover = null;
  run(app, { to: h.base, scroll: 'keep' }, {});
}

// ---- hovers captured from the real pages -------------------------------------------------------------------------
// The hover audit (capture/flow/hover-audit.js) recorded what hovering each element does on the real page: changes
// in place (Microsoft IQ's title actions, Teams' message actions) and portals placed against the element (tooltips,
// the Workspace chips' cards). Hovering the same element here does the same, after the same delay, and undoes it
// when the pointer leaves. Data: /snaps/hovers-<app>.json (process.mjs).
const hoverData = {};
async function loadHovers(app) {
  if (!hoverData[app.id]) hoverData[app.id] = await getJson(local(`/snaps/hovers-${app.id}.json`)).catch(() => ({ css: {}, defs: [] }));
}
const ekids = el => [...el.children].filter(c => !/^(script|noscript|template|base)$/.test(c.localName));
const walk = (el, path) => (path || []).reduce((e, i) => e && ekids(e)[i], el);
function frag(doc, html) {
  const t = doc.createElement('template');
  if (t.setHTMLUnsafe) t.setHTMLUnsafe(html); else t.innerHTML = html;
  return t.content.firstElementChild;
}
const isHovered = el => { try { return el.matches(':hover'); } catch (e) { return false; } };
function hvState(app) { return app.hv || (app.hv = { on: new Set(), timers: new Map() }); }
function hvDefsAt(app, doc, target) {
  const H = hoverData[app.id];
  if (!H || !target) return [];
  const fk = frameKeyOf(doc);
  const out = [];
  for (const d of H.defs) {
    if ((d.frame || null) !== fk) continue;
    // Anchors with no name of their own: the nearest one of the recorded size, over a target that has a name.
    if (d.bySize || d.loose) {
      const w = d.bySize ? d.bySize.w : d.anchorRect.w, h = d.bySize ? d.bySize.h : d.anchorRect.h;
      if (d.bySize && !matchUp(target, { ...d.bySize.target, up: 12 })) continue;
      let el = null;
      for (let e = target, i = 0; e && i < 40 && !el; e = e.parentElement, i++) {
        if (!matches(e, d.anchors[0])) continue;
        const r = e.getBoundingClientRect();
        if (!(Math.abs(r.width - w) <= 3 && Math.abs(r.height - h) <= 3)) continue;
        let c = e;
        if (d.scope && d.scope.length) { c = walk(e, d.scope); if (!c || !c.contains(target)) continue; }
        if (d.ops && !hvFits(c, d)) continue;
        if (d.loose && !hvNamed(c, d.portals[0].text, doc)) continue;
        el = c;
      }
      if (el) out.push({ d, el });
      continue;
    }
    for (const a of d.anchors || [d.anchor]) {
      let el = matchUp(target, { ...a, up: 40 });
      // The part of the anchor the changes are in: the pointer has to be in it.
      if (el && d.scope && d.scope.length) { el = walk(el, d.scope); if (!el || !el.contains(target)) el = null; }
      if (el) { out.push({ d, el }); break; }
    }
  }
  // Nothing shows for an element that isn't visible (a Send button while the box is empty).
  for (let i = out.length - 1; i >= 0; i--) { const cs = doc.defaultView.getComputedStyle(out[i].el); if (+cs.opacity === 0 || cs.visibility === 'hidden') out.splice(i, 1); }
  // Look-alike elements (the same icon in several rows) can carry different tooltips: the one that names
  // something written next to the element is its own (a Fabric IQ item's icon says "Fabric IQ").
  const byEl = new Map();
  for (const h of out) if (h.d.portals) { if (!byEl.has(h.el)) byEl.set(h.el, []); byEl.get(h.el).push(h); }
  const drop = new Set();
  for (const [el, hs] of byEl) {
    // Popups from one hover of the real page (a tooltip and its description) all stay.
    const rec = h => h.d.id.replace(/-p\d+$/, '');
    if (new Set(hs.map(rec)).size < 2) continue;
    const texts = new Set(hs.map(h => norm(h.d.portals[0].text)));
    if (texts.size < 2) { hs.filter(h => rec(h) !== rec(hs[0])).forEach(h => drop.add(h)); continue; }
    let keep = null;
    for (let e = el; e && !keep && e !== doc.body; e = e.parentElement) {
      const t = norm(e.innerText);
      const found = t ? hs.filter(h => { const pt = norm(h.d.portals[0].text); return t.includes(pt) || (t.length >= 3 && pt.startsWith(t)); }) : [];
      if (found.length) keep = found.sort((x, y) => y.d.portals[0].text.length - x.d.portals[0].text.length)[0];
    }
    const win = rec(keep || hs[0]);
    hs.forEach(h => { if (rec(h) !== win) drop.add(h); });
  }
  return out.filter(h => !drop.has(h));
}
function hvNamed(el, text, doc) {
  const pt = norm(text);
  for (let e = el, i = 0; e && e !== doc.body && i < 8; e = e.parentElement, i++) {
    const t = norm(e.innerText);
    if (!t) continue;
    const name = t.replace(/\(.*?\)/g, '').split(' ').filter(Boolean).slice(0, 2).join(' ');
    return pt.includes(t) || (t.length >= 3 && pt.startsWith(t)) || (name.length >= 3 && pt.includes(name));
  }
  return false;
}
// In-place changes apply only where the page has the same shape as the real one did.
function hvFits(el, d) {
  for (const op of d.ops || []) {
    const host = walk(el, op.path);
    if (!host) return false;
    if (op.kind === 'attr' && op.tag && host.localName !== op.tag.toLowerCase() && host.localName !== op.tag) return false;
    if (op.kind === 'remove' && op.restTag !== '#text') { const c = ekids(host)[op.index]; if (!c || c.localName !== op.restTag) return false; }
  }
  return true;
}
function hvOver(e, app, doc, now) {
  if (busy) return;
  if (e.clientX !== undefined) app.ptr = { doc, x: e.clientX, y: e.clientY };
  const st = hvState(app);
  for (const { d, el } of hvDefsAt(app, doc, e.target)) {
    const k = d.id;
    if ([...st.on].some(h => h.d === d && h.el === el) || st.timers.has(k)) continue;
    const show = () => { st.timers.delete(k); if (!busy && el.isConnected && (now || isHovered(el))) hvApply(app, doc, d, el); };
    if (now) show(); else st.timers.set(k, setTimeout(show, T(d.delay || 0)));
  }
}
function hvOut(app) {
  const st = hvState(app);
  clearTimeout(st.sweep);
  st.sweepPending = true;
  st.sweep = setTimeout(() => {
    st.sweepPending = false;
    for (const h of [...st.on]) if (!(h.el.isConnected && (isHovered(h.el) || h.nodes.some(isHovered)))) hvUndo(app, h);
  }, T(110));
}
function hvCss(doc, app, page, enable = true) {
  const css = ((hoverData[app.id] || {}).css || {})[page];
  if (!css || !doc.head) return;
  const was = doc.head.querySelector(`style[data-d1-hover="${page}"]`);
  if (was) { if (enable && was.sheet && was.sheet.disabled) was.sheet.disabled = false; return; }
  const s = doc.createElement('style'); s.setAttribute('data-d1-hover', page); s.textContent = css; doc.head.appendChild(s);
  if (!enable && s.sheet) s.sheet.disabled = true;
}
// Every hover and click style a page can use is put in when it's prepared or morphed, switched off, and switched on
// at its first hover or click (as it used to be added then). A pointer passing over a control applies its hover at
// once, so adding styles then made the page's <head> depend on the pointer's path and timing: a fresh start could
// differ from a second run. A stylesheet's disabled flag isn't part of the page's markup, and what's on screen is
// as before (some of these rules also reach the page's own elements).
function hvCssAll(doc, app) {
  const H = hoverData[app.id]; if (!H || !doc || !doc.head) return;
  const fk = frameKeyOf(doc), pages = new Set();
  for (const d of H.defs || []) if ((d.frame || null) === fk) pages.add(d.page);
  for (const d of H.clicks || []) if ((d.frame || null) === fk) pages.add('click-' + d.page);
  for (const p of pages) hvCss(doc, app, p, false);
}
function hvApply(app, doc, d, el) {
  if (!hvFits(el, d)) return;
  hvCss(doc, app, d.page);
  const h = { d, el, doc, undo: [], nodes: [], portals: [] };
  for (const op of d.ops || []) {
    const host = walk(el, op.path);
    if (!host) continue;
    if (op.kind === 'attr') {
      for (const [k, v] of Object.entries(op.set)) {
        const old = host.getAttribute(k);
        h.undo.push(() => old === null ? host.removeAttribute(k) : host.setAttribute(k, old));
        if (v === null) host.removeAttribute(k); else host.setAttribute(k, v);
      }
    } else if (op.kind === 'add') {
      // Two hovers that add the same part in the same place (a post's toolbar) add it once.
      if (ekids(host).some(c => c.__d1add === op.html)) continue;
      const n = frag(doc, op.html); if (!n) continue;
      n.__d1add = op.html;
      host.insertBefore(n, ekids(host)[op.index] || null);
      h.undo.push(() => n.remove());
    } else if (op.kind === 'remove') {
      const c = ekids(host)[op.index];
      if (!c || c.localName !== op.restTag) continue;
      const next = c.nextSibling; c.remove();
      h.undo.push(() => host.insertBefore(c, next && next.parentNode === host ? next : null));
    } else if (op.kind === 'text') {
      const t = [...host.childNodes].filter(n => n.nodeType === 3 && n.data.trim())[op.index];
      if (t) { const old = t.data; t.data = op.text; h.undo.push(() => { t.data = old; }); }
    }
  }
  for (const q of d.portals || []) {
    let parent = doc.body; let root = null;
    for (const tag of q.shells) { const sh = frag(doc, tag + '</' + /^<([a-zA-Z0-9-]+)/.exec(tag)[1] + '>'); if (!sh) continue; parent.appendChild(sh); parent = sh; root = root || sh; }
    const n = frag(doc, q.html); if (!n) continue;
    parent.appendChild(n); root = root || n;
    root.setAttribute('data-d1-hv', d.id);
    // Popovers (the sidebar's task peek) show only in the top layer.
    for (const pe of [n, ...n.querySelectorAll('[data-d1-popover]')]) if (pe.hasAttribute && pe.hasAttribute('data-d1-popover')) { try { pe.showPopover(); } catch (e) {} }
    h.nodes.push(root); h.portals.push({ q, node: n });
  }
  hvState(app).on.add(h);
  hvPlace(h);
}
function hvUndo(app, h) {
  for (const f of h.undo.reverse()) { try { f(); } catch (e) {} }
  for (const n of h.nodes) n.remove();
  hvState(app).on.delete(h);
}
function hvClear(app) {
  const st = hvState(app);
  for (const t of st.timers.values()) clearTimeout(t);
  st.timers.clear();
  for (const h of [...st.on]) hvUndo(app, h);
}
function hvRehover(app) {
  const p = app.ptr;
  if (!p || !p.doc || !p.doc.defaultView) return;
  const t = p.doc.elementFromPoint(p.x, p.y);
  if (t) hvOver({ target: t }, app, p.doc);
}
function hvTrigger(anchor, spec) {
  if (!spec || matches(anchor, spec)) return anchor;
  for (const e of anchor.querySelectorAll(spec.sel || '*')) if (matches(e, spec)) return e;
  return matchUp(anchor, { ...spec, up: 6 }) || anchor;
}
// A portal goes where the real page put it: the same side of the element, the same gap and alignment, kept inside
// the window (moving its arrow to stay on the element), flipped to the other side if it doesn't fit.
function hvPlace(h) {
  for (const { q, node } of h.portals) {
    if (!q.pos) continue;
    const pos = walk(node, q.pos.path);
    if (!pos) continue;
    const W = h.doc.defaultView, vw = W.innerWidth, vh = W.innerHeight;
    const T = hvTrigger(h.el, q.trigger).getBoundingClientRect(), T0 = q.triggerRect, P0 = q.pos.rect;
    const R = pos.getBoundingClientRect(), w = R.width, ht = R.height;
    const vp = q.vp || [1920, 1080];
    let pl = q.pos.placement;
    if (!pl) pl = P0.y >= T0.y + T0.h - 2 ? 'bottom' : P0.y + P0.h <= T0.y + 2 ? 'top' : P0.x >= T0.x + T0.w - 2 ? 'right' : 'left';
    const [side, align] = pl.split('-');
    const vert = side === 'top' || side === 'bottom';
    // Cross axis: aligned like the capture; an edge it was pushed against there is kept here too.
    const [t0, tl0, p0, pl0, view0, tl, tlen, plen, view] = vert ? [T0.x, T0.w, P0.x, P0.w, vp[0], T.x, T.width, w, vw] : [T0.y, T0.h, P0.y, P0.h, vp[1], T.y, T.height, ht, vh];
    const ref0 = align === 'start' ? t0 : align === 'end' ? t0 + tl0 : t0 + tl0 / 2;
    const pref0 = align === 'start' ? p0 : align === 'end' ? p0 + pl0 : p0 + pl0 / 2;
    let off = pref0 - ref0, pad = 0;
    if (Math.abs(off) > 1.5) { if (p0 <= 12) { pad = Math.max(0, p0); off = 0; } else if (p0 + pl0 >= view0 - 12) { pad = Math.max(0, view0 - p0 - pl0); off = 0; } }
    const adj = len => align === 'start' ? 0 : align === 'end' ? len : len / 2;
    const shift0 = p0 - (ref0 + off - adj(pl0));
    const ref = align === 'start' ? tl : align === 'end' ? tl + tlen : tl + tlen / 2;
    const ideal = ref + off - adj(plen);
    const cross = Math.max(pad, Math.min(ideal, view - plen - pad));
    // Main axis: the same gap, flipped if it doesn't fit.
    let main;
    if (side === 'bottom') { const gap = P0.y - (T0.y + T0.h); main = T.bottom + gap; if (main + ht > vh && T.top - gap - ht >= 0) main = T.top - gap - ht; }
    else if (side === 'top') { const gap = T0.y - (P0.y + P0.h); main = T.top - gap - ht; if (main < 0 && T.bottom + gap + ht <= vh) main = T.bottom + gap; }
    else if (side === 'right') { const gap = P0.x - (T0.x + T0.w); main = T.right + gap; if (main + w > vw && T.left - gap - w >= 0) main = T.left - gap - w; }
    else { const gap = T0.x - (P0.x + P0.w); main = T.left - gap - w; if (main < 0 && T.right + gap + w <= vw) main = T.right + gap; }
    const [x, y] = vert ? [cross, main] : [main, cross];
    const dx = x - R.x, dy = y - R.y;
    // The arrow points at the element's middle: it moves by however much more (or less) the box was pushed
    // against the window's edge than in the capture.
    const arrow = [...pos.querySelectorAll('*')].find(e => !e.children.length && !norm(e.textContent) && (vert ? e.style.left : e.style.top) && e.getBoundingClientRect().width < 40);
    if (arrow) { const k = vert ? 'left' : 'top'; if (arrow.__d1base === undefined) arrow.__d1base = parseFloat(arrow.style[k]); arrow.style[k] = (arrow.__d1base + shift0 - (cross - ideal)).toFixed(3) + 'px'; }
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    const tr = pos.style.transform || '';
    const m = /translate3d\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(tr) || /translate\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(tr);
    if (m) pos.style.transform = tr.replace(m[0], `translate3d(${(+m[1] + dx).toFixed(1)}px, ${(+m[2] + dy).toFixed(1)}px, ${m[3] && m[0].startsWith('translate3d') ? m[3] : 0}px)`);
    else { const cs = W.getComputedStyle(pos); pos.style.left = (parseFloat(cs.left) || 0) + dx + 'px'; pos.style.top = (parseFloat(cs.top) || 0) + dy + 'px'; }
  }
}

// ---- clicks and drags captured from the real pages --------------------------------------------------------------
// The click audit (capture/flows/click-audit.js, scenecast record side clicks) recorded what clicking each pane, menu
// and expander control does on the real page: changes in place, from an ancestor of the control (a pane closing, a
// folder collapsing), and popups (menus, flyouts). It also recorded how the page undoes it: the same control again
// (toggle), Escape or a click elsewhere (escape), a control that appears in its place (reopen: a "Show details panel"
// button), or by itself (auto: a Copy button's check mark). Panes and sections stay as she left them when the page
// changes (sticky), until ⌥0 or a beat jump puts everything back as captured.
// Data: clicks in /snaps/hovers-<app>.json. Drags: flow.drags, from the drag audit (scenecast record side drags).
function clkState(app) { return app.clk || (app.clk = { open: [], sticky: new Set(), dirty: false }); }
const clickDefs = app => ((hoverData[app.id] || {}).clicks) || [];
const upFrom = (el, n) => { let e = el; for (let i = 0; e && i < (n || 0); i++) e = e.parentElement; return e; };
function clkFits(anc, ops) {
  if (!anc) return false;
  for (const op of ops || []) {
    const host = walk(anc, op.path);
    if (!host) return false;
    if (op.kind === 'attr' && op.tag && host.localName !== op.tag.toLowerCase() && host.localName !== op.tag) return false;
    if (op.kind === 'remove' && op.restTag !== '#text') { const c = ekids(host)[op.index]; if (!c || c.localName !== op.restTag) return false; }
  }
  return true;
}
// The ancestor the changes were recorded from: as many levels up as on the real page, or (where the capture nests
// one level more or less) the nearest one up the tree where every change fits.
// Tried in order: the recorded anchor; the narrower one (the part holding what changes on screen); then the nearest
// ancestor where either fits. Returns the anchor and the changes to make from it.
function clkAnchor(el, d) {
  if (!d.ops) return null;
  const tries = [[d.up, d.ops], [d.sup, d.sops]].filter(t => t[1]);
  for (const [up, ops] of tries) { const a = upFrom(el, up); if (a && clkFits(a, ops)) return { anc: a, ops }; }
  for (const [, ops] of tries.slice().reverse()) for (let k = 0, e = el; e && k < 18; k++, e = e.parentElement) if (clkFits(e, ops)) return { anc: e, ops };
  return null;
}
function clkFind(app, doc, target) {
  const fk = frameKeyOf(doc);
  for (const d of clickDefs(app)) {
    if ((d.frame || null) !== fk) continue;
    const el = matchUp(target, { ...d.ctl, up: 10 });
    if (!el) continue;
    const a = clkAnchor(el, d);
    // A menu whose control has a different shape here still opens (its control just doesn't show it's open).
    if (d.ops && !a && !d.portals) continue;
    return { d, el, anc: a && a.anc, ops: a ? a.ops : [] };
  }
  return null;
}
function clkApply(app, doc, d, el, anc, ops) {
  hvCss(doc, app, 'click-' + d.page);
  const rec = { d, el, anc, doc, undo: [], nodes: [], added: [] };
  const res = anc ? (ops || []).map(op => ({ op, host: walk(anc, op.path) })).filter(x => x.host) : [];
  for (const { op, host } of res) {
    if (op.kind === 'attr') for (const [k, v] of Object.entries(op.set)) {
      const old = host.getAttribute(k);
      rec.undo.push(() => old === null ? host.removeAttribute(k) : host.setAttribute(k, old));
      if (v === null) host.removeAttribute(k); else host.setAttribute(k, v);
    } else if (op.kind === 'text') {
      const t = [...host.childNodes].filter(n => n.nodeType === 3 && n.data.trim())[op.index];
      if (t) { const old = t.data; t.data = op.text; rec.undo.push(() => { t.data = old; }); }
    }
  }
  const rm = res.filter(x => x.op.kind === 'remove' && x.op.restTag !== '#text').map(x => ({ parent: x.host, child: ekids(x.host)[x.op.index], tag: x.op.restTag })).filter(x => x.child && x.child.localName === x.tag);
  for (const r of rm) { const next = r.child.nextSibling; r.child.remove(); rec.undo.push(() => r.parent.insertBefore(r.child, next && next.parentNode === r.parent ? next : null)); }
  for (const { op, host } of res.filter(x => x.op.kind === 'add').sort((a, b) => a.op.index - b.op.index)) {
    const n = frag(doc, op.html); if (!n) continue;
    host.insertBefore(n, ekids(host)[op.index] || null);
    // Nodes a click adds were open on the real page; their popovers open the same way.
    for (const pe of [n, ...n.querySelectorAll('[popover]')]) if (pe.hasAttribute('popover')) { try { if (!pe.matches(':popover-open')) pe.showPopover(); } catch (e) {} }
    // CSS anchor positioning: the real control carried the anchor name while its popover was open.
    for (const pe of [n, ...n.querySelectorAll('[style*="position-anchor"]')]) {
      const m = /position-anchor:\s*(--[\w-]+)/.exec(pe.getAttribute && pe.getAttribute('style') || '');
      if (!m || doc.querySelector(`[style*="anchor-name: ${m[1]}"]`)) continue;
      const was = el.style.getPropertyValue('anchor-name');
      el.style.setProperty('anchor-name', was ? was + ', ' + m[1] : m[1]);
      rec.undo.push(() => { if (was) el.style.setProperty('anchor-name', was); else el.style.removeProperty('anchor-name'); if (!el.getAttribute('style')) el.removeAttribute('style'); });
    }
    rec.added.push(n); rec.undo.push(() => n.remove());
  }
  const portals = [];
  for (const q of d.portals || []) {
    let parent = doc.body, root = null;
    for (const tag of q.shells) { const sh = frag(doc, tag + '</' + /^<([a-zA-Z0-9-]+)/.exec(tag)[1] + '>'); if (!sh) continue; parent.appendChild(sh); parent = sh; root = root || sh; }
    const n = frag(doc, q.html); if (!n) continue;
    parent.appendChild(n); root = root || n;
    root.setAttribute('data-d1-clk', d.id);
    for (const pe of [n, ...n.querySelectorAll('[data-d1-popover]')]) if (pe.hasAttribute && pe.hasAttribute('data-d1-popover')) { try { pe.showPopover(); } catch (e) {} }
    rec.nodes.push(root); portals.push({ q, node: n });
  }
  rec.place = { el, doc, portals };
  hvPlace(rec.place);
  // What undoes it: the control again (where it is now), the control that took its place, or a timer.
  rec.toggleEl = el.isConnected ? el : clkAt(doc, d.ctlRect);
  if (d.reopen) rec.reopenEl = findEl(doc, d.reopen);
  if (d.restore === 'auto') rec.timer = setTimeout(() => clkUndo(app, rec, true), T(d.revertMs || 2000));
  if (d.copy) clkCopy(doc, el);
  clkState(app).open.push(rec);
  if (d.sticky) clkState(app).sticky.add(d.id);
  queueLayout(app);
  return rec;
}
function clkAt(doc, r) { const e = r && doc.elementFromPoint(r.x + r.w / 2, r.y + r.h / 2); return e && (e.closest('button,[role=button],[role=treeitem],a') || e); }
function clkUndo(app, rec, byUser) {
  clearTimeout(rec.timer);
  for (const f of rec.undo.reverse()) { try { f(); } catch (e) {} }
  rec.undo = [];
  for (const n of rec.nodes) n.remove();
  const st = clkState(app);
  st.open = st.open.filter(r => r !== rec);
  if (byUser) st.sticky.delete(rec.d.id);
  queueLayout(app);
}
// Before a morph: everything is undone (the morph brings the page to a capture); after it, sticky ones come back.
function clkClear(app) { const st = clkState(app); for (const rec of [...st.open].reverse()) clkUndo(app, rec, false); st.dirty = st.sticky.size > 0; grpClear(app); }
function clkReapply(app) {
  const st = clkState(app);
  if (!st.dirty || !app.iframe.contentDocument) return;
  st.dirty = false;
  for (const id of st.sticky) {
    const d = clickDefs(app).find(x => x.id === id);
    if (!d || st.open.some(r => r.d.id === id)) continue;
    const el = findEl(app.iframe.contentDocument, { ...d.ctl, frame: d.frame || null });
    if (!el) continue;
    const a = clkAnchor(el, d);
    if (d.ops && !a) continue;
    clkApply(app, el.ownerDocument, d, el, a && a.anc, a ? a.ops : []);
  }
}
function clkCopy(doc, el) {
  let e = el; while (e && e.parentElement && norm(e.innerText).length < 200) e = e.parentElement;
  try { const p = doc.defaultView.navigator.clipboard.writeText((e && e.innerText || '').trim()); if (p && p.catch) p.catch(() => {}); } catch (x) {}
}
// A click on a control that's open closes it; so does a menu item or a Close button in what it opened.
function clkOnOpen(app, doc, target) {
  const st = clkState(app);
  for (const rec of [...st.open].reverse()) {
    if (rec.doc !== doc) continue;
    const inEl = x => x && x.isConnected && (x === target || x.contains(target));
    if (inEl(rec.toggleEl) && rec.d.restore !== 'reopen' && rec.d.restore !== 'auto') { clkUndo(app, rec, true); return true; }
    if (inEl(rec.reopenEl)) { clkUndo(app, rec, true); return true; }
    const inside = [...rec.nodes, ...rec.added].some(n => n.contains(target));
    if (inside) {
      const item = target.closest('[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],button[aria-label="Close"],button[aria-label^="Close "],button[aria-label="Dismiss"]');
      if (item) { clkUndo(app, rec, true); return true; }
      return false;
    }
  }
  return false;
}
// Menus and flyouts close when she clicks anywhere else, like the real ones.
function clkDismiss(app, doc, target) {
  for (const rec of [...clkState(app).open].reverse()) {
    if (!rec.d.popup || rec.d.sticky) continue;
    if (rec.doc === doc && ([...rec.nodes, ...rec.added].some(n => n.contains(target)) || (rec.toggleEl && rec.toggleEl.contains(target)))) continue;
    clkUndo(app, rec, true);
  }
}
function clkEscape(app) {
  const rec = [...clkState(app).open].reverse().find(r => r.d.restore === 'escape' || r.d.popup);
  if (!rec) return false;
  clkUndo(app, rec, true);
  return true;
}

// Drags. live: the pane follows the pointer; release: the new size applies when she lets go (Teams).
// write: flexPercent (a pane's flex share, its own CSS min/max width), px (target's width), cssVar (a custom property
// on target, in px or vw), teamsSlot (Teams' --slot-width and its slider). dir: +1 when dragging right makes it
// bigger (a pane on the left), -1 when dragging left does (a pane on the right).
const dragRules = app => (flow.drags || []).map((r, i) => ({ ...r, i })).filter(r => r.app === app.id);
function dragPane(h) {
  for (let e = h, k = 0; e && k < 3; e = e.parentElement, k++) for (let n = e.nextElementSibling; n; n = n.nextElementSibling) if (/flex: 0 0 [\d.]+%/.test(n.getAttribute('style') || '')) return n;
  return null;
}
const sepOf = h => h.querySelector('[role=separator][aria-label]') || h.closest('[role=separator]') || h;
function dragKey(r, h) { return r.i + ':' + (sepOf(h).getAttribute('aria-label') || ''); }
function dragWrite(app, doc, r, h, v) {
  const W = doc.defaultView;
  if (r.write === 'flexPercent') {
    const pane = dragPane(h); if (!pane) return;
    pane.style.flex = `0 0 ${v.toFixed(2)}%`;
    sepOf(h).setAttribute('aria-valuenow', String(Math.round(v)));
  } else if (r.write === 'px') {
    const t = doc.querySelector(r.target); if (!t) return;
    t.style.width = v + 'px'; t.style.minWidth = v + 'px';
    sepOf(h).setAttribute('aria-valuenow', String(Math.round(v)));
  } else if (r.write === 'cssVar') {
    const t = doc.querySelector(r.target); if (!t) return;
    t.style.setProperty(r.name, r.unit === 'vw' ? (v / W.innerWidth * 100) + 'vw' : v + 'px');
    const sl = r.slider ? doc.querySelector(r.slider) : sepOf(h);
    if (sl) sl.setAttribute('aria-valuenow', String(Math.round(v)));
  } else if (r.write === 'teamsSlot') {
    const slot = doc.querySelector(r.slot); if (!slot) return;
    slot.style.setProperty('--slot-width', (v / W.innerWidth * 100) + 'vw');
    const sl = doc.querySelector(r.slider);
    if (sl) { sl.setAttribute('aria-valuenow', String(Math.round(v))); sl.parentElement.style.setProperty('--slot-resize-cursor-v', v >= r.max ? 'var(--col-resize-w)' : v <= r.min ? 'var(--col-resize-e)' : 'var(--col-resize)'); }
  }
}
function startDrag(app, doc, r, h, e0) {
  const W = doc.defaultView;
  const x0 = e0.clientX;
  let calc;
  if (r.write === 'flexPercent') {
    const pane = dragPane(h); if (!pane) return;
    const room = pane.parentElement.getBoundingClientRect().width;
    const cs = W.getComputedStyle(pane);
    const min = parseFloat(cs.minWidth) || 0, max = parseFloat(cs.maxWidth) || room;
    const w0 = pane.getBoundingClientRect().width, dir = r.dir || -1;
    calc = dx => Math.max(min, Math.min(max, w0 + dir * dx)) / room * 100;
  } else if (r.write === 'px' || r.write === 'cssVar') {
    const t = doc.querySelector(r.target); if (!t) return;
    const w0 = t.getBoundingClientRect().width, dir = r.dir || 1;
    calc = dx => Math.max(r.min, Math.min(r.max, Math.round(w0 + dir * dx)));
  } else {
    const slot = doc.querySelector(r.slot); if (!slot) return;
    const w0 = slot.getBoundingClientRect().width;
    calc = dx => Math.max(r.min, Math.min(r.max, Math.round(w0 + dx)));
  }
  const root = doc.documentElement, oldCursor = root.style.cursor;
  if (r.cursor) root.style.cursor = r.cursor;
  const sizes = app.sizes || (app.sizes = {});
  const key = dragKey(r, h);
  app.dragging = true;
  const move = e => { if (r.mode === 'live') { const v = calc(e.clientX - x0); sizes[key] = v; dragWrite(app, doc, r, h, v); queueLayout(app); } e.preventDefault(); };
  const up = e => {
    doc.removeEventListener('mousemove', move, true); doc.removeEventListener('mouseup', up, true);
    root.style.cursor = oldCursor; app.dragging = false;
    const dx = e.clientX - x0;
    if (r.mode === 'release' && dx) { const v = calc(dx); sizes[key] = v; dragWrite(app, doc, r, h, v); }
    queueLayout(app);
  };
  doc.addEventListener('mousemove', move, true); doc.addEventListener('mouseup', up, true);
}
function onDown(e, app, doc) {
  if (e.button !== 0) return;
  clkDismiss(app, doc, e.target);
  if (busy) return;
  const fk = frameKeyOf(doc);
  for (const r of dragRules(app)) {
    if ((r.frame || null) !== fk) continue;
    const h = e.target.closest && e.target.closest(r.handle);
    if (!h) continue;
    e.preventDefault(); e.stopPropagation();
    startDrag(app, doc, r, h, e);
    return;
  }
}
function dragReapply(app) {
  if (!app.sizes || app.dragging) return;
  for (const r of dragRules(app)) {
    const d = docFor(app, r.frame); if (!d) continue;
    for (const h of d.querySelectorAll(r.handle)) { const v = app.sizes[dragKey(r, h)]; if (v !== undefined) dragWrite(app, d, r, h, v); }
  }
}

// ---- step groups -------------------------------------------------------------------------------------------------
// Collapsed step groups in an answer ("21 items complete", "Approved 1 action") open and close like the product's,
// on any screen, also while an answer is still coming in, and stay open through the next frames and prompts until
// she closes them, or ⌥0 or a jump. Data: groups in /snaps/hovers-<app>.json (process.mjs, from flow.groups):
//   sel     { button, label, chevron }: the toggle buttons (aria-controls names each one's region), the part of a
//           button that holds its label (else its text, without aria-hidden parts), its chevron
//   btn     how a button changes when it opens (attributes, with {label}; classes; children it drops), and
//   chevron, region   class changes: all from a real closed/open pair (flow.groups template)
//   grid    { closed, open } region classes for groups whose list stays in the page (opened by a class swap)
//   lists   { label: [{ html, snaps, stream? }] }: a list the product drops when its group closes, from a real open
//           capture or the run's frame where the group was still filled; the one for this screen is used
// A list group's region slides open to its list's height, the way the product's script does it.
const grpData = app => ((hoverData[app.id] || {}).groups) || null;
function grpState(app) { return app.grp || (app.grp = { open: new Set(), live: [], timers: new Set() }); }
const grpBtnSel = app => (grpData(app) || {}).sel && grpData(app).sel.button;
function grpKey(app, btn) {
  const G = grpData(app), el = (G && G.sel.label && btn.querySelector(G.sel.label)) || btn;
  const c = el.cloneNode(true); c.querySelectorAll('[aria-hidden="true"]').forEach(e => e.remove());
  return norm(c.textContent);
}
// What keeps a group open across morphs: its region's id (stable within a live page), else its label.
const grpOpenKey = (app, btn) => btn.getAttribute('aria-controls') ? '#' + btn.getAttribute('aria-controls') : 'label:' + grpKey(app, btn);
const grpRegion = btn => { const id = btn.getAttribute('aria-controls'); return id ? btn.ownerDocument.getElementById(id) : null; };
const grpIsGrid = (G, region) => !!(G.grid && (G.grid.closed || []).some(c => region.classList.contains(c)));
// The product swaps a class in place, so the first added class takes the first removed one's place.
const grpClasses = (el, add, remove) => {
  const list = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean), rm = new Set(remove || []);
  const at = list.findIndex(c => rm.has(c)), keep = list.filter(c => !rm.has(c)), extra = (add || []).filter(c => !keep.includes(c));
  keep.splice(at < 0 ? keep.length : Math.min(at, keep.length), 0, ...extra);
  el.setAttribute('class', keep.join(' '));
};
// The list for this screen (or the screen an answer that's still coming in ends on).
function grpList(app, key) {
  const e = (grpData(app).lists || {})[key];
  if (!e || !e.length) return null;
  const snap = (S[app.playing || app.state] || {}).snap;
  return (e.find(x => (x.snaps || []).includes(snap)) || e.find(x => !x.stream) || e[0]).html;
}
// Whether a closed group has something to show: a list in the page, or a captured one.
function grpCanOpen(app, btn) {
  const G = grpData(app), region = grpRegion(btn);
  if (!G || !region || btn.getAttribute('aria-expanded') !== 'false') return false;
  if (grpIsGrid(G, region)) return true;
  const inner = region.firstElementChild;
  return !!inner && (inner.childElementCount > 0 || !!grpList(app, grpKey(app, btn)));
}
function grpOpen(app, btn, animate) {
  if (!grpCanOpen(app, btn)) return false;
  const G = grpData(app), region = grpRegion(btn), st = grpState(app);
  const key = grpKey(app, btn), grid = grpIsGrid(G, region);
  const rec = { key, okey: grpOpenKey(app, btn), btn, region, saved: [btn.cloneNode(true), region.cloneNode(true)] };
  btn.setAttribute('aria-expanded', 'true');
  if (!grid && G.btn) {
    for (const [k, v] of Object.entries(G.btn.set || {})) if (v === null) btn.removeAttribute(k); else btn.setAttribute(k, v.split('{label}').join(key));
    if (G.btn.cls) grpClasses(btn, G.btn.cls.add, G.btn.cls.remove);
    // Open, a button can show less (a list group's plugin icons go).
    for (const s of G.btn.drop || []) for (const c of [...btn.children]) if (c.matches(s)) c.remove();
  }
  const chev = G.sel.chevron && btn.querySelector(G.sel.chevron);
  if (chev && G.chevron) grpClasses(chev, G.chevron.add, G.chevron.remove);
  if (region.hasAttribute('aria-hidden')) region.setAttribute('aria-hidden', 'false');
  region.removeAttribute('inert');
  if (grid) grpClasses(region, G.grid.open, G.grid.closed);
  else {
    const inner = region.firstElementChild;
    if (!inner.childElementCount) { const t = btn.ownerDocument.createElement('template'); t.innerHTML = grpList(app, key); inner.append(t.content); }
    if (G.region) grpClasses(region, G.region.add, G.region.remove);
    const h = inner.offsetHeight;
    if (animate) { region.style.height = '0px'; inner.style.transform = `translateY(-${h}px)`; void region.offsetHeight; }
    else { region.style.transition = 'none'; inner.style.transition = 'none'; }
    region.style.height = h + 'px'; inner.style.transform = 'translateY(0px)';
    if (!animate) { void region.offsetHeight; region.style.transition = ''; inner.style.transition = ''; grpTidy(region); grpTidy(inner); }
  }
  st.live.push(rec);
  return true;
}
// Inline styles the replica set only to skip an animation come off again.
const grpTidy = el => { if (!el.getAttribute('style')) el.removeAttribute('style'); };
function grpClose(app, rec, animate) {
  const st = grpState(app);
  st.live = st.live.filter(r => r !== rec);
  const restore = () => { if (rec.btn.isConnected) rec.btn.replaceWith(rec.saved[0]); if (rec.region.isConnected) rec.region.replaceWith(rec.saved[1]); };
  if (!animate) return restore();
  const G = grpData(app);
  rec.btn.setAttribute('aria-expanded', 'false');
  const chev = G.sel.chevron && rec.btn.querySelector(G.sel.chevron);
  if (chev && G.chevron) grpClasses(chev, G.chevron.remove, G.chevron.add);
  if (G.grid && (G.grid.open || []).some(c => rec.region.classList.contains(c))) grpClasses(rec.region, G.grid.closed, G.grid.open);
  else { const inner = rec.region.firstElementChild; if (inner) { const h = inner.offsetHeight; rec.region.style.height = '0px'; inner.style.transform = `translateY(-${h}px)`; } }
  // After the slide, the page is as it was before she opened it.
  const tm = setTimeout(() => { st.timers.delete(tm); if (!rec.closed) { rec.closed = true; restore(); } }, T(240));
  st.timers.add(tm);
  rec.finish = () => { clearTimeout(tm); st.timers.delete(tm); if (!rec.closed) { rec.closed = true; restore(); } };
  st.closing = (st.closing || []).concat(rec);
}
function grpToggle(app, btn) {
  const st = grpState(app);
  const rec = st.live.find(r => r.btn === btn);
  if (rec) { st.open.delete(rec.okey); grpClose(app, rec, true); return true; }
  const okey = grpOpenKey(app, btn);
  if (!grpOpen(app, btn, true)) return false;
  st.open.add(okey);
  return true;
}
// Before a morph, every group is as captured (closed); after it, the ones she opened open again, without the slide.
function grpClear(app) {
  const st = grpState(app);
  for (const r of st.closing || []) r.finish();
  st.closing = [];
  for (const r of [...st.live].reverse()) grpClose(app, r, false);
}
function grpReapply(app) {
  const st = grpState(app), doc = app.iframe.contentDocument, G = grpData(app);
  if (!doc || !G) return;
  if (st.open.size) for (const btn of doc.querySelectorAll(G.sel.button)) if (st.open.has(grpOpenKey(app, btn)) && !st.live.some(r => r.btn === btn)) grpOpen(app, btn, false);
  // An open list keeps its real height when the window or zoom changes (the product measures it again).
  for (const r of st.live) {
    const inner = r.region.firstElementChild;
    if (!inner || grpIsGrid(G, r.region) || (G.grid && (G.grid.open || []).some(c => r.region.classList.contains(c)))) continue;
    const h = inner.offsetHeight;
    if (Math.abs(parseFloat(r.region.style.height) - h) > 1) { r.region.style.transition = 'none'; r.region.style.height = h + 'px'; void r.region.offsetHeight; r.region.style.transition = ''; }
  }
}

// ---- layout the apps' own scripts keep up to date ----------------------------------------------------------------
// The real pages run scripts that place some things in pixels and re-place them whenever the window changes size,
// for example when she zooms. The captures hold those pixels from 1920×1080, so these rules redo that work:
//   responsive: below a width, a part of the page (a sidebar) is swapped for the same part captured at that width
//   set:        inline styles the script would have written (the Workspace pane's 25% share)
//   pin:        a fixed element placed over its placeholder (Copilot's message box)
//   float:      a popup placed against the element it belongs to (hover cards, menus)
//   stick:      a message list that stays scrolled to its newest post unless she scrolls up (Teams)
const parsedSnaps = new Map();
function parsedSync(snap) { return parsedSnaps.get(snap) || null; }
async function ensureParsed(snap) { if (!parsedSnaps.has(snap)) parsedSnaps.set(snap, parse(await getText(snapUrl(snap)))); return parsedSnaps.get(snap); }
const layoutOf = id => (flow.apps.find(a => a.id === id) || {}).layout || null;
function partOf(doc, part) { let e = doc.querySelector(part.sel); for (let i = 0; e && i < (part.up || 0); i++) e = e.parentElement; return e; }
function docFor(app, frame) { const doc = app.iframe.contentDocument; return frame ? docsOf(doc).find(d => frameKeyOf(d) === frame) || null : doc; }
function firstMatch(d, m) { for (const e of d.querySelectorAll(m.sel || '*')) if (matches(e, m)) return e; return null; }

function applyLayout(app) {
  for (const h of hvState(app).on) hvPlace(h);
  for (const r of clkState(app).open) hvPlace(r.place);
  if (!app.state) return;
  const L = layoutOf(app.id) || {};
  const doc = app.iframe.contentDocument;
  if (!doc || !doc.body) return;
  for (const r of L.responsive || []) {
    const live = partOf(doc, r.part);
    if (!live) continue;
    // One threshold (below + variant per state) or width bands (the narrowest band the width falls under wins).
    const vw = doc.defaultView.innerWidth;
    // A band's variant is one capture, or one per state ({ default, <state>: capture }).
    const pick = v => v && typeof v === 'object' ? (v[app.state] || v.default || null) : v;
    // Narrow widths (the product collapses the part itself), else a flag she set (a Collapse sidebar toggle: t.flag).
    const band = r.bands ? r.bands.filter(b => vw < b.below && pick(b.variant)).sort((x, y) => x.below - y.below)[0] : vw < r.below ? { variant: r.variant[app.state] || r.variant.default } : r.flag && (app.flags || {})[r.flag] ? { variant: pick(r.flagVariant) } : null;
    const want = band ? pick(band.variant) : null;
    if (!want && !live.__d1band) continue;
    if (want && live.__d1band === want && live.__d1gen === app.morphGen) continue;
    const src = parsedSync(want || S[app.state].snap);
    const twin = src && partOf(src, r.part);
    if (!twin) continue;
    hvClear(app); clkClear(app);
    morphNode(live, twin);
    live.__d1band = want; live.__d1gen = app.morphGen;
  }
  for (const r of L.set || []) {
    const d = docFor(app, r.frame); if (!d) continue;
    for (const el of d.querySelectorAll(r.sel)) for (const [k, v] of Object.entries(r.style)) if (el.style.getPropertyValue(k) !== v) el.style.setProperty(k, v);
  }
  // Fluent DataGrid fits its columns to the container: columns get their ideal width from the first one on, the last
  // takes what's left, and none goes below its minimum (then the grid scrolls sideways).
  for (const r of L.gridfit || []) {
    const d = docFor(app, r.frame); if (!d) continue;
    for (const g of d.querySelectorAll('[role=grid]')) {
      const rows = g.querySelectorAll('[role=row]');
      if (!rows.length) continue;
      const heads = [...rows[0].children].filter(c => c.getAttribute('role') === 'columnheader');
      if (heads.map(h => norm(h.innerText)).join('|') !== r.columns.join('|')) continue;
      let room = g.parentElement.clientWidth - r.extra;
      const w = r.columns.map((c, i) => r.min[i]);
      room -= w.reduce((a, b) => a + b, 0);
      for (let i = 0; i < w.length - 1 && room > 0; i++) { const add = Math.min(r.ideal[i] - w[i], room); w[i] += add; room -= add; }
      if (room > 0) w[w.length - 1] += room;
      const css = w.map(x => `width: ${x}px; min-width: ${x}px; max-width: ${x}px;`);
      for (const row of rows) {
        const cells = [...row.children].filter(c => /^(columnheader|gridcell|rowheader)$/.test(c.getAttribute('role')));
        if (cells.length !== w.length) continue;
        cells.forEach((c, i) => { if (c.getAttribute('style') !== css[i]) c.setAttribute('style', css[i]); });
      }
    }
  }
  // Chip lists that show at most N rows: the rest give way to a "+N" chip (its markup comes from a capture).
  // Clicking it shows them all (they wrap onto more rows) and it becomes "Show less" (plus.less), until she clicks
  // that, or ⌥0 or a jump. plus.labelMore / labelLess: its aria-label ("+{n} more plugins"), or plus.noun.
  const isPlus = e => /^\+\d+$/.test(norm(e.textContent)) || e.hasAttribute('data-d1-plusmark');
  for (const [ri, r] of (L.chips || []).entries()) {
    const d = docFor(app, r.frame); if (!d) continue;
    const src = parsedSync(r.plus.from);
    const plusSrc = src && (src.querySelector('[data-d1-plusmark]') || [...src.querySelectorAll(r.list + ' ' + r.item)].find(isPlus));
    const more = r.plus.labelMore || (r.plus.noun && `+{n} more ${r.plus.noun}`), lessLabel = r.plus.labelLess || (r.plus.noun && `Show less ${r.plus.noun}`);
    for (const ul of d.querySelectorAll(r.list)) {
      ul.querySelectorAll('[data-d1-plus]').forEach(e => e.remove());
      // A "+N" the real page drew in this capture (a zoom capture) gives way to the replica's own.
      for (const e of ul.querySelectorAll(':scope > ' + r.item)) if (isPlus(e)) e.style.setProperty('display', 'none');
      const chips = [...ul.querySelectorAll(':scope > ' + r.item)].filter(e => !isPlus(e));
      chips.forEach(c => { if (c.style.display === 'none') c.style.removeProperty('display'); });
      if (!plusSrc || chips.length < 2) continue;
      const W = ul.clientWidth, widths = chips.map(c => c.getBoundingClientRect().width);
      const rowsFor = ws => { let rows = 1, x = 0; for (const w of ws) { if (x && x + r.gap + w > W) { rows++; x = w; } else x = x ? x + r.gap + w : w; } return rows; };
      if (rowsFor(widths) <= r.rows) continue;
      const plus = d.importNode(plusSrc, true);
      plus.setAttribute('data-d1-plus', String(ri));
      plus.style.removeProperty('display'); if (!plus.getAttribute('style')) plus.removeAttribute('style');
      ul.insertBefore(plus, chips[chips.length - 1].nextSibling);
      const btn = plus.querySelector('button,[role=button]') || plus;
      const label = [...plus.querySelectorAll('*')].reverse().find(e => !e.children.length && /^\+\d+$/.test(norm(e.textContent))) || btn;
      if ((app.flags || {})['chips' + ri]) {
        if (btn.hasAttribute('aria-expanded')) btn.setAttribute('aria-expanded', 'true');
        if (lessLabel) btn.setAttribute('aria-label', lessLabel);
        label.textContent = r.plus.less || 'Show less';
        continue;
      }
      let k = chips.length - 1;
      for (; k > 0; k--) { label.textContent = '+' + (chips.length - k); if (rowsFor([...widths.slice(0, k), plus.getBoundingClientRect().width]) <= r.rows) break; }
      label.textContent = '+' + (chips.length - k);
      if (more) btn.setAttribute('aria-label', more.split('{n}').join(String(chips.length - k)));
      chips.slice(k).forEach(c => c.style.setProperty('display', 'none'));
    }
  }
  for (const r of L.stick || []) {
    const d = docFor(app, r.frame); if (!d) continue;
    for (const el of d.querySelectorAll(r.el)) {
      if (!el.__d1stick) { el.__d1stick = true; el.addEventListener('scroll', () => { el.__d1away = el.scrollHeight - el.clientHeight - el.scrollTop > 2; }, { passive: true }); }
      if (el.__d1stuck !== app.morphGen) { el.__d1stuck = app.morphGen; el.__d1away = false; }
      const max = el.scrollHeight - el.clientHeight;
      if (!el.__d1away && el.scrollTop < max) el.scrollTop = max;
    }
  }
  clkReapply(app);
  dragReapply(app);
  grpReapply(app);
  for (const r of L.pin || []) {
    const d = docFor(app, r.frame); if (!d) continue;
    const a = d.querySelector(r.anchor);
    if (!a) continue;
    const b = a.getBoundingClientRect();
    for (const el of d.querySelectorAll(r.el)) {
      el.style.left = b.left + 'px'; el.style.top = b.top + 'px'; el.style.width = b.width + 'px';
      // sync: the placeholder is as tall as the fixed box (it grows with a formatting bar, or a long prompt).
      if (r.sync) { const h = Math.round(el.getBoundingClientRect().height); if (h && Math.abs(parseFloat(a.style.minHeight || 0) - h) > 1) a.style.minHeight = h + 'px'; }
    }
  }
  for (const r of L.float || []) {
    const d = docFor(app, r.frame); if (!d) continue;
    const el = [...d.querySelectorAll(r.el)].find(e => !e.closest('[data-d1-hv]')), a = el && firstMatch(d, r.anchor);
    if (!a) continue;
    const ab = a.getBoundingClientRect(), w = el.getBoundingClientRect().width, vw = d.defaultView.innerWidth;
    let x = r.place === 'bottom-start' ? ab.left : ab.left + ab.width / 2 - w / 2;
    x = Math.max(0, Math.min(x, vw - w));
    el.style.transform = `translate3d(${x}px, ${ab.bottom + (r.gap || 0)}px, 0px)`;
    if (r.arrow) { const ar = el.querySelector(r.arrow); if (ar) ar.style.left = (ab.left + ab.width / 2 - x - r.arrowHalf) + 'px'; }
  }
}
const layoutQueued = new Set();
function queueLayout(app) {
  if (layoutQueued.has(app)) return;
  layoutQueued.add(app);
  requestAnimationFrame(() => { layoutQueued.delete(app); try { applyLayout(app); } catch (e) { note(e); } });
}
async function prepareLayout(app) {
  const L = layoutOf(app.id);
  if (!L) return;
  const snaps = new Set([S[app.state].snap]);
  const want = v => { const x = v && typeof v === 'object' ? (v[app.state] || v.default) : v; if (x) snaps.add(x); };
  for (const r of L.responsive || []) { if (r.bands) r.bands.forEach(b => want(b.variant)); else { snaps.add(r.variant.default); Object.values(r.variant).forEach(v => snaps.add(v)); } if (r.flagVariant) want(r.flagVariant); }
  for (const r of L.chips || []) snaps.add(r.plus.from);
  await Promise.all([...snaps].map(ensureParsed));
}

// ---- running transitions ---------------------------------------------------------------------------------------
async function run(app, t, ctx) {
  const my = gen;
  busy++;
  try {
    if (t.stream) await playStream(app, t, ctx, my);
    else if (t.query) {
      const q = norm(ctx.typed !== undefined ? ctx.typed : textOf(ctx.el)).toLowerCase();
      const key = Object.keys(t.query).filter(k => k && q.includes(k)).sort((a, b) => b.length - a.length)[0];
      const to = t.query[key !== undefined ? key : ''];
      if (to) await go(app, to, { scroll: 'target', keep: t.enter });
    } else if (t.flag) { app.flags = app.flags || {}; app.flags[t.flag] = !app.flags[t.flag]; hvClear(app); applyLayout(app); }
    else if (t.scope) await scoped(app, t, ctx);
    else if (t.to) await go(app, t.to, { scroll: t.scroll || 'target', keep: t.keep });
    if (t.app && gen === my) activate(t.app);
  } catch (e) { note(e); } finally { busy--; }
}

// The field she's typing in is taken out, the page morphs, and the field goes back where the capture has it.
function detachKeep(doc, specs) {
  const out = [];
  for (const m of [].concat(specs)) {
    const el = findEl(doc, m);
    if (!el) continue;
    const focused = el.ownerDocument.activeElement === el || el.contains(el.ownerDocument.activeElement);
    out.push({ el, m, focused, parent: el.parentNode, next: el.nextSibling });
  }
  for (const k of out) k.el.remove();
  return out;
}
function restoreKeep(doc, kept) {
  for (const k of kept) restoreOne(doc, k);
}
function restoreOne(doc, k) {
  const slot = findEl(doc, k.m);
  if (slot) slot.replaceWith(k.el);
  else if (k.parent && k.parent.isConnected) k.parent.insertBefore(k.el, k.next && k.next.parentNode === k.parent ? k.next : null);
  if (k.focused) {
    const el = k.el; el.focus({ preventScroll: true });
    const d = el.ownerDocument;
    if (el.localName === 'input' || el.localName === 'textarea') el.setSelectionRange(el.value.length, el.value.length);
    else { const r = d.createRange(); r.selectNodeContents(el); r.collapse(false); const s = d.getSelection(); s.removeAllRanges(); s.addRange(r); }
  }
}

function subst(app, html) {
  for (const [a, b] of app.subst || []) if (a !== b) html = html.split(a).join(b);
  return html;
}
async function targetDoc(app, stateId) { return parse(subst(app, await getText(snapUrl(S[stateId].snap)))); }

// Frame captures of a state, fetched and parsed up front, so the morph itself is one synchronous step.
async function frameTargets(snap) {
  const meta = await getJson(snapRelated(snap, '.json')).catch(() => ({ frames: [] }));
  const out = new Map();
  await Promise.all((meta.frames || []).map(async f => {
    const t = await getText(snapRelated(snap, `.${f.key}.html`)).catch(() => null);
    if (t) out.set(f.key, parse(t));
  }));
  return out;
}
function morphFrames(liveDoc, targetSnap, scroll, targets, later) {
  for (const f of liveDoc.querySelectorAll('iframe[data-d1-frame]')) {
    const key = f.getAttribute('data-d1-frame');
    const want = snapRelated(targetSnap, `.${key}.html`);
    if (f.__d1src === want) continue;
    let fd; try { fd = f.contentDocument; } catch (e) { continue; }
    if (!fd || !fd.body) { f.__d1src = want; later.push(() => loadFrame(f, want)); continue; }
    const t = targets.get(key);
    if (!t || !t.body || !t.body.childElementCount) continue;
    const before = scrolled(fd);
    morphDocument(fd, t);
    f.__d1src = want;
    morphFrames(fd, targetSnap, scroll, targets, later);
    post(fd, scroll, before);
  }
}

async function go(app, stateId, { scroll = 'target', keep } = {}) {
  if (!S[stateId]) throw new Error('no state ' + stateId);
  const [target, frames] = await Promise.all([targetDoc(app, stateId), frameTargets(S[stateId].snap)]);
  const doc = app.iframe.contentDocument;
  hvClear(app); clkClear(app);
  const before = scrolled(doc);
  // From here to restoreKeep is synchronous: a field she's typing in is out of the page only between two
  // keystrokes, and goes back after every frame has morphed, so no capture overwrites it.
  const kept = keep ? detachKeep(doc, keep) : [];
  morphDocument(doc, target);
  app.morphGen = (app.morphGen || 0) + 1;
  for (const f of doc.querySelectorAll('iframe')) if (!f.__d1src) { f.__d1src = f.getAttribute('src'); f.addEventListener('load', () => prepare(f.contentDocument, app)); }
  const later = [];
  morphFrames(doc, S[stateId].snap, scroll, frames, later);
  restoreKeep(doc, kept);
  const prev = app.state;
  app.state = stateId;
  parsedSnaps.set(S[stateId].snap, parsedSnaps.get(S[stateId].snap) || target);
  applyLayout(app);
  for (const fn of later) await fn();
  post(doc, scroll, before);
  for (const d of docsOf(doc)) hvCssAll(d, app);
  applyLayout(app);
  await afterFonts(app, docs => { for (const d of docs) post(d, scroll, []); applyLayout(app); });
  if (prev !== stateId) prepareLayout(app).catch(note);
  if (app.id === active) { syncChrome(); if (!kept.some(k => k.focused)) autofocus(app); }
  prefetch(app);
  hvRehover(app);
}
// Screens whose real app puts the cursor in a field when they open (Copilot's message box, the IQ picker search).
function autofocus(app) {
  const m = (S[app.state] || {}).focus;
  if (!m) return;
  const el = findEl(app.iframe.contentDocument, m);
  if (!el) return;
  const d = el.ownerDocument;
  if (d.defaultView.frameElement && d !== app.iframe.contentDocument) { try { d.defaultView.focus(); } catch (e) {} }
  el.focus({ preventScroll: true });
  if (el.localName === 'input' || el.localName === 'textarea') el.setSelectionRange(el.value.length, el.value.length);
  else { const r = d.createRange(); r.selectNodeContents(el); r.collapse(false); const sel = d.getSelection(); sel.removeAllRanges(); sel.addRange(r); }
}

// A switch or an expander changes only its own part of the page: that subtree is morphed to the same place in
// the capture that has it on (t.on) or off (t.off). A checkbox has already toggled itself; an expander says
// whether it's open in its aria-expanded or label.
function wantsOn(el) {
  if (el.type === 'checkbox') return el.checked;
  const x = el.getAttribute('aria-expanded');
  if (x !== null) return x !== 'true';
  return !/collapse/i.test(el.getAttribute('aria-label') || '');
}
async function scoped(app, t, ctx) {
  const scopeEl = t.scope.closest ? ctx.el.closest(t.scope.closest) : (() => { let e = ctx.el; for (let i = 0; i < (t.scope.up || 0); i++) e = e.parentElement; return e; })();
  // The source is a state (t.on / t.off), a variant capture (t.snap), or the screen's own capture (t.snap '@self').
  const which = t.snap ? null : wantsOn(ctx.el) ? t.on : t.off;
  const snap = t.snap ? (t.snap === '@self' ? S[app.state].snap : t.snap) : S[which].snap;
  if (!scopeEl) return which ? go(app, which, { scroll: 'keep' }) : undefined;
  const fk = frameKeyOf(ctx.doc);
  const target = fk ? parse(await getText(snapRelated(snap, `.${fk}.html`))) : parse(subst(app, await getText(snapUrl(snap))));
  const twin = atPath(target, pathOf(scopeEl));
  if (!twin || twin.localName !== scopeEl.localName) return which ? go(app, which, { scroll: 'keep' }) : undefined;
  hvClear(app); clkClear(app);
  morphNode(scopeEl, twin);
  app.morphGen = (app.morphGen || 0) + 1;
  applyLayout(app);
  post(ctx.doc, 'keep', []);
}

// Streamed frames are <body> only; the final capture's <head> (a superset of the CSS) goes in first.
async function playStream(app, t, ctx, my) {
  const s = flow.streams[t.stream];
  const index = await getJson(local(`/streams/${t.stream}.json`));
  const data = { frames: await Promise.all(index.frames.map(async f => ({ t: f.t, html: await getText(local(`/streams/${t.stream}/${f.file}`)) }))) };
  const doc = app.iframe.contentDocument;
  if (s.prompt && ctx.typed !== undefined) {
    app.subst = (app.subst || []).filter(([a]) => a !== esc(s.prompt));
    app.subst.push([esc(s.prompt), esc(ctx.typed)]);
  }
  const fin = await targetDoc(app, s.to);
  hvClear(app); clkClear(app);
  morphChildren(doc.head, fin.head);
  hvCssAll(doc, app);
  // Lists for step groups opened while it plays are the ones for the screen it ends on.
  app.playing = s.to;
  try {
    const frames = data.frames;
    const dur = paced(t.ms || s.ms || 5000);
    const cut = s.answerAt === undefined ? undefined : index.frames.findIndex(f => f.raw >= s.answerAt);
    const at = frameTimes(index.frames, dur, { ...s, answerFrom: cut === -1 ? undefined : cut });
    const t0 = performance.now();
    for (let i = 0; i < frames.length; i++) {
      const body = parse('<!DOCTYPE html><html><head></head>' + subst(app, frames[i].html) + '</html>').body;
      const wait = t0 + at[i] - performance.now();
      if (wait > 0) await sleep(wait);
      if (gen !== my) return;
      const before = scrolled(doc);
      hvClear(app); clkClear(app);
      morphNode(doc.body, body);
      app.morphGen = (app.morphGen || 0) + 1;
      applyLayout(app);
      post(doc, 'target', before);
    }
    const wait = t0 + dur - performance.now();
    if (wait > 0) await sleep(wait);
    if (gen !== my) return;
  } finally { app.playing = null; }
  await go(app, s.to, { scroll: 'target' });
}
// Frames [0, answerFrom) are the steps and share s.split of the time; the answer's frames share the rest.
// timing 'real': each frame at its real time, scaled to fit (the recorder writes this).
function frameTimes(frames, dur, s) {
  const n = frames.length, end = dur * 0.92;
  if (s.timing === 'real' && n) { const t0 = frames[0].t || 0, span = Math.max(1, (frames[n - 1].t || 0) - t0); return frames.map(f => end * ((f.t || 0) - t0) / span); }
  const cut = s.answerFrom !== undefined ? Math.min(s.answerFrom, n) : n;
  const stepsEnd = cut < n ? dur * (s.split || 0.6) : end;
  return frames.map((f, i) => i < cut ? stepsEnd * i / cut : stepsEnd + (end - stepsEnd) * (i - cut + 1) / (n - cut));
}

// ---- prefetch ----------------------------------------------------------------------------------------------------
function prefetch(app) {
  for (const t of [...transitions(app, 'click'), ...transitions(app, 'enter'), ...transitions(app, 'type'), ...transitions(app, 'hover')]) {
    const ids = t.stream ? [flow.streams[t.stream].to] : t.query ? Object.values(t.query) : t.to ? [t.to] : [];
    for (const id of ids) if (S[id]) getText(snapUrl(S[id].snap)).catch(note);
    if (t.stream) getJson(local(`/streams/${t.stream}.json`)).then(ix => ix.frames.forEach(f => getText(local(`/streams/${t.stream}/${f.file}`)).catch(note))).catch(note);
  }
}

// ---- apps, beats, presenter keys ------------------------------------------------------------------------------
function syncChrome() {
  const app = apps[active];
  let d; try { d = app.iframe.contentDocument; } catch (e) { return; }
  if (!d) return;
  const title = (S[app.state] && S[app.state].title) || d.title;
  if (title && document.title !== title) document.title = title;
  const icon = d.querySelector('link[rel~="icon"]');
  const href = icon ? icon.href : (flow.apps.find(a => a.id === active) || {}).icon;
  if (href && fav.href !== href) fav.href = href;
}
function activate(id) {
  if (!apps[id]) return;
  if (id !== active) for (const h of hooks.activate) h(id, active);
  active = id;
  for (const a of Object.values(apps)) a.iframe.classList.toggle('on', a.id === id);
  try { apps[id].iframe.contentWindow.focus(); } catch (e) {}
  autofocus(apps[id]);
  syncChrome();
}
function switchApp(d) { activate(order[(order.indexOf(active) + d + order.length) % order.length]); }

async function loadApp(app, stateId) {
  hvClear(app); clkClear(app);
  // A fresh start (⌥0, a beat jump): panes, sections, flags and sizes as captured.
  clkState(app).sticky.clear(); grpState(app).open.clear(); app.flags = {}; app.sizes = {}; app.playing = null;
  app.state = stateId; app.hover = null; app.subst = []; app.morphGen = (app.morphGen || 0) + 1;
  const snap = S[stateId].snap;
  app.customElements = ((await getJson(snapRelated(snap, '.json')).catch(() => ({}))).customElements) || [];
  await Promise.all([loadFrame(app.iframe, snapUrl(snap)), prepareLayout(app), loadHovers(app)]);
  prepare(app.iframe.contentDocument, app);
  applyLayout(app);
  await afterFonts(app, docs => { for (const d of docs) post(d, 'target', []); applyLayout(app); });
  prefetch(app);
}

async function jump(n) {
  const b = flow.beats[n];
  if (!b) return;
  const my = ++gen;
  for (const h of hooks.jump) h(n);
  busy++;
  try {
    clearTimeout(hoverTimer);
    await Promise.all(order.map(id => loadApp(apps[id], b.states[id])));
    if (gen === my) activate(b.active);
  } catch (e) { note(e); } finally { busy--; }
}

// ⌥P types the scripted text (fill[].value) into the field she's in, or the screen's first field, at a steady pace.
async function fill(app) {
  if (busy) return;
  const st = S[app.state] || {};
  const doc = app.iframe.contentDocument;
  const fills = st.fill || [];
  let f = null, el = null;
  for (const c of fills) { const e = findEl(doc, c); if (e && (e === e.ownerDocument.activeElement || e.contains(e.ownerDocument.activeElement))) { f = c; el = e; break; } }
  if (!f) for (const c of fills) { const e = findEl(doc, c); if (e) { f = c; el = e; break; } }
  if (!f || app.filling) return;
  app.filling = true;
  const my = gen;
  try {
    const d = el.ownerDocument;
    el.focus();
    const isInput = el.localName === 'input' || el.localName === 'textarea';
    if (isInput) el.value = '';
    else { const r = d.createRange(); r.selectNodeContents(el); const s = d.getSelection(); s.removeAllRanges(); s.addRange(r); d.execCommand('delete'); }
    for (const ch of f.value) {
      if (gen !== my) return;
      while (busy) await sleep(10);
      if (isInput) { el.value += ch; el.dispatchEvent(new d.defaultView.InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch })); }
      else { if (d.activeElement !== el && !el.contains(d.activeElement)) { el.focus(); const r = d.createRange(); r.selectNodeContents(el); r.collapse(false); const s = d.getSelection(); s.removeAllRanges(); s.addRange(r); } d.execCommand('insertText', false, ch); }
      await sleep(T(f.ms || (ch === ' ' ? 34 : /[.,?]/.test(ch) ? 120 : 24)));
    }
    while (busy) await sleep(10);
  } catch (e) { note(e); } finally { app.filling = false; }
}

// ⌥N does the screen's next scripted step (a click, a fill + Enter, or a switch to the next app).
async function next(app) {
  if (busy) return;
  const st = S[app.state] || {};
  const n = st.next;
  if (!n) return;
  const doc = app.iframe.contentDocument;
  if (n.app) return activate(n.app);
  if (n.click) { const el = findEl(doc, n.click); if (el) el.click(); return; }
  if (n.enter) { const el = findEl(doc, n.enter); if (!el) return; if (!textOf(el)) await fill(app); el.dispatchEvent(new el.ownerDocument.defaultView.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })); }
}

for (const a of flow.apps) {
  const f = document.createElement('iframe');
  f.setAttribute('data-app', a.id);
  f.setAttribute('allow', 'clipboard-read; clipboard-write');
  stage.appendChild(f);
  apps[a.id] = { id: a.id, iframe: f, state: null };
}
// Each module's default export gets this API: on('key' | 'activate' | 'jump', fn) (a key hook returns true to take
// the key), expose(name, value) (on window.d1, for the checks), and the stage, apps and step groups.
const exposed = {};
const grpButton = (app, label) => { const sel = grpBtnSel(app); if (!sel) return null; for (const d of docsOf(app.iframe.contentDocument)) for (const b of d.querySelectorAll(sel)) if (grpKey(app, b) === label) return b; return null; };
const moduleApi = {
  flow, stage, apps, docsOf, speed: SPEED,
  current: () => { const a = apps[active]; return a && { id: a.id, app: a, state: a.hover ? a.hover.base : a.state, doc: a.iframe.contentDocument }; },
  groupButton: grpButton,
  openGroup: (app, label) => { const b = grpButton(app, label); return !!b && b.getAttribute('aria-expanded') === 'false' && grpToggle(app, b); },
  on: (kind, fn) => hooks[kind].push(fn),
  expose: (name, value) => { exposed[name] = value; },
};
for (const m of flow.modules || []) { try { (await import(m.startsWith('/') ? local(m) : m)).default(moduleApi); } catch (e) { note(e); } }
// Fonts first. Chrome draws a fallback font while a web font is still loading whenever it judges the network slow
// ("Slow network is detected"; it can on localhost, on a cold start or a second run in the same browser), and a page
// then lays out, scrolls and swaps in front of her. A font that's already in memory is drawn at once, so every font
// the replica has is loaded before the first screen (7.5 MB from localhost for Demo 1, a fraction of a second).
const fontsKept = [];
try { const list = await (await fetch(local('/__replica/fonts'), { cache: 'no-store' })).json(); await Promise.all(list.map(u => { const f = new FontFace('d1-font', `url("${local(u)}")`, { display: 'block' }); fontsKept.push(f); return f.load().catch(() => {}); })); } catch (e) {}
document.addEventListener('keydown', e => onKey(e, apps[active], document), true);
await jump(0);

// For the run-through and determinism checks only; nothing on screen.
window.d1 = {
  get state() { return { active, busy, states: Object.fromEntries(order.map(id => [id, apps[id].state])) }; },
  get filling() { return Object.values(apps).some(a => a.filling); },
  errors,
  jump, activate, next: () => next(apps[active]), fill: () => fill(apps[active]),
  go: async (id, st) => { const my = ++gen; busy++; try { await loadApp(apps[id], st); if (gen === my) activate(id); } finally { busy--; } },
  // Morphs to a state the way a transition does (panes, sections and sizes she set stay), unlike go.
  morph: async (id, st) => { busy++; try { await go(apps[id], st, { scroll: 'target' }); } finally { busy--; } },
  doc: id => apps[id || active].iframe.contentDocument,
  reveal(m, id) { const el = findEl(apps[id || active].iframe.contentDocument, m); if (el) el.scrollIntoView({ block: 'center', inline: 'nearest' }); return !!el; },
  locate(m, id) {
    const app = apps[id || active]; const el = findEl(app.iframe.contentDocument, m);
    if (!el) return null;
    let r = el.getBoundingClientRect(); let x = r.x, y = r.y;
    let w = el.ownerDocument.defaultView;
    while (w.frameElement) { const fr = w.frameElement.getBoundingClientRect(); x += fr.x; y += fr.y; w = w.parent; }
    return { x: x + r.width / 2, y: y + r.height / 2, w: r.width, h: r.height };
  },
  // Whether the field a matcher finds has the cursor (for the checks).
  focused(m, id) { const el = findEl(apps[id || active].iframe.contentDocument, m); if (!el) return false; const a = el.ownerDocument.activeElement; return !!a && (a === el || el.contains(a)); },
  // Settled: nothing playing and no hover waiting to show or hide.
  idle: async () => { while (busy || fontWaits.size || Object.values(apps).some(a => (a.hv && (a.hv.timers.size || a.hv.sweepPending)) || (a.grp && a.grp.timers.size))) await sleep(50); },
  // Which captured hovers apply at a point, and whether their in-place changes fit (for tests/hover-check.mjs).
  hoverAt(x, y, id) {
    const app = apps[id || active];
    let d = app.iframe.contentDocument, px = x, py = y, t = d.elementFromPoint(px, py);
    while (t && t.localName === 'iframe') { const r = t.getBoundingClientRect(); px -= r.x; py -= r.y; d = t.contentDocument; t = d.elementFromPoint(px, py); }
    const trail = (el, op) => { let e = el; const tr = []; for (const i of op.path) { const k = ekids(e); tr.push(i + '/' + k.length + ':' + (k[i] ? k[i].localName : '-')); e = k[i]; if (!e) break; } return tr.join(' ') + ' => ' + (e ? e.localName + ' kids:' + ekids(e).map(c => c.localName).join(',').slice(0, 80) : 'none') + ' want ' + op.kind + ' ' + (op.tag || op.restTag || '') + ' @' + op.index; };
    return { target: t && (t.localName + (t.getAttribute('data-testid') ? '[' + t.getAttribute('data-testid') + ']' : '') + ' ' + norm(t.innerText).slice(0, 40)), defs: hvDefsAt(app, d, t).map(h => { const fits = hvFits(h.el, h.d); return { id: h.d.id, fits, why: fits ? undefined : (h.d.ops || []).map(op => trail(h.el, op)) }; }) };
  },
  hoverFit(defId, id) {
    const app = apps[id || active]; const d = hoverData[app.id].defs.find(x => x.id === defId); const out = [];
    const docs = docsOf(app.iframe.contentDocument).filter(x => (frameKeyOf(x) || null) === (d.frame || null));
    for (const doc of docs) for (const a of d.anchors) { let el = [...doc.querySelectorAll(a.sel)].find(e => matches(e, a)); if (el && d.scope) el = walk(el, d.scope); if (!el) continue;
      for (const op of d.ops || []) { let e = el; const trail = []; for (const i of op.path) { const k = ekids(e); trail.push(i + '/' + k.length + ':' + (k[i] ? k[i].localName : '-')); e = k[i]; if (!e) break; }
        out.push({ op: op.kind, tag: op.tag || op.restTag, trail: trail.join(' '), got: e && e.localName, idx: op.index, kids: e && ekids(e).map(c => c.localName).join(',').slice(0, 120) }); } }
    return out;
  },
  // Why a recorded click does nothing on this screen: whether its control is found and its changes fit.
  clickFit(name, id) {
    const app = apps[id || active]; const out = [];
    for (const d of clickDefs(app).filter(x => x.name === name)) {
      const el = findEl(app.iframe.contentDocument, { ...d.ctl, frame: d.frame || null });
      const a = el && d.ops ? clkAnchor(el, d) : null; const anc = a ? a.anc : el && upFrom(el, d.up);
      const why = []; if (anc) for (const op of d.ops || []) { let e = anc; const tr = []; for (const i of op.path) { const k = ekids(e); tr.push(i + '/' + k.length + ':' + (k[i] ? k[i].localName : '-')); e = k[i]; if (!e) break; } const ok = e && (op.kind !== 'remove' || (ekids(e)[op.index] || {}).localName === op.restTag) && (op.kind !== 'attr' || e.localName === op.tag); if (!ok) why.push(op.kind + ' ' + (op.tag || op.restTag) + '@' + op.index + ' ' + tr.join(' ') + ' kids:' + (e ? ekids(e).map(c => c.localName).join(',') : '')); }
      out.push({ id: d.id, found: !!el, up: d.up, anc: anc && anc.localName, fits: d.ops ? !!a : null, why: a ? [] : why.slice(0, 4), ctl: d.ctl });
    }
    return out;
  },
  // Where an open click's control is now; what's open; flags and drag sizes (for the checks).
  openAt(name, id) {
    const rec = clkState(apps[id || active]).open.find(r => r.d.name === name);
    const el = rec && (rec.toggleEl && rec.toggleEl.isConnected ? rec.toggleEl : null);
    if (!el) return null;
    const r = el.getBoundingClientRect(); let x = r.x, y = r.y; let w = el.ownerDocument.defaultView;
    while (w.frameElement) { const fr = w.frameElement.getBoundingClientRect(); x += fr.x; y += fr.y; w = w.parent; }
    return { x: x + r.width / 2, y: y + r.height / 2 };
  },
  clicks: id => clkState(apps[id || active]).open.map(r => ({ id: r.d.id, name: r.d.name, sticky: !!r.d.sticky })),
  // What a click at a point would do: a transition, a recorded click, or nothing (with the hover off, as a click is).
  clickAt(x, y, id) {
    const app = apps[id || active]; let d = app.iframe.contentDocument, px = x, py = y, t = d.elementFromPoint(px, py);
    while (t && t.localName === 'iframe') { const r = t.getBoundingClientRect(); px -= r.x; py -= r.y; d = t.contentDocument; t = d.elementFromPoint(px, py); }
    const hit = findTransition(app, 'click', t, d); if (!hit) hvClear(app); const c = hit ? null : clkFind(app, d, t); if (!hit) hvRehover(app);
    return { target: t && t.localName, busy, transition: hit && JSON.stringify(hit.t).slice(0, 120), click: c && c.d.id, defs: clickDefs(app).length };
  },
  // Step groups: which are open, and every group button on the screen with its state (for the checks).
  groups: id => { const st = grpState(apps[id || active]); return { open: [...st.open], live: st.live.map(r => r.key) }; },
  groupButtons(id) {
    const app = apps[id || active], sel = grpBtnSel(app);
    if (!sel) return [];
    return [...app.iframe.contentDocument.querySelectorAll(sel)].map(b => {
      const r = b.getBoundingClientRect(), rg = grpRegion(b), rr = rg && rg.getBoundingClientRect();
      return { key: grpKey(app, b), id: b.getAttribute('aria-controls'), expanded: b.getAttribute('aria-expanded') === 'true', canOpen: grpCanOpen(app, b), x: r.x + Math.min(40, r.width / 2), y: r.y + r.height / 2, w: r.width, h: r.height, height: rr ? Math.round(rr.height) : 0, text: rg ? norm(rg.innerText) : '', visible: !!rg && getComputedStyle(rg).visibility !== 'hidden' };
    });
  },
  flags: id => ({ ...(apps[id || active].flags || {}) }),
  sizes: id => ({ ...(apps[id || active].sizes || {}) }),
  hovers: id => [...hvState(apps[id || active]).on].map(h => ({ id: h.d.id, text: h.portals.map(p => norm(p.node.innerText)).join(' / '), ops: (h.d.ops || []).length })),
};
Object.assign(window.d1, exposed);
