// Text rules: declared changes to captured text, applied to every page, streamed frame and hover or click part a build
// writes, so a recapture keeps them. One applier for a demo's own rules (its build hook, from replica-kit: inv641's
// capture/text-overrides.mjs) and an app pack's (@stuntdouble/apps build.edits, through htmlPasses). Kinds:
//   raw:   [from, to]       literal swap anywhere in the markup, attributes too (dates, times, IDs)
//   text:  [from, to]       visible text, matched across tags; `to` may be one string per text node the match spans,
//                           to keep the markup (a bold label, then the rest)
//   drop:  'text'           visible text removed, with the space after it
//   block: 'text', tag      the nearest enclosing <tag> element of that text removed (a paragraph, a list item)
//                           (in plain text such as a skill's Markdown or a screen reader's live region, its line or sentence)
// Each may say `in: ['cop-*', 'stream:payoff', ...]` (captures it applies to: a snap id, "stream:<name>",
// "hover:<app>", "click:<app>"; default all) and `check: false` (another rule puts the same text back elsewhere, so its
// leftovers aren't counted). Matching ignores the difference between straight and curly quotes, hyphen forms and
// non-breaking spaces.
//
// Streamed frames are cut wherever the answer had got to, often mid-sentence. In them a text node that ends with the
// start of a rule's text (the rest of it not streamed yet) gets the same start of the new text, or is removed, so old
// words never show for a frame.
//
//   const R = overrides(rules, { elementEnd, skip: ['hov-*'] });   // elementEnd: @stuntdouble/capture/compose.mjs
//   R.html(markup, ctx, { partial }), R.plain(text, ctx), R.leftovers(text, ctx), R.unused(), R.ops

const NORM = { '\u2019': "'", '\u2018': "'", '\u201c': '"', '\u201d': '"', '\u2011': '-', '\u2010': '-', '\u2013': '-', '\u00a0': ' ' };
const norm = s => s.replace(/[\u2019\u2018\u201c\u201d\u2011\u2010\u2013\u00a0]/g, c => NORM[c]);
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', '#39': "'" };
const encode = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const glob = p => new RegExp('^' + p.split('*').map(esc).join('.*') + '$');

// The page's text, outside tags, comments and style/script/title contents: T (normalized, one char per char) and,
// for each char, where it starts and ends in the markup.
function textOf(html) {
  const T = [], at = [], to = [], segEnd = new Set();
  let i = 0; const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i), end = lt < 0 ? n : lt;
    for (let k = i; k < end;) {
      let ch = html[k], len = 1;
      if (ch === '&') { const m = /^&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/i.exec(html.slice(k, k + 12)); if (m) { len = m[0].length; const e = m[1]; ch = e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENT[e] ?? m[0]); } }
      T.push(norm(ch)); at.push(k); to.push(k + len); k += len;
    }
    if (end > i) segEnd.add(T.length);
    if (lt < 0) break;
    if (html.startsWith('<!--', lt)) { const c = html.indexOf('-->', lt); i = c < 0 ? n : c + 3; continue; }
    let q = null, g = lt + 1;
    for (; g < n; g++) { const c = html[g]; if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === '>') break; }
    const raw = /^<(style|script|title|textarea)\b/i.exec(html.slice(lt, lt + 10));
    if (raw) { const close = html.toLowerCase().indexOf('</' + raw[1].toLowerCase(), g); i = close < 0 ? n : close; continue; }
    i = g + 1;
  }
  return { T: T.join(''), at, to, segEnd };
}
const pattern = s => new RegExp(esc(norm(s)).replace(/ /g, '\\s+'), 'g');

export { overrides as textRules };
export function overrides(list, { elementEnd, skip = [] }) {
  const ops = list.map((o, k) => {
    const kind = ['raw', 'text', 'drop', 'block'].find(x => o[x] !== undefined);
    const from = kind === 'raw' || kind === 'text' ? o[kind][0] : o[kind];
    const to = kind === 'raw' || kind === 'text' ? o[kind][1] : '';
    return { ...o, k, kind, from, to, n: 0, scope: (o.in || ['*']).map(glob), re: pattern(from) };
  });
  const skips = skip.map(glob);
  const inScope = (op, ctx) => !skips.some(r => r.test(ctx)) && op.scope.some(r => r.test(ctx));

  // Replace T[a, b) in the markup with `to` (a string, or one string per text run the range spans).
  function splice(html, map, a, b, to) {
    const runs = [];
    for (let k = a; k < b; k++) { if (!runs.length || map.segEnd.has(k) || map.at[k] !== map.to[k - 1]) runs.push({ s: map.at[k], e: map.to[k] }); else runs[runs.length - 1].e = map.to[k]; }
    const pieces = Array.isArray(to) ? to : [to];
    let out = html;
    for (let r = runs.length - 1; r >= 0; r--) {
      const piece = Array.isArray(to) ? (pieces[r] ?? '') : (r === 0 ? pieces[0] : '');
      out = out.slice(0, runs[r].s) + encode(piece) + out.slice(runs[r].e);
    }
    return out;
  }
  // The nearest <tag> around pos, if it's a single item (a paragraph or list item, not a whole list or chat turn).
  function enclosing(html, pos, tag) {
    let s = pos;
    while ((s = html.lastIndexOf('<' + tag, s - 1)) >= 0) {
      const c = html[s + tag.length + 1];
      if (c !== ' ' && c !== '>') continue;
      const e = elementEnd(html, s);
      if (e <= pos) continue;
      return html.slice(s, e).replace(/<[^>]+>/g, '').length <= 2000 ? [s, e] : null;
    }
    return null;
  }
  // Without one (the text is plain: a skill's Markdown, a screen reader's live region), its line, or else its sentence.
  function plainItem(html, map, a, b) {
    const s = map.at[a], e = map.to[b - 1];
    const nl0 = html.lastIndexOf('\n', s), lt0 = html.lastIndexOf('>', s), nl1 = html.indexOf('\n', e), lt1 = html.indexOf('<', e);
    if (nl0 > lt0 && nl1 >= 0 && nl1 < lt1) return [nl0 + 1, nl1 + 1];
    const dot = html.slice(e, lt1 < 0 ? undefined : lt1).search(/\.(\s|$)/);
    return [s, dot < 0 ? e : e + dot + 1];
  }

  // st: { html, map } with the text map kept until the markup changes.
  const mapOf = st => st.map || (st.map = textOf(st.html));
  const set = (st, html) => { if (html !== st.html) { st.html = html; st.map = null; } };
  function applyOne(st, op, partial) {
    if (op.kind === 'raw') { if (!st.html.includes(op.from)) return; const parts = st.html.split(op.from); op.n += parts.length - 1; set(st, parts.join(op.to)); return; }
    // Full matches, last first so earlier positions stay valid.
    for (let guard = 0; guard < 50; guard++) {
      const map = mapOf(st);
      if (map.T.search(op.re) < 0) break;
      op.re.lastIndex = 0;
      const hits = [...map.T.matchAll(op.re)];
      const h = hits[hits.length - 1]; let a = h.index, b = a + h[0].length;
      op.n++;
      if (op.kind === 'block') {
        // In plain text (a skill's Markdown shown as text), the line holding it.
        const r = enclosing(st.html, map.at[a], op.tag) || plainItem(st.html, map, a, b);
        set(st, st.html.slice(0, r[0]) + st.html.slice(r[1])); continue;
      }
      if (op.kind === 'drop' && /\s/.test(map.T[b] || '')) b++;
      set(st, splice(st.html, map, a, b, op.kind === 'text' ? op.to : ''));
    }
    if (!partial) return;
    // A frame cut inside the text: one of its text nodes ends with the start of it.
    const F = norm(op.from).replace(/\s+/g, ' '), min = op.kind === 'text' ? 6 : 20;
    const map = mapOf(st);
    for (const E of [...map.segEnd].sort((x, y) => y - x)) {
      if (E < min) continue;
      const tail = map.T.slice(E - min, E).replace(/\s+/g, ' ');
      for (let k = F.indexOf(tail); k >= 0; k = F.indexOf(tail, k + 1)) {
        const L = k + min; if (L >= F.length) continue;
        if (map.T.slice(E - L, E).replace(/\s+/g, ' ') !== F.slice(0, L)) continue;
        op.n++;
        const J = norm(Array.isArray(op.to) ? op.to.join('') : op.to).replace(/\s+/g, ' ');
        // The new text starts the same way: what's there is already right.
        if (op.kind === 'text' && J.startsWith(F.slice(0, L))) { op.n--; continue; }
        if (op.kind === 'block') { const r = enclosing(st.html, map.at[E - L], op.tag); if (r) return set(st, st.html.slice(0, r[0]) + st.html.slice(r[1])); }
        const cut = op.kind === 'text' ? J.slice(0, Math.round(L * J.length / F.length)) : '';
        return set(st, splice(st.html, map, E - L, E, cut));
      }
    }
  }

  return {
    ops,
    // Markup of one capture (ctx: snap id, "stream:<name>", "hover:<app>" or "click:<app>").
    html(html, ctx, { partial = false } = {}) { const st = { html, map: null }; for (const op of ops) if (inScope(op, ctx)) applyOne(st, op, partial); return st.html; },
    // Plain text (a hover's anchor text): the same swaps, without markup.
    plain(s, ctx) {
      for (const op of ops) {
        if (!inScope(op, ctx)) continue;
        if (op.kind === 'raw') s = s.split(op.from).join(op.to);
        else if (op.kind === 'text' || op.kind === 'drop') {
          // Matched on the normalized text, replaced in the original (same length), so other quotes stay as they were.
          const hits = [...norm(s).matchAll(op.re)].reverse(), to = op.kind === 'text' ? (Array.isArray(op.to) ? op.to.join('') : op.to) : '';
          for (const h of hits) s = s.slice(0, h.index) + to + s.slice(h.index + h[0].length);
        }
      }
      return s;
    },
    // Old text still in a written file, for the leak check.
    leftovers(text, ctx) {
      const out = [];
      // The text index once per file, not once per rule (it was most of a large demo's build: 435 of 521 s).
      let T = null;
      for (const op of ops) {
        if (op.check === false || !inScope(op, ctx)) continue;
        const hay = op.kind === 'raw' ? text : (T ??= textOf(text).T);
        if (op.kind === 'raw' ? text.includes(op.from) : hay.search(op.re) >= 0) out.push(op.from.slice(0, 50));
      }
      return out;
    },
    unused: () => ops.filter(op => !op.n && !op.optional).map(op => `${op.kind}: ${op.from.slice(0, 50)}`),
  };
}
