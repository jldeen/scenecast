// In-page helper for the hover audit (capture/flow/hover-audit.js). One function expression; evaluated as
// `(${HOVER_PAGE})()` in a page or frame, it installs window.__d1h. Read-only: it never clicks or types.
//
// How a hover is found: the body is cloned at rest, the pointer moves onto an element, and the live body is
// compared with the clone. What changed is either
//   in place: attributes, added or removed children, or text inside the hovered element's own area
//             (Teams' message actions, Microsoft IQ's title actions), or
//   a portal: something that appeared elsewhere in the page, placed against the element (tooltips, hover cards).
() => {
  // A newer copy replaces the one already on the page.
  if (window.__d1h && window.__d1h.obs) window.__d1h.obs.disconnect();
  const norm = s => (s || '').replace(/\s+/g, ' ').trim();
  const ids = new WeakMap(); let nextId = 0;
  const idOf = n => { if (!ids.has(n)) ids.set(n, ++nextId); return ids.get(n); };
  // Attributes that change with focus and keyboard bookkeeping, not with what's on screen.
  const IGN = /^(aria-describedby|aria-labelledby|aria-owns|aria-controls|aria-activedescendant|tabindex|data-tabster|data-tabster-dummy|data-keyboard-nav|data-fui-focus-visible|data-fui-focus-within|data-focus-visible-added|data-is-focusable|data-d1-.+)$/;
  const SKIP = new Set(['script', 'style', 'link', 'noscript', 'template', 'meta']);
  const kids = n => [...n.childNodes].filter(c => (c.nodeType === 1 && !SKIP.has(c.localName) && !(c.hasAttribute && c.hasAttribute('data-tabster-dummy'))) || (c.nodeType === 3 && c.data.trim()));
  const key = n => n.nodeType === 3 ? '#text' : n.localName + '#' + (n.getAttribute('data-testid') || n.getAttribute('data-tid') || n.getAttribute('role') || '');
  function align(A, B) {
    const n = A.length, m = B.length;
    let s = 0; while (s < n && s < m && A[s] === B[s]) s++;
    if (s === n && s === m) return A.map((_, i) => [i, i]);
    let e = 0; while (e < n - s && e < m - s && A[n - 1 - e] === B[m - 1 - e]) e++;
    const a = A.slice(s, n - e), b = B.slice(s, m - e);
    const L = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const out = []; for (let i = 0; i < s; i++) out.push([i, i]);
    let i = 0, j = 0;
    while (i < a.length && j < b.length) { if (a[i] === b[j]) { out.push([s + i, s + j]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++; }
    for (let k = 0; k < e; k++) out.push([n - e + k, m - e + k]);
    return out;
  }
  function diff(a, b, ops) {
    if (b.nodeType === 1) {
      const set = {}, was = {};
      for (const at of b.attributes) if (!IGN.test(at.name) && a.getAttribute(at.name) !== at.value) { set[at.name] = at.value; was[at.name] = a.getAttribute(at.name); }
      for (const at of a.attributes) if (!IGN.test(at.name) && !b.hasAttribute(at.name)) { set[at.name] = null; was[at.name] = at.value; }
      if (Object.keys(set).length) ops.push({ kind: 'attr', host: b, set, was, ra: a });
    }
    const A = kids(a), B = kids(b);
    const pairs = align(A.map(key), B.map(key));
    const mA = new Set(pairs.map(p => p[0])), mB = new Set(pairs.map(p => p[1]));
    B.forEach((c, j) => { if (!mB.has(j)) ops.push({ kind: 'add', host: c, parent: b, ra: a }); });
    A.forEach((c, i) => { if (!mA.has(i)) ops.push({ kind: 'remove', rest: c, parent: b, index: i, ra: a }); });
    for (const [i, j] of pairs) {
      const x = A[i], y = B[j];
      if (y.nodeType === 3) { if (x.data !== y.data) ops.push({ kind: 'text', host: y, parent: b, was: x.data, ra: a, rt: x }); }
      else diff(x, y, ops);
    }
  }
  const sigOf = o => o.kind + ':' + idOf(o.parent || o.host) + ':' + (o.kind === 'attr' ? Object.keys(o.set).sort().join(',') : o.kind === 'add' ? key(o.host) : o.kind === 'remove' ? key(o.rest) : '');
  const visible = e => { if (!e || e.nodeType !== 1) return false; const r = e.getBoundingClientRect(); if (!(r.width > 1 && r.height > 1)) return false; const cs = getComputedStyle(e); return cs.visibility !== 'hidden' && +cs.opacity > 0.05; };
  const hostEl = o => o.kind === 'attr' ? o.host : o.kind === 'add' ? o.host : o.parent;
  const depth = e => { let d = 0; for (; e; e = e.parentElement) d++; return d; };
  const lca = (a, b) => { const s = new Set(); for (let e = a; e; e = e.parentElement) s.add(e); for (let e = b; e; e = e.parentElement) if (s.has(e)) return e; return document.documentElement; };
  const INTERACTIVE = 'a[href],button,[role=button],[role=link],[role=tab],[role=menuitem],[role=treeitem],[role=option],[role=switch],[role=checkbox],[role=row],[role=gridcell],[role=listitem],li,[tabindex],input,textarea,[contenteditable=true],img,[title],[aria-describedby]';
  // Child indices skip what the serializer drops (scripts, templates), so a path means the same in the replica.
  const ekids = el => [...el.children].filter(c => !/^(script|noscript|template|base)$/.test(c.localName));
  const pathFrom = (anc, el) => { const p = []; for (let e = el; e && e !== anc; e = e.parentElement) { const par = e.parentElement; if (!par) return null; p.unshift(ekids(par).indexOf(e)); } return p; };
  const openTag = e => '<' + e.localName + [...e.attributes].filter(a => !/^data-d1-/.test(a.name)).map(a => ' ' + a.name + '="' + a.value.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '"').join('') + '>';
  const stableAttr = v => v !== null && v.length < 140 && !/(^|[_-])r[_:]?[0-9a-z]+_|^_r_|^menur|^tooltip-|[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v);
  function specOf(el) {
    let sel = el.localName;
    for (const a of ['role', 'data-testid', 'data-tid', 'aria-label', 'type', 'data-chip-item', 'data-list-row']) { const v = el.getAttribute(a); if (v !== null && stableAttr(v)) sel += '[' + a + '="' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]'; }
    if (sel === el.localName) { const c = [...el.classList].find(c => /^___[a-z0-9]+$/.test(c)) || [...el.classList].find(c => /^fui-[A-Za-z]+(__[A-Za-z]+)?$/.test(c)) || [...el.classList].find(c => /^ms-[A-Za-z]+(-[A-Za-z]+)?$/.test(c)); if (c) sel += '.' + c; }
    const spec = { sel };
    const t = norm(el.innerText);
    if (t && t.length <= 100) spec.text = t; else if (t) spec.textStarts = t.slice(0, 60);
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const tid = p.getAttribute('data-testid'), dtid = p.getAttribute('data-tid');
      if (tid && stableAttr(tid)) { spec.in = '[data-testid="' + tid + '"]'; break; }
      if (dtid && stableAttr(dtid)) { spec.in = '[data-tid="' + dtid + '"]'; break; }
      if (['aside', 'nav', 'main', 'header', 'dialog'].includes(p.localName)) { spec.in = p.localName; break; }
    }
    const ok = e => e.matches(sel) && (!spec.in || e.closest(spec.in)) && (spec.text === undefined || norm(e.innerText) === spec.text) && (spec.textStarts === undefined || norm(e.innerText).startsWith(spec.textStarts));
    spec.count = [...document.querySelectorAll(sel)].filter(ok).length;
    return spec;
  }
  const rect = e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };

  const H = {
    rest: null, noiseSigs: new Set(), done: new Set(), mut: 0, lastMut: 0,
    init() {
      if (H.obs) return;
      H.obs = new MutationObserver(list => { H.mut += list.length; H.lastMut = performance.now(); });
      H.obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    },
    takeRest() { H.rest = document.body.cloneNode(true); H.mutAtRest = H.mut; H.cssRest = new Set(document.querySelectorAll('style,link[rel~="stylesheet"]')); return true; },
    // Stylesheets that arrived since the rest copy (a menu whose styles load when it first opens, and may go again
    // when it closes): marked data-d1-hcss for the serializer.
    markNewCss() { let n = 0; for (const e of document.querySelectorAll('style,link[rel~="stylesheet"]')) if (!(H.cssRest || new Set()).has(e) && e.sheet) { e.setAttribute('data-d1-hcss', ''); n++; } return n; },
    unmarkCss() { for (const e of document.querySelectorAll('[data-d1-hcss]')) e.removeAttribute('data-d1-hcss'); },
    quietFor() { return performance.now() - H.lastMut; },
    ops() { const ops = []; diff(H.rest, document.body, ops); return ops.filter(o => !H.noiseSigs.has(sigOf(o))); },
    sig() { return H.ops().map(sigOf).sort().join('|'); },
    count() { return H.mut - H.mutAtRest; },
    // Something visible appeared away from the pointer (a tooltip or card), not just a change under it.
    farVisible(x, y) {
      const target = document.elementFromPoint(x, y); if (!target) return false;
      for (const o of H.ops()) { const h = hostEl(o); if (!h || !h.isConnected) continue; const l = lca(h, target); const up = depth(target) - depth(l); if (!(l !== document.body && l !== document.documentElement && depth(l) > 3 && up <= 9)) { if (o.kind !== 'remove' && (visible(h) || [...h.querySelectorAll('*')].some(visible))) return true; } }
      return false;
    },
    noise() { const ops = []; diff(H.rest, document.body, ops); ops.forEach(o => H.noiseSigs.add(sigOf(o))); return ops.length; },
    // Candidates on screen: interactive elements and list items, one per element under their centre.
    candidates(opt) {
      opt = opt || {};
      const root = opt.region ? document.querySelector(opt.region) : document.body;
      if (!root) return [];
      const out = []; const seen = new Set();
      const perSel = {};
      // The recording's hovers (opt.floor: [{ id, anchor, scope }]), found as the replica finds them: the anchor by its
      // selector, place and words, then down its scope (child by child). A control that is that element, holds it or
      // is inside it is theirs (c.floor: their ids).
      const fmatch = (el, m) => { try { if (m.sel && !el.matches(m.sel)) return false; } catch (e) { return false; } if (m.in && !el.closest(m.in)) return false; if (m.text !== undefined && norm(el.innerText) !== m.text) return false; if (m.textStarts !== undefined && !norm(el.innerText).startsWith(m.textStarts)) return false; return true; };
      const ekids = el => [...el.children].filter(c => !/^(script|noscript|template|base)$/.test(c.localName));
      const targets = [];
      for (const f of opt.floor || []) {
        let els = []; try { els = [...document.querySelectorAll(f.anchor.sel)]; } catch (e) {}
        for (const e of els) if (fmatch(e, f.anchor)) { const t = (f.scope || []).reduce((x, i) => x && ekids(x)[i], e); if (t) targets.push([t, f.id]); }
      }
      for (const e of root.querySelectorAll(opt.sel || INTERACTIVE)) {
        if (!visible(e)) continue;
        const r = e.getBoundingClientRect();
        const x = Math.round(r.x + Math.min(r.width / 2, 40)), y = Math.round(r.y + r.height / 2);
        if (x < 1 || y < 1 || x > innerWidth - 2 || y > innerHeight - 2) continue;
        const at = document.elementFromPoint(x, y);
        if (!at || !(e === at || e.contains(at))) continue;
        const owner = at.closest(INTERACTIVE) || at;
        const id = idOf(owner);
        if (seen.has(id) || H.done.has(id)) continue;
        seen.add(id);
        const s = specOf(owner);
        const k = s.sel + '|' + (s.in || ''), text = (s.text || s.textStarts || '').slice(0, 60);
        const fl = targets.length ? [...new Set(targets.filter(([t]) => t === owner || t.contains(owner) || owner.contains(t)).map(([, fid]) => fid))] : [];
        perSel[k] = (perSel[k] || 0) + 1;
        // A control the recording has a hover for is never left out for its kind's count.
        if (perSel[k] > (opt.perSel || 14) && !fl.length) continue;
        out.push({ x, y, id, sel: s.sel, text, ...(fl.length ? { floor: fl } : {}) });
      }
      return out;
    },
    markDone(id) { H.done.add(id); },
    // What the hover at (x, y) changed, split into in-place changes and portals. Parts to serialize get
    // data-d1-hpart="N"; unmark() takes the marks off again.
    result(x, y) {
      const target = document.elementFromPoint(x, y);
      if (!target) return null;
      const ops = H.ops();
      if (!ops.length) return null;
      const near = [], far = [];
      for (const o of ops) {
        const h = hostEl(o);
        if (!h || !h.isConnected) continue;
        const l = lca(h, target);
        const up = depth(target) - depth(l);
        (l !== document.body && l !== document.documentElement && depth(l) > 3 && up <= 9 ? near : far).push(o);
      }
      let n = 0; const mark = e => { e.setAttribute('data-d1-hpart', String(n)); return n++; };
      const res = { target: specOf(target.closest(INTERACTIVE) || target), at: { x, y } };
      // In place: relative to the smallest element holding the target and every change.
      const nearOk = near;
      if (nearOk.length) {
        let anchor = target;
        for (const o of nearOk) anchor = lca(anchor, hostEl(o));
        res.anchor = specOf(anchor);
        // The anchor is found at rest, so its text is the text before the hover: without what the hover added.
        for (const key of ['text', 'textStarts']) if (res.anchor[key]) {
          let t = res.anchor[key];
          for (const o of nearOk) if (o.kind === 'add') { const a = norm(o.host.nodeType === 1 ? o.host.innerText : o.host.data); if (a) t = norm(t.replace(a, ' ')); }
          res.anchor[key] = t;
        }
        res.anchorRect = rect(anchor);
        res.ops = nearOk.map(o => {
          if (o.kind === 'attr') return { kind: 'attr', path: pathFrom(anchor, o.host), set: o.set, was: o.was, tag: o.host.localName };
          if (o.kind === 'add') {
            if (o.host.nodeType === 3) return { kind: 'addText', path: pathFrom(anchor, o.parent), text: o.host.data, before: kids(o.parent).indexOf(o.host) };
            return { kind: 'add', path: pathFrom(anchor, o.parent), index: ekids(o.parent).indexOf(o.host), part: mark(o.host), tag: o.host.localName };
          }
          if (o.kind === 'remove') return { kind: 'remove', path: pathFrom(anchor, o.parent), index: o.rest.nodeType === 1 ? ekids(o.rest.parentNode).indexOf(o.rest) : -1, restTag: o.rest.nodeType === 1 ? o.rest.localName : '#text', restText: norm(o.rest.textContent).slice(0, 80) };
          return { kind: 'text', path: pathFrom(anchor, o.parent), text: o.host.data, was: o.was, index: kids(o.parent).filter(c => c.nodeType === 3).indexOf(o.host) };
        });
      }
      // Portals: the new or newly shown element, the shells it sits in, and where it was placed.
      const portals = [];
      const seenTop = new Set();
      for (const o of far) {
        let el = o.kind === 'add' ? o.host : o.kind === 'attr' ? o.host : null;
        if (!el || el.nodeType !== 1) continue;
        // Climb to the outermost new or changed element that doesn't hold the target.
        if (o.kind === 'attr') { while (el.parentElement && el.parentElement !== document.body && !el.parentElement.contains(target) && el.parentElement.children.length === 1) el = el.parentElement; }
        if (seenTop.has(el)) continue;
        seenTop.add(el);
        const vis = visible(el) || [...el.querySelectorAll('*')].some(visible);
        if (!vis) continue;
        const shells = []; for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) shells.unshift(openTag(p));
        const all = [el, ...el.querySelectorAll('*')];
        const pos = all.find(e => /translate/.test(e.style.transform || '') || ((e.style.left || e.style.top) && /absolute|fixed/.test(getComputedStyle(e).position)));
        const ids2 = all.map(e => e.id).filter(Boolean);
        let trigger = null;
        for (const id of ids2) { trigger = document.querySelector('[aria-describedby~="' + CSS.escape(id) + '"],[aria-labelledby~="' + CSS.escape(id) + '"]'); if (trigger) break; }
        if (!trigger || !trigger.contains(target) && !target.contains(trigger)) trigger = target.closest(INTERACTIVE) || target;
        portals.push({ part: mark(el), shells, trigger: specOf(trigger), triggerRect: rect(trigger), pos: pos ? { rect: rect(pos), transform: pos.style.transform || '', left: pos.style.left, top: pos.style.top, placement: pos.getAttribute('data-popper-placement') || '', path: pathFrom(el, pos) } : null, rect: rect(el), text: norm(el.innerText).slice(0, 300), kind: o.kind });
      }
      if (portals.length) res.portals = portals;
      if (!res.ops && !res.portals) return null;
      res.far = far.length; res.near = near.length;
      return res;
    },
    unmark() { for (const e of document.querySelectorAll('[data-d1-hpart]')) e.removeAttribute('data-d1-hpart'); },
    // ---- click audit -------------------------------------------------------------------------------------------
    // markCtl: the control about to be clicked gets data-d1-ctl, before the rest clone, so the clone has it too.
    markCtl(m) {
      document.querySelectorAll('[data-d1-ctl]').forEach(e => e.removeAttribute('data-d1-ctl'));
      const els = [...document.querySelectorAll(m.sel || '*')].filter(e => visible(e) && (m.text === undefined || norm(e.innerText) === m.text) && (m.textStarts === undefined || norm(e.innerText).startsWith(m.textStarts)) && (m.label === undefined || e.getAttribute('aria-label') === m.label) && (!m.in || e.closest(m.in)));
      const e = els[m.nth || 0];
      if (!e) return null;
      e.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      e.setAttribute('data-d1-ctl', '');
      H.ctl = e;
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), rect: rect(e), spec: specOf(e), attrs: Object.fromEntries([...e.attributes].filter(a => !/^(class|style|data-d1-.*|id)$/.test(a.name)).map(a => [a.name, a.value.slice(0, 200)])) };
    },
    // What's on screen that wasn't at rest (ignoring things that aren't visible).
    visibleOpsList() { const keep = H._vis(); return keep.map(o => o.kind + ' ' + (o.host && o.host.nodeType === 1 ? o.host.localName + '.' + (o.host.getAttribute('role') || '') + (o.host.getAttribute('data-tid') ? '[' + o.host.getAttribute('data-tid') + ']' : '') : '') + ' ' + (o.set ? JSON.stringify(o.set).slice(0, 160) : o.kind === 'add' && o.host.nodeType === 1 ? o.host.outerHTML.slice(0, 200) : o.rest ? (o.rest.outerHTML || o.rest.data || '').slice(0, 160) : o.host && o.host.data)); },
    visibleOps() { return H._vis().length; },
    _vis() {
      // Empty containers a popup leaves behind, and the control's own focus styling, don't count.
      // Tooltips don't count either: Escape gives the control focus back, and focus shows its tooltip.
      const tip = e => !!(e && e.closest && e.closest('[role=tooltip]'));
      const text = e => [...e.querySelectorAll('*')].some(x => visible(x) && !tip(x) && [...x.childNodes].some(c => c.nodeType === 3 && c.data.trim()));
      const content = e => e.nodeType === 3 ? !!e.data.trim() && !tip(e.parentElement) : visible(e) && !tip(e) && (text(e) || [...e.querySelectorAll('svg,img,canvas,input,button')].some(x => visible(x) && !tip(x)));
      const onCtl = e => H.ctl && (H.ctl === e || H.ctl.contains(e));
      return H.ops().filter(o => {
        if (o.kind === 'remove') return o.rest.nodeType === 3 ? !!o.rest.data.trim() : !o.rest.querySelector('[role=tooltip]') && o.rest.getAttribute('role') !== 'tooltip' && (!!norm(o.rest.textContent) || !!o.rest.querySelector('svg,img'));
        if (o.kind === 'text') return !tip(o.parent);
        if (tip(o.host)) return false;
        if (o.kind === 'add') return content(o.host);
        const keys = Object.keys(o.set);
        if (onCtl(o.host) && keys.every(k => /^(class|style|data-.*)$/.test(k))) return false;
        return visible(o.host) && !keys.every(k => /^(data-.*|aria-describedby)$/.test(k));
      });
    },
    // The click's changes: in place (paths in the page as it was before the click, from the smallest element that
    // holds the control and every change) and portals (new layers on the page, placed against the control).
    clickResult(ctlRect) {
      const restCtl = H.rest.querySelector('[data-d1-ctl]');
      if (!restCtl) return null;
      const ops = H.ops();
      if (!ops.length) return null;
      const rdepth = e => { let d = 0; for (; e && e !== H.rest; e = e.parentElement) d++; return d; };
      const rlca = (a, b) => { const s2 = new Set(); for (let e = a; e; e = e.parentElement) s2.add(e); for (let e = b; e; e = e.parentElement) if (s2.has(e)) return e; return H.rest; };
      const near = [], far = [];
      for (const o of ops) { const l = rlca(restCtl, o.ra); (l === H.rest || rdepth(l) <= 1 ? far : near).push(o); }
      let n = 0; const mark = e => { e.setAttribute('data-d1-hpart', String(n)); return n++; };
      const res = { ctl: { rect: ctlRect }, near: near.length, far: far.length };
      if (near.length) {
        let anc = restCtl; for (const o of near) anc = rlca(anc, o.ra);
        let up = 0; for (let e = restCtl; e && e !== anc; e = e.parentElement) up++;
        const rpath = el => { const p = []; for (let e = el; e && e !== anc; e = e.parentElement) p.unshift(ekids(e.parentElement).indexOf(e)); return p; };
        res.up = up; res.anchorTag = anc.localName; res.anchorKids = ekids(anc).length;
        res.ops = near.map(o => {
          if (o.kind === 'attr') return { kind: 'attr', path: rpath(o.ra), tag: o.ra.localName, set: o.set, was: o.was };
          if (o.kind === 'add') {
            if (o.host.nodeType === 3) return { kind: 'addText', path: rpath(o.ra), text: o.host.data, before: kids(o.parent).indexOf(o.host) };
            return { kind: 'add', path: rpath(o.ra), index: ekids(o.parent).indexOf(o.host), part: mark(o.host), tag: o.host.localName };
          }
          if (o.kind === 'remove') return { kind: 'remove', path: rpath(o.ra), index: o.rest.nodeType === 1 ? ekids(o.ra).indexOf(o.rest) : -1, restTag: o.rest.nodeType === 1 ? o.rest.localName : '#text', restText: norm(o.rest.textContent).slice(0, 80) };
          return { kind: 'text', path: rpath(o.ra), index: [...o.ra.childNodes].filter(c => c.nodeType === 3 && c.data.trim()).indexOf(o.rt), text: o.host.data, was: o.was };
        });
      }
      const portals = [];
      for (const o of far) {
        if (o.kind !== 'add' || o.host.nodeType !== 1) continue;
        const el = o.host;
        if (!(visible(el) || [...el.querySelectorAll('*')].some(visible))) continue;
        const shells = []; for (let p2 = el.parentElement; p2 && p2 !== document.body && p2 !== document.documentElement; p2 = p2.parentElement) shells.unshift(openTag(p2));
        const all = [el, ...el.querySelectorAll('*')];
        const pos = all.find(e => /translate/.test(e.style.transform || '') || ((e.style.left || e.style.top || e.style.inset) && /absolute|fixed/.test(getComputedStyle(e).position)));
        portals.push({ part: mark(el), shells, pos: pos ? { rect: rect(pos), transform: pos.style.transform || '', left: pos.style.left, top: pos.style.top, placement: pos.getAttribute('data-popper-placement') || pos.getAttribute('data-placement') || '', path: pathFrom(el, pos) } : null, rect: rect(el), text: norm(el.innerText).slice(0, 300), modal: !!el.querySelector('[aria-modal=true],dialog[open]') || el.getAttribute('aria-modal') === 'true' });
      }
      if (portals.length) res.portals = portals;
      res.farIgnored = far.filter(o => o.kind !== 'add').map(o => o.kind + ':' + (o.ra && o.ra.localName) + ':' + (o.set ? Object.keys(o.set).join(',') : '')).slice(0, 12);
      return (res.ops || res.portals) ? res : null;
    },
    // Buttons and links that appeared with the click (a "reopen" control), for finding how to undo it.
    newControls() {
      const out = [];
      for (const o of H.ops()) if (o.kind === 'add' && o.host.nodeType === 1) for (const e of [o.host, ...o.host.querySelectorAll('button,[role=button],a')]) if (/^(button|a)$/.test(e.localName) || e.getAttribute('role') === 'button') if (visible(e)) { const r = e.getBoundingClientRect(); out.push({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), label: e.getAttribute('aria-label') || norm(e.innerText).slice(0, 40), spec: specOf(e) }); }
      return out;
    },
    // Resize handles: separators and sliders named for resizing, and anything with a resize cursor.
    handles() {
      const out = []; const seen = new Set();
      for (const e of document.querySelectorAll('[role=separator],[role=slider],[data-is-resize-handle],[data-testid*=resize],div,span')) {
        if (seen.has(e) || !visible(e) && e.getAttribute('role') !== 'separator') continue;
        const cs = getComputedStyle(e);
        const named = /resiz/i.test((e.getAttribute('aria-label') || '') + (e.getAttribute('data-testid') || '')) || e.hasAttribute('data-is-resize-handle');
        if (!(named || /^(col-resize|ew-resize|row-resize|ns-resize|e-resize|w-resize)$/.test(cs.cursor))) continue;
        if (e.closest('[role=columnheader]') && !named) continue;
        seen.add(e);
        const r = e.getBoundingClientRect();
        out.push({ rect: rect(e), cursor: cs.cursor, label: e.getAttribute('aria-label'), testid: e.getAttribute('data-testid'), role: e.getAttribute('role'), now: e.getAttribute('aria-valuenow'), min: e.getAttribute('aria-valuemin'), max: e.getAttribute('aria-valuemax'), spec: specOf(e) });
      }
      return out;
    },
  };
  window.__d1h = H;
  H.init();
  return 'installed';
}
