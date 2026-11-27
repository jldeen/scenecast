// The editor: edit mode inside the replica, for people to adjust what the script matcher worked out (or to add their
// own focus points). Loaded only when the replica is served for authoring (scenecast serve / edit, never --release or
// an export), and nothing of it is on screen until its key: ⌥⇧E (Ctrl+Alt+Shift+E on Windows), or ?edit=1.
//   Dots     click anywhere: a focus point on what's there (snapped to the element, with its zoom, box or arrow and
//            its place in the beat worked out). Drag a dot to move it; select it and Delete (or ✕) to remove it, [ and ]
//            (or ↑ ↓) to reorder it, M to switch box/arrow; ▶ previews it the way ⌥F plays it.
//   Wording  drag across text, type the new words, Enter: changed everywhere that text appears (screens and answers).
//   Beats    "Start here" sets which screen a beat key (⌥1–⌥9) starts on.
//   Undo     ⌘Z / Ctrl+Z.
// Every change shows at once and is saved to the demo's focus.json and flow.editor.json (the server checks and writes
// them); nothing needs a build. Done (or the key again) leaves edit mode.
import { presenterKey } from '/app/presenter-key.js';
import { snap, describe, markFor, norm } from '/app/focus-target.js';
import { orderFocus, mergeFocus, stateSequence, beatPositions, beatAt } from '/app/focus-order.js';

const RED = 'rgb(255, 56, 60)';
const clone = v => JSON.parse(JSON.stringify(v));
const slug = s => norm(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32).replace(/^-+|-+$/g, '') || 'point';
const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unescHtml = s => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const reText = t => new RegExp(norm(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['\u2019]").replace(/ /g, '[\\s\u00a0]+'), 'g');
const call = (path, opts = {}) => fetch(new URL(path, location.origin).href, { ...opts, headers: { 'x-scenecast-editor': '1', 'content-type': 'application/json', ...(opts.headers || {}) } }).then(async r => { const v = await r.json().catch(() => ({})); if (!r.ok) throw new Error(v.error || r.status); return v; });

export default function editor(api) {
  const focus = () => api.get('focus');
  const st = { on: false, paused: false, focus: { version: 1, points: [] }, overrides: { version: 1, edits: [], beats: {} }, hand: [], history: [], sel: null, status: '', saving: 0, lastBeat: 0, sig: '', replace: null };
  let ui = null, saves = Promise.resolve();
  const loaded = call('/__replica/editor').then(v => {
    st.focus = { version: 1, ...v.focus, points: v.focus.points || [] };
    st.overrides = { version: 1, edits: v.overrides.edits || [], beats: v.overrides.beats || {} };
    const own = new Set(st.focus.points.map(p => p.id));
    // Points from the demo's focus.mjs: shown, not editable here (they're code).
    st.hand = (api.flow.focus || []).filter(p => !own.has(p.id));
  }).catch(e => { st.status = 'editor: ' + e.message; });

  const all = () => mergeFocus(st.focus.points, st.hand, api.flow);
  const mine = p => !!p && st.focus.points.includes(p);
  function applyPoints() { const list = all(); api.flow.focus = list; if (focus()) focus().setPoints(list); }

  // ---- saving and undo ---------------------------------------------------------------------------------------------
  function save(what, { reload = false } = {}) {
    st.saving++; st.status = 'Saving…'; render();
    const body = JSON.stringify({ focus: st.focus, overrides: st.overrides, what });
    saves = saves.then(() => call('/__replica/editor', { method: 'POST', body }))
      .then(r => { st.status = r.error ? 'Saved, but the flow has a problem: ' + r.error : 'Saved: ' + what; })
      .catch(e => { st.status = 'Not saved: ' + e.message; })
      .then(async () => { if (reload) { api.invalidate(); await api.reload(); } })
      .finally(() => { st.saving--; render(); });
    return saves;
  }
  function commit(what, change, opts) {
    st.history.push({ focus: clone(st.focus), overrides: clone(st.overrides), beats: clone(api.flow.beats), what });
    change();
    applyPoints();
    return save(what, opts);
  }
  function undo() {
    const h = st.history.pop();
    if (!h) { st.status = 'Nothing to undo'; render(); return Promise.resolve(); }
    const textChanged = JSON.stringify(h.overrides.edits) !== JSON.stringify(st.overrides.edits);
    st.focus = h.focus; st.overrides = h.overrides; api.flow.beats.splice(0, api.flow.beats.length, ...h.beats);
    st.sel = null; st.replace = null;
    applyPoints();
    return save('undid ' + h.what, { reload: textChanged });
  }

  // ---- where the presenter is ---------------------------------------------------------------------------------------
  const cur = () => api.current();
  function placeOf(state) {
    const seq = stateSequence(api.flow), beats = beatPositions(api.flow, seq);
    const from = Math.max(0, beats[st.lastBeat] || 0);
    let pos = seq.findIndex((x, i) => i >= from && x.state === state);
    if (pos < 0) pos = seq.findIndex(x => x.state === state);
    return { pos, beat: pos < 0 ? st.lastBeat : beatAt(pos, beats) };
  }
  const here = (p, c = cur()) => !!c && p.app === c.id && (p.states || []).includes(c.state);
  const boxOf = p => { const f = focus(); const t = f && f.locatePoint(p); return t ? t.box : null; };
  const frameRect = () => cur().app.iframe.getBoundingClientRect();

  // ---- dots --------------------------------------------------------------------------------------------------------
  function target(x, y) {
    const c = cur(), fr = frameRect();
    const hit = snap(c.doc, x - fr.x, y - fr.y);
    if (!hit) return null;
    return describe(hit.el, { root: c.doc, phrase: hit.phrase, locate: t => focus().locatePoint(t), W: innerWidth, H: innerHeight });
  }
  const targetKeys = d => ({ ...(d.target.find ? { find: d.target.find } : { union: d.target.union }), mark: d.mark, ...(d.dir ? { dir: d.dir } : {}) });
  const sameTarget = (p, d) => JSON.stringify([p.find || null, p.union || null]) === JSON.stringify([d.target.find || null, d.target.union || null]);
  function dropAt(x, y) {
    const c = cur(), d = target(x, y);
    if (!d) { st.status = 'Nothing to point at there: try right on the text or the button'; render(); return Promise.resolve(null); }
    const dup = all().find(p => here(p, c) && sameTarget(p, d));
    if (dup) { st.sel = dup.id; st.status = 'That one is already a focus point'; render(); return Promise.resolve(dup.id); }
    const { beat } = placeOf(c.state);
    const ids = new Set(all().map(p => p.id));
    let id = 'dot-' + slug(d.text), k = 2; while (ids.has(id)) id = `dot-${slug(d.text)}-${k++}`;
    const p = { id, beat, app: c.id, states: [c.state], ...targetKeys(d), label: d.text.slice(0, 80), source: 'dot' };
    // Its place in the beat: in reading order among the points already on this screen.
    const pts = st.focus.points, same = pts.filter(q => q.beat === beat && here(q, c));
    const after = same.find(q => { const b = boxOf(q); return b && (b[1] > d.box[1] + 4 || (Math.abs(b[1] - d.box[1]) <= 4 && b[0] > d.box[0])); });
    st.sel = id;
    return commit(`added a dot on “${d.text.slice(0, 60)}”`, () => {
      if (after) pts.splice(pts.indexOf(after), 0, p);
      else if (same.length) pts.splice(pts.indexOf(same[same.length - 1]) + 1, 0, p);
      else pts.push(p);
    }).then(() => id);
  }
  function moveTo(id, x, y) {
    const p = st.focus.points.find(q => q.id === id); if (!p) return Promise.resolve();
    const d = target(x, y);
    if (!d) { st.status = 'Nothing to point at there'; render(); return Promise.resolve(); }
    return commit(`moved ${id} to “${d.text.slice(0, 60)}”`, () => {
      delete p.find; delete p.union; delete p.dir;
      Object.assign(p, targetKeys(d), { label: d.text.slice(0, 80) });
      if (p.source === 'script') p.source = 'edited';
    });
  }
  function remove(id) {
    const i = st.focus.points.findIndex(q => q.id === id); if (i < 0) return Promise.resolve();
    st.sel = null;
    return commit(`removed ${id}`, () => st.focus.points.splice(i, 1));
  }
  // Up or down one place among the points of its beat on its screen (the only order ⌥F can play).
  function reorder(id, dir) {
    const pts = st.focus.points, p = pts.find(q => q.id === id); if (!p) return Promise.resolve();
    const peers = pts.filter(q => q.beat === p.beat && q.app === p.app && q.states[0] === p.states[0]);
    const j = peers.indexOf(p) + dir; if (j < 0 || j >= peers.length) return Promise.resolve();
    const a = pts.indexOf(p), b = pts.indexOf(peers[j]);
    return commit(`moved ${id} ${dir < 0 ? 'up' : 'down'}`, () => { pts[a] = peers[j]; pts[b] = p; if (p.source === 'script') p.source = 'edited'; });
  }
  function toggleMark(id) {
    const p = st.focus.points.find(q => q.id === id); if (!p) return Promise.resolve();
    const b = boxOf(p);
    return commit(`${id}: ${p.mark === 'arrow' ? 'box' : 'arrow'}`, () => {
      if (p.mark === 'arrow') { p.mark = 'rect'; delete p.dir; }
      else { p.mark = 'arrow'; p.dir = b ? markFor('button', [b[0], b[1], b[0] + 1, b[1] + 1], innerWidth, innerHeight).dir : 'sw'; }
      if (p.source === 'script') p.source = 'edited';
    });
  }
  async function preview(id) {
    const f = focus(); if (!f) return;
    setPaused(true);
    f.at(id); await f.next();
  }

  // ---- wording and dates -------------------------------------------------------------------------------------------
  // Shown at once in every app's page (text nodes), then saved as a { replace } edit, which the server applies to
  // every screen and answer frame it serves from then on.
  function replaceLive(a, b) {
    const re = reText(a); let n = 0;
    for (const app of Object.values(api.apps)) {
      let docs; try { docs = api.docsOf(app.iframe.contentDocument); } catch (e) { continue; }
      for (const d of docs) {
        if (!d.body) continue;
        const w = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT);
        for (let t; (t = w.nextNode());) { const v = t.data.replace(re, () => { n++; return b; }); if (v !== t.data) t.data = v; }
      }
    }
    return n;
  }
  function changeText(a, b) {
    a = norm(a);
    if (!a || a === b) { render(); return Promise.resolve(); }
    const ov = st.overrides;
    return commit(`“${a}” → “${b}”`, () => {
      // Changing a change again: the original text goes straight to the new words (or back, with no edit at all).
      const prev = ov.edits.find(e => unescHtml(e.replace[1]) === a);
      if (prev) { if (unescHtml(prev.replace[0]) === b) ov.edits.splice(ov.edits.indexOf(prev), 1); else prev.replace[1] = escHtml(b); }
      else {
        const same = ov.edits.find(e => unescHtml(e.replace[0]) === a);
        if (same) same.replace[1] = escHtml(b); else ov.edits.push({ replace: [escHtml(a), escHtml(b)] });
      }
      replaceLive(a, b);
    }).then(() => api.invalidate());
  }
  async function startReplace(text) {
    text = norm(text);
    if (!text || text.length > 300) { st.status = text ? 'Pick a shorter piece of text' : ''; render(); return; }
    st.replace = { text, count: null };
    render();
    const inp = ui && ui.panel.querySelector('input[data-replace]'); if (inp) { inp.focus(); inp.select(); }
    try { const c = await call('/__replica/editor/count?text=' + encodeURIComponent(text)); if (st.replace && st.replace.text === text) { st.replace.count = c; const s = ui.panel.querySelector('[data-count]'); if (s) s.textContent = `(on ${c.screens} screen${c.screens === 1 ? '' : 's'} and frames)`; } } catch (e) {}
  }

  // ---- beat starts -------------------------------------------------------------------------------------------------
  function setBeat(n) {
    const c = cur(), beats = api.flow.beats;
    if (n < 1 || n > 9 || n > beats.length) return Promise.resolve();
    return commit(`beat ${n} starts on ${c.id} · ${c.state}`, () => {
      const prev = beats[n] || { label: `${n} ${c.id}: ${c.state}`, states: { ...beats[n - 1].states } };
      beats[n] = { ...prev, active: c.id, states: { ...prev.states, [c.id]: c.state } };
      const o = st.overrides.beats[n] || { states: {} };
      // A plan's beat keeps its name (one of the show's beats) when its start moves.
      st.overrides.beats[n] = { active: c.id, states: { ...o.states, [c.id]: c.state }, ...(o.label ? { label: o.label } : {}) };
    });
  }

  // ---- on screen ---------------------------------------------------------------------------------------------------
  function build() {
    const overlay = document.createElement('div');
    overlay.setAttribute('data-scenecast-editor', 'overlay');
    Object.assign(overlay.style, { position: 'fixed', inset: '0', zIndex: '2147483100', cursor: 'crosshair', display: 'none' });
    const marks = document.createElement('div');
    Object.assign(marks.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
    overlay.appendChild(marks);
    const panel = document.createElement('div');
    panel.setAttribute('data-scenecast-editor', 'panel');
    Object.assign(panel.style, { position: 'fixed', right: '14px', bottom: '14px', width: '400px', maxHeight: '70vh', overflow: 'auto', zIndex: '2147483200', display: 'none', background: '#fff', color: '#1b1b1b', font: '13px/1.4 -apple-system, "Segoe UI", system-ui, sans-serif', border: '1px solid #d0d4da', borderRadius: '10px', boxShadow: '0 8px 30px rgba(0,0,0,.18)', padding: '10px 12px' });
    document.body.append(overlay, panel);
    ui = { overlay, marks, panel };
    let down = null;
    overlay.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      const dot = e.target.closest('[data-dot]');
      down = { x: e.clientX, y: e.clientY, dot: dot && dot.getAttribute('data-dot'), moved: false };
      if (down.dot) { st.sel = down.dot; render(); }
    });
    overlay.addEventListener('mousemove', e => {
      if (!down) return;
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) down.moved = true;
      if (!down.moved) return;
      if (down.dot) { const el = ui.marks.querySelector(`[data-dot="${CSS.escape(down.dot)}"]`); if (el) Object.assign(el.style, { left: e.clientX - 11 + 'px', top: e.clientY - 11 + 'px' }); }
      else selectBetween(down.x, down.y, e.clientX, e.clientY);
    });
    overlay.addEventListener('mouseup', e => {
      const d = down; down = null; if (!d) return;
      if (d.dot) { if (d.moved && mine(st.focus.points.find(p => p.id === d.dot))) moveTo(d.dot, e.clientX, e.clientY); else render(); return; }
      if (d.moved) { const r = selectBetween(d.x, d.y, e.clientX, e.clientY); if (r) startReplace(r.toString()); return; }
      dropAt(e.clientX, e.clientY);
    });
    // Scrolling still scrolls the page under the pointer.
    overlay.addEventListener('wheel', e => {
      e.preventDefault();
      const c = cur(), fr = frameRect();
      let d = c.doc, px = e.clientX - fr.x, py = e.clientY - fr.y, t = d.elementFromPoint(px, py);
      while (t && t.localName === 'iframe') { const r = t.getBoundingClientRect(); px -= r.x; py -= r.y; d = t.contentDocument; t = d && d.elementFromPoint(px, py); }
      for (let el = t; el; el = el.parentElement) { const s = el.ownerDocument.defaultView.getComputedStyle(el); if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1) { el.scrollBy(0, e.deltaY); return; } }
      const se = (d || c.doc).scrollingElement; if (se) se.scrollBy(0, e.deltaY);
    }, { passive: false });
    panel.addEventListener('click', e => {
      const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
      const act = b.getAttribute('data-act'), id = b.getAttribute('data-id'), n = +b.getAttribute('data-n');
      if (act === 'done') toggle(false);
      else if (act === 'undo') undo();
      else if (act === 'pause') setPaused(!st.paused);
      else if (act === 'del') remove(id);
      else if (act === 'up') reorder(id, -1);
      else if (act === 'down') reorder(id, 1);
      else if (act === 'mark') toggleMark(id);
      else if (act === 'play') preview(id);
      else if (act === 'sel') { st.sel = id; render(); }
      else if (act === 'beat') setBeat(n);
      else if (act === 'apply') { const v = panel.querySelector('input[data-replace]').value; const t = st.replace.text; st.replace = null; changeText(t, v); }
      else if (act === 'cancel') { st.replace = null; render(); }
    });
    panel.addEventListener('keydown', e => {
      if (!e.target.matches('input[data-replace]')) return;
      if (e.key === 'Enter') { e.preventDefault(); const t = st.replace.text; st.replace = null; changeText(t, e.target.value); }
      else if (e.key === 'Escape') { e.preventDefault(); st.replace = null; render(); }
      e.stopPropagation();
    }, true);
    setInterval(() => { if (st.on && !st.replace && signature() !== st.sig) render(); }, 200);
  }
  // A drag across text: the words between where it started and where the pointer is, in one document.
  function selectBetween(x0, y0, x1, y1) {
    const c = cur(), fr = frameRect();
    const at = (x, y) => { let d = c.doc, px = x - fr.x, py = y - fr.y, t = d.elementFromPoint(px, py); while (t && t.localName === 'iframe') { const r = t.getBoundingClientRect(); px -= r.x; py -= r.y; d = t.contentDocument; t = d && d.elementFromPoint(px, py); } return d && d.caretRangeFromPoint ? { d, r: d.caretRangeFromPoint(px, py) } : null; };
    const a = at(x0, y0), b = at(x1, y1);
    if (!a || !b || !a.r || !b.r || a.d !== b.d) return null;
    const fwd = a.r.compareBoundaryPoints(Range.START_TO_START, b.r) <= 0;
    const s = fwd ? a.r : b.r, z = fwd ? b.r : a.r, r = a.d.createRange();
    r.setStart(s.startContainer, s.startOffset); r.setEnd(z.startContainer, z.startOffset);
    // Whole words: a drag rarely starts and ends exactly on a word's edge.
    if (r.startContainer.nodeType === 3) { const t = r.startContainer.data; let i = r.startOffset; while (i > 0 && /\S/.test(t[i - 1])) i--; r.setStart(r.startContainer, i); }
    if (r.endContainer.nodeType === 3) { const t = r.endContainer.data; let i = r.endOffset; while (i < t.length && /[^\s.,;:!?)]/.test(t[i])) i++; r.setEnd(r.endContainer, i); }
    drawRange(r);
    return r;
  }
  function drawRange(r) {
    ui.marks.querySelectorAll('[data-range]').forEach(e => e.remove());
    let ox = 0, oy = 0; for (let w = r.startContainer.ownerDocument.defaultView; w.frameElement; w = w.parent) { const b = w.frameElement.getBoundingClientRect(); ox += b.x; oy += b.y; }
    for (const q of r.getClientRects()) { const e = document.createElement('div'); e.setAttribute('data-range', ''); Object.assign(e.style, { position: 'absolute', left: ox + q.left + 'px', top: oy + q.top + 'px', width: q.width + 'px', height: q.height + 'px', background: 'rgba(255, 196, 0, .35)' }); ui.marks.appendChild(e); }
  }
  function signature() {
    const c = cur(); if (!c) return '';
    let sc = ''; try { const d = c.doc; sc = [d.scrollingElement ? d.scrollingElement.scrollTop : 0, ...[...d.querySelectorAll('*')].filter(e => e.scrollTop).slice(0, 8).map(e => e.scrollTop)].join(','); } catch (e) {}
    return [c.id, c.state, sc, innerWidth, innerHeight, st.focus.points.length, (api.flow.beats || []).length].join('|');
  }
  const btn = (act, label, extra = '', title = '') => `<button data-act="${act}" ${extra} title="${escHtml(title)}" style="font:inherit;border:1px solid #c9ccd1;background:#f6f7f9;border-radius:6px;padding:1px 7px;margin-left:3px;cursor:pointer">${label}</button>`;
  const presenterLabel = () => /mac/i.test(navigator.userAgentData?.platform || navigator.platform) ? '⌥' : 'Ctrl+Alt+';
  function render() {
    if (!ui || !st.on) return;
    const c = cur(); if (!c) return;
    st.sig = signature();
    ui.overlay.style.display = 'block';
    ui.overlay.style.pointerEvents = st.paused ? 'none' : 'auto';
    ui.panel.style.display = 'block';
    // Dots on this screen, numbered by their place in the beat.
    ui.marks.querySelectorAll('[data-dot],[data-box]').forEach(e => e.remove());
    if (!st.replace) ui.marks.querySelectorAll('[data-range]').forEach(e => e.remove());
    const byBeat = {}, rows = [];
    for (const p of all()) {
      byBeat[p.beat] = (byBeat[p.beat] || 0) + 1;
      if (!here(p, c)) continue;
      const n = byBeat[p.beat], b = boxOf(p), edit = mine(p), on = st.sel === p.id;
      rows.push({ p, n, b, edit, on });
      if (!b) continue;
      const color = edit ? RED : '#7a7f87';
      const box = document.createElement('div'); box.setAttribute('data-box', p.id);
      Object.assign(box.style, { position: 'absolute', left: b[0] - 3 + 'px', top: b[1] - 3 + 'px', width: b[2] - b[0] + 6 + 'px', height: b[3] - b[1] + 6 + 'px', border: `2px ${on ? 'solid' : 'dashed'} ${color}`, borderRadius: '4px', pointerEvents: 'none' });
      const dot = document.createElement('div'); dot.setAttribute('data-dot', p.id); dot.title = p.find || JSON.stringify(p.union);
      Object.assign(dot.style, { position: 'absolute', left: b[0] - 11 + 'px', top: (p.mark === 'arrow' ? (b[1] + b[3]) / 2 : b[1]) - 11 + 'px', width: '22px', height: '22px', borderRadius: '50%', background: color, color: '#fff', font: '600 12px/22px -apple-system, "Segoe UI", sans-serif', textAlign: 'center', pointerEvents: 'auto', cursor: edit ? 'grab' : 'default', boxShadow: on ? '0 0 0 3px rgba(255,56,60,.35)' : '0 1px 3px rgba(0,0,0,.3)' });
      dot.textContent = String(n);
      ui.marks.append(box, dot);
    }
    if (st.replace && ui.panel.querySelector('[data-replace-form]')) return;
    const beats = api.flow.beats || [], k = presenterLabel(), q = s => escHtml(s);
    const label = p => q((p.label || p.find || (p.union || []).map(u => typeof u === 'string' ? u : u.text || u.sel).join(' + ')).slice(0, 48));
    const { beat } = placeOf(c.state);
    ui.panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px"><b style="color:${RED}">EDIT</b><span style="flex:1;color:#555">${q(c.id)} · ${q(c.state)} · beat ${beat}</span>${btn('undo', 'Undo', st.history.length ? '' : 'disabled', '⌘Z / Ctrl+Z')}${btn('pause', st.paused ? 'Edit' : 'Use the app', '', 'Clicks go to the app while paused')}${btn('done', 'Done', '', k + '⇧E')}</div>
      ${st.replace ? `<div data-replace-form style="background:#fff8e1;border:1px solid #f0d58a;border-radius:8px;padding:8px;margin-bottom:8px">Change “<b>${q(st.replace.text)}</b>” <span data-count style="color:#666"></span> to<div style="display:flex;gap:4px;margin-top:4px"><input data-replace value="${q(st.replace.text)}" style="flex:1;font:inherit;padding:3px 6px;border:1px solid #c9ccd1;border-radius:6px">${btn('apply', 'Change')}${btn('cancel', 'Cancel')}</div></div>` : ''}
      <div style="font-weight:600;margin:4px 0">Focus points on this screen</div>
      ${rows.length ? rows.map(r => `<div data-row="${q(r.p.id)}" style="display:flex;align-items:center;gap:4px;padding:2px 4px;border-radius:6px;${r.on ? 'background:#ffecec' : ''}"><span data-act="sel" data-id="${q(r.p.id)}" style="flex:1;cursor:pointer;${r.b ? '' : 'color:#a14a00'}">${r.n}. ${r.p.mark === 'arrow' ? '➚' : '▭'} ${label(r.p)}${r.b ? '' : ' (not on screen)'}${r.edit ? '' : ' <i style="color:#888">focus.mjs</i>'}</span>${btn('play', '▶', `data-id="${q(r.p.id)}"`, 'Preview (as ' + k + 'F plays it)')}${r.edit ? btn('up', '↑', `data-id="${q(r.p.id)}"`) + btn('down', '↓', `data-id="${q(r.p.id)}"`) + btn('mark', r.p.mark === 'arrow' ? '▭' : '➚', `data-id="${q(r.p.id)}"`, 'Box or arrow (M)') + btn('del', '✕', `data-id="${q(r.p.id)}"`, 'Delete') : ''}</div>`).join('') : '<div style="color:#777">None yet: click what the line points at.</div>'}
      <div style="font-weight:600;margin:8px 0 4px">Beats</div>
      ${beats.slice(1).map((b, i) => `<div style="display:flex;align-items:center"><span style="flex:1">${k}${i + 1} · ${q(b.active)} · ${q(b.states[b.active] || '')}</span>${b.active === c.id && b.states[c.id] === c.state ? '<span style="color:#0b6b2f">starts here</span>' : btn('beat', 'Start here', `data-n="${i + 1}"`)}</div>`).join('')}
      ${beats.length <= 9 ? `<div style="display:flex"><span style="flex:1;color:#555">${k}${beats.length} (new)</span>${btn('beat', 'Start here', `data-n="${beats.length}"`)}</div>` : ''}
      <div data-status style="margin-top:8px;color:${/^Not saved|problem/.test(st.status) ? '#a14a00' : '#555'}">${q(st.status || 'Click to drop a dot · drag across text to change it')}</div>`;
  }
  function setPaused(v) { st.paused = v; render(); }
  async function toggle(on) {
    await loaded;
    // On or off is decided once the editor's data is in: a key pressed while ?edit=1 is still turning it on flips
    // what's on screen by then, not the state from before.
    if (on === undefined) on = !st.on;
    if (on && !ui) build();
    st.on = on; st.sel = null; st.replace = null; st.paused = false;
    if (focus()) focus().clear();
    if (!on && ui) { ui.overlay.style.display = 'none'; ui.panel.style.display = 'none'; ui.marks.replaceChildren(); }
    render();
  }

  api.on('key', e => {
    if (presenterKey(e) && e.shiftKey && e.code === 'KeyE') { toggle(); return true; }
    if (!st.on) return false;
    if (e.target && e.target.closest && e.target.closest('[data-scenecast-editor]')) return false;
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.code === 'KeyZ') { undo(); return true; }
    if (presenterKey(e) || e.metaKey || e.ctrlKey) return false;
    const id = st.sel, ok = mine(st.focus.points.find(p => p.id === id));
    if (ok && (e.key === 'Delete' || e.key === 'Backspace')) { remove(id); return true; }
    if (ok && (e.key === '[' || e.key === 'ArrowUp') && !(focus() && focus().zoomed)) { reorder(id, -1); return true; }
    if (ok && (e.key === ']' || e.key === 'ArrowDown') && !(focus() && focus().zoomed)) { reorder(id, 1); return true; }
    if (ok && (e.key === 'm' || e.key === 'M')) { toggleMark(id); return true; }
    if (e.key === 'Escape' && !(focus() && focus().zoomed) && (st.sel || st.replace || st.paused)) { st.sel = null; st.replace = null; st.paused = false; render(); return true; }
    return false;
  });
  api.on('jump', n => { st.lastBeat = n; setTimeout(render, 0); });
  api.on('activate', () => setTimeout(render, 0));
  if (new URLSearchParams(location.search).get('edit') === '1') (async () => { while (!cur() || !cur().state) await new Promise(r => setTimeout(r, 50)); await toggle(true); })();

  // For the tests (window.d1.editor); nothing on screen.
  api.expose('editor', {
    toggle, dropAt, moveTo, remove, reorder, toggleMark, changeText, setBeat, undo,
    get on() { return st.on; },
    idle: async () => { await loaded; for (let i = 0; i < 400 && st.saving; i++) await new Promise(r => setTimeout(r, 25)); await saves; },
    state: () => ({ on: st.on, paused: st.paused, sel: st.sel, status: st.status, replace: st.replace && { text: st.replace.text }, points: clone(st.focus.points), edits: clone(st.overrides.edits), beats: clone(st.overrides.beats), history: st.history.length, dots: ui ? [...ui.marks.querySelectorAll('[data-dot]')].map(e => { const r = e.getBoundingClientRect(); return { id: e.getAttribute('data-dot'), n: +e.textContent, x: r.x + r.width / 2, y: r.y + r.height / 2 }; }) : [] }),
  });
}
