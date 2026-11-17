// What a focus point points at, worked out from the page: shared by the script matcher (its screen index, in the
// replica page) and the editor's dots (a click snapped to the element it means). Nothing here draws or zooms; the
// focus engine (focus.js) does that from the point this writes. Runs in the replica's own document, over the app's
// documents (frames included).
//   items(doc)               every element a line or a dot can point at: text blocks, controls, lists and regions
//   snap(doc, x, y)          the element a click at (x, y) means, and the sentence under it in a long text
//   describe(el, opts)       a focus point's target (opts.root: the app's document) for it ({ find } or { union }), verified with locate, and its mark
//   markFor(role, box, W, H) a box, or an arrow (with the side its tail comes from) for a small control

export const norm = s => String(s || '').replace(/[\u2019\u2018]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2011\u2010]/g, '-').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
const CONTROL_ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'checkbox', 'radio', 'switch', 'option', 'textbox', 'searchbox', 'combobox', 'slider']);
const ITEM_ROLES = new Set(['listitem', 'gridcell', 'cell', 'row', 'article', 'treeitem']);
const REGION_ROLES = new Set(['list', 'grid', 'table', 'dialog', 'region', 'complementary', 'navigation', 'form', 'group', 'tablist', 'menu', 'toolbar', 'img']);
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'title', 'meta', 'link', 'br', 'wbr']);
export const CONTROLS = 'button,a[href],input,textarea,select,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch],[role=option],[role=textbox],[role=searchbox],[role=combobox],[contenteditable=""],[contenteditable="true"]';

export function roleOf(el) {
  const r = (el.getAttribute('role') || '').trim().split(/\s+/)[0];
  if (r && r !== 'presentation' && r !== 'none') return r;
  const t = el.localName;
  if (t === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
  if (t === 'button' || t === 'summary') return 'button';
  if (t === 'input') { const ty = (el.getAttribute('type') || 'text').toLowerCase(); return ty === 'search' ? 'searchbox' : ty === 'checkbox' ? 'checkbox' : ty === 'radio' ? 'radio' : ty === 'range' ? 'slider' : /^(button|submit|reset|image)$/.test(ty) ? 'button' : 'textbox'; }
  if (t === 'textarea') return 'textbox';
  if (t === 'select') return 'combobox';
  if (/^h[1-6]$/.test(t)) return 'heading';
  if (t === 'li') return 'listitem';
  if (t === 'ul' || t === 'ol') return 'list';
  if (t === 'nav') return 'navigation';
  if (t === 'aside') return 'complementary';
  if (t === 'main') return 'main';
  if (t === 'header') return 'banner';
  if (t === 'dialog') return 'dialog';
  if (t === 'img') return 'img';
  if (t === 'table') return 'table';
  if (t === 'td') return 'cell';
  if (t === 'th') return 'columnheader';
  if (t === 'tr') return 'row';
  if (t === 'p') return 'paragraph';
  if (t === 'article') return 'article';
  if (t === 'section' && el.hasAttribute('aria-label')) return 'region';
  if (el.isContentEditable && el.getAttribute('contenteditable') !== null) return 'textbox';
  return 'generic';
}
export const isControl = role => CONTROL_ROLES.has(role);

// Every document of an app (frames too) with its offset in the replica's window.
export function docsOf(doc, out = []) {
  if (!doc || !doc.body) return out;
  out.push(doc);
  for (const f of doc.querySelectorAll('iframe')) { try { if (f.contentDocument && f.contentDocument.body) docsOf(f.contentDocument, out); } catch (e) {} }
  return out;
}
export function offsetOf(d) {
  let x = 0, y = 0, w = d.defaultView;
  while (w && w !== w.top && w.frameElement) { const r = w.frameElement.getBoundingClientRect(); x += r.x; y += r.y; w = w.parent; }
  return [x, y];
}
export function boxOf(el) {
  const [ox, oy] = offsetOf(el.ownerDocument), r = el.getBoundingClientRect();
  return [ox + r.left, oy + r.top, ox + r.right, oy + r.bottom].map(v => Math.round(v * 100) / 100);
}
const visible = el => { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2 && (!el.checkVisibility || el.checkVisibility({ visibilityProperty: true, opacityProperty: true })); };
const ownText = el => { let s = ''; for (const n of el.childNodes) if (n.nodeType === 3) s += n.data + ' '; return norm(s); };
const labelOf = el => norm(el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => { const x = id && el.ownerDocument.getElementById(id); return x ? x.textContent : ''; }).join(' ') || '');
export function nameOf(el) {
  const l = labelOf(el); if (l) return l;
  if (el.localName === 'input' || el.localName === 'textarea') return norm(el.getAttribute('placeholder') || el.getAttribute('title') || el.value || '');
  if (el.localName === 'img') return norm(el.getAttribute('alt') || '');
  return norm(el.innerText || el.textContent || '');
}
const frameOf = d => { const fe = d.defaultView && d.defaultView.frameElement; return fe ? fe.getAttribute('data-d1-frame') : null; };

// The screen's index: what a script line can be backed by. Deterministic (document order), so a second pass on the
// same screen gives the same numbers.
export function items(rootDoc) {
  const out = [], els = [];
  for (const d of docsOf(rootDoc)) {
    if (!d.body) continue;
    const [ox, oy] = offsetOf(d), frame = frameOf(d);
    for (const el of d.body.querySelectorAll('*')) {
      if (SKIP.has(el.localName) || el.closest('svg') && el.localName !== 'svg') continue;
      const role = roleOf(el), control = isControl(role);
      const own = control ? '' : ownText(el);
      const label = labelOf(el);
      const kind = control ? 'control' : own ? (ITEM_ROLES.has(role) ? 'item' : 'text') : REGION_ROLES.has(role) && (label || role === 'list' || role === 'grid' || role === 'dialog' || role === 'img') ? 'region' : null;
      if (!kind) continue;
      if (!control && el.parentElement && el.parentElement.closest(CONTROLS)) continue;
      if (el.closest('[aria-hidden="true"]') || el.closest('[inert]')) continue;
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      const text = kind === 'control' ? nameOf(el) : kind === 'region' ? norm((label ? label + ' ' : '') + (el.innerText || '')).slice(0, 600) : norm(el.innerText || el.textContent);
      if (!text) continue;
      out.push({ i: out.length, kind, role, tag: el.localName, text: text.slice(0, 2000), label, frame, box: [ox + r.left, oy + r.top, ox + r.right, oy + r.bottom].map(v => Math.round(v)) });
      els.push(el);
    }
  }
  return { items: out, els };
}

// A click at (x, y) in the replica's window: the element it means. Controls win; then the text block under it (a
// paragraph, a list item, a cell, a heading), with the sentence under the pointer when its text is long; then the
// smallest named region or list around it.
export function snap(rootDoc, x, y) {
  let d = rootDoc, px = x, py = y, t = d.elementFromPoint(px, py);
  while (t && t.localName === 'iframe') { const r = t.getBoundingClientRect(); px -= r.x; py -= r.y; try { d = t.contentDocument; } catch (e) { break; } if (!d) break; t = d.elementFromPoint(px, py); }
  if (!t) return null;
  const control = t.closest(CONTROLS);
  if (control && visible(control)) return { el: control, role: roleOf(control) };
  let el = t;
  // Up from inline text to its block.
  while (el && el !== d.body && !ownText(el) && el.parentElement && !REGION_ROLES.has(roleOf(el))) el = el.parentElement;
  if (el && el !== d.body && ownText(el)) {
    const view = d.defaultView;
    while (el.parentElement && el.parentElement !== d.body && /^inline/.test(view.getComputedStyle(el).display) && !ITEM_ROLES.has(roleOf(el))) el = el.parentElement;
    const text = norm(el.innerText);
    let phrase = null;
    if (text.length > 160 && d.caretRangeFromPoint) {
      const c = d.caretRangeFromPoint(px, py);
      if (c && c.startContainer.nodeType === 3 && el.contains(c.startContainer)) {
        // The sentence around the caret, found in the block's text by the words just before and after it.
        const all = norm(el.innerText);
        const node = c.startContainer, before = norm(node.data.slice(0, c.startOffset)).split(' ').slice(-3).join(' '), after = norm(node.data.slice(c.startOffset)).split(' ').slice(0, 2).join(' ');
        let at = all.indexOf(norm(before + (before && after && /\s$/.test(node.data.slice(0, c.startOffset)) ? ' ' : '') + after));
        if (at < 0) at = all.indexOf(after);
        if (at >= 0) phrase = sentenceAt(all, at + before.length);
      }
    }
    return { el, role: roleOf(el), phrase };
  }
  el = t;
  while (el && el !== d.body) { const role = roleOf(el); if (REGION_ROLES.has(role) || ITEM_ROLES.has(role) || el.getAttribute('aria-label') || el.getAttribute('data-testid')) return { el, role }; el = el.parentElement; }
  return { el: t, role: roleOf(t) };
}
export function sentences(text) {
  const out = [], re = /(?:[^.!?]|[.!?](?!\s|$))+(?:[.!?]+|$)/g;
  let m; while ((m = re.exec(text))) { const s = norm(m[0]); if (s) out.push(s); if (m.index === re.lastIndex) re.lastIndex++; }
  return out;
}
function sentenceAt(text, at) {
  let n = 0;
  for (const s of sentences(text)) { const i = text.indexOf(s, n); if (i >= 0 && at <= i + s.length) return s; if (i >= 0) n = i + s.length; }
  return null;
}

const cssStr = s => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
const ITEM_UP = el => { const r = el.getAttribute('role'); return r ? `[role=${r}]` : el.localName; };
// A CSS selector for an element that names it the way the recorder does (test ids, labels, roles; never a generated
// class), made longer with its landmarks until it's the first visible match in the app.
function selectorFor(el, docs) {
  const tag = el.localName, base = [];
  for (const a of ['data-testid', 'data-tid', 'aria-label', 'placeholder', 'name']) { const v = el.getAttribute(a); if (v && v.length < 120) base.push(`${tag}[${a}=${cssStr(v)}]`); }
  const role = el.getAttribute('role'); if (role) base.push(`${tag}[role=${role}]`);
  if (el.id && /^[A-Za-z][\w-]*$/.test(el.id) && !/\d{3,}/.test(el.id)) base.push(`${tag}#${el.id}`);
  if (!base.length) base.push(tag);
  const firstVisible = sel => { for (const d of docs) { let list; try { list = d.querySelectorAll(sel); } catch (e) { return null; } const e = [...list].find(visible); if (e) return e; } return null; };
  const landmarks = [];
  for (let a = el.parentElement; a && a !== el.ownerDocument.body; a = a.parentElement) {
    const r = roleOf(a), l = a.getAttribute('aria-label');
    if (/^(nav|aside|main|header|footer|dialog|section|form)$/.test(a.localName) || REGION_ROLES.has(r) && r !== 'img') landmarks.push(l ? `${a.localName}[aria-label=${cssStr(l)}]` : a.getAttribute('role') ? `${a.localName}[role=${a.getAttribute('role')}]` : a.localName);
  }
  for (const b of base) {
    if (firstVisible(b) === el) return b;
    for (let k = 1; k <= Math.min(3, landmarks.length); k++) { const s = landmarks.slice(0, k).reverse().join(' ') + ' ' + b; if (firstVisible(s) === el) return s; }
  }
  return null;
}

// The mark for a target: an arrow for a small control (its tail toward the open middle of the screen), else a box.
export function markFor(role, box, W, H) {
  const w = box[2] - box[0], h = box[3] - box[1];
  if (!(isControl(role) && w * h <= W * H * 0.02 && w <= W * 0.3)) return { mark: 'rect' };
  const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
  return { mark: 'arrow', dir: (cy < H / 2 ? 's' : 'n') + (cx < W / 2 ? 'e' : 'w') };
}

// A focus point's target for an element (and, for long text, the phrase in it): the first of these that the focus
// engine's own locate (opts.locate) finds on this element. Returns { target, mark, dir, box, text } or null.
export function describe(el, { root, phrase = null, locate, W = innerWidth, H = innerHeight } = {}) {
  const docs = docsOf(root || el.ownerDocument);
  const role = roleOf(el), box = boxOf(el), text = isControl(role) ? nameOf(el) : norm(el.innerText || el.textContent || '');
  const tries = [];
  if (phrase) tries.push({ find: phrase });
  if (isControl(role)) {
    const s = selectorFor(el, docs); if (s) tries.push({ union: [{ sel: s }] });
    const shown = norm(el.innerText || ''); if (shown && shown.length <= 80) tries.push({ union: [{ text: shown, up: ITEM_UP(el) }] });
  } else if (ITEM_ROLES.has(role)) {
    const first = norm((el.innerText || '').split('\n').find(l => norm(l)) || text).slice(0, 120);
    if (first) tries.push({ union: [{ text: first, up: ITEM_UP(el) }] });
    const s = selectorFor(el, docs); if (s) tries.push({ union: [{ sel: s }] });
  } else if (REGION_ROLES.has(role) && !ownText(el)) {
    const s = selectorFor(el, docs); if (s) tries.push({ union: [{ sel: s }] });
  } else {
    if (text && text.length <= 200) tries.push({ find: text });
    const s = selectorFor(el, docs); if (s) tries.push({ union: [{ sel: s }] });
  }
  for (const target of tries) {
    const got = locate ? locate(target) : null;
    if (!got) continue;
    // The engine's box has to be this element's (or the phrase's, inside it).
    const b = got.box || got, inside = b[0] >= box[0] - 4 && b[1] >= box[1] - 4 && b[2] <= box[2] + 4 && b[3] <= box[3] + 4;
    const same = Math.abs(b[0] - box[0]) < 6 && Math.abs(b[1] - box[1]) < 6 && Math.abs(b[2] - box[2]) < 6 && Math.abs(b[3] - box[3]) < 6;
    if (target.find ? inside : same) return { target, ...markFor(role, b, W, H), role, box: b, text: target.find || text.slice(0, 160) };
  }
  return null;
}
