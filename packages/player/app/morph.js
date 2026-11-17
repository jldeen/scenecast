// Morphs a live document (or subtree) into a captured one, keeping every node that's already the same.
// That is how the replica moves between real captured states: no reload, no flash, scroll and hover kept, the way a
// single-page app re-renders. Nodes marked data-d1-keep (an editor she's typing in) are left alone.

const inserted = new WeakSet();
export const wasInserted = n => inserted.has(n);

function syncAttrs(from, to) {
  const fa = from.attributes, ta = to.attributes;
  for (let i = fa.length - 1; i >= 0; i--) {
    const n = fa[i].name;
    if (!to.hasAttribute(n) && !(from.localName === 'iframe' && n === 'src')) from.removeAttribute(n);
  }
  for (let i = 0; i < ta.length; i++) {
    const { name, value } = ta[i];
    if (from.localName === 'iframe' && name === 'src') continue;
    if (from.getAttribute(name) !== value) {
      try { from.setAttribute(name, value); } catch (e) { /* attribute names the HTML parser accepts but setAttribute doesn't */ }
    }
  }
}

function same(a, b) {
  if (a.nodeType !== b.nodeType) return false;
  if (a.nodeType !== 1) return true;
  if (a.localName !== b.localName || a.namespaceURI !== b.namespaceURI) return false;
  const ia = a.getAttribute('id'), ib = b.getAttribute('id');
  if (ia && ib && ia !== ib) return false;
  if (a.localName === 'iframe') return a.getAttribute('data-d1-frame') === b.getAttribute('data-d1-frame');
  return true;
}

function importInto(doc, node) {
  const n = doc.importNode(node, true);
  inserted.add(n);
  if (n.nodeType === 1) for (const d of n.querySelectorAll('*')) inserted.add(d);
  return n;
}

export function morphNode(from, to) {
  if (from.nodeType === 3 || from.nodeType === 8) { if (from.data !== to.data) from.data = to.data; return; }
  if (from.nodeType !== 1) return;
  if (from.hasAttribute && from.hasAttribute('data-d1-keep')) return;
  syncAttrs(from, to);
  const tag = from.localName;
  if (tag === 'style' || tag === 'textarea' || tag === 'title') {
    if (from.textContent !== to.textContent) from.textContent = to.textContent;
    if (tag === 'textarea') from.value = to.textContent;
    return;
  }
  if (tag === 'input') {
    const t = (from.type || '').toLowerCase();
    if (t === 'checkbox' || t === 'radio') from.checked = to.hasAttribute('checked');
    else if (from.value !== (to.getAttribute('value') || '')) from.value = to.getAttribute('value') || '';
    return;
  }
  if (tag === 'option') { from.selected = to.hasAttribute('selected'); }
  if (from.shadowRoot && to.shadowRoot) morphChildren(from.shadowRoot, to.shadowRoot);
  morphChildren(from, to);
}

export function morphChildren(fromParent, toParent) {
  const doc = fromParent.ownerDocument || fromParent;
  let f = fromParent.firstChild, t = toParent.firstChild;
  while (t) {
    if (f && same(f, t)) { morphNode(f, t); f = f.nextSibling; t = t.nextSibling; continue; }
    // Look ahead a little for a match, so an insertion or removal doesn't rewrite every later sibling.
    let ahead = f ? f.nextSibling : null, k = 0, found = null;
    while (ahead && k < 6) { if (same(ahead, t) && ahead.nodeType === 1 && (ahead.id || ahead.className)) { found = ahead; break; } ahead = ahead.nextSibling; k++; }
    if (found) { while (f !== found) { const nx = f.nextSibling; f.remove(); f = nx; } continue; }
    let tAhead = t.nextSibling, j = 0, laterMatch = false;
    while (f && tAhead && j < 6) { if (same(f, tAhead) && f.nodeType === 1 && (f.id || f.className)) { laterMatch = true; break; } tAhead = tAhead.nextSibling; j++; }
    if (laterMatch || !f) { fromParent.insertBefore(importInto(doc, t), f); t = t.nextSibling; continue; }
    const n = importInto(doc, t);
    fromParent.replaceChild(n, f);
    f = n.nextSibling; t = t.nextSibling;
  }
  while (f) { const nx = f.nextSibling; f.remove(); f = nx; }
}

export function morphDocument(live, target, { headToo = true } = {}) {
  syncAttrs(live.documentElement, target.documentElement);
  if (headToo && target.head) morphChildren(live.head, target.head);
  if (target.body) morphNode(live.body, target.body);
}

// Element path from body (element-child indexes), for scoped morphs between two captures of the same layout.
export function pathOf(el) {
  const p = [];
  while (el && el.parentElement && el !== el.ownerDocument.body) { p.unshift([...el.parentElement.children].indexOf(el)); el = el.parentElement; }
  return p;
}
export function atPath(doc, p) {
  let el = doc.body;
  for (const i of p) { el = el && el.children[i]; if (!el) return null; }
  return el;
}
