// In-page recorder. One function expression; `(${REC_PAGE})(opts)` installs window.__rkrec in a page or frame.
// It watches what the person does (clicks, typing, Enter, Escape, drags) and queues each action with a robust
// matcher for the element: data-testid, aria-label, role and text, scoped to a landmark only when needed, never a
// generated class name. The driver (capture/recorder.js) drains the queue, captures what each action changed, and
// writes the flow.
//
// While the driver is capturing (busy), clicks and Enter are held back, so every captured state is the page as it
// settled. Enter in a field is always held back: the driver captures the typed state first, then presses Enter
// itself (pass), so the replica has the screen with the text in the box and the screen after it.
(opts) => {
  if (window.__rkrec) { Object.assign(window.__rkrec.opts, opts || {}); return 'ok'; }
  const norm = s => (s || '').replace(/\s+/g, ' ').trim();
  const R = { q: [], busy: false, pass: 0, dirty: false, opts: opts || {}, seq: 0, lastMut: Date.now(), mut: 0 };
  // The queue survives a same-origin navigation (a click that loads a new page).
  try { const s = sessionStorage.getItem('__rkq'); if (s) R.q = JSON.parse(s) || []; } catch (e) {}
  const save = () => { try { sessionStorage.setItem('__rkq', JSON.stringify(R.q)); } catch (e) {} };
  const push = ev => { ev.t = Date.now(); ev.seq = ++R.seq; ev.url = location.href.split('#')[0].split('?')[0]; R.q.push(ev); save(); };
  R.drain = () => { const q = R.q; R.q = []; save(); return q; };

  // ---- matchers (the same rules as the replica shell's matches()/findEl()) -------------------------------------
  const matches = (el, m) => {
    if (!el || el.nodeType !== 1) return false;
    if (m.sel && !el.matches(m.sel)) return false;
    if (m.in && !el.closest(m.in)) return false;
    if (m.text !== undefined && norm(el.innerText) !== m.text) return false;
    if (m.textStarts !== undefined && !norm(el.innerText).startsWith(m.textStarts)) return false;
    return true;
  };
  const area = e => { const r = e.getBoundingClientRect(); return r.width * r.height; };
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const found = m => { let els; try { els = [...document.querySelectorAll(m.sel || '*')]; } catch (e) { return []; } els = els.filter(e => matches(e, m)).sort((a, b) => area(a) - area(b)); return [...els.filter(visible), ...els.filter(e => !visible(e))]; };
  // Values that change between sessions: React ids, GUIDs, long numbers, generated tooltip/menu ids.
  const STABLE = v => v != null && v.length > 0 && v.length < 120 && !/(^|[_-])r[_:]?[0-9a-z]+_|^_r_|^:r|^menur|^tooltip-|[0-9a-f]{8}-[0-9a-f]{4}-|\d{5,}/i.test(v);
  const q = v => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const OWNER = 'a[href],button,summary,label,select,input,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=treeitem],[role=switch],[role=checkbox],[role=radio],[role=row],[role=gridcell],[role=listitem],[role=combobox],[role=textbox],[role=searchbox],[contenteditable=true],[contenteditable=""],[tabindex]:not([tabindex="-1"])';
  const LANDMARK = '[data-testid],[data-tid],aside,nav,main,header,footer,dialog,[role=dialog],[role=navigation],[role=main],[role=complementary],[role=banner],[role=region][aria-label],[role=toolbar][aria-label],section[aria-label],form[aria-label]';
  const fieldOf = t => {
    if (!t || t.nodeType !== 1) t = t && t.parentElement;
    if (!t) return null;
    if (t.closest('input,textarea')) return t.closest('input,textarea');
    if (t.isContentEditable) { let e = t; while (e.parentElement && e.parentElement.isContentEditable) e = e.parentElement; return e; }
    return t.closest('[role=textbox],[role=searchbox],[role=combobox]');
  };
  const isField = e => !!e && (e.localName === 'input' && !/^(checkbox|radio|button|submit|reset|range|color|file|image)$/i.test(e.type) || e.localName === 'textarea' || e.isContentEditable);
  const valueOf = e => !e ? '' : (e.localName === 'input' || e.localName === 'textarea') ? e.value : norm(e.innerText);
  const landmarkOf = el => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (!p.matches(LANDMARK)) continue;
      const tid = p.getAttribute('data-testid'), dtid = p.getAttribute('data-tid'), lab = p.getAttribute('aria-label'), role = p.getAttribute('role');
      if (tid !== null) { if (STABLE(tid)) return `[data-testid="${q(tid)}"]`; continue; }
      if (dtid !== null) { if (STABLE(dtid)) return `[data-tid="${q(dtid)}"]`; continue; }
      if (['aside', 'nav', 'main', 'header', 'footer', 'dialog'].includes(p.localName)) return p.localName;
      if (role && !lab) return `[role=${role}]`;
      if (lab && STABLE(lab)) return `${role ? `[role=${role}]` : p.localName}[aria-label="${q(lab)}"]`;
    }
    return null;
  };
  // Candidates, best first. Each is checked for picking out this element alone.
  function candidates(el) {
    const tag = el.localName, out = [];
    const role = el.getAttribute('role');
    const a = n => el.getAttribute(n);
    if (STABLE(a('data-testid'))) out.push({ sel: `${tag}[data-testid="${q(a('data-testid'))}"]` });
    if (STABLE(a('data-tid'))) out.push({ sel: `${tag}[data-tid="${q(a('data-tid'))}"]` });
    if (STABLE(a('aria-label'))) out.push({ sel: `${tag}[aria-label="${q(a('aria-label'))}"]` });
    if (isField(el)) {
      let s = tag + (role ? `[role=${role}]` : '') + (el.isContentEditable && el.hasAttribute('contenteditable') ? '[contenteditable=true]' : '');
      if (tag === 'input' && a('type')) s += `[type=${a('type')}]`;
      for (const n of ['placeholder', 'aria-placeholder', 'name', 'data-placeholder']) if (STABLE(a(n))) out.push({ sel: `${s}[${n}="${q(a(n))}"]` });
      out.push({ sel: s });
    }
    const t = norm(el.innerText);
    const base = role ? `[role=${role}]` : tag;
    if (t && !isField(el)) out.push(t.length <= 80 ? { sel: base, text: t } : { sel: base, textStarts: t.slice(0, 60) });
    if (STABLE(a('title'))) out.push({ sel: `${tag}[title="${q(a('title'))}"]` });
    const id = el.id;
    if (id && STABLE(id) && /^[A-Za-z][\w-]*$/.test(id) && !/\d{3,}/.test(id)) out.push({ sel: `${tag}#${id}` });
    out.push({ sel: base });
    return out;
  }
  function specOf(el) {
    const cands = candidates(el);
    const lm = landmarkOf(el);
    let fallback = null;
    for (const c of cands) {
      const hits = found(c);
      if (!hits.includes(el)) continue;
      if (hits.filter(visible).length <= 1) return describe(c, el);
      if (lm) { const c2 = { ...c, in: lm }; const h2 = found(c2); if (h2.includes(el) && h2.filter(visible).length <= 1) return describe(c2, el); }
      if (!fallback) fallback = lm ? { ...c, in: lm } : c;
    }
    const c = fallback || { sel: el.localName };
    const n = found(c).indexOf(el);
    return describe(n > 0 ? { ...c, nth: n } : c, el);
  }
  function describe(m, el) {
    const r = el.getBoundingClientRect();
    return { m, desc: norm(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.innerText || el.localName).slice(0, 60), rect: { x: r.x, y: r.y, w: r.width, h: r.height }, tag: el.localName };
  }
  const ownerOf = t => { if (!t || t.nodeType !== 1) t = t && t.parentElement; if (!t) return null; const f = fieldOf(t); if (f && isField(f)) return f; return t.closest(OWNER) || t; };
  R.specOf = el => specOf(el);
  R.specAt = (x, y) => { const e = document.elementFromPoint(x, y); const o = e && ownerOf(e); return o ? { ...specOf(o), field: isField(o) } : null; };

  // ---- what the page looks like, for "is this a state we already have" -----------------------------------------
  // opts.ignore: selectors whose text changes on its own (a clock, presence, a typing indicator) and isn't a step.
  R.sig = () => {
    let text = norm(document.body ? document.body.innerText : '');
    for (const sel of R.opts.ignore || []) { try { for (const e of document.querySelectorAll(sel)) { const t = norm(e.innerText); if (t) text = text.split(t).join(''); } } catch (e) {} }
    const parts = [location.pathname + location.hash, text];
    for (const e of document.querySelectorAll('[aria-expanded="true"],[aria-selected="true"],[aria-pressed="true"],[aria-checked="true"],[open],dialog,[role=dialog]')) if (visible(e)) parts.push(e.localName + ':' + (e.getAttribute('aria-label') || norm(e.innerText).slice(0, 40)));
    for (const e of document.querySelectorAll('input,textarea')) { if (e.type === 'checkbox' || e.type === 'radio') parts.push('c' + (e.checked ? 1 : 0)); else if (e.value) parts.push('v' + e.value); }
    const s = parts.join('\u0001');
    let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16) + ':' + s.length;
  };
  R.isBusy = list => (list || R.opts.busy || []).some(b => {
    if (b.sel) { try { return [...document.querySelectorAll(b.sel)].some(visible); } catch (e) { return false; } }
    if (b.text) return !!document.body && document.body.innerText.includes(b.text);
    return false;
  });
  R.quiet = () => Date.now() - R.lastMut;
  // What the recorder's automatic side paths need to know about this screen, cheaply:
  //   kind     the kind of screen (its path with ids taken out, and its landmarks): side paths that are the same on
  //            every screen of a kind (zoom, chips, drags) run once per kind
  //   groups   closed step groups (buttons naming the region they open)
  //   list     a list or grid with more rows than it has rendered (virtualized)
  //   handles  resize handles
  //   frames   child frames that hold most of the screen (their own hovers and clicks)
  R.features = groupSel => {
    const vis = e => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1 && getComputedStyle(e).visibility !== 'hidden'; };
    const path = location.pathname.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id').replace(/\/[^/]*\d{3,}[^/]*/g, '/:id').replace(/\/[A-Za-z0-9_-]{24,}/g, '/:id');
    const marks = [...document.querySelectorAll('nav,aside,main,header,dialog[open],[role=dialog],[role=navigation],[role=complementary],[role=main],[role=banner]')].filter(vis).map(e => e.localName + (e.getAttribute('role') ? '=' + e.getAttribute('role') : '') + (STABLE(e.getAttribute('aria-label')) ? ':' + e.getAttribute('aria-label') : '')).sort();
    const kind = path + '|' + [...new Set(marks)].join(',');
    let groups = [];
    try { groups = [...document.querySelectorAll(groupSel || 'button[aria-expanded][aria-controls]')].filter(b => vis(b) && b.getAttribute('aria-expanded') === 'false' && document.getElementById(b.getAttribute('aria-controls'))).map(b => b.getAttribute('aria-controls')); } catch (e) {}
    const list = [...document.querySelectorAll('[aria-rowcount],[role=grid],[role=treegrid],[role=list],[role=listbox],[role=feed]')].some(g => {
      const total = +(g.getAttribute('aria-rowcount') || 0) || Math.max(0, ...[...g.querySelectorAll('[aria-setsize]')].slice(0, 50).map(x => +x.getAttribute('aria-setsize') || 0));
      return total > g.querySelectorAll('[aria-rowindex],[aria-posinset]').length + 2;
    });
    const handles = [...document.querySelectorAll('[role=separator],[role=slider],[data-is-resize-handle],[data-testid*=resize],[class*=resize],[class*=Resize]')].filter(e => (/resiz/i.test((e.getAttribute('aria-label') || '') + (e.getAttribute('data-testid') || '')) || e.hasAttribute('data-is-resize-handle') || /^(col-resize|ew-resize|row-resize|ns-resize)$/.test(getComputedStyle(e).cursor))).length;
    const area = innerWidth * innerHeight;
    const frames = [...document.querySelectorAll('iframe')].filter(f => { const r = f.getBoundingClientRect(); return r.width * r.height > 0.3 * area; }).map(f => { try { return new URL(f.src, location.href).origin + new URL(f.src, location.href).pathname; } catch (e) { return null; } }).filter(Boolean);
    return { kind, groups, list, handles, frames };
  };
  R.colorScheme = () => {
    const bg = getComputedStyle(document.body || document.documentElement).backgroundColor;
    return { dark: matchMedia('(prefers-color-scheme: dark)').matches, bg, scheme: getComputedStyle(document.documentElement).colorScheme };
  };
  try { new MutationObserver(l => { R.mut += l.length; R.lastMut = Date.now(); }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true }); } catch (e) {}

  // ---- listeners -----------------------------------------------------------------------------------------------
  // off: a side path (a click or drag audit) is driving the page; nothing is held back or recorded.
  const on = (type, fn) => addEventListener(type, e => { if (!R.off) fn(e); }, true);
  // A click while text typed in a field is still waiting to be captured (dirty) is held back too: the driver
  // captures the typed screen, then clicks at the same place itself (pass).
  const hold = e => { e.preventDefault(); e.stopImmediatePropagation(); };
  let down = null, held = null;
  on('pointerdown', e => {
    if (R.pass > 0) { down = null; return; }
    if (R.busy) { hold(e); push({ kind: 'blocked', what: 'click' }); down = null; return; }
    if (R.dirty) { hold(e); held = { x: e.clientX, y: e.clientY }; down = null; return; }
    const o = ownerOf(e.target);
    down = { x: e.clientX, y: e.clientY, spec: o ? specOf(o) : null, field: isField(o), moved: 0 };
  }, true);
  on('pointermove', e => { if (down && e.buttons) down.moved = Math.max(down.moved, Math.hypot(e.clientX - down.x, e.clientY - down.y)); }, true);
  on('pointerup', e => {
    if (down && down.moved > 8) { push({ kind: 'drag', spec: down.spec, x0: down.x, y0: down.y, x1: e.clientX, y1: e.clientY }); down.dragged = true; }
  }, true);
  on('mousedown', e => { if (!R.pass && (R.busy || held)) hold(e); }, true);
  on('mouseup', e => { if (!R.pass && (R.busy || held)) hold(e); }, true);
  on('click', e => {
    if (R.pass > 0) { R.pass--; return; }
    if (R.busy) { hold(e); return; }
    if (held) { hold(e); const s = R.specAt(held.x, held.y); if (s) push({ kind: 'click', spec: s, x: held.x, y: held.y, held: true, field: s.field }); held = null; return; }
    if (down && down.dragged) { down = null; return; }
    const o = ownerOf(e.target);
    const spec = (down && down.spec) || (o ? specOf(o) : null);
    if (spec) push({ kind: 'click', spec, x: e.clientX, y: e.clientY, field: down ? down.field : isField(o) });
    down = null;
  }, true);
  on('input', e => {
    const f = fieldOf(e.target);
    if (!f || !isField(f)) return;
    R.dirty = true;
    const last = R.q[R.q.length - 1];
    const ev = { kind: 'input', spec: specOf(f), value: valueOf(f) };
    if (last && last.kind === 'input' && JSON.stringify(last.spec.m) === JSON.stringify(ev.spec.m)) { R.q.pop(); }
    push(ev);
  }, true);
  on('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !e.altKey && !e.metaKey && !e.ctrlKey) {
      const f = fieldOf(e.target);
      if (!f || !isField(f) || f.localName === 'textarea' && R.opts.textareaEnter === false) return;
      if (R.pass > 0) { R.pass--; return; }
      hold(e);
      if (R.busy) { push({ kind: 'blocked', what: 'Enter' }); return; }
      push({ kind: 'enter', spec: specOf(f), value: valueOf(f) });
    } else if (e.key === 'Escape') {
      if (R.busy) return;
      push({ kind: 'esc' });
    }
  }, true);
  window.__rkrec = R;
  return 'installed';
}
