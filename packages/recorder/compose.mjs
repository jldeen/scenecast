// Composition: puts a part captured on one real page into another real page. Used once: prompt 2's card. Today's
// product shows "Save skill" there; the real "Copy file" approval card (Cancel / Approve) from Nov 13's takes was
// captured from a throwaway task (Nov 14) and replaces it. Only the CSS rules that the part's classes need, and
// that the page doesn't already have, go with it.

// Start and end offsets of the element whose start tag begins at `start` (same-name tags are balanced).
export function elementEnd(html, start) {
  const tag = /^<([a-zA-Z0-9-]+)/.exec(html.slice(start))[1];
  const re = new RegExp(`<(/?)${tag}\\b`, 'g');
  re.lastIndex = start;
  let depth = 0, m;
  while ((m = re.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.indexOf('>', m.index) + 1;
  }
  throw new Error('unbalanced ' + tag);
}
// The innermost <tag> element that contains offset `at`.
export function around(html, at, tag) {
  let s = html.lastIndexOf('<' + tag, at);
  while (s >= 0) {
    if (/^<[a-zA-Z0-9-]+[\s>]/.test(html.slice(s, s + tag.length + 2)) && elementEnd(html, s) > at) return [s, elementEnd(html, s)];
    s = html.lastIndexOf('<' + tag, s - 1);
  }
  return null;
}
// Top-level CSS blocks (rules and at-rules with their bodies).
function blocks(css) {
  const out = []; let depth = 0, start = 0, q = null;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { out.push(css.slice(start, i + 1).trim()); start = i + 1; } }
  }
  return out;
}
const classesOf = html => new Set([...html.matchAll(/class="([^"]*)"/g)].flatMap(m => m[1].split(/\s+/).filter(Boolean)));
const uses = (selector, classes) => [...selector.matchAll(/\.([A-Za-z0-9_-]+)/g)].some(m => classes.has(m[1]));
// CSS from `sourceHtml` that `partHtml` needs and `targetHtml` lacks.
export function cssFor(partHtml, sourceHtml, targetHtml) {
  const classes = classesOf(partHtml);
  const have = new Set();
  for (const m of targetHtml.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) for (const b of blocks(m[1])) have.add(b);
  const keep = new Set(); const frames = new Set();
  const pick = b => {
    const head = b.slice(0, b.indexOf('{'));
    if (/^@(media|supports|layer|container)/.test(head)) { const inner = blocks(b.slice(b.indexOf('{') + 1, -1)).filter(x => uses(x.slice(0, x.indexOf('{')), classes)); return inner.length ? `${head}{${inner.join('\n')}}` : null; }
    if (head.startsWith('@')) return null;
    return uses(head, classes) ? b : null;
  };
  for (const m of sourceHtml.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) for (const b of blocks(m[1])) {
    if (/^@keyframes/.test(b)) { frames.add(b); continue; }
    const p = pick(b); if (p && !have.has(p)) keep.add(p);
  }
  const text = [...keep].join('\n');
  for (const k of frames) { const name = /^@keyframes\s+([^\s{]+)/.exec(k)[1]; if (text.includes(name) && !have.has(k)) keep.add(k); }
  return [...keep].join('\n');
}
// Applies one compose step to a page or a streamed frame. Returns the new html, or null if the anchor isn't there.
export function compose(html, step, part, partCss) {
  const at = html.indexOf(step.anchor);
  if (at < 0) return null;
  const r = around(html, at, step.tag);
  if (!r) throw new Error('compose: no <' + step.tag + '> around ' + step.anchor);
  let out = html.slice(0, r[0]) + part + html.slice(r[1]);
  if (partCss && out.includes('</head>')) out = out.replace('</head>', `<style data-d1-compose="">${partCss.replace(/<\/style/gi, '<\\/style')}</style></head>`);
  return out;
}

// Fluent v8 (merge-styles) names classes by load order (root-236, navItem-288), so the same name means different
// styles in two captures of one app. A variant capture's own names get a prefix, in its markup and its CSS alike.
const MERGE_STYLES = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
export function isolateClasses(html, prefix = 'd1v-') {
  html = html.replace(/class="([^"]*)"/g, (m, v) => 'class="' + v.split(/(\s+)/).map(t => MERGE_STYLES.test(t) ? prefix + t : t).join('') + '"');
  return html.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/g, (m, a, css, b) => a + css.replace(/\.([A-Za-z][A-Za-z0-9]*-\d+)(?![\w-])/g, '.' + prefix + '$1') + b);
}
// The element at a start-tag offset, and its ancestors (offsets of their start tags), via a small tag-stack scan.
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
export function ancestorsAt(html, at) {
  const stack = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>|<style[^>]*>[\s\S]*?<\/style>|<!--[\s\S]*?-->/g;
  let m;
  while ((m = re.exec(html)) && m.index <= at) {
    if (!m[2]) continue;
    const tag = m[2].toLowerCase();
    if (m[1]) { while (stack.length && stack.pop().tag !== tag); continue; }
    if (m.index === at) return stack.map(s => s.start);
    if (!VOID.has(tag) && !m[3]) stack.push({ tag, start: m.index });
  }
  return stack.map(s => s.start);
}
