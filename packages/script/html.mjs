// A captured page read without a browser: its controls (named the way the recorder's outline names them,
// packages/recorder/outline-page.js), its text items (the way the script matcher indexes a screen,
// packages/player/app/focus-target.js, with a box that's its place in the page's order) and its words. Captures are
// serialized DOM, so a small stack parser is enough. Used to map a talk track's Do lines to real controls, and its
// lines to what's on screen, before there's a replica to look at.
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'template', 'noscript', 'title']);
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', mdash: '—', ndash: '–', hellip: '…', middot: '·', rsaquo: '›' };
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(/x/i.test(e[1]) ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e.toLowerCase()] ?? m);
// Without the invisible marks pages put in text (zero-width spaces, left-to-right marks).
const clean = s => String(s || '').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, '').replace(/\s+/g, ' ').trim();

export function parseHtml(html) {
  const root = { tag: '#root', attrs: {}, children: [], parent: null };
  let cur = root, m;
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)|</g;
  const s = String(html || '');
  while ((m = re.exec(s))) {
    if (m[5] !== undefined || m[0] === '<') { cur.children.push(decode(m[5] ?? '<')); continue; }
    if (m[1]) { const t = m[1].toLowerCase(); let n = cur; while (n && n.tag !== t) n = n.parent; if (n && n.parent) cur = n.parent; continue; }
    if (!m[2]) continue;
    const tag = m[2].toLowerCase(), attrs = {};
    for (const a of (m[3] || '').matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? '');
    const el = { tag, attrs, children: [], parent: cur };
    cur.children.push(el);
    if (RAW.has(tag) && !m[4]) {
      const end = s.toLowerCase().indexOf(`</${tag}`, re.lastIndex);
      const body = s.slice(re.lastIndex, end < 0 ? s.length : end);
      if (tag === 'title') el.children.push(decode(body));
      re.lastIndex = end < 0 ? s.length : s.indexOf('>', end) + 1;
      continue;
    }
    if (!VOID.has(tag) && !m[4]) cur = el;
  }
  return root;
}

// Not on screen at all (text marked aria-hidden is still seen, so it counts as words; controls skip it).
const hiddenEl = el => 'hidden' in el.attrs || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(el.attrs.style || '') || el.tag === 'svg' || el.tag === 'head';
const unreachable = el => el.attrs['aria-hidden'] === 'true' || 'inert' in el.attrs;
const BLOCK = new Set(['p', 'div', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'td', 'th', 'section', 'article', 'header', 'footer', 'nav', 'main', 'aside', 'button', 'a', 'label', 'dt', 'dd', 'table', 'form', 'fieldset', 'figure', 'figcaption', 'blockquote', 'pre', 'summary', 'details', 'br', 'hr', 'option']);
// Inline formatting: its text runs on with what's around it. Any other element is set apart by a space (a page's CSS
// often makes spans blocks, which innerText would show apart).
const INLINE = new Set(['b', 'i', 'em', 'strong', 'mark', 'sup', 'sub', 'u', 's', 'small', 'code', 'kbd', 'abbr', 'time', 'bdi', 'bdo', 'wbr']);
// The words an element shows (innerText, roughly: blocks on lines of their own).
export function textOf(el, out = []) {
  if (typeof el === 'string') { out.push(el); return out; }
  if (el.tag !== '#root' && hiddenEl(el)) return out;
  if (el.tag === 'input' && /^(button|submit|reset)$/i.test(el.attrs.type || '')) out.push(el.attrs.value || '');
  const block = BLOCK.has(el.tag), gap = !block && !INLINE.has(el.tag);
  if (block) out.push('\n'); else if (gap) out.push(' ');
  for (const c of el.children) textOf(c, out);
  if (block) out.push('\n'); else if (gap) out.push(' ');
  return out;
}
export const wordsOf = el => textOf(el).join('').split('\n').map(clean).filter(Boolean).join('\n');

// Roles and names as packages/recorder/outline-page.js gives them.
const ROLE_SEL = /^(button|link|tab|menuitem|menuitemcheckbox|menuitemradio|option|treeitem|switch|checkbox|radio|textbox|searchbox|combobox|gridcell)$/;
function roleOf(el) {
  const r = el.attrs.role;
  if (r) return r;
  const t = el.tag;
  if (t === 'a' && 'href' in el.attrs) return 'link';
  if (t === 'button' || t === 'summary') return 'button';
  if (t === 'select') return 'combobox';
  if (t === 'textarea') return 'textbox';
  if (t === 'input') { const ty = (el.attrs.type || 'text').toLowerCase(); return ty === 'checkbox' ? 'checkbox' : ty === 'radio' ? 'radio' : /^(button|submit|reset|image)$/.test(ty) ? 'button' : ty === 'search' ? 'searchbox' : 'textbox'; }
  if (el.attrs.contenteditable === '' || el.attrs.contenteditable === 'true') return 'textbox';
  return t;
}
function isControl(el) {
  const a = el.attrs, t = el.tag;
  if (t === 'input') return !/^(hidden|password)$/i.test(a.type || '');
  if (/^(button|summary|select|textarea)$/.test(t) || (t === 'a' && 'href' in a)) return true;
  if (a.contenteditable === '' || a.contenteditable === 'true') return true;
  if (a.role && ROLE_SEL.test(a.role)) return true;
  if ((a.role === 'row' || a.role === 'listitem') && 'tabindex' in a) return true;
  return a.tabindex === '0';
}

// The page's controls, items and words, from one or more documents (the page and its frames).
export function readScreen(docs) {
  const controls = [], items = [], text = [], headings = [];
  let pos = 0;
  for (const { key, html } of docs) {
    const root = parseHtml(html);
    const ids = new Map();
    const index = el => { if (typeof el === 'string') return; if (el.attrs.id) ids.set(el.attrs.id, el); el.children.forEach(index); };
    index(root);
    const own = el => clean(el.children.filter(c => typeof c === 'string').join(' '));
    const nameOf = el => {
      const a = el.attrs;
      const by = a['aria-labelledby'] ? a['aria-labelledby'].split(/\s+/).map(id => ids.get(id)).filter(Boolean).map(wordsOf).join(' ') : '';
      const inner = el.tag === 'input' || el.tag === 'textarea' || a.contenteditable === 'true' || a.contenteditable === '' ? '' : wordsOf(el).replace(/\n/g, ' ');
      return clean(a['aria-label'] || by || inner || a.placeholder || a['data-placeholder'] || a['aria-placeholder'] || a.title || a.alt || a.value).replace(/^(.{2,}?) ?\1$/, '$1').slice(0, 90);
    };
    const walk = (el, aria = false) => {
      if (typeof el === 'string') return;
      if (el.tag !== '#root' && hiddenEl(el)) return;
      aria = aria || (el.tag !== '#root' && unreachable(el));
      const start = pos++;
      if (!aria && isControl(el)) {
        const role = roleOf(el), name = nameOf(el);
        if (name || /textbox|searchbox|combobox/.test(role)) {
          const c = { i: controls.length, role, name, frame: key === 'main' ? undefined : key };
          if (role === 'textbox' || el.tag === 'textarea' || el.attrs.contenteditable) { c.editable = el.attrs.contenteditable !== undefined ? 'content' : 'field'; if (el.tag === 'textarea' || c.editable === 'content') c.multiline = true; }
          if (el.attrs['aria-expanded']) c.expanded = el.attrs['aria-expanded'] === 'true';
          if ('disabled' in el.attrs || el.attrs['aria-disabled'] === 'true') c.disabled = true;
          if (el.attrs['data-testid']) c.testid = el.attrs['data-testid'];
          controls.push(c);
        }
      }
      if (/^h[1-6]$/.test(el.tag) || el.attrs.role === 'heading') { const h = clean(wordsOf(el)); if (h) headings.push(h); }
      const mine = own(el);
      const item = mine && el.tag !== '#root' ? { i: items.length, kind: isControl(el) ? 'control' : 'text', role: el.attrs.role || ({ li: 'listitem', p: 'paragraph', a: 'link', button: 'button', td: 'cell', th: 'cell' }[el.tag] || (/^h[1-6]$/.test(el.tag) ? 'heading' : 'generic')), tag: el.tag, frame: key === 'main' ? undefined : key } : null;
      if (item) items.push(item);
      el.children.forEach(c => walk(c, aria));
      if (item) { item.text = clean(wordsOf(el).replace(/\n/g, ' ')).slice(0, 2000); item.box = [start, 0, pos, 1]; }
    };
    walk(root);
    text.push(wordsOf(root));
  }
  return { controls, items: items.filter(it => it.text), headings: headings.slice(0, 30), text: text.join('\n') };
}
