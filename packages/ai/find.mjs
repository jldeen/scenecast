// Finding a control on the page outline by the name a plan gives it: exact first, then the name's words.
const norm = s => String(s || '').toLowerCase().replace(/[“”"']/g, '').replace(/\s+/g, ' ').trim();
const words = s => norm(s).split(/[^a-z0-9$.%-]+/).filter(w => w && !STOP.has(w)).map(w => w.length > 3 ? w.replace(/s$/, '') : w);
const STOP = new Set(['the', 'a', 'an', 'to', 'on', 'of', 'in', 'and', 'it', 'its', 'this', 'that', 'button', 'link', 'tab', 'page', 'menu', 'row', 'item', 'details', 'pane', 'box', 'field', 'app', 'open', 'click', 'select']);
const CLICKABLE = /^(button|link|tab|menuitem|menuitemcheckbox|menuitemradio|option|treeitem|gridcell|row|listitem|switch|checkbox|radio|summary|combobox)$/;

// controls: outline.items. want: a name. kind: 'field' for typing, else anything you can click.
export function findItem(items, want, kind) {
  const w = norm(want);
  if (!w) return null;
  const pool = (items || []).filter(it => !it.disabled && (kind === 'field' ? it.editable || /textbox|searchbox|combobox/.test(it.role) : true));
  const score = it => {
    const n = norm(it.name);
    let s = n === w ? 100 : n.startsWith(w) || w.startsWith(n) && n.length > 2 ? 60 : n.includes(w) ? 50 : 0;
    if (!s) {
      const ww = words(want), nn = new Set(words(it.name));
      const hit = ww.filter(x => nn.has(x)).length;
      if (hit) s = 40 * hit / Math.max(ww.length, nn.size);
    }
    if (s && kind !== 'field' && CLICKABLE.test(it.role)) s += 5;
    if (s && it.editable && kind === 'field') s += 5;
    return s;
  };
  let best = null, bs = 0;
  for (const it of pool) { const s = score(it); if (s > bs) { bs = s; best = it; } }
  return bs >= 15 ? best : null;
}

// The box a question to an AI assistant goes in: a multi-line field, else one labelled like a message.
export function composer(items) {
  const f = (items || []).filter(it => it.editable || /textbox/.test(it.role));
  return f.find(it => it.multiline && /message|ask|prompt|chat|reply|compose/i.test(it.name)) || f.find(it => it.multiline) || f.find(it => /message|ask|prompt|chat/i.test(it.name)) || null;
}
export function searchBox(items) {
  return (items || []).find(it => (it.editable || /textbox|searchbox|combobox/.test(it.role)) && /search|find|filter/i.test(it.name)) || null;
}
