// The page as the AI sees it (the observe command): what's on screen that a presenter could act on, and the words
// on it. Only what's in the window right now; no values from password fields. Returns
// { url, title, items: [{ i, role, name, x, y, w, h, editable, multiline, focused, expanded, checked }], headings,
//   dialog, text }.
(opts) => {
  opts = opts || {};
  const vis = e => { const b = e.getBoundingClientRect(); if (!(b.width > 1 && b.height > 1 && b.bottom > 0 && b.right > 0 && b.top < innerHeight && b.left < innerWidth)) return null; const s = getComputedStyle(e); if (s.visibility === 'hidden' || s.display === 'none' || +s.opacity === 0) return null; return b; };
  const trim = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  // Roles and names by the one rule (@stuntdouble/core/lib/control-name.mjs; page-naming.mjs puts it here, via build.mjs).
  /*CONTROL_NAME*/
  const roleOf = e => domControl(e).role;
  const nameOf = e => domControl(e).name;
  const SEL = 'a[href],button,summary,select,textarea,input:not([type=hidden]):not([type=password]),[contenteditable=""],[contenteditable=true],[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=treeitem],[role=switch],[role=checkbox],[role=radio],[role=textbox],[role=searchbox],[role=combobox],[role=gridcell],[role=row][tabindex],[role=listitem][tabindex],[tabindex="0"]';
  const items = [], seen = new Set();
  for (const e of document.querySelectorAll(SEL)) {
    if (items.length >= (opts.max || 160)) break;
    if (e.closest('[inert],[aria-hidden=true]')) continue;
    const b = vis(e); if (!b) continue;
    const role = roleOf(e), name = nameOf(e);
    if (!name && !/textbox|searchbox|combobox/.test(role)) continue;
    const key = role + '|' + name + '|' + Math.round(b.x / 4) + '|' + Math.round(b.y / 4);
    if (seen.has(key)) continue; seen.add(key);
    const it = { i: items.length, role, name, x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), w: Math.round(b.width), h: Math.round(b.height) };
    if (e.isContentEditable || /textbox|searchbox|combobox/.test(role) && /^(input|textarea)$/.test(e.localName)) { it.editable = e.isContentEditable ? 'content' : 'field'; if (e.localName === 'textarea' || e.isContentEditable) it.multiline = true; }
    if (e === document.activeElement || e.contains(document.activeElement)) it.focused = true;
    const ex = e.getAttribute('aria-expanded'); if (ex) it.expanded = ex === 'true';
    const ch = e.getAttribute('aria-checked') || e.getAttribute('aria-pressed') || (e.type === 'checkbox' || e.type === 'radio' ? String(e.checked) : null); if (ch) it.checked = ch === 'true';
    if (e.disabled || e.getAttribute('aria-disabled') === 'true') it.disabled = true;
    items.push(it);
  }
  const headings = [...document.querySelectorAll('h1,h2,h3,[role=heading]')].filter(vis).map(h => trim(h.innerText, 120)).filter(Boolean).slice(0, 20);
  const dlg = [...document.querySelectorAll('[role=dialog],[role=alertdialog],dialog[open]')].find(vis);
  const text = opts.text === false ? '' : trim(document.body ? document.body.innerText : '', opts.textMax || 4000);
  return { url: location.href, title: document.title, items, headings, dialog: dlg ? trim(dlg.getAttribute('aria-label') || (dlg.querySelector('h1,h2,h3') || {}).innerText || 'a dialog', 120) : null, text, vw: innerWidth, vh: innerHeight };
}
