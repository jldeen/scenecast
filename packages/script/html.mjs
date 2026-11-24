// A captured page read without a browser: its controls (what's a control, its role and its name:
// @stuntdouble/core/lib/control-name.mjs, the rule a run uses on the live page too), its text items (the way the script matcher indexes a screen,
// packages/player/app/focus-target.js, with a box that's its place in the page's order) and its words. Captures are
// serialized DOM, so a small stack parser is enough. Used to map a talk track's Do lines to real controls, and its
// lines to what's on screen, before there's a replica to look at.
import { controlOf } from '@stuntdouble/core/lib/control-name.mjs';

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
const TIMES = /^(time|relative-time|local-time|time-ago|time-until)$/;
// A list (a list, a listbox, a grid, a table, a tree, tabs, a menu, a feed) and a row in it (an item, an option, a row,
// a tab, a menu item, a post).
const LISTS = /^(list|listbox|grid|treegrid|table|tree|tablist|menu|menubar|radiogroup|feed)$/, ROWS = /^(listitem|option|row|treeitem|tab|menuitem|menuitemcheckbox|menuitemradio|radio|article)$/;
const says = n => +n > 0 ? +n : null;
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

// A small CSS selector engine, for the recorder's matchers ([data-testid="x"], #id, a[href*="/edit/"],
// section[aria-label="Reviewers"] button): tags, ids, classes, attributes (= ^= $= *= ~= |=), and the descendant,
// child and sibling combinators. Pseudo-classes are skipped.
function parseSelector(sel) {
  const out = [];
  for (const one of String(sel || '').split(/,(?![^[]*\])/)) {
    const s = one.trim(), steps = [];
    let i = 0, comb = null;
    while (i < s.length) {
      let ws = false;
      while (s[i] === ' ') { i++; ws = true; }
      if ('>+~'.includes(s[i] || '_')) { comb = s[i++]; while (s[i] === ' ') i++; } else if (ws && steps.length) comb = ' ';
      const c = { tag: null, id: null, classes: [], attrs: [] };
      const at = re => { re.lastIndex = i; const m = re.exec(s); if (m) i = re.lastIndex; return m; };
      let m = at(/[a-zA-Z*][\w-]*/y);
      if (m && m[0] !== '*') c.tag = m[0].toLowerCase();
      for (;;) {
        if (s[i] === '#' && (m = at(/#([\w-]+)/y))) c.id = m[1];
        else if (s[i] === '.' && (m = at(/\.([\w-]+)/y))) c.classes.push(m[1]);
        else if (s[i] === '[' && (m = at(/\[\s*([\w:-]+)\s*(?:([~^$*|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*[is]?\s*\]/y))) c.attrs.push({ name: m[1].toLowerCase(), op: m[2] || null, value: m[3] ?? m[4] ?? m[5] ?? '' });
        else if (s[i] === ':' && (m = at(/::?[\w-]+(?:\((?:[^()]|\([^()]*\))*\))?/y))) continue;
        else break;
      }
      if (!c.tag && !c.id && !c.classes.length && !c.attrs.length) { i++; continue; }
      steps.push({ comb: steps.length ? comb || ' ' : null, c });
      comb = null;
    }
    if (steps.length) out.push(steps);
  }
  return out;
}
function compoundMatches(el, c) {
  if (typeof el === 'string' || el.tag === '#root') return false;
  if (c.tag && el.tag !== c.tag) return false;
  if (c.id && el.attrs.id !== c.id) return false;
  if (c.classes.length) { const cl = String(el.attrs.class || '').split(/\s+/); if (!c.classes.every(x => cl.includes(x))) return false; }
  for (const a of c.attrs) {
    const v = el.attrs[a.name];
    if (v === undefined) return false;
    if (a.op === '=' && v !== a.value) return false;
    if (a.op === '^=' && !v.startsWith(a.value)) return false;
    if (a.op === '$=' && !v.endsWith(a.value)) return false;
    if (a.op === '*=' && !v.includes(a.value)) return false;
    if (a.op === '~=' && !v.split(/\s+/).includes(a.value)) return false;
    if (a.op === '|=' && v !== a.value && !v.startsWith(a.value + '-')) return false;
  }
  return true;
}
function selectorMatches(el, steps, k = steps.length - 1) {
  if (!compoundMatches(el, steps[k].c)) return false;
  if (k === 0) return true;
  const comb = steps[k].comb;
  if (comb === '>') return !!el.parent && selectorMatches(el.parent, steps, k - 1);
  if (comb === ' ') { for (let p = el.parent; p; p = p.parent) if (selectorMatches(p, steps, k - 1)) return true; return false; }
  const sibs = el.parent ? el.parent.children.filter(x => typeof x !== 'string') : [], i = sibs.indexOf(el);
  if (comb === '+') return i > 0 && selectorMatches(sibs[i - 1], steps, k - 1);
  for (let j = i - 1; j >= 0; j--) if (selectorMatches(sibs[j], steps, k - 1)) return true;
  return false;
}
export function querySelectorAll(root, sel) {
  const parsed = parseSelector(sel), out = [];
  const walk = el => { if (typeof el === 'string') return; if (parsed.some(st => selectorMatches(el, st))) out.push(el); el.children.forEach(walk); };
  walk(root);
  return out;
}
const closest = (el, sel) => { const p = parseSelector(sel); for (let e = el; e; e = e.parent) if (p.some(st => selectorMatches(e, st))) return e; return null; };
// The element a recorded matcher picks, the way the player does (packages/player/app/shell.js findEl): its selector,
// scope, label, test id and text, the innermost one first, then its nth.
function findSpec(roots, m) {
  for (const { key, root } of roots) {
    if (m.frame !== undefined && (m.frame || 'main') !== key) continue;
    let els = querySelectorAll(root, m.sel || '*').filter(el => {
      const a = el.attrs, t = () => clean(wordsOf(el).replace(/\n/g, ' '));
      if (m.in && !closest(el, m.in)) return false;
      if (m.label !== undefined && a['aria-label'] !== m.label) return false;
      if (m.labelStarts !== undefined && !(a['aria-label'] || '').startsWith(m.labelStarts)) return false;
      if (m.testid !== undefined && a['data-testid'] !== m.testid) return false;
      if (m.text !== undefined && t() !== clean(m.text)) return false;
      if (m.textStarts !== undefined && !t().startsWith(clean(m.textStarts))) return false;
      return true;
    });
    const within = (o, el) => { for (let p = o.parent; p; p = p.parent) if (p === el) return true; return false; };
    els = els.filter(el => !els.some(o => o !== el && within(o, el)));
    const e = els[m.nth || 0];
    if (e) return e;
  }
  return null;
}

// The page's controls, items and words, from one or more documents (the page and its frames). specs: recorded
// matchers ({ key, sel, text, … }) to resolve to the controls they pick (picks: key → control index, or -1).
export function readScreen(docs, { specs = [] } = {}) {
  // A page's own headings come first; an app bar's or a menu's (inside a header, banner or nav) after them.
  const controls = [], items = [], text = [], headings = [], barHeadings = [], roots = [], ctlOf = new Map();
  let pos = 0, theme = null, times = 0, lives = 0;
  const regions = {}, lists = {};
  for (const { key, html } of docs) {
    const root = parseHtml(html);
    roots.push({ key: key || 'main', root });
    if (!theme) theme = themeOf(root);
    // Ids as getElementById finds them (the first with that id), and each field's <label>s as el.labels gives them:
    // a label's `for` names its field (when that's a field), else it's the first field inside it.
    const ids = new Map(), labelEls = [], labels = new Map();
    const index = el => { if (typeof el === 'string') return; if (el.attrs.id && !ids.has(el.attrs.id)) ids.set(el.attrs.id, el); if (el.tag === 'label') labelEls.push(el); el.children.forEach(index); };
    index(root);
    const labelable = el => el && typeof el !== 'string' && (/^(button|meter|output|progress|select|textarea)$/.test(el.tag) || (el.tag === 'input' && String(el.attrs.type || '').toLowerCase() !== 'hidden'));
    const firstIn = el => { for (const c of el.children) { if (labelable(c)) return c; const f = typeof c !== 'string' && firstIn(c); if (f) return f; } return null; };
    for (const l of labelEls) { const f = 'for' in l.attrs ? ids.get(l.attrs.for) : firstIn(l); if (labelable(f)) (labels.get(f) || labels.set(f, []).get(f)).push(l); }
    const own = el => clean(el.children.filter(c => typeof c === 'string').join(' '));
    const acc = { tag: el => el.tag, attr: (el, n) => (n in el.attrs ? el.attrs[n] : null), text: el => wordsOf(el), byId: id => ids.get(id) || null, labels: el => labels.get(el) || [] };
    // Marks on items and controls, kept as they are (what a landing can be proven by: docs/engine/plan-format.md):
    // shut: inside a closed dialog (no open attribute) or a template, so not on the page as it shows (innerText).
    // nav:  in the page's frame rather than its own content: a nav or an aside, the page's own header or footer (not
    //       one inside an article, aside, main, nav or section), or a banner, navigation, complementary or
    //       contentinfo landmark.
    // live: in a live region (role status, alert, log, marquee or timer; aria-live polite or assertive; an output), or
    //       holding one: words that come and go by themselves (a toast, "Message sent").
    // time: a time (time, relative-time, local-time, time-ago, time-until), in one, or holding one: words that change
    //       as time passes.
    // article: where the item's nearest article (role article, or an article: a message, a post, a comment) starts.
    // region: where the nearest part of the page named by its aria-label starts (a section, a dialog, a panel, a
    //         group: regions[at] is [its name, the region around it]).
    // list, row: where the nearest list starts (lists[at] is [its name or null, its role, the rows it says it has
    //         (aria-rowcount or aria-setsize, its own or its first row's) or null]) and the row in it (none for the
    //         list itself, or what's in it outside a row). What describes one row's element (aria-describedby: a
    //         tooltip in a portal) is in that row too, marked described.
    // restored: in a row a capture put back (data-d1-row: packages/capture/flows/virtual-list.js scrolls a list that
    //         shows only the rows in view and keeps every row), not one the page showed.
    // tip:  in a tooltip (role tooltip): on the screen only while its control is hovered.
    const desc = new Map(), spans = new Map();
    const walk = (el, aria = false, bar = false, shut = false, nav = false, live = false, time = false, sect = false, art = null, reg = null, lst = null, row = null, back = false, tip = false) => {
      if (typeof el === 'string') return;
      if (el.tag !== '#root' && hiddenEl(el)) return;
      const role = el.attrs.role || '';
      aria = aria || (el.tag !== '#root' && unreachable(el));
      bar = bar || el.tag === 'header' || el.tag === 'nav' || /^(banner|navigation)$/.test(role);
      shut = shut || (el.tag === 'dialog' && !('open' in el.attrs)) || el.tag === 'template';
      nav = nav || /^(nav|aside)$/.test(el.tag) || (/^(header|footer)$/.test(el.tag) && !sect) || /^(banner|navigation|complementary|contentinfo)$/.test(role);
      live = live || el.tag === 'output' || /^(status|alert|log|marquee|timer)$/.test(role) || /^(polite|assertive)$/.test(el.attrs['aria-live'] || '');
      time = time || TIMES.test(el.tag);
      sect = sect || /^(article|aside|main|nav|section)$/.test(el.tag);
      const t0 = times, l0 = lives;
      if (time) times++;
      if (live) lives++;
      const start = pos++;
      if (el.tag === 'article' || role === 'article') art = start;
      if (clean(el.attrs['aria-label']) && (/^(section|article|aside|dialog|main|form|nav)$/.test(el.tag) || /^(region|group|dialog|alertdialog|article|tabpanel|document|main|complementary|navigation|form|feed)$/.test(role))) { regions[start] = [clean(el.attrs['aria-label']).slice(0, 120), reg]; reg = start; }
      if (LISTS.test(role) || (!role && /^(ul|ol|table|menu)$/.test(el.tag))) { lists[start] = [clean(el.attrs['aria-label']).slice(0, 120) || null, role || el.tag, says(el.attrs['aria-rowcount']) || says(el.attrs['aria-setsize'])]; lst = start; row = null; }
      else if (lst !== null && (ROWS.test(role) || (!role && /^(li|tr)$/.test(el.tag)))) { row = start; if (!lists[lst][2]) lists[lst][2] = says(el.attrs['aria-setsize']); }
      back = back || 'data-d1-row' in el.attrs;
      tip = tip || role === 'tooltip';
      if (row !== null && el.attrs['aria-describedby']) for (const id of el.attrs['aria-describedby'].split(/\s+/).filter(Boolean)) { const was = desc.get(id); desc.set(id, was === undefined || (was && was.lst === lst && was.row === row) ? { lst, row } : null); }
      const i0 = items.length, c0 = controls.length;
      const ctl = el.tag === '#root' ? null : controlOf(el, acc);
      let mark = null;
      if (!aria && ctl && ctl.control) {
        const { role, name } = ctl;
        if (name || /textbox|searchbox|combobox/.test(role)) {
          const c = { i: controls.length, role, name, frame: key === 'main' ? undefined : key };
          if (role === 'textbox' || el.tag === 'textarea' || el.attrs.contenteditable) { c.editable = el.attrs.contenteditable !== undefined ? 'content' : 'field'; if (el.tag === 'textarea' || c.editable === 'content') c.multiline = true; }
          if (el.attrs['aria-expanded']) c.expanded = el.attrs['aria-expanded'] === 'true';
          if ('disabled' in el.attrs || el.attrs['aria-disabled'] === 'true') c.disabled = true;
          if (el.attrs['data-testid']) c.testid = el.attrs['data-testid'];
          // What a switch, checkbox or radio is set to, as captured (aria-checked, or an input's checked), and a
          // toggle button's aria-pressed.
          const ac = el.attrs['aria-checked'];
          if (ac === 'true' || ac === 'false') c.on = ac === 'true';
          else if (el.tag === 'input' && /^(checkbox|radio)$/i.test(el.attrs.type || '')) c.on = 'checked' in el.attrs;
          if (el.attrs['aria-pressed'] === 'true' || el.attrs['aria-pressed'] === 'false') c.pressed = el.attrs['aria-pressed'] === 'true';
          if (el.attrs['aria-selected'] === 'true' || el.attrs['aria-selected'] === 'false') c.selected = el.attrs['aria-selected'] === 'true';
          // What's in a box, as captured: a text input's value (a search box's too), a text area's text, an editable
          // area's words.
          const textInput = el.tag === 'input' && !/^(checkbox|radio|button|submit|reset|image|hidden|password|file|range|color)$/i.test(el.attrs.type || '');
          if (c.editable || textInput) { const v = el.tag === 'input' ? clean(el.attrs.value) : el.tag === 'textarea' ? clean(el.children.filter(x => typeof x === 'string').join('')) : clean(wordsOf(el)); if (v) c.value = v.slice(0, 300); }
          if (shut) c.shut = true;
          if (nav) c.nav = true;
          if (lst !== null) c.list = lst;
          if (row !== null) c.row = row;
          if (back) c.restored = true;
          if (tip) c.tip = true;
          controls.push(c);
          ctlOf.set(el, c.i);
          mark = c;
        }
      }
      if (/^h[1-6]$/.test(el.tag) || el.attrs.role === 'heading') { const h = clean(wordsOf(el)); if (h) (bar ? barHeadings : headings).push(h); }
      const mine = own(el);
      const item = mine && el.tag !== '#root' ? { i: items.length, kind: ctl && ctl.control ? 'control' : 'text', role: el.attrs.role || ({ li: 'listitem', p: 'paragraph', a: 'link', button: 'button', td: 'cell', th: 'cell' }[el.tag] || (/^h[1-6]$/.test(el.tag) ? 'heading' : 'generic')), tag: el.tag, frame: key === 'main' ? undefined : key } : null;
      if (item) { if (shut) item.shut = true; if (nav) item.nav = true; if (art !== null) item.article = art; if (reg !== null) item.region = reg; if (lst !== null) item.list = lst; if (row !== null) item.row = row; if (back) item.restored = true; if (tip) item.tip = true; items.push(item); }
      el.children.forEach(c => walk(c, aria, bar, shut, nav, live, time, sect, art, reg, lst, row, back, tip));
      if (el.attrs.id && ids.get(el.attrs.id) === el) spans.set(el.attrs.id, [i0, items.length, c0, controls.length]);
      if (item) { item.text = clean(wordsOf(el).replace(/\n/g, ' ')).slice(0, 2000); item.box = [start, 0, pos, 1]; }
      for (const m of [item, mark]) if (m) { if (lives > l0) m.live = true; if (times > t0) m.time = true; }
    };
    walk(root);
    // What describes one row's element, and isn't in a list itself, is in that row.
    for (const [id, ref] of desc) {
      const sp = ref && spans.get(id);
      if (sp) for (const x of [...items.slice(sp[0], sp[1]), ...controls.slice(sp[2], sp[3])]) if (x.list === undefined) { x.list = ref.lst; x.row = ref.row; x.described = true; }
    }
    text.push(wordsOf(root));
  }
  if (!theme) { const t = controls.find(c => /^switch to (dark|light) (mode|theme)$/i.test(c.name) && c.pressed !== undefined); if (t) theme = /dark/i.test(t.name) === !t.pressed ? 'light' : 'dark'; }
  // Each matcher's control: the element's own, the control around it, or the first one inside it.
  const picks = {};
  const inside = el => { if (typeof el === 'string') return -1; if (ctlOf.has(el)) return ctlOf.get(el); for (const c of el.children) { const k = inside(c); if (k >= 0) return k; } return -1; };
  for (const m of specs) {
    const el = findSpec(roots, m);
    let k = -1;
    if (el) { for (let p = el; p && k < 0; p = p.parent) if (ctlOf.has(p)) k = ctlOf.get(p); if (k < 0) k = inside(el); }
    picks[m.key] = k;
  }
  return { controls, items: items.filter(it => it.text), headings: [...headings, ...barHeadings].slice(0, 30), text: text.join('\n'), theme, regions, lists, ...(specs.length ? { picks } : {}) };
}

// Light or dark, as the page's root says it (a color scheme, a theme attribute, or a theme class); null if it doesn't.
function themeOf(root) {
  const find = (el, tag) => { if (typeof el === 'string') return null; if (el.tag === tag) return el; for (const c of el.children) { const f = find(c, tag); if (f) return f; } return null; };
  for (const el of [find(root, 'html'), find(root, 'body')].filter(Boolean)) {
    const a = el.attrs;
    const scheme = a['data-color-scheme'] || (/color-scheme\s*:\s*(light|dark)\b/i.exec(a.style || '') || [])[1];
    if (/^(light|dark)$/i.test(scheme || '')) return scheme.toLowerCase();
    const words = `${a['data-theme'] || ''} ${a.class || ''}`;
    if (/(^|[\s_-])(theme-?)?dark/i.test(words)) return 'dark';
    if (/(^|[\s_-])(theme-?)?(light|default)/i.test(words)) return 'light';
  }
  return null;
}
