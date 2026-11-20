// In-page DOM serializer. One async function expression, evaluated in a page or frame (Playwright frame.evaluate).
// It writes the rendered document as static HTML:
//  - CSS from the live CSSOM (so insertRule styles from Griffel and merge-styles are kept), adopted sheets too
//  - open shadow roots as declarative shadow DOM
//  - form state (value, checked, selected), scroll offsets, canvases, open popovers and modal dialogs
//  - no scripts, no event handlers, no CSP, no preload hints
// Every resource URL becomes a "d1res://N" token; urls[N] is its absolute URL, so the capture driver can fetch it
// and the processor can point it at a local asset. Child frames marked data-d1-frame="K" become "d1frame://K".
// opts: { body: true } serializes only <body> (streaming frames); { css: false } leaves <style> bodies empty.
async (opts) => {
  opts = opts || {};
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
  const DROP = new Set(['script', 'noscript', 'template', 'base']);
  const RAWTEXT = new Set(['style', 'xmp', 'noembed', 'noframes']);
  const doc = document;
  // prefers-color-scheme in the page's CSS is kept as written, both branches: the build answers it for the theme it
  // builds (the one captured, meta.colorScheme, unless the demo asks for the other), and playback can switch it.
  const DARK = matchMedia('(prefers-color-scheme: dark)').matches;
  const pin = t => t;
  const urls = [];
  const index = new Map();
  const inline = {};
  const absu = (u, b) => { try { return new URL(u, b || doc.baseURI).href; } catch (e) { return null; } };
  const tok = (u, b) => {
    if (!u) return u;
    u = String(u).trim();
    if (!u || /^(data:|about:|javascript:|#|mailto:|tel:)/i.test(u)) return u;
    const a = /^blob:/i.test(u) ? u : absu(u, b);
    if (!a) return u;
    if (!index.has(a)) { index.set(a, urls.length); urls.push(a); }
    return 'd1res://' + index.get(a);
  };
  // url(...) in CSS text, with quoted values that may contain parentheses.
  const cssUrls = (text, b) => {
    let out = '', i = 0;
    for (;;) {
      const j = text.indexOf('url(', i);
      if (j < 0) { out += text.slice(i); break; }
      out += text.slice(i, j);
      let k = j + 4;
      while (text[k] === ' ') k++;
      let val, end;
      if (text[k] === '"' || text[k] === "'") {
        const q = text[k]; let m = k + 1;
        while (m < text.length && text[m] !== q) { if (text[m] === '\\') m++; m++; }
        val = text.slice(k + 1, m); end = text.indexOf(')', m);
      } else { end = text.indexOf(')', k); val = end < 0 ? '' : text.slice(k, end).trim(); }
      if (end < 0) { out += text.slice(j); break; }
      if (/^data:/i.test(val) || val.startsWith('#')) out += text.slice(j, end + 1);
      else out += 'url("' + tok(val.replace(/\\(.)/g, '$1'), b) + '")';
      i = end + 1;
    }
    return out;
  };
  const sheetCss = (sheet) => {
    let rules;
    try { rules = sheet.cssRules; } catch (e) { return null; }
    if (!rules) return null;
    const b = sheet.href || doc.baseURI;
    let out = '';
    for (const r of rules) {
      if (r.type === 3 /* IMPORT */) {
        const t = r.styleSheet ? sheetCss(r.styleSheet) : null;
        if (t !== null) { const m = r.media && r.media.mediaText; out += (m ? '@media ' + pin(m) + '{' + t + '}' : t) + '\n'; }
        else out += '/* d1-import ' + tok(r.href, b) + ' */\n';
        continue;
      }
      out += pin(cssUrls(r.cssText, b)) + '\n';
    }
    return out;
  };
  const escText = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\u00a0/g, '&nbsp;');
  const escAttr = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\u00a0/g, '&nbsp;');
  const rawCss = s => s.replace(/<\/(style)/gi, '<\\/$1');
  const URL_ATTRS = { img: ['src'], image: ['href', 'xlink:href'], input: ['src'], video: ['poster', 'src'], audio: ['src'], source: ['src'], track: ['src'], embed: ['src'], object: ['data'], use: ['href', 'xlink:href'], feimage: ['href', 'xlink:href'], feImage: ['href', 'xlink:href'] };
  const SKIP = new Set(['nonce', 'integrity', 'srcset', 'sizes', 'loading', 'fetchpriority', 'decoding', 'crossorigin', 'referrerpolicy', 'autofocus']);
  const custom = new Set();
  const pending = [];
  let nodes = 0;

  const adopted = root => {
    let s = '';
    for (const sh of (root.adoptedStyleSheets || [])) { const t = sheetCss(sh); if (t !== null) s += '<style data-d1-adopted="">' + (opts.css === false ? '' : rawCss(t)) + '</style>'; }
    return s;
  };

  const SECRET_ATTR = /(^|[-_:])(access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|client[-_]?secret|password|api[-_]?key|authorization)$/i;
  const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, JWT_ALL = new RegExp(JWT.source, 'g');
  const attrs = (el) => {
    const tag = el.localName;
    let s = '';
    const isInput = tag === 'input';
    const urlAttrs = URL_ATTRS[tag] || [];
    for (const a of el.attributes) {
      const n = a.name;
      if (/^on/i.test(n) || SKIP.has(n)) continue;
      if (isInput && (n === 'value' || n === 'checked')) continue;
      if (tag === 'option' && n === 'selected') continue;
      if ((tag === 'iframe' || tag === 'frame') && (n === 'src' || n === 'srcdoc')) continue;
      let v = a.value;
      // Sign-in tokens a page keeps in its markup (Power BI's embeds: powerbi-access-token) never reach the capture: a
      // credential in the raw captures stops the build, and the replica doesn't need it.
      if (SECRET_ATTR.test(n)) v = '';
      else if (v.length > 40 && JWT.test(v)) v = v.replace(JWT_ALL, '');
      if (tag === 'img' && n === 'src') v = el.currentSrc || el.src || v;
      if (urlAttrs.includes(n)) {
        if (tag === 'use' && v.startsWith('#')) { /* internal reference */ }
        else if (tag === 'use') { const h = v.indexOf('#'); v = h > 0 ? tok(v.slice(0, h)) + v.slice(h) : tok(v); }
        else v = tok(v);
      } else if (n === 'style' && v.includes('url(')) v = cssUrls(v);
      else if (n === 'href' && (tag === 'a' || tag === 'area')) { const x = absu(v); if (x && !/^javascript:/i.test(v)) v = x; }
      else if (n === 'href' && tag === 'link') v = tok(v);
      else if (n === 'background') v = tok(v);
      s += ' ' + n + (v === '' ? '=""' : '="' + escAttr(v) + '"');
    }
    if (isInput) {
      const t = (el.type || '').toLowerCase();
      if (t === 'checkbox' || t === 'radio') { if (el.checked) s += ' checked=""'; if (el.indeterminate) s += ' data-d1-indeterminate=""'; }
      else if (t !== 'password' && t !== 'file' && el.value) s += ' value="' + escAttr(el.value) + '"';
    }
    if (tag === 'option' && el.selected) s += ' selected=""';
    if (el.scrollTop || el.scrollLeft) s += ' data-d1-scroll="' + Math.round(el.scrollTop) + ',' + Math.round(el.scrollLeft) + '"';
    try { if (el.matches(':popover-open')) s += ' data-d1-popover=""'; } catch (e) {}
    try { if (tag === 'dialog' && el.matches(':modal')) s += ' data-d1-modal=""'; } catch (e) {}
    if (tag === 'canvas') { try { const d = el.toDataURL('image/png'); const k = 'canvas' + nodes; inline[k] = d; s += ' data-d1-canvas="' + k + '"'; } catch (e) {} }
    if (tag === 'iframe' || tag === 'frame') {
      const k = el.getAttribute('data-d1-frame');
      s += ' src="' + (k ? 'd1frame://' + k : 'about:blank') + '"';
    }
    if (tag.includes('-') && customElements.get(tag)) custom.add(tag);
    return s;
  };

  const ser = (node, inSvg) => {
    nodes++;
    if (node.nodeType === 3) return escText(node.data);
    if (node.nodeType !== 1) return '';
    const el = node, tag = el.localName;
    if (DROP.has(tag)) return '';
    if (tag === 'link') {
      const rel = (el.getAttribute('rel') || '').toLowerCase();
      if (/stylesheet/.test(rel)) {
        if (el.sheet && el.sheet.disabled) return '';
        const t = el.sheet ? sheetCss(el.sheet) : null;
        const media = el.getAttribute('media');
        const m = media && media !== 'all' ? ' media="' + escAttr(pin(media)) + '"' : '';
        if (t !== null) return '<style data-d1-href=""' + m + '>' + (opts.css === false ? '' : rawCss(t)) + '</style>';
        if (!el.href) return '';
        const r = tok(el.href);
        pending.push(r);
        return '<style data-d1-fetch="' + r + '"' + m + '></style>';
      }
      if (/icon/.test(rel)) return '<link' + attrs(el) + '>';
      return '';
    }
    if (tag === 'meta' && el.getAttribute('http-equiv')) return '';
    if (tag === 'style') {
      if (el.sheet && el.sheet.disabled) return '';
      const t = el.sheet ? sheetCss(el.sheet) : pin(el.textContent);
      return '<style' + attrs(el) + '>' + (opts.css === false ? '' : rawCss(t || '')) + '</style>';
    }
    let s = '<' + tag + attrs(el) + '>';
    if (VOID.has(tag) && !inSvg) return s;
    // Open roots, and closed ones the extension handed over (window.__scShadow): both written open, so the replica
    // can reach into them.
    const sr = (el.shadowRoot && el.shadowRoot.mode === 'open' && el.shadowRoot) || (window.__scShadow && window.__scShadow.get(el));
    if (sr) {
      s += '<template shadowrootmode="open" shadowrootclonable=""' + (sr.mode === 'closed' ? ' data-sc-closed=""' : '') + (sr.delegatesFocus ? ' shadowrootdelegatesfocus=""' : '') + '>';
      for (const c of sr.childNodes) s += ser(c, inSvg);
      s += adopted(sr) + '</template>';
    }
    if (tag === 'textarea') return s + escText(el.value || '') + '</textarea>';
    if (RAWTEXT.has(tag)) return s + rawCss(el.textContent) + '</' + tag + '>';
    const svg = (inSvg || tag === 'svg') && tag !== 'foreignObject';
    for (const c of el.childNodes) s += ser(c, svg);
    return s + '</' + tag + '>';
  };

  // blob: resources live only in this document, so read them here.
  const blobs = async () => {
    for (const u of urls) {
      if (!/^blob:/i.test(u) || inline[u]) continue;
      try {
        const b = await (await fetch(u)).blob();
        inline[u] = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.onerror = () => r(null); fr.readAsDataURL(b); });
      } catch (e) {}
    }
  };

  const html = doc.documentElement;
  // { parts: selector }: only those elements (the hover audit's new or changed parts), with their resources.
  if (opts.parts) {
    const parts = [...doc.querySelectorAll(opts.parts)].map(e => ser(e, !!(e.parentElement && e.parentElement.closest('svg')) && e.localName !== 'foreignObject'));
    await blobs();
    return { parts, urls, inline };
  }
  let out;
  if (opts.body) {
    out = ser(doc.body, false);
  } else {
    let head = '';
    for (const c of doc.head.childNodes) head += ser(c, false);
    head += adopted(doc);
    // A page that follows the system (color-scheme: light dark) keeps the one it used: form controls, scrollbars and
    // light-dark() colours too.
    const rs = getComputedStyle(html).colorScheme || '';
    if (/light/.test(rs) && /dark/.test(rs)) head += '<style data-sc-scheme="">:root{color-scheme:' + (DARK ? 'dark' : 'light') + '}</style>';
    out = '<!DOCTYPE html><html' + attrs(html) + '><head>' + head + '</head>' + ser(doc.body, false) + '</html>';
  }
  // Font files the page loaded, by any means (a stylesheet's @font-face, or script through the FontFace API, which
  // leaves no rule in any stylesheet): fetched with the capture, so the fidelity loop can match fonts by file.
  const fontFiles = opts.body ? [] : [...new Set(performance.getEntriesByType('resource').map(e => e.name).filter(u => /\.(woff2?|ttf|otf)([?#]|$)/i.test(u)))];
  for (const u of fontFiles) tok(u);
  await blobs();
  const se = doc.scrollingElement || html;
  return {
    html: out,
    urls,
    inline,
    pending,
    meta: {
      url: location.href,
      title: doc.title,
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      scroll: { top: se.scrollTop, left: se.scrollLeft },
      customElements: [...custom],
      nodes,
      colorScheme: DARK ? 'dark' : 'light',
      // How the page looks (its background where it's opaque), light or dark, whatever the system prefers.
      theme: (() => { const lum = c => { const m = /rgba?\(([^)]+)\)/.exec(c || ''); if (!m) return null; const v = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); if (v.length > 3 && v[3] < 0.5) return null; return (0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]) / 255; };
        for (const e of [doc.elementFromPoint(innerWidth / 2, innerHeight / 2), doc.body, html]) for (let x = e; x; x = x.parentElement) { const l = lum(getComputedStyle(x).backgroundColor); if (l !== null) return l < 0.5 ? 'dark' : 'light'; }
        return DARK && /dark/.test(getComputedStyle(html).colorScheme) ? 'dark' : 'light'; })(),
      fonts: [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family + ' ' + f.weight + ' ' + f.style),
      fontFiles,
      at: new Date().toISOString(),
    },
  };
}
