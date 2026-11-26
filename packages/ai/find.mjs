// Finding a control on the page outline by the name a plan gives it: exact first, then the name's words.
// Text as the walker compares it: lower case, no quotes, one space, and no invisible marks (the admin center wraps
// numbers and names in left-to-right marks: "Showing \u200e16\u200e items").
export const norm = s => String(s || '').toLowerCase().replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, '').replace(/[“”"'’‘]/g, '').replace(/\s+/g, ' ').trim();
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

// Copilot's step groups ("21 items complete, using Ledger IQ, Supply chain disruption, expand"): their counts and
// plugin lists change with every answer. The one by that exact name, else the index-th group on the screen, top to
// bottom (the plan's index-th group label in its beat). → the item, or null.
export const GROUP_LABEL = /^\d+ (?:items?|background tasks?) complete\b/i;
// An answer's timeline header, folded ("Worked for 1m 36s"): today's Copilot keeps an answer's step groups under it.
// The newest (lowest on the page) that's closed, or null.
export const TIMELINE_HEAD = /^(?:worked|background task ran) for \d/i;
export function timelineHead(items, { folded = true } = {}) {
  return (items || []).filter(it => !it.disabled && (folded ? it.expanded === false : typeof it.expanded === 'boolean') && TIMELINE_HEAD.test(String(it.name || '').trim()))
    .sort((a, b) => (b.y - a.y) || (b.x - a.x))[0] || null;
}
// Whether any of a beat's step groups is open after its step si (each group's clicks alternate open, closed): with no
// groups on the screen, the answer's timeline header stands in for them.
export function groupOpenAfter(steps, si) {
  const n = new Map();
  for (const x of (steps || []).slice(0, si + 1)) if (x.kind === 'click' && GROUP_LABEL.test(x.target || '')) n.set(x.target, (n.get(x.target) || 0) + 1);
  return [...n.values()].some(k => k % 2 === 1);
}
export function groupPick(items, want, index) {
  const w = norm(want);
  const exact = (items || []).find(it => norm(it.name) === w);
  if (exact) return exact;
  if (!Number.isInteger(index) || index < 0) return null;
  const seen = new Set();
  const groups = (items || []).filter(it => !it.disabled && GROUP_LABEL.test(String(it.name || '').trim()))
    .sort((a, b) => (a.y - b.y) || (a.x - b.x))
    .filter(it => { const k = `${Math.round(it.x / 4)},${Math.round(it.y / 4)}`; return seen.has(k) ? false : (seen.add(k), true); });
  return groups[index] || null;
}

// A control found by its name alone (in a frame, where there's no outline to go on), is it the one? Equal, starting
// with it, or one inside the other when it's most of it ("SC Supply Chain Operations" for "Supply Chain
// Operations"). Not a name that only contains it ("Search business plugins" for "Plugins") or a small part of it ("Our
// numbers" for "Add content to Our numbers").
export function nameFits(name, want) {
  const a = norm(name), w = norm(want);
  if (!a || !w) return false;
  return a === w || a.startsWith(w) || (a.includes(w) || w.includes(a)) && Math.min(a.length, w.length) >= 0.6 * Math.max(a.length, w.length);
}

// The box a question to an AI assistant goes in: a multi-line field, else one labelled like a message.
export function composer(items) {
  const f = (items || []).filter(it => it.editable || /textbox/.test(it.role));
  return f.find(it => it.multiline && /message|ask|prompt|chat|reply|compose/i.test(it.name)) || f.find(it => it.multiline) || f.find(it => /message|ask|prompt|chat/i.test(it.name)) || null;
}
export function searchBox(items) {
  return (items || []).find(it => (it.editable || /textbox|searchbox|combobox/.test(it.role)) && /search|find|filter/i.test(it.name)) || null;
}
