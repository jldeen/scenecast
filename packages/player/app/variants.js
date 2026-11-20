// Variants after the fact: a captured page shown in another theme (light, dark, high contrast, GitHub's Primer set)
// or on the other platform (macOS/Windows), with no second take. Runs in the page (the player's prepare(), a headless
// render, or the build), on the live CSSOM.
//
// Theme: an app ships only the active theme's colours. Fluent v9 writes one token set on its provider; Fluent v8 and
// CSS-in-JS write literal colours; GitHub loads only the active Primer theme's CSS. A theme pack, captured once per app
// and theme (or taken from a design system's published tokens), carries:
//   markers  how the app says which theme is on: classes and attributes on <html> and <body>, color-scheme
//   tokens   custom properties from the app's unthemed theme scopes (a provider rule, :root), as declared
//   colors   every theme token resolved to sRGB, for the palette
//   css      the theme-keyed rules that were on ([data-color-mode=dark] {...}), for a page that never loaded them
// Flipping sets the markers, adds missing theme CSS, sets the tokens, then recolours literal colours with a palette
// learned from the two token sets: a colour the page used for token X becomes token X's colour in the other theme,
// with backgrounds, text and strokes mapped separately. A colour no token explains is left alone and counted.
//
// Platform: the window frame and scrollbars (for the GitHub Copilot app, whose frame is part of the capture), plus
// shortcut text and the system font, for any captured page.

const SCOPE_MIN = 20;
const MARKER_ATTRS = ['data-theme', 'data-color-scheme', 'data-color-mode', 'data-theme-tone', 'data-bs-theme', 'data-light-theme', 'data-dark-theme', 'data-mode'];
const THEME_CLASS = /(^|[-_])(theme|dark|light|contrast)([-_A-Z0-9]|$)/i;
const COLOR_PROPS = /^(color|background|background-color|background-image|border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-color)?|outline(-color)?|fill|stroke|box-shadow|text-shadow|text-decoration(-color)?|caret-color|column-rule(-color)?|stop-color|flood-color|lighting-color|scrollbar-color|accent-color|-webkit-text-fill-color|-webkit-tap-highlight-color)$/;
const COLOR_FN = /#[0-9a-f]{3,8}\b|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([^()]*\)|color\([^()]*\)|\b(?:white|black)\b/gi;
const NOT_A_COLOR = /^(inherit|initial|unset|revert|revert-layer|currentcolor|none|transparent|auto)$/i;

// ---- colours -------------------------------------------------------------------------------------------------
export function parseColor(s) {
  if (!s) return null;
  s = String(s).trim().toLowerCase();
  if (s === 'transparent') return [0, 0, 0, 0];
  if (s === 'white') return [255, 255, 255, 1];
  if (s === 'black') return [0, 0, 0, 1];
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map(c => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = i => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? +(n(6) / 255).toFixed(3) : 1];
  }
  m = /^rgba?\(([^)]*)\)$/.exec(s);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    const v = parts.map((x, i) => x.endsWith('%') ? parseFloat(x) * (i === 3 ? 0.01 : 2.55) : parseFloat(x));
    if (v.length < 3 || v.some(Number.isNaN)) return null;
    return [Math.round(v[0]), Math.round(v[1]), Math.round(v[2]), v.length > 3 ? +(+v[3]).toFixed(3) : 1];
  }
  return null;
}
export const colorKey = c => c && (c[3] === 1 ? `${c[0]},${c[1]},${c[2]}` : `${c[0]},${c[1]},${c[2]},${c[3]}`);
const fromKey = k => { const v = k.split(',').map(Number); return [v[0], v[1], v[2], v.length > 3 ? v[3] : 1]; };
const fmt = (c, alpha) => { const a = alpha ?? c[3]; return a === 1 ? `rgb(${c[0]}, ${c[1]}, ${c[2]})` : `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`; };

// Any CSS colour (oklch, lab, color(), relative colours, named) to sRGB bytes: the browser computes it on a probe and
// paints it on a 1 px canvas. hex and rgb() skip the browser.
export function resolver(doc) {
  const cache = new Map(), W = doc.defaultView;
  const probe = doc.createElement('i');
  probe.style.cssText = 'position:absolute;left:-9px;top:-9px;width:0;height:0;visibility:hidden;pointer-events:none';
  (doc.body || doc.documentElement).appendChild(probe);
  const cv = doc.createElement('canvas'); cv.width = cv.height = 1;
  const g = cv.getContext('2d', { willReadFrequently: true });
  const color = v => {
    if (!v) return null;
    v = String(v).trim();
    if (!v || NOT_A_COLOR.test(v) || v.length > 400) return null;
    const fast = parseColor(v); if (fast) return fast;
    if (cache.has(v)) return cache.get(v);
    let out = null;
    probe.style.color = ''; probe.style.color = v;
    if (probe.style.color) {
      const c = W.getComputedStyle(probe).color;
      out = parseColor(c);
      if (!out) { g.clearRect(0, 0, 1, 1); g.fillStyle = '#000'; g.fillStyle = c; g.fillRect(0, 0, 1, 1); const d = g.getImageData(0, 0, 1, 1).data; out = [d[0], d[1], d[2], +(d[3] / 255).toFixed(3)]; }
    }
    cache.set(v, out);
    return out;
  };
  return { color, key: v => colorKey(color(v)), done: () => probe.remove() };
}

const roleOfToken = name => /background|bg|surface|fill|canvas|layer|shadow/i.test(name) ? 'bg' : /stroke|border|outline|divider|separator/i.test(name) ? 'stroke' : /foreground|fg|text|icon|link/i.test(name) ? 'fg' : 'any';
const roleOfProp = prop => /^(color|-webkit-text-fill-color|caret-color|text-decoration|text-decoration-color|text-shadow)$/.test(prop) ? 'fg'
  : /^(border|outline|column-rule|stroke)/.test(prop) ? 'stroke' : 'bg';

// ---- walking the CSSOM ---------------------------------------------------------------------------------------
// Rules an app already keys on a theme (.theme-darkV2 {...}, [data-color-mode=dark] {...}, @media (forced-colors)
// or prefers-color-scheme) are its own multi-theme CSS: flipping the markers switches them, so they're never recoloured.
const THEMED_SELECTOR = /\.(?:[\w-]*[-_])?(?:theme|dark|light)(?:[-_A-Z0-9][\w-]*)?(?![\w-])|\[data-(?:theme|color-scheme|color-mode|theme-tone|bs-theme|mode|light-theme|dark-theme)\b/i;
const THEMED_MEDIA = /forced-colors|high-contrast|prefers-color-scheme|prefers-contrast/i;
function* styleRules(rules, themed = false, media = '') {
  for (const r of rules) {
    if (r.style && r.selectorText !== undefined) { r.__sdThemed = themed || THEMED_SELECTOR.test(r.selectorText); r.__sdMedia = media; yield r; }
    if (r.cssRules && r.cssRules.length) {
      const cond = r.conditionText || (r.media && r.media.mediaText) || '';
      yield* styleRules(r.cssRules, themed || THEMED_MEDIA.test(cond), r.media ? (media ? media + ' and ' : '') + cond : media);
    }
  }
}
function rootsOf(doc) { const roots = [doc]; for (const el of doc.querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot); return roots; }
function* sheetsOf(doc) {
  const seen = new Set();
  for (const root of rootsOf(doc)) {
    for (const s of [...(root.styleSheets || []), ...(root.adoptedStyleSheets || [])]) {
      if (seen.has(s)) continue; seen.add(s);
      let rules; try { rules = s.cssRules; } catch (e) { continue; }
      if (rules) yield rules;
    }
  }
}
function* allRules(doc) { for (const rules of sheetsOf(doc)) yield* styleRules(rules); }
const customProps = st => { const out = []; for (let i = 0; i < st.length; i++) if (st[i].startsWith('--')) out.push(st[i]); return out; };
const isScope = r => /^(:root|html|body)$/i.test(r.selectorText.trim()) || customProps(r.style).length >= SCOPE_MIN;
const firstMatch = (doc, sel) => { try { return doc.querySelector(sel); } catch (e) { return null; } };
const mediaOn = (W, m) => { if (!m) return true; try { return W.matchMedia(m).matches; } catch (e) { return false; } };

// ---- prefers-color-scheme -------------------------------------------------------------------------------------
// The capture keeps both branches of prefers-color-scheme. The build answers them for the theme it builds (the one
// captured, unless the demo asks for the other), with an always-true or always-false query that still says which
// branch it was (dark: width, light: height), so playback can switch them without the original text.
export const SCHEME_TOKENS = { dark: ['(min-width: 0.0001px)', '(max-width: -0.0001px)'], light: ['(min-height: 0.0001px)', '(max-height: -0.0001px)'] };
const PCS = /\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/gi;
export const pinSchemeText = (text, scheme) => text.replace(PCS, (m, v) => { v = v.toLowerCase(); return SCHEME_TOKENS[v][v === scheme ? 0 : 1]; });
const TOKEN_RE = /\((min|max)-(width|height):\s*(-?)0\.0001px\)/g;
const setTokens = (text, scheme) => text.replace(TOKEN_RE, (m, mm, wh) => { const branch = wh === 'width' ? 'dark' : 'light'; return SCHEME_TOKENS[branch][branch === scheme ? 0 : 1]; });
// Playback: every pinned query in the document (rules, @import, <style media>, <link media>) answered for `scheme`.
export function setScheme(doc, scheme) {
  let n = 0;
  const walk = rules => { for (const r of rules) {
    if (r.media && r.media.mediaText && TOKEN_RE.test(r.media.mediaText)) { TOKEN_RE.lastIndex = 0; const t = setTokens(r.media.mediaText, scheme); if (t !== r.media.mediaText) { r.media.mediaText = t; n++; } }
    TOKEN_RE.lastIndex = 0;
    if (r.cssRules) walk(r.cssRules);
  } };
  for (const rules of sheetsOf(doc)) walk(rules);
  for (const el of doc.querySelectorAll('style[media],link[media]')) { const v = el.getAttribute('media'), t = setTokens(v, scheme); if (t !== v) { el.setAttribute('media', t); n++; } }
  return n;
}

// ---- theme pack ----------------------------------------------------------------------------------------------
function markersOf(el) {
  if (!el) return null;
  const attrs = {};
  for (const a of MARKER_ATTRS) if (el.hasAttribute(a)) attrs[a] = el.getAttribute(a);
  return { classes: [...el.classList].filter(c => THEME_CLASS.test(c)), attrs, colorScheme: el.style.colorScheme || '' };
}
// How the page looks (its opaque background behind the middle of the screen): light or dark.
export function modeOf(doc, R) {
  const W = doc.defaultView, own = !R; R = R || resolver(doc);
  const lum = s => { const v = R.color(s); return v && v[3] >= 0.5 ? (0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]) / 255 : null; };
  let mode = 'light';
  out: for (const e of [doc.elementFromPoint(W.innerWidth / 2, W.innerHeight / 2), doc.body, doc.documentElement]) {
    for (let x = e; x; x = x.parentElement) { const l = lum(W.getComputedStyle(x).backgroundColor); if (l !== null) { mode = l < 0.5 ? 'dark' : 'light'; break out; } }
  }
  if (own) R.done();
  return mode;
}
// The theme's name, from its markers: Primer's per-mode theme, a theme class, a data-theme value, else the mode.
function themeName(markers, mode) {
  const h = markers.html || { classes: [], attrs: {} }, b = markers.body || { classes: [], attrs: {} };
  const a = { ...b.attrs, ...h.attrs };
  if (a['data-color-mode'] && (a['data-dark-theme'] || a['data-light-theme'])) return a[mode === 'dark' ? 'data-dark-theme' : 'data-light-theme'] || mode;
  return h.classes.concat(b.classes).find(c => /theme/i.test(c)) || a['data-theme'] || a['data-color-scheme'] || a['data-theme-tone'] || mode;
}
export function extractThemePack(doc, app = '') {
  const W = doc.defaultView, R = resolver(doc);
  const tokens = {}, colors = {}, css = [], scopes = new Set();
  const html = doc.documentElement, body = doc.body;
  let cssBytes = 0;
  for (const r of allRules(doc)) {
    const props = customProps(r.style);
    if (r.__sdThemed) {
      // A theme-keyed rule that's on here (its media matches, something matches it): carried in the pack, so a
      // capture that never loaded this theme's CSS can still switch to it.
      if (!mediaOn(W, r.__sdMedia)) continue;
      const el = firstMatch(doc, r.selectorText); if (!el) continue;
      if (cssBytes < 3e6) { const t = r.__sdMedia ? `@media ${r.__sdMedia}{${r.cssText}}` : r.cssText; css.push(t); cssBytes += t.length; }
      const cs = W.getComputedStyle(el === html || el === body ? el : el);
      for (const p of props) if (!(p in colors)) { const k = R.key(cs.getPropertyValue(p)); if (k) colors[p] = k; }
      continue;
    }
    if (!props.length || !isScope(r) || !mediaOn(W, r.__sdMedia)) continue;
    scopes.add(r.selectorText.replace(/r[0-9a-z]+$/i, '*').slice(0, 80));
    const el = firstMatch(doc, r.selectorText), cs = el && W.getComputedStyle(el);
    // The value in effect where the rule applies (a theme-keyed rule can override an unthemed one on the same element:
    // Copilot's :root is light as declared, dark in effect on a dark page).
    for (const p of props) {
      if (!(p in tokens)) tokens[p] = (cs && cs.getPropertyValue(p).trim()) || r.style.getPropertyValue(p).trim();
      if (cs && !(p in colors)) { const k = R.key(cs.getPropertyValue(p)); if (k) colors[p] = k; }
    }
  }
  for (const el of [html, body]) if (el) for (const p of customProps(el.style)) { tokens[p] = el.style.getPropertyValue(p).trim(); const k = R.key(W.getComputedStyle(el).getPropertyValue(p)); if (k) colors[p] = k; }
  const mode = modeOf(doc, R);
  R.done();
  const markers = { html: markersOf(html), body: markersOf(body) };
  return { kind: 'stuntdouble-theme-pack', version: 1, app, theme: themeName(markers, mode), mode, at: new Date().toISOString(), scopes: [...scopes], markers, tokens, colors, css };
}

// Votes, per role, from a colour in one theme to the colour the same token has in the other. Several tokens share a
// colour in one theme and not the other (dark #292929 is Background1, Background8, Background4Hover...), so a base
// token outvotes its states (Hover, Pressed, Selected, Disabled) and the special ones (Inverted, OnBrand, Static).
const STATE_TOKEN = /Hover|Pressed|Selected|Disabled|Inverted|OnBrand|Static|Alpha|Shadow|Active|Focus|Rest$/;
export function buildPalette(fromColors, toColors) {
  const votes = { bg: {}, fg: {}, stroke: {}, any: {} };
  for (const [name, ka] of Object.entries(fromColors)) {
    const kb = toColors[name]; if (!kb) continue;
    const w = STATE_TOKEN.test(name) ? 1 : 3;
    for (const role of new Set([roleOfToken(name), 'any'])) {
      const v = votes[role][ka] || (votes[role][ka] = {});
      v[kb] = (v[kb] || 0) + w;
    }
  }
  const pick = v => { let best = null, n = 0; for (const [k, c] of Object.entries(v)) if (c > n) { best = k; n = c; } return best; };
  const out = {};
  for (const role of Object.keys(votes)) { out[role] = {}; for (const [k, v] of Object.entries(votes[role])) out[role][k] = pick(v); }
  return out;
}

// One colour through the palette: an exact match in its role, then any role, then the same RGB at another alpha
// (Fluent's translucent strokes and shadows share the opaque colour's mapping, keeping their own alpha).
function mapColor(pal, c, role, stats) {
  if (!c || c[3] === 0) return null;
  const k = colorKey(c), kOpaque = colorKey([c[0], c[1], c[2], 1]);
  const exact = pal[role][k] || pal.any[k];
  const hit = exact || (c[3] < 1 && (pal[role][kOpaque] || pal.any[kOpaque]));
  if (!hit) { stats.unmapped[k] = (stats.unmapped[k] || 0) + 1; return null; }
  const t = fromKey(hit);
  return fmt(t, exact ? t[3] : +(c[3] * t[3]).toFixed(3));
}
function recolorValue(pal, R, value, role, stats) {
  if (!value || value.includes('var(')) return null;
  let changed = false;
  const out = value.replace(COLOR_FN, m => { const t = mapColor(pal, R.color(m), role, stats); if (t) { changed = true; return t; } return m; });
  return changed ? out : null;
}

// Switches doc to the pack's theme, any number of times and back. Each rule, inline style and SVG paint remembers
// the theme it is in now (the captured one until first switched), and its literal colours map from that theme's
// colours to the pack's; tokens are set from the pack. After a morph, only what's new is switched.
function paletteFor(doc, from, pack) {
  const cache = doc.__sdPals || (doc.__sdPals = new Map());
  let byFrom = cache.get(pack); if (!byFrom) cache.set(pack, byFrom = new Map());
  let pal = byFrom.get(from);
  if (!pal) {
    pal = buildPalette(from.colors, pack.colors);
    // Literal colours learned from one screen captured in both themes (pack.literals[fromMode][role][from] = to,
    // harness learnLiterals): for apps that paint with literals (Fluent v8), they win over the token guess.
    const lit = pack.literals && pack.literals[from.mode];
    if (lit) for (const role of Object.keys(lit)) Object.assign(pal[role] || (pal[role] = {}), lit[role]);
    byFrom.set(from, pal);
  }
  return pal;
}
export function applyTheme(doc, pack, opts = {}) {
  const captured = doc.__sdThemeCaptured || (doc.__sdThemeCaptured = opts.current || extractThemePack(doc));
  const shown = doc.__sdShown || captured;
  const stats = { from: shown.theme, to: pack.theme, mode: [shown.mode, pack.mode], markers: 0, css: 0, tokens: 0, literal: 0, inline: 0, svg: 0, unmapped: {} };
  if (!doc.__sdShown && pack.theme === captured.theme && pack.mode === captured.mode && !opts.force) return stats;
  const R = resolver(doc);
  // The switch is instant: the apps animate colour changes (Fluent buttons fade their background), which would
  // otherwise show a half-flipped frame.
  const still = doc.createElement('style');
  still.textContent = '*,*::before,*::after{transition:none!important;animation-play-state:paused!important}';
  (doc.head || doc.documentElement).appendChild(still);
  // Markers first: a class like theme-darkV2 or Primer's data-color-mode switches rule sets the page already has.
  // Every time, not only on a change: a morph brings the captured page's markers and media queries back.
  for (const [el, k] of [[doc.documentElement, 'html'], [doc.body, 'body']]) {
    const to = pack.markers[k]; if (!el || !to) continue;
    for (const from of [shown.markers[k], captured.markers[k]]) if (from) for (const c of from.classes) if (!to.classes.includes(c) && el.classList.contains(c)) { el.classList.remove(c); stats.markers++; }
    for (const c of to.classes) if (!el.classList.contains(c)) { el.classList.add(c); stats.markers++; }
    for (const [a, v] of Object.entries(to.attrs)) if (el.getAttribute(a) !== v) { el.setAttribute(a, v); stats.markers++; }
    if (to.colorScheme || (shown.markers[k] || {}).colorScheme || (captured.markers[k] || {}).colorScheme) el.style.colorScheme = to.colorScheme || pack.mode;
  }
  for (const m of new Set([shown.mode, captured.mode])) if (m !== pack.mode) {
    const sel = MARKER_ATTRS.map(a => `[${a}="${m}"]`).join(',');
    for (const el of doc.querySelectorAll(sel)) for (const a of MARKER_ATTRS) if (el.getAttribute(a) === m) { el.setAttribute(a, pack.mode); stats.markers++; }
  }
  doc.documentElement.style.colorScheme = pack.mode;
  stats.schemeQueries = setScheme(doc, pack.mode);
  // Theme CSS the page never loaded (GitHub fetches only the active Primer theme). By rule text, not selector: a page
  // can hold a thinner rule under the same selector (Copilot's light page keeps a few dark tokens on
  // :root[data-color-scheme=dark]; the dark page has all of them).
  let st = doc.getElementById('stuntdouble-theme-css');
  if (st) st.textContent = '';
  const have = new Set(); for (const r of allRules(doc)) if (r.__sdThemed) have.add(r.__sdMedia ? `@media ${r.__sdMedia}{${r.cssText}}` : r.cssText);
  const add = pack === captured ? [] : (pack.css || []).filter(t => !have.has(t));
  if (add.length) {
    if (!st) { st = doc.createElement('style'); st.id = 'stuntdouble-theme-css'; (doc.head || doc.documentElement).appendChild(st); }
    st.textContent = add.join('\n'); stats.css = add.length;
  }
  for (const r of allRules(doc)) {
    if (r.__sdThemed || r.parentStyleSheet?.ownerNode?.id === 'stuntdouble-theme-css') continue;
    const from = r.__sdIn || captured; if (from === pack) continue;
    const pal = paletteFor(doc, from, pack); r.__sdIn = pack;
    const sty = r.style, scope = isScope(r);
    for (let i = sty.length - 1; i >= 0; i--) {
      const p = sty[i], v = sty.getPropertyValue(p), prio = sty.getPropertyPriority(p);
      if (p.startsWith('--')) {
        if (scope && pack.tokens[p] !== undefined) { if (v.trim() !== pack.tokens[p]) { sty.setProperty(p, pack.tokens[p], prio); stats.tokens++; } continue; }
        const t = recolorValue(pal, R, v, roleOfToken(p), stats); if (t) { sty.setProperty(p, t, prio); stats.literal++; }
      } else if (COLOR_PROPS.test(p)) {
        const t = recolorValue(pal, R, v, roleOfProp(p), stats); if (t) { sty.setProperty(p, t, prio); stats.literal++; }
      } else if (p === 'color-scheme' && /\b(light|dark)\b/.test(v) && !/light\s+dark|dark\s+light/.test(v)) sty.setProperty(p, pack.mode, prio);
    }
  }
  for (const root of rootsOf(doc)) {
    for (const el of root.querySelectorAll('[style]')) {
      const from = el.__sdIn || captured; if (from === pack) continue;
      const pal = paletteFor(doc, from, pack); el.__sdIn = pack;
      const sty = el.style;
      for (let i = sty.length - 1; i >= 0; i--) {
        const p = sty[i];
        if (!(COLOR_PROPS.test(p) || p.startsWith('--'))) continue;
        if (p.startsWith('--') && (el === doc.documentElement || el === doc.body) && pack.tokens[p] !== undefined) { sty.setProperty(p, pack.tokens[p]); stats.tokens++; continue; }
        const t = recolorValue(pal, R, sty.getPropertyValue(p), p.startsWith('--') ? roleOfToken(p) : roleOfProp(p), stats);
        if (t) { sty.setProperty(p, t, sty.getPropertyPriority(p)); stats.inline++; }
      }
    }
    for (const el of root.querySelectorAll('[fill],[stroke],[stop-color]')) {
      const from = el.__sdSvgIn || captured; if (from === pack) continue;
      const pal = paletteFor(doc, from, pack); el.__sdSvgIn = pack;
      for (const a of ['fill', 'stroke', 'stop-color']) {
        const v = el.getAttribute(a); if (!v || v === 'none' || /^currentcolor$/i.test(v) || v.startsWith('url(')) continue;
        const t = recolorValue(pal, R, v, a === 'stroke' ? 'stroke' : 'fg', stats); if (t) { el.setAttribute(a, t); stats.svg++; }
      }
    }
  }
  doc.__sdShown = pack;
  const settleAll = root => { for (const el of root.querySelectorAll('*')) { doc.defaultView.getComputedStyle(el).color; if (el.shadowRoot) settleAll(el.shadowRoot); } };
  settleAll(doc);
  still.remove();
  R.done();
  return stats;
}

// ---- platform ------------------------------------------------------------------------------------------------
// Switching is lossless: the first switch keeps the captured text, attributes and font stacks, and every later switch
// (any number of times, mid-show) starts from those, so going back gives the capture exactly.
export const PLATFORM_STYLE_ID = 'stuntdouble-platform';
const MOD_NAMES = { '⌘': 'cmd', '⌥': 'alt', '⇧': 'shift', '⌃': 'ctrl', command: 'cmd', cmd: 'cmd', option: 'alt', opt: 'alt', control: 'ctrl', ctrl: 'ctrl', shift: 'shift', alt: 'alt', win: 'meta', meta: 'meta' };
const KEY_WIN = { '↩': 'Enter', return: 'Enter', '⌫': 'Backspace', '⎋': 'Esc', escape: 'Esc', '↑': 'Up', '↓': 'Down', '←': 'Left', '→': 'Right', '⇥': 'Tab' };
const KEY_MAC = { enter: '↩', backspace: '⌫', esc: '⎋', escape: '⎋', up: '↑', down: '↓', left: '←', right: '→' };
const KEY = '(?:Enter|Return|Esc|Escape|Tab|Space|Delete|Del|Backspace|Home|End|PageUp|PageDown|Up|Down|Left|Right|F\\d{1,2}|[A-Z0-9]|[,./;\'\\[\\]=`\\\\-]|↩|⌫|⎋|↑|↓|←|→|⇥)';
const SYM_CHORD = new RegExp(`((?:[⌘⌥⇧⌃]\\s?)+)(${KEY})(?![\\w])`, 'g');
const MODW = '(?:Command|Cmd|Option|Opt|Control|Ctrl|Shift|Alt|Win|Meta)';
// Word chords keep their own look: "Command + Option + O" (spaced) or "Cmd+K"; the key may be a word ("Left bracket").
const WORD_CHORD = new RegExp(`(?<![\\w])(${MODW}(?:\\s?\\+\\s?${MODW})*)(\\s?\\+\\s?)([A-Z][a-z]*(?: (?:bracket|arrow|quote|slash))?|[A-Z0-9]|F\\d{1,2}|[,./;'\\[\\]=\`\\\\-]|↩|⌫|⎋|↑|↓|←|→)(?![\\w])`, 'g');
const WIN_WORD = { command: 'Ctrl', cmd: 'Ctrl', control: 'Ctrl', ctrl: 'Ctrl', meta: 'Ctrl', option: 'Alt', opt: 'Alt', alt: 'Alt', shift: 'Shift', win: 'Win' };
const MAC_WORD = { ctrl: 'Command', control: 'Command', alt: 'Option', shift: 'Shift', win: 'Control', meta: 'Command', command: 'Command', cmd: 'Cmd', option: 'Option', opt: 'Opt' };
function wordChord(m, mods, sep, key, platform) {
  const names = mods.split(/\s?\+\s?/);
  if (platform === 'windows') {
    if (!names.some(n => /^(command|cmd|option|opt|meta)$/i.test(n))) return m;
    const set = new Set(names.map(n => WIN_WORD[n.toLowerCase()]));
    return ['Ctrl', 'Alt', 'Shift', 'Win'].filter(k => set.has(k)).concat(KEY_WIN[key] || key).join(sep);
  }
  if (!names.some(n => /^(ctrl|control|alt|win)$/i.test(n))) return m;
  return [...new Set(names.map(n => MAC_WORD[n.toLowerCase()] || n))].concat(key).join(sep);
}
// One key chord in the other platform's words: ⌥ ⌘ E <-> Ctrl+Alt+E, Command+Shift+P <-> Ctrl+Shift+P. Ctrl on Windows is
// ⌘ on a Mac (the usual mapping; an app with real Control shortcuts needs its own table).
export function shortcutText(s, platform) {
  const conv = (mods, key, spaced) => {
    const set = new Set(mods.map(m => MOD_NAMES[m.toLowerCase()] || MOD_NAMES[m]).filter(Boolean));
    if (platform === 'windows') {
      if (set.has('cmd')) { set.delete('cmd'); set.add('ctrl'); }
      const k = KEY_WIN[key.toLowerCase()] || KEY_WIN[key] || key;
      return ['ctrl', 'alt', 'shift', 'meta'].filter(m => set.has(m)).map(m => ({ ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Win' })[m]).concat(k).join('+');
    }
    if (set.has('ctrl')) { set.delete('ctrl'); set.add('cmd'); }
    if (set.has('meta')) { set.delete('meta'); set.add('ctrl'); }
    const k = KEY_MAC[key.toLowerCase()] || key;
    // Apple's order: Control, Option, Shift, Command.
    return ['ctrl', 'alt', 'shift', 'cmd'].filter(m => set.has(m)).map(m => ({ ctrl: '⌃', alt: '⌥', shift: '⇧', cmd: '⌘' })[m]).concat(k).join(spaced ? ' ' : '');
  };
  // A key cap on its own (<kbd>⌘</kbd><kbd>K</kbd>): the modifier alone, in the other platform's words.
  const lone = /^(\s*)([⌘⌥⇧⌃]|Command|Cmd|Option|Control|Ctrl|Alt|Shift)(\s*)$/i.exec(s);
  if (lone) {
    const m = MOD_NAMES[lone[2].toLowerCase()] || MOD_NAMES[lone[2]];
    const word = platform === 'windows' ? ({ cmd: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' })[m] : ({ ctrl: '⌘', cmd: '⌘', alt: '⌥', shift: '⇧' })[m];
    return word && (platform === 'windows' ? /[⌘⌥⇧⌃]|cmd|command|option/i.test(lone[2]) : true) ? lone[1] + word + lone[3] : s;
  }
  if (platform === 'windows') s = s.replace(SYM_CHORD, (m, mods, key) => conv([...mods.replace(/\s/g, '')], key));
  return s.replace(WORD_CHORD, (m, mods, sep, key) => wordChord(m, mods, sep, key, platform));
}
// aria-keyshortcuts (ARIA names keys Meta/Control/Alt; Teams writes Command/Option): the same chord, other platform.
const MOD_ORDER = { windows: ['Control', 'Alt', 'Shift', 'Meta'], macos: ['Control', 'Alt', 'Shift', 'Meta'] };
const keyshortcuts = (v, platform) => v.split(/\s+/).map(ch => {
  const parts = ch.split('+'), key = parts.pop();
  const mods = new Set(parts.map(p => platform === 'windows' ? ({ Command: 'Control', Meta: 'Control', Option: 'Alt' })[p] || p : ({ Control: 'Meta', Alt: 'Alt' })[p] || p));
  return [...MOD_ORDER[platform].filter(m => mods.has(m)), ...[...mods].filter(m => !MOD_ORDER[platform].includes(m)), key].join('+');
}).join(' ');
// An app's own shortcut table (platform pack .shortcuts): what each control says on the other platform, by the
// control (tag, data-tid or id, and its label with the chord taken out). Learned from one capture on that platform;
// it wins over the generic conversion (Teams' Mac Control+Shift+1 is Control+1 on Windows).
const CHORD_TAIL = /\s*[(,]?\s*((Command|Cmd|Option|Control|Ctrl|Alt|Shift|Meta|Win|[⌘⌥⇧⌃])[\s+]*)+\S*\)?\s*$/;
const controlKey = el => [el.localName, el.getAttribute('data-tid') || el.id || el.getAttribute('role') || '', (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || '').replace(CHORD_TAIL, '').slice(0, 60)].join('|');
const CHORDISH = /[⌘⌥⇧⌃]|\b(Command|Cmd|Option|Ctrl|Control|Alt|Shift)\s?\+|^\s*(Ctrl|Alt|Shift|Control|Option|Command|Cmd)\s*$/;
function origins(doc) {
  if (!doc.__sdOrig) doc.__sdOrig = { texts: new Map(), attrs: new Map(), fonts: new Map() };
  return doc.__sdOrig;
}
function rewriteShortcuts(doc, platform, captured, table) {
  const O = origins(doc); let n = 0;
  for (const root of rootsOf(doc)) {
    const w = doc.createTreeWalker(root, 4 /* SHOW_TEXT */);
    for (let t = w.nextNode(); t; t = w.nextNode()) {
      const p = t.parentElement && t.parentElement.localName; if (p === 'style' || p === 'script') continue;
      const orig = O.texts.has(t) ? O.texts.get(t) : t.data;
      if (!CHORDISH.test(orig)) continue;
      O.texts.set(t, orig);
      const v = platform === captured ? orig : shortcutText(orig, platform);
      if (v !== t.data) { t.data = v; n++; }
    }
    for (const el of root.querySelectorAll('[aria-label],[title],[placeholder],[aria-description],[aria-keyshortcuts]')) {
      for (const a of ['aria-label', 'title', 'placeholder', 'aria-description', 'aria-keyshortcuts']) {
        if (!el.hasAttribute(a)) continue;
        let rec = O.attrs.get(el); const orig = rec && a in rec ? rec[a] : el.getAttribute(a);
        if (a === 'aria-keyshortcuts' ? !/Meta|Control|Command|Option|Alt/.test(orig) : !CHORDISH.test(orig)) continue;
        if (!rec) O.attrs.set(el, rec = {}); rec[a] = orig;
        const known = table && (table[controlKey(el)] || {})[a];
        const v = platform === captured ? orig : known && a === 'aria-keyshortcuts' ? known : a === 'aria-keyshortcuts' ? keyshortcuts(orig, platform) : shortcutText(orig, platform);
        if (v !== el.getAttribute(a)) { el.setAttribute(a, v); n++; }
      }
    }
  }
  return n;
}
// The system font. Each app names it its own way: Teams puts the platform's font first (-apple-system on a Mac),
// admin and IQ ask for "Segoe UI" (a Mac without Microsoft fonts falls to their Segoe UI Web faces), Copilot loads
// Segoe as a web font everywhere. Windows: "Segoe UI" goes first and is backed by the page's own captured Segoe UI
// Web (West European) files, every weight, so a Mac presenter sees real Segoe (not a local copy with missing weights).
// Mac: local-only Windows names leave the stacks, so they fall to what a Mac has (web fonts the page loads stay).
const WIN_ONLY = /^(Segoe UI( Variable( Text| Display| Small)?)?|Segoe UI (Regular|Semibold|Bold|Light|Semilight)|Segoe|Segoe WP|Segoe Sans( Text| Display)?|Leelawadee UI|Segoe UI Emoji|Segoe UI Symbol|Segoe Fluent Icons|Segoe MDL2 Assets)$/i;
const MAC_SYSTEM = /^(-apple-system|BlinkMacSystemFont|system-ui|SF Pro( Text| Display)?|SF NS|Helvetica Neue|\.AppleSystemUIFont)$/i;
const families = v => (v.match(/"[^"]*"|'[^']*'|[^,]+/g) || []).map(s => s.trim()).filter(Boolean);
const famName = f => f.replace(/^["']|["']$/g, '');
function rewriteFonts(doc, platform, captured, fontFaces) {
  const O = origins(doc); let n = 0;
  const faces = new Set();
  for (const root of [doc]) for (const s of sheetsOf(root)) for (const r of s) if (r.constructor.name === 'CSSFontFaceRule') faces.add(famName(r.style.getPropertyValue('font-family').trim()).toLowerCase());
  const fix = (v) => {
    const fams = families(v);
    if (platform === 'windows') {
      const first = famName(fams[0] || '');
      if (!MAC_SYSTEM.test(first) && /segoe/i.test(first)) return v;
      if (!fams.some(f => MAC_SYSTEM.test(famName(f)) || /segoe/i.test(famName(f)))) return v;
      return ['"Segoe UI"', ...fams.filter(f => famName(f).toLowerCase() !== 'segoe ui')].join(', ');
    }
    const kept = fams.filter(f => !WIN_ONLY.test(famName(f)) || faces.has(famName(f).toLowerCase()));
    if (kept.length === fams.length) return v;
    if (!kept.some(f => MAC_SYSTEM.test(famName(f)) || /segoe ui web/i.test(famName(f)))) kept.unshift('-apple-system', 'BlinkMacSystemFont');
    return kept.join(', ');
  };
  for (const r of allRules(doc)) {
    for (const p of ['font-family', '--fontFamilyBase', '--fontFamilyMonospace', '--fontFamilyNumeric', '--font-family', '--fontStack-sansSerif', '--fontStack-system']) {
      let rec = O.fonts.get(r); const cur = r.style.getPropertyValue(p);
      const orig = rec && p in rec ? rec[p] : cur;
      if (!orig || orig.includes('var(')) continue;
      const v = platform === captured ? orig : fix(orig);
      if (v !== orig || (rec && p in rec)) { if (!rec) O.fonts.set(r, rec = {}); rec[p] = orig; }
      if (v !== cur) { r.style.setProperty(p, v, r.style.getPropertyPriority(p)); n++; }
    }
  }
  // Windows: "Segoe UI" from the captured Segoe UI Web faces (all weights), shadowing any local copy.
  let aliases = '';
  if (platform === 'windows') {
    // An app that ships no Segoe UI Web faces (the Copilot app) gets them from the platform pack (fonts from the
    // presenter's own Microsoft captures); never from the public package.
    for (const f of fontFaces || []) aliases += `@font-face{font-family:"Segoe UI";src:${f.src};font-weight:${f.weight || 400};font-style:${f.style || 'normal'};font-display:block}\n`;
    if (!aliases) for (const s of sheetsOf(doc)) for (const r of s) {
      if (r.constructor.name !== 'CSSFontFaceRule' || !/^["']?Segoe UI Web \(West European\)["']?$/i.test(r.style.getPropertyValue('font-family').trim())) continue;
      aliases += `@font-face{font-family:"Segoe UI";src:${r.style.getPropertyValue('src')};font-weight:${r.style.getPropertyValue('font-weight') || 400};font-style:${r.style.getPropertyValue('font-style') || 'normal'};font-display:block}\n`;
    }
  }
  return { n, aliases };
}
// Scrollbars: macOS shows overlay scrollbars only while scrolling (none at rest in a still frame); Windows Chrome
// draws a 15 px (at 100%) light or dark track with a rounded thumb and arrow buttons (Chrome's Fluent scrollbars).
// Containers that style their own scrollbars are left alone.
const WIN_SCROLLBAR_CSS = mode => {
  const thumb = mode === 'dark' ? '#6b6b6b' : '#8b8b8b', track = mode === 'dark' ? '#2b2b2b' : '#f0f0f0';
  return `
:where(html[data-sd-platform="windows"]) :where([data-sd-scroll]) { scrollbar-width: auto; scrollbar-color: ${thumb} ${track}; }
html[data-sd-platform="windows"] [data-sd-scroll]::-webkit-scrollbar { width: 15px; height: 15px; background: ${track}; }
html[data-sd-platform="windows"] [data-sd-scroll]::-webkit-scrollbar-thumb { background: ${thumb}; border: 4px solid ${track}; border-radius: 8px; min-height: 30px; }
html[data-sd-platform="windows"] [data-sd-scroll]::-webkit-scrollbar-button:single-button { display: block; height: 15px; width: 15px; background: ${track}; }`;
};
const MAC_SCROLLBAR_CSS = `
html[data-sd-platform="macos"] [data-sd-scroll] { scrollbar-width: none !important; }
html[data-sd-platform="macos"] [data-sd-scroll]::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }`;
function authoredScrollbar(el, W) {
  const cs = W.getComputedStyle(el);
  if ((cs.scrollbarWidth && cs.scrollbarWidth !== 'auto') || (cs.scrollbarColor && cs.scrollbarColor !== 'auto')) return true;
  const sb = W.getComputedStyle(el, '::-webkit-scrollbar');
  return sb.display === 'none' || (sb.width && sb.width !== 'auto' && sb.width !== '0px');
}
function markScrollers(doc) {
  const W = doc.defaultView; let n = 0;
  const scrolls = el => { const cs = W.getComputedStyle(el); return /(auto|scroll)/.test(cs.overflowY + cs.overflowX) && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1); };
  for (const el of [doc.documentElement, ...doc.querySelectorAll('body *')]) {
    if (el.hasAttribute('data-sd-scroll')) continue;
    if (!scrolls(el) || authoredScrollbar(el, W)) continue;
    el.setAttribute('data-sd-scroll', ''); n++;
  }
  return n;
}
// Window frame. kind 'app': the GitHub Copilot app's own frame (macOS traffic lights at x 19/42/65, top 15, 14 pt; a
// Windows title bar 32 px high with minimise/maximise/close on the right). kind 'browser': a
// Chrome window around a captured web page, for screenshots and video (live playback shows the presenter's own).
// Frames go on the outer document; the page itself isn't shifted for 'browser' (the frame is drawn above it).
export function frameHtml(platform, { kind = 'browser', mode = 'light', title = '', url = '' } = {}) {
  const dark = mode === 'dark';
  if (platform === 'macos') {
    const lights = ['#ff5f57', '#febc2e', '#28c840'].map((c, i) => `<span style="position:absolute;left:${19 + 23 * i - 7}px;top:${kind === 'app' ? 15 : 13}px;width:12px;height:12px;border-radius:50%;background:${c};box-shadow:inset 0 0 0 .5px rgba(0,0,0,.15)"></span>`).join('');
    if (kind === 'app') return `<div data-sd-frame="macos-app" style="position:absolute;inset:0 auto auto 0;width:84px;height:44px;pointer-events:none">${lights}</div>`;
    return `<div data-sd-frame="macos-browser" style="height:38px;position:relative;background:${dark ? '#1f1f1f' : '#dfe1e5'};font:12px -apple-system,BlinkMacSystemFont,sans-serif;color:${dark ? '#e8eaed' : '#202124'}">${lights}
<div style="position:absolute;left:84px;bottom:0;height:30px;width:240px;border-radius:8px 8px 0 0;background:${dark ? '#35363a' : '#fff'};padding:0 12px;display:flex;align-items:center;overflow:hidden;white-space:nowrap">${title}</div></div>
<div style="height:36px;background:${dark ? '#35363a' : '#fff'};display:flex;align-items:center;padding:0 12px;font:13px -apple-system,BlinkMacSystemFont,sans-serif;color:${dark ? '#bdc1c6' : '#5f6368'};border-bottom:1px solid ${dark ? '#202124' : '#dadce0'}"><div style="flex:1;height:28px;border-radius:14px;background:${dark ? '#202124' : '#f1f3f4'};display:flex;align-items:center;padding:0 14px">${url}</div></div>`;
  }
  const btn = d => `<span style="width:46px;display:grid;place-items:center"><svg width="10" height="10" viewBox="0 0 10 10" style="fill:none;stroke:currentColor;stroke-width:1">${d}</svg></span>`;
  const ctl = btn('<path d="M0 5.5h10"/>') + btn('<rect x=".5" y=".5" width="9" height="9"/>') + btn('<path d="m0 0 10 10m0-10L0 10"/>');
  if (kind === 'app') return `<div data-sd-frame="windows-app" style="position:absolute;inset:0 0 auto 0;height:32px;display:flex;align-items:stretch;justify-content:space-between;padding-left:12px;background:${dark ? '#202020' : '#f3f3f3'};color:${dark ? '#fff' : '#1f2328'};font:12px 'Segoe UI',Arial,sans-serif;border-bottom:1px solid ${dark ? 'rgba(255,255,255,.08)' : 'rgba(31,35,40,.15)'};z-index:2147483647"><span style="display:flex;align-items:center;gap:8px">${title}</span><span style="display:flex">${ctl}</span></div>`;
  return `<div data-sd-frame="windows-browser" style="height:41px;position:relative;display:flex;justify-content:space-between;background:${dark ? '#202124' : '#dfe1e5'};color:${dark ? '#e8eaed' : '#202124'};font:12px 'Segoe UI',Arial,sans-serif">
<div style="margin:8px 0 0 8px;height:33px;width:240px;border-radius:8px 8px 0 0;background:${dark ? '#35363a' : '#fff'};padding:0 12px;display:flex;align-items:center;overflow:hidden;white-space:nowrap">${title}</div><span style="display:flex">${ctl}</span></div>
<div style="height:36px;background:${dark ? '#35363a' : '#fff'};display:flex;align-items:center;padding:0 12px;font:14px 'Segoe UI',Arial,sans-serif;color:${dark ? '#bdc1c6' : '#5f6368'};border-bottom:1px solid ${dark ? '#202124' : '#dadce0'}"><div style="flex:1;height:28px;border-radius:14px;background:${dark ? '#202124' : '#f1f3f4'};display:flex;align-items:center;padding:0 14px">${url}</div></div>`;
}

// A platform pack: where an app's window chrome sits on the other platform (header controls by their label, before
// any shortcut), taken once per app from a render on that platform. The GitHub Copilot app places its sidebar
// header from the native traffic lights' inset (inline left: 87px on macOS, 12px on Windows): the pack moves each
// control to its other-platform spot and hides the ones that platform doesn't have (the macOS window buttons).
const BAND = 60;
const WINDOW_BUTTONS = /^(Close|Minimi[sz]e|Maximi[sz]e|Restore|Zoom|Enter Full Screen|Exit Full Screen)$/i;
const labelHead = el => (el.getAttribute('aria-label') || '').split(',')[0].trim();
export function extractPlatformPack(doc, app = '') {
  const controls = {};
  for (const el of doc.querySelectorAll('button[aria-label],a[aria-label],[role=button][aria-label]')) {
    const r = el.getBoundingClientRect(); if (!r.width || r.top > BAND) continue;
    const k = labelHead(el); if (k && !(k in controls)) controls[k] = { x: Math.round(r.left), y: Math.round(r.top) };
  }
  const shortcuts = {};
  for (const el of doc.querySelectorAll('[aria-keyshortcuts],[aria-label],[title],[placeholder]')) {
    const rec = {};
    for (const a of ['aria-keyshortcuts', 'aria-label', 'title', 'placeholder']) { const v = el.getAttribute(a); if (v && (a === 'aria-keyshortcuts' || CHORDISH.test(v))) rec[a] = v; }
    if (Object.keys(rec).length) shortcuts[controlKey(el)] = rec;
  }
  return { kind: 'stuntdouble-platform-pack', version: 1, app, platform: doc.documentElement.getAttribute('data-platform') || (/Win/.test(doc.defaultView.navigator.platform) ? 'windows' : 'macos'), controls, shortcuts };
}
function placeControls(doc, platform, captured, pack) {
  const O = origins(doc);
  if (!O.controls) { O.controls = extractPlatformPack(doc).controls; O.moved = new Set(); }
  for (const el of O.moved) { el.style.removeProperty('translate'); el.style.removeProperty('visibility'); }
  O.moved.clear();
  if (platform === captured || !pack) return 0;
  for (const el of doc.querySelectorAll('button[aria-label],a[aria-label],[role=button][aria-label]')) {
    const k = labelHead(el), here = O.controls[k]; if (!here) continue;
    const there = pack.controls[k];
    // Only window buttons go (the other platform draws its own); app controls the pack's screen didn't show stay.
    if (!there) { if (WINDOW_BUTTONS.test(k)) { el.style.setProperty('visibility', 'hidden', 'important'); O.moved.add(el); } continue; }
    const dx = there.x - here.x, dy = there.y - here.y;
    if (dx || dy) { el.style.setProperty('translate', `${dx}px ${dy}px`, 'important'); O.moved.add(el); }
  }
  return O.moved.size;
}
// The GitHub Copilot app's own window frame on Windows: a native title bar (32 px at 100%) painted in the app's
// background, muted text and border tokens, with the content below it. Live playback on a Mac or in a browser shows
// it inside the page; screenshots and video get the same.
export const APP_TITLEBAR_ID = 'stuntdouble-app-titlebar';
function appFrame(doc, platform, on) {
  let bar = doc.getElementById(APP_TITLEBAR_ID);
  if (!on || platform !== 'windows') { if (bar) bar.remove(); doc.documentElement.removeAttribute('data-sd-app-frame'); return; }
  if (!bar) {
    bar = doc.createElement('div'); bar.id = APP_TITLEBAR_ID; bar.setAttribute('aria-hidden', 'true');
    const btn = d => `<span style="width:46px;display:grid;place-items:center"><svg width="10" height="10" viewBox="0 0 10 10" style="fill:none;stroke:currentColor;stroke-width:1">${d}</svg></span>`;
    bar.innerHTML = `<span style="display:flex;align-items:center;gap:8px;padding-left:12px">GitHub Copilot</span><span style="display:flex">${btn('<path d="M0 5.5h10"/>')}${btn('<rect x=".5" y=".5" width="9" height="9"/>')}${btn('<path d="m0 0 10 10m0-10L0 10"/>')}</span>`;
    bar.style.cssText = 'position:fixed;inset:0 0 auto 0;height:32px;display:flex;justify-content:space-between;align-items:stretch;z-index:2147483647;font:12px "Segoe UI",system-ui,sans-serif;background:var(--background-color-default,#fff);color:var(--text-color-muted,#59636e);border-bottom:1px solid var(--border-color-muted,rgba(31,35,40,.15));box-sizing:border-box';
    doc.body.prepend(bar);
  }
  doc.documentElement.setAttribute('data-sd-app-frame', 'windows');
}
const APP_FRAME_CSS = `html[data-sd-app-frame="windows"] body > :not(#${APP_TITLEBAR_ID}) { translate: 0 32px; }
html[data-sd-app-frame="windows"] body { height: calc(100vh - 32px) !important; overflow: hidden !important; }`;

// Switches doc to a platform. opts.captured: the platform it was captured on (meta.platform; macOS when unknown).
// opts.pack: the app's platform pack for the target platform. opts.frame: 'app' draws the app's own window frame.
// Switching back to the captured platform restores the capture exactly.
export function applyPlatform(doc, platform, opts = {}) {
  const html = doc.documentElement;
  const captured = doc.__sdCaptured || (doc.__sdCaptured = opts.captured || 'macos');
  const O = origins(doc);
  const stats = { platform, captured, shortcuts: 0, fonts: 0, scrollers: 0, controls: 0 };
  html.setAttribute('data-sd-platform', platform);
  // Apps that say their platform on <html> (the Copilot app's data-platform) get it switched: their own CSS follows.
  if (O.platformAttr === undefined) O.platformAttr = html.getAttribute('data-platform');
  if (O.platformAttr !== null) html.setAttribute('data-platform', platform === captured ? O.platformAttr : platform);
  if (opts.shortcuts !== false) stats.shortcuts = rewriteShortcuts(doc, platform, captured, opts.pack && opts.pack.platform === platform ? opts.pack.shortcuts : null);
  let css = '';
  if (opts.fonts !== false) { const f = rewriteFonts(doc, platform, captured, opts.pack && opts.pack.fonts); stats.fonts = f.n; css += f.aliases; }
  if (opts.scrollbars !== false && platform !== captured) { stats.scrollers = markScrollers(doc); css += platform === 'windows' ? WIN_SCROLLBAR_CSS(opts.mode || modeOf(doc)) : MAC_SCROLLBAR_CSS; }
  stats.controls = placeControls(doc, platform, captured, opts.pack);
  appFrame(doc, platform, opts.frame === 'app' && platform !== captured);
  if (opts.frame === 'app' && platform !== captured && platform === 'windows') css += APP_FRAME_CSS;
  let st = doc.getElementById(PLATFORM_STYLE_ID);
  if (css) { if (!st) { st = doc.createElement('style'); st.id = PLATFORM_STYLE_ID; (doc.head || html).appendChild(st); } st.textContent = css; }
  else if (st) st.remove();
  return stats;
}
