// Recorder (driver side), inlined by build.mjs after driver.js. A person (or an agent) runs the demo once in
// Chrome; this watches every app tab through capture/recorder-page.js and, for each action:
//   typing     after a pause in typing (or before Enter / a click), the screen with the text in the box
//   Enter      held back by the page, the typed screen captured, then Enter pressed here and what it changed captured
//   click      what it changed, frame by frame while it changes, then the settled screen
//   Escape     the same, recorded as the screen's esc
// A change that keeps changing for streamMinMs over streamMinFrames frames (an AI answer streaming in) is kept as
// a stream (its frames replay at their real times); anything quicker is a plain move to the next state. A screen
// that's the same as one already captured (same text, same open/selected/checked controls, same field values)
// reuses that state, so closing a pane goes back to the screen before it.
// Side paths (recordSide): hovers (the hover audit), zoom (the page at other browser zooms), list (every row of a
// virtualized list). recordStop posts the recording to the receiver (recording.json in the raw folder); the kit's
// compile/flow.mjs turns it into flow.json.
const RECX = o => `(${REC_PAGE})(${JSON.stringify(o || {})})`;
const REC = { on: false };
const rslug = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 28) || 'x';
const rlogr = msg => { const l = `${((Date.now() - (REC.t0 || Date.now())) / 1000).toFixed(1)}s ${msg}`; (REC.log = REC.log || []).push(l); if (REC.log.length > 400) REC.log.shift(); return rlog('rec: ' + msg); };
const recApp = id => { const A = REC.apps.find(a => a.id === id); if (!A) throw new Error('no app ' + id); return A; };

async function recFrameKey(p, f) { if (f === p.mainFrame()) return null; const keys = await frameKeys(p); return keys.get(f) || null; }
const withFrame = (m, fk) => fk ? { frame: fk, ...m } : m;
async function recInstall(p) { for (const f of p.frames()) await f.evaluate(RECX(REC.opts)).catch(() => {}); }
async function recEach(p, fn, arg) { const out = []; for (const f of p.frames()) { const r = await f.evaluate(fn, arg).catch(() => undefined); if (r !== undefined) out.push([f, r]); } return out; }
async function recSig(p) {
  const all = await recEach(p, () => window.__rkrec ? window.__rkrec.sig() : null);
  return all.filter(([, r]) => r).map(([f, r]) => (f === p.mainFrame() ? 'main' : 'frame') + '=' + r).sort().join(' ');
}
async function recSetBusy(p, on) { await recEach(p, on => { if (window.__rkrec) window.__rkrec.busy = on; }, on); }
async function recSetOff(p, on) { await recEach(p, on => { if (window.__rkrec) window.__rkrec.off = on; }, on); }
// A flow.drags rule from one handle of the drag audit: which element the page wrote while it moved (a pane's flex
// share, a width, a custom property), live or on release, which way, and the limits it stopped at.
function dragRule(rec) {
  const S = rec.samples || [], meta = rec.styleMeta || {};
  if (!S.length) return { why: rec.error || 'no samples' };
  const num = v => v === undefined || v === null || v === '' ? null : +v;
  const parse = v => {
    if (!v) return null;
    let m = /flex:\s*0 0 ([\d.]+)%/.exec(v); if (m) return { write: 'flexPercent', v: +m[1] };
    m = /(?:^|;\s*)width:\s*([\d.]+)px/.exec(v); if (m) return { write: 'px', v: +m[1] };
    m = /(--[\w-]+):\s*([\d.]+)(px|vw)/.exec(v); if (m) return { write: 'cssVar', name: m[1], unit: m[3], v: m[3] === 'vw' ? +m[2] * (rec.vw || 1920) / 100 : +m[2] };
    return null;
  };
  const keys = Object.keys(meta).filter(k => meta[k].attr === 'style');
  const live = keys.filter(k => new Set(S.map(s => (s.styles || {})[k]).filter(v => v !== undefined)).size > 1);
  const rel = rec.release || [];
  const released = keys.filter(k => rel.some(s => (s.styles || {})[k] !== ((s.before || {}).styles || {})[k]));
  const mode = live.length ? 'live' : released.length ? 'release' : null;
  if (!mode) return { why: 'dragging it changed nothing' };
  const seq = mode === 'live' ? S : rel;
  const sel = m => m.testid ? `${m.tag}[data-testid="${m.testid}"]` : m.label ? `${m.tag}[aria-label="${m.label}"]` : null;
  const order = { flexPercent: 0, px: 1, cssVar: 2 };
  const cands = (mode === 'live' ? live : released).map(k => ({ k, m: meta[k], p: parse(seq.map(s => (s.styles || {})[k]).find(Boolean)) })).filter(c => c.p && (c.p.write === 'flexPercent' || sel(c.m))).sort((a, b) => order[a.p.write] - order[b.p.write]);
  const c = cands[0];
  if (!c) return { why: 'the page wrote no width, flex share or size variable (add a drags rule by hand)' };
  const pts = seq.map(s => [s.d, parse((s.styles || {})[c.k])]).filter(x => x[1] && x[1].write === c.p.write).map(([d, x]) => [d, x.v]);
  const lo = pts.reduce((a, b) => b[0] < a[0] ? b : a), hi = pts.reduce((a, b) => b[0] > a[0] ? b : a);
  const dir = hi[1] >= lo[1] ? 1 : -1;
  const rule = { handle: rec.spec && rec.spec.sel, mode, write: c.p.write, dir, cursor: /resize/.test(rec.cursor || '') ? rec.cursor : undefined };
  if (c.p.write !== 'flexPercent') {
    rule.target = sel(c.m);
    if (c.p.write === 'cssVar') { rule.name = c.p.name; rule.unit = c.p.unit; }
    // Limits: where it stopped while dragging far both ways; on release only two sizes are seen, so the handle's
    // own aria-valuemin/max.
    const vs = pts.map(x => x[1]);
    rule.min = mode === 'live' ? Math.round(Math.min(...vs)) : num(rec.min) !== null ? num(rec.min) : Math.round(Math.min(...vs));
    rule.max = mode === 'live' ? Math.round(Math.max(...vs)) : num(rec.max) !== null ? num(rec.max) : Math.round(Math.max(...vs));
  }
  if (!rule.handle) return { why: 'no selector for the handle' };
  return { rule };
}
async function recBusyNow(p) { const r = await p.mainFrame().evaluate(b => window.__rkrec ? window.__rkrec.isBusy(b) : false, REC.opts.busy).catch(() => false); return !!r; }
async function recFocus(p) {
  for (const [f, r] of await recEach(p, () => { const R = window.__rkrec, a = document.activeElement; if (!R || !a || a === document.body) return null; const ed = a.isContentEditable || a.localName === 'textarea' || (a.localName === 'input' && !/^(checkbox|radio|button|submit)$/i.test(a.type)); return ed && document.hasFocus() ? R.specOf(a).m : null; })) {
    if (r) return withFrame(r, await recFrameKey(p, f));
  }
  return null;
}
// Waits until the page's text and controls stop changing for ms (and nothing busy shows), at most maxMs.
async function recSettle(p, ms, maxMs) {
  const t0 = Date.now(); let sig = await recSig(p), since = Date.now();
  while (Date.now() - t0 < maxMs) {
    await sleep(Math.min(250, REC.opts.everyMs));
    const s = await recSig(p);
    if (s !== sig) { sig = s; since = Date.now(); continue; }
    if (Date.now() - since >= ms && !(await recBusyNow(p))) break;
  }
  return sig;
}
function recUniq(id) { let k = id, n = 1; while (REC.states[k]) k = `${id}-${++n}`; return k; }
async function recAddState(A, id, sig) {
  await H.snap(A.page, id);
  const meta = await A.page.mainFrame().evaluate(() => ({ title: document.title, cs: window.__rkrec ? window.__rkrec.colorScheme() : null })).catch(() => ({}));
  const st = { app: A.id, snap: id, sig: sig || await recSig(A.page), title: meta.title, on: [] };
  const focus = await recFocus(A.page);
  if (focus) st.focus = focus;
  if (meta.cs && meta.cs.dark) REC.notes.push(`${id}: the page prefers dark mode; recapture in light mode`);
  REC.states[id] = st;
  REC.sigs[A.id].set(st.sig, id);
  rlogr(`state ${id}`);
  return st;
}
function recOn(from, t) {
  const st = REC.states[from];
  const key = JSON.stringify({ ...t, to: undefined, stream: undefined, empty: undefined });
  const same = st.on.findIndex(x => JSON.stringify({ ...x, to: undefined, stream: undefined, empty: undefined }) === key);
  if (same >= 0) { if (JSON.stringify(st.on[same]) !== JSON.stringify(t)) REC.notes.push(`${from}: ${Object.keys(t)[0]} on ${JSON.stringify(Object.values(t)[0]).slice(0, 80)} went somewhere else the second time; the first is kept`); return; }
  st.on.push(t);
}
function recBeat(label) {
  const b = { label, active: REC.active, states: Object.fromEntries(REC.apps.map(a => [a.id, a.state])) };
  const last = REC.beats[REC.beats.length - 1];
  if (last && last.active === b.active && JSON.stringify(last.states) === JSON.stringify(b.states)) return;
  REC.beats.push(b);
}
function recSwitch(A) {
  if (REC.active === A.id) return;
  REC.active = A.id;
  REC.path.push({ app: A.id, checkpoint: A.state });
  recBeat(`${A.id}: ${A.state}`);
}
function recFill(A, T) {
  const typed = REC.states[A.state];
  if (!typed.typedOf) return;
  const f = [{ ...T.spec, value: T.value }];
  typed.fill = f; REC.states[typed.typedOf.base].fill = f;
  for (let i = REC.path.length - 1; i >= 0; i--) if (REC.path[i].type && JSON.stringify(REC.path[i].type) === JSON.stringify(T.spec)) { REC.path[i].text = T.value; break; }
}
// The screen with text in a field: a new state the first time, then only its fill value changes.
async function recTyped(A) {
  const T = A.typing; if (!T || T.done) return;
  T.done = true;
  await T.f.evaluate(() => { if (window.__rkrec) window.__rkrec.dirty = false; }).catch(() => {});
  recSwitch(A);
  const cur = REC.states[A.state];
  const key = JSON.stringify(T.spec);
  if (cur.typedOf && cur.typedOf.key === key) {
    if (!T.value) { A.state = cur.typedOf.base; REC.path.push({ clear: T.spec, checkpoint: A.state }); return; }
    return recFill(A, T);
  }
  if (!T.value) return;
  const id = recUniq(`${A.state}-typed`);
  await recSetBusy(A.page, true);
  try { await recAddState(A, id); } finally { await recSetBusy(A.page, false); }
  recOn(A.state, { type: T.spec, to: id });
  REC.states[id].on.push({ type: T.spec, empty: A.state });
  REC.states[id].typedOf = { key, base: A.state, spec: T.spec };
  REC.path.push({ type: T.spec, text: T.value, checkpoint: id });
  A.state = id;
  recFill(A, T);
}
// What an action changed. trigger() does the action (Enter, a held-back click); without one it already happened.
async function recCapture(A, ev, trigger) {
  const p = A.page, o = REC.opts;
  const from = REC.states[A.state];
  await recSetBusy(p, true);
  const name = `s${String(++REC.seq).padStart(3, '0')}`;
  const frames = []; let prev = null; const t0 = Date.now();
  let lastHtml = t0;
  const grab = async () => {
    try {
      const r = await p.mainFrame().evaluate(SERX({ body: true, css: false }));
      if (r.html === prev) return;
      prev = r.html; lastHtml = Date.now();
      await fetchResources(p, [{ urls: r.urls, frame: p.mainFrame() }]);
      const t = Date.now() - t0;
      await post('/frame', { stream: name, n: frames.length, t, html: r.html, urls: r.urls, inline: r.inline, meta: r.meta });
      frames.push(t);
    } catch (e) { rlogr('frame: ' + String(e.message || e).slice(0, 120)); }
  };
  await grab();
  if (trigger) await trigger();
  let sig = await recSig(p), since = Date.now(), first = null, last = null;
  for (;;) {
    await sleep(o.everyMs);
    await grab();
    const s = await recSig(p);
    const now = Date.now();
    if (s !== sig) { sig = s; since = now; if (first === null) first = now - t0; last = now - t0; }
    if (now - t0 > o.maxS * 1000) { REC.notes.push(`${A.state}: still changing after ${o.maxS} s; captured as it was`); break; }
    const busy = await recBusyNow(p);
    // Settled: text and controls unchanged for settleMs, nothing busy, and the markup quiet too (or long enough
    // that what still moves is an animation).
    if (!busy && now - since >= o.settleMs && now - t0 >= o.settleMs && (now - lastHtml >= 600 || now - since >= 2 * o.settleMs)) break;
  }
  try {
    if (sig === from.sig && first === null) return { changed: false };
    let to = REC.sigs[A.id].get(sig);
    if (!to) { to = recUniq(`${A.id}-${String(++A.n).padStart(2, '0')}-${rslug(ev.desc || ev.kind)}`); await recAddState(A, to, sig); }
    const isStream = frames.length >= o.streamMinFrames && last !== null && last >= o.streamMinMs;
    if (isStream) REC.streams[name] = { raw: name, frames: [0, frames.length - 1], to, timing: 'real', ms: Math.max(600, Math.min(o.streamMaxMs || 10000, last + 300)), realMs: last };
    rlogr(`${ev.kind} ${ev.desc ? '"' + ev.desc + '" ' : ''}→ ${to}${isStream ? ` (stream ${name}, ${frames.length} frames, ${(last / 1000).toFixed(1)} s)` : ''}`);
    return { changed: true, to, stream: isStream ? name : undefined };
  } finally { await recSetBusy(p, false); }
}
async function recEnter(A, e) {
  const fk = await recFrameKey(A.page, e.f);
  const spec = withFrame(e.spec.m, fk);
  if (!A.typing || A.typing.done) A.typing = { spec, value: e.value, at: Date.now(), f: e.f, done: false };
  A.typing.value = e.value;
  await recTyped(A);
  const from = A.state;
  const res = await recCapture(A, { kind: 'enter', desc: e.spec.desc }, async () => { await e.f.evaluate(() => { window.__rkrec.pass++; }); await A.page.keyboard.press('Enter'); });
  A.typing = null;
  if (!res.changed) { REC.notes.push(`${from}: Enter in "${e.spec.desc}" changed nothing`); return; }
  const t = { enter: spec };
  if (res.stream) { t.stream = res.stream; if (e.value) REC.streams[res.stream].prompt = e.value; } else t.to = res.to;
  recOn(from, t);
  REC.path.push({ enter: spec, checkpoint: res.to });
  A.state = res.to;
  if (res.stream) recBeat(`${A.id}: ${res.to}`);
  await recAuto(A);
}
async function recClick(A, e) {
  const fk = await recFrameKey(A.page, e.f);
  const spec = withFrame(e.spec.m, fk);
  // A click held back because the box had text not yet captured: capture the typed screen, then click for real.
  if (A.typing && !A.typing.done) await recTyped(A);
  const from = A.state, typedOf = REC.states[from].typedOf;
  // Clicking into a field only puts the cursor there: no capture (typing makes the next state).
  if (e.field && !e.held) return;
  const trigger = e.held ? async () => {
    let off = { x: 0, y: 0 };
    if (e.f !== A.page.mainFrame()) { const bb = await (await e.f.frameElement()).boundingBox(); if (bb) off = bb; }
    await e.f.evaluate(() => { window.__rkrec.pass++; });
    await A.page.mouse.click(off.x + e.x, off.y + e.y);
  } : null;
  const res = await recCapture(A, { kind: 'click', desc: e.spec.desc }, trigger);
  if (!res.changed) { REC.notes.push(`${from}: click on "${e.spec.desc}" changed nothing (a dead control in the replica too)`); return; }
  const t = { click: spec };
  if (res.stream) t.stream = res.stream; else t.to = res.to;
  // A send button: it sends what's in the box, like Enter.
  if (typedOf && !e.field && res.to !== typedOf.base && res.to !== from) { t.typedFrom = typedOf.spec; if (res.stream) { const fl = REC.states[from].fill; if (fl && fl[0]) REC.streams[res.stream].prompt = fl[0].value; } }
  recOn(from, t);
  const dx = e.spec.rect && e.spec.rect.w > 160 ? Math.round(Math.max(4, Math.min(e.x - e.spec.rect.x, e.spec.rect.w - 4))) : undefined;
  REC.path.push({ click: spec, dx, checkpoint: res.to });
  A.state = res.to;
  if (res.stream) recBeat(`${A.id}: ${res.to}`);
  await recAuto(A);
}
async function recEsc(A, e) {
  const from = A.state;
  const res = await recCapture(A, { kind: 'esc', desc: 'escape' }, null);
  if (!res.changed) return;
  REC.states[from].esc = res.to;
  REC.path.push({ key: 'Escape', checkpoint: res.to });
  A.state = res.to;
  await recAuto(A);
}
async function recHandle(e) {
  const A = e.A;
  if (e.kind === 'blocked') { REC.blocked = (REC.blocked || 0) + 1; return rlogr(`held back a ${e.what} while capturing: do it again once the screen has settled`); }
  if (e.kind === 'input') { const fk = await recFrameKey(A.page, e.f); A.typing = { spec: withFrame(e.spec.m, fk), value: e.value, at: Date.now(), f: e.f, done: false }; return; }
  recSwitch(A);
  if (e.kind === 'enter') return recEnter(A, e);
  if (e.kind === 'click') return recClick(A, e);
  if (e.kind === 'esc') return recEsc(A, e);
  if (e.kind === 'drag') { REC.drags.push({ app: A.id, state: A.state, spec: e.spec && e.spec.m, dx: Math.round(e.x1 - e.x0), dy: Math.round(e.y1 - e.y0) }); return rlogr(`drag on "${e.spec && e.spec.desc}" by ${Math.round(e.x1 - e.x0)} px (a pane resize: add a drags rule)`); }
}
async function recLoop() {
  while (!REC.stop) {
    try {
      // The start screens' side states first (and after a resume, the screens left without them).
      if (!REC.paused && REC.autoQueue.length) {
        REC.busyNow = true;
        try { while (REC.autoQueue.length && !REC.stop) { const A = recApp(REC.autoQueue.shift()); await recAuto(A); recCheckpoint(); } const act = REC.apps.find(a => a.id === REC.active); if (act) await act.page.bringToFront(); }
        finally { REC.busyNow = false; }
      }
      if (!REC.paused) {
        const evs = [];
        for (const A of REC.apps) for (const f of A.page.frames()) {
          const q = await f.evaluate('window.__rkrec ? window.__rkrec.drain() : null').catch(() => undefined);
          if (q === null) { await f.evaluate(RECX(REC.opts)).catch(() => {}); continue; }
          if (q && q.length) for (const e of q) evs.push({ ...e, A, f });
        }
        evs.sort((a, b) => a.t - b.t || a.seq - b.seq);
        for (const e of evs) { if (REC.stop) break; REC.busyNow = true; try { await recHandle(e); REC.actions++; } catch (err) { rlogr('error: ' + String(err.stack || err).slice(0, 300)); } finally { REC.busyNow = false; } }
        if (evs.some(e => e.kind !== 'input')) recCheckpoint();
        for (const A of REC.apps) if (A.typing && !A.typing.done && Date.now() - A.typing.at > REC.opts.typeIdleMs) await recTyped(A);
      }
    } catch (err) { rlogr('loop: ' + String(err.message || err).slice(0, 200)); }
    await sleep(120);
  }
}
// What the automatic side paths have already done in an app: hovers by control ("sel|text"), clicks by name,
// step groups by region, screen kinds.
function recSeen(kind, key) { const m = REC.seen[kind] = REC.seen[kind] || {}; return m[key] = m[key] || new Set(); }
// The automatic side paths (record.auto): on each new settled screen, the side states a presenter can reach from it,
// so one recording is all the Chrome time a demo needs. Each runs only where it has something new to find:
//   groups  closed step groups not opened before          chips   once per kind of screen, at a couple of widths
//   hovers  controls not hovered on another screen          clicks  expanders and menus not clicked before
//   drags   resize handles, once per kind of screen         zoom    once per kind of screen
//   list    a list with more rows than it shows (all of them, last: it changes the page)
// The same for each frame that holds most of the screen (hovers and clicks). Budget: auto.maxS per screen.
const recAutoOpts = () => { const a = REC.opts.auto; return a === false ? null : { hovers: true, clicks: true, groups: true, chips: true, lists: true, drags: true, zoom: true, maxS: 240, hoverMax: 40, hoverMaxS: 120, clickMax: 25, clickMaxS: 120, chipWidths: [1366, 1100], ...(a || {}) }; };
async function recAuto(A) {
  const o = recAutoOpts(), state = A.state, st = REC.states[state];
  if (!o || !st || st.typedOf || REC.autoDone.has(state)) return;
  REC.autoDone.add(state);
  const p = A.page, t0 = Date.now(), did = [];
  await p.bringToFront();
  const f = await p.mainFrame().evaluate(sel => window.__rkrec ? window.__rkrec.features(sel) : null, REC.opts.groups.button).catch(() => null);
  if (!f) return;
  const kinds = recSeen('kinds', A.id), newKind = !kinds.has(f.kind); kinds.add(f.kind);
  const run = async (kind, c = {}) => {
    if (Date.now() - t0 > o.maxS * 1000) { did.push(kind + ' (out of time: record side ' + kind + ' on ' + state + ' if needed)'); return; }
    REC.side = `${kind} on ${state}`;
    const t1 = Date.now();
    try {
      const r = await recSide(A, { kind, ...c });
      const what = r.error ? 'failed: ' + r.error : kind === 'hovers' ? `${r.n} of ${r.tried}${r.skipped ? ` (${r.skipped} seen before)` : ''}` : kind === 'clicks' ? `${(r.clicks || []).length} of ${(r.controls || []).length}` : kind === 'groups' ? `${(r.groups || []).length}` : kind === 'chips' ? (r.rule ? 'found' : 'none') : kind === 'drags' ? `${(r.rules || []).length}` : kind === 'zoom' ? `${(r.zooms || []).length}` : kind === 'list' ? `${r.list && r.list.seen} rows` : 'done';
      did.push(`${kind}${c.frameRe ? ' (frame)' : ''} ${what}, ${Math.round((Date.now() - t1) / 1000)} s`);
    } catch (e) { did.push(`${kind} failed: ${String(e.message || e).slice(0, 120)}`); REC.notes.push(`${state}: the automatic ${kind} failed (${String(e.message || e).slice(0, 120)}); record side ${kind} on it if it matters`); }
  };
  const gseen = recSeen('groups', A.id);
  if (o.groups && f.groups.some(id => !gseen.has(id))) { await run('groups'); f.groups.forEach(id => gseen.add(id)); }
  if (o.chips && newKind) await run('chips', { widths: o.chipWidths });
  const hv = c => ({ waitMs: 900, settleMaxMs: 2500, perSel: 8, max: o.hoverMax, maxS: o.hoverMaxS, ...c });
  if (o.hovers) await run('hovers', hv({ skipKeys: [...recSeen('hovers', A.id)] }));
  if (o.clicks) await run('clicks', { pick: { max: o.clickMax }, maxS: o.clickMaxS, skipNames: [...recSeen('clicks', A.id)] });
  for (const [i, fu] of f.frames.entries()) {
    const frameRe = '^' + fu.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (o.hovers) await run('hovers', hv({ frameRe, page: `${state}-frame${i}`, skipKeys: [...recSeen('hovers', A.id + fu)] }));
    if (o.clicks) await run('clicks', { frameRe, page: `${state}-frame${i}`, pick: { max: o.clickMax }, maxS: o.clickMaxS, skipNames: [...recSeen('clicks', A.id + fu)] });
  }
  if (o.zoom && newKind) await run('zoom', { zooms: o.zooms || REC.zooms });
  if (o.lists && f.list) await run('list');
  // Last: the drag audit moves panes (and puts them back).
  if (o.drags && newKind && f.handles) await run('drags', { range: 240, step: 40 });
  REC.side = null;
  await recSetBusy(p, true); await recSettle(p, 700, 8000); await recSetBusy(p, false);
  if ((await recSig(p)) !== st.sig) REC.notes.push(`${state}: after the automatic side paths the page isn't as it was; check it (reload the tab if a panel stayed open)`);
  REC.autos.push({ state, secs: Math.round((Date.now() - t0) / 1000), did });
  rlogr(`auto ${state} (${Math.round((Date.now() - t0) / 1000)} s): ${did.join('; ') || 'nothing new'}`);
}
// The recording so far, kept by the receiver after every step (raw/recording-partial.json): record start --resume
// picks up from it after an interruption (the agent restarted, Chrome reloaded).
function recSnapshot() {
  const states = Object.fromEntries(Object.entries(REC.states).map(([k, st]) => [k, { ...st }]));
  return { kit: 1, savedAt: new Date().toISOString(), t0: REC.t0, opts: REC.opts, zooms: REC.zooms, apps: REC.apps.map(a => ({ id: a.id, match: a.match, state: a.state, n: a.n })), states, sigs: Object.fromEntries(Object.entries(REC.sigs).map(([k, m]) => [k, [...m]])), streams: REC.streams, beats: REC.beats, path: REC.path, notes: REC.notes, drags: REC.drags, sides: REC.sides, seq: REC.seq, active: REC.active, actions: REC.actions, autoDone: [...REC.autoDone], autos: REC.autos, seen: Object.fromEntries(Object.entries(REC.seen).map(([k, m]) => [k, Object.fromEntries(Object.entries(m).map(([kk, v]) => [kk, [...v]]))])) };
}
let recSaving = null;
function recCheckpoint() { if (!REC.on) return; const snap = recSnapshot(); recSaving = (recSaving || Promise.resolve()).then(() => post('/recording-partial', snap)).catch(() => {}); }

// record start --resume: the recording from the receiver's last checkpoint. Each app's tab has to be on the screen it
// was on (the status lists any that aren't); the screens left without side states get them first.
async function recResume(c) {
  const snap = await page0.request.get(RX + '/recording-partial', { timeout: 30000 }).then(r => r.ok() ? r.json() : null).catch(() => null);
  if (!snap || !snap.states) { REC.on = false; return { error: 'nothing to resume (no checkpoint in the raw folder)' }; }
  Object.assign(REC, { t0: snap.t0, opts: { ...snap.opts, ...(c.record || {}) }, zooms: snap.zooms || c.zooms, states: snap.states, streams: snap.streams, beats: snap.beats, path: snap.path, notes: snap.notes, drags: snap.drags, sides: snap.sides, seq: snap.seq, active: snap.active, actions: snap.actions, autos: snap.autos || [], autoDone: new Set(snap.autoDone || []) });
  REC.opts.groups = { button: 'button[aria-expanded][aria-controls]', ...(REC.opts.groups || {}) };
  REC.sigs = Object.fromEntries(Object.entries(snap.sigs).map(([k, v]) => [k, new Map(v)]));
  REC.seen = Object.fromEntries(Object.entries(snap.seen || {}).map(([k, m]) => [k, Object.fromEntries(Object.entries(m).map(([kk, v]) => [kk, new Set(v)]))]));
  const off = [];
  for (const a of snap.apps) {
    const p = await pageFor(a.match);
    REC.apps.push({ id: a.id, match: a.match, page: p, state: a.state, n: a.n, typing: null });
    await recInstall(p);
    const sig = await recSettle(p, 600, 8000);
    if (sig !== (REC.states[a.state] || {}).sig && (REC.sigs[a.id] || new Map()).get(sig) !== a.state) off.push(`${a.id}: bring the tab back to ${a.state} (as captured in raw/shots/${(REC.states[a.state] || {}).snap}.png), then go on`);
  }
  REC.autoQueue = REC.apps.filter(a => !REC.autoDone.has(a.state) && !(REC.states[a.state] || {}).typedOf).map(a => a.id);
  rlogr(`resumed: ${Object.keys(REC.states).length} screens, ${REC.path.length} steps`);
  REC.loopP = recLoop();
  REC.resumed = { at: new Date().toISOString(), states: Object.keys(REC.states).length, steps: REC.path.length, notOnTheirScreen: off };
  return { recording: true, resumed: true, states: Object.keys(REC.states).length, steps: REC.path.length, active: REC.active, notOnTheirScreen: off };
}

OPS.recordStart = async c => {
  if (REC.on) return { error: 'already recording' };
  const opts = { everyMs: 400, settleMs: 2500, typeIdleMs: 1200, streamMinMs: 1500, streamMinFrames: 4, streamMaxMs: 10000, maxS: 240, busy: [], ignore: [], ...(c.record || {}) };
  opts.groups = { button: 'button[aria-expanded][aria-controls]', ...(opts.groups || {}) };
  Object.assign(REC, { on: true, resumed: undefined, stop: false, paused: false, opts, apps: [], states: {}, sigs: {}, streams: {}, beats: [], path: [], notes: [], drags: [], log: [], sides: { zoom: [], lists: [], hovers: [], clicks: [], drags: [], groups: [], chips: [] }, actions: 0, blocked: 0, t0: Date.now(), seq: 0, active: null, autoDone: new Set(), autos: [], autoQueue: [], seen: {}, side: null, zooms: c.zooms });
  if (c.resume) return recResume(c);
  for (const a of c.apps) {
    const p = await pageFor(a.match);
    REC.apps.push({ id: a.id, match: a.match, page: p, state: null, n: 0, typing: null });
    REC.sigs[a.id] = new Map();
  }
  const dark = [];
  for (const A of REC.apps) {
    await A.page.bringToFront(); await recInstall(A.page);
    const cs = await A.page.mainFrame().evaluate(() => window.__rkrec && window.__rkrec.colorScheme()).catch(() => null);
    if (cs && cs.dark) dark.push(A.id);
  }
  if (dark.length && !c.allowDark) { REC.on = false; return { error: `dark mode in ${dark.join(', ')}: set each app's theme to Light (not System) and start again` }; }
  for (const A of REC.apps) {
    await A.page.bringToFront();
    if (c.neutral) await A.page.mouse.move(c.neutral[0], c.neutral[1]);
    const sig = await recSettle(A.page, 800, 15000);
    await recSetBusy(A.page, true);
    try { await recAddState(A, `${A.id}-start`, sig); } finally { await recSetBusy(A.page, false); }
    A.state = `${A.id}-start`;
  }
  const first = c.first ? recApp(c.first) : REC.apps[0];
  await first.page.bringToFront();
  REC.active = first.id;
  REC.path.push({ app: first.id, checkpoint: first.state });
  recBeat('start');
  if (recAutoOpts()) REC.autoQueue = [...REC.apps.filter(a => a.id !== first.id).map(a => a.id), first.id];
  recCheckpoint();
  REC.loopP = recLoop();
  return { recording: true, states: Object.keys(REC.states), auto: !!recAutoOpts(), go: `${recAutoOpts() ? 'the recorder first captures each start screen\'s side states (status busy); then ' : ''}run the demo in ${first.id}; after each action wait until record status shows busy: false (each new screen's side states are captured then)` };
};
// Stops recording without writing the recording, as if the agent had died (for testing record start --resume).
OPS.recordAbort = async () => { if (!REC.on) return { error: 'not recording' }; REC.stop = true; await REC.loopP; await recSaving; for (const A of REC.apps) await recSetBusy(A.page, false).catch(() => {}); REC.on = false; return { aborted: true }; };
OPS.recordStatus = async () => REC.on ? { recording: true, resumed: REC.resumed, busy: !!REC.busyNow || REC.autoQueue.length > 0, side: REC.side || undefined, autos: REC.autos.length, chromeSecs: Math.round((Date.now() - REC.t0) / 1000), typing: REC.apps.filter(a => a.typing && !a.typing.done).map(a => a.id), actions: REC.actions, blocked: REC.blocked, active: REC.active, states: Object.fromEntries(REC.apps.map(a => [a.id, a.state])), count: Object.keys(REC.states).length, streams: Object.keys(REC.streams).length, log: REC.log.slice(-8) } : { recording: false };
OPS.recordStop = async () => {
  if (!REC.on) return { error: 'not recording' };
  REC.stop = true; await REC.loopP;
  for (const A of REC.apps) { if (A.typing && !A.typing.done) await recTyped(A); await recSetBusy(A.page, false); }
  const states = Object.fromEntries(Object.entries(REC.states).map(([k, s]) => { const { typedOf, ...rest } = s; return [k, rest]; }));
  const rec = { kit: 1, recordedAt: new Date(REC.t0).toISOString(), secs: Math.round((Date.now() - REC.t0) / 1000), opts: REC.opts,
    apps: REC.apps.map(a => ({ id: a.id, match: a.match, start: `${a.id}-start`, end: a.state })), states, streams: REC.streams, beats: REC.beats, path: REC.path, notes: REC.notes, drags: REC.drags, sides: REC.sides, autos: REC.autos, log: REC.log };
  await post('/recording', rec);
  REC.on = false;
  return { states: Object.keys(states).length, streams: Object.keys(REC.streams).length, beats: REC.beats.length, steps: REC.path.length, notes: REC.notes, blocked: REC.blocked, secs: rec.secs, autoSecs: REC.autos.reduce((n, a) => n + a.secs, 0), autos: REC.autos.map(a => `${a.state} ${a.secs} s: ${a.did.join('; ') || 'nothing new'}`) };
};
// Step groups on this screen (record side groups): each closed group is opened (the page's own click), the screen is
// captured with them open, and they're closed again. What the build needs: a real closed/open pair (the screen's own
// capture and this one), each group's list as the product shows it open, and which groups keep their list in the page
// and open by a class swap (grid) rather than a list put in and slid open. Main frame only.
async function recGroups(A, state, c) {
  const p = A.page, sel = c.button || REC.opts.groups.button, label = c.label || REC.opts.groups.label || null;
  const look = () => p.mainFrame().evaluate(([sel, label]) => {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim();
    const key = b => { const el = (label && b.querySelector(label)) || b; const c = el.cloneNode(true); c.querySelectorAll('[aria-hidden="true"]').forEach(e => e.remove()); return norm(c.textContent); };
    return [...document.querySelectorAll(sel)].map(b => {
      const id = b.getAttribute('aria-controls'), r = id && document.getElementById(id), br = b.getBoundingClientRect();
      if (!r || br.width < 2) return null;
      return { id, label: key(b), expanded: b.getAttribute('aria-expanded') === 'true', cls: r.getAttribute('class') || '', style: r.getAttribute('style') || '', innerKids: r.firstElementChild ? r.firstElementChild.childElementCount : -1 };
    }).filter(Boolean);
  }, [sel, label]);
  const press = async id => {
    const pt = await p.mainFrame().evaluate(id => { const b = document.querySelector(`[aria-controls="${CSS.escape(id)}"]`); if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.x + Math.min(40, r.width / 2), y: r.y + r.height / 2 }; }, id);
    if (!pt) return false;
    await p.mouse.move(pt.x, pt.y, { steps: 3 }); await sleep(150); await p.mouse.click(pt.x, pt.y); await sleep(200);
    await recSettle(p, 700, 8000);
    return true;
  };
  const rest = REC.states[state].sig;
  const before = (await look()).filter(g => !g.expanded);
  if (!before.length) return { state, groups: 0, note: `no closed groups (${sel}) on this screen` };
  for (const g of before) await press(g.id);
  const after = await look();
  const snap = 'grp-' + state;
  await p.mouse.move(c.neutral ? c.neutral[0] : 4, c.neutral ? c.neutral[1] : 4); await sleep(300);
  await H.snap(p, snap);
  const groups = before.map(g => {
    const o = after.find(x => x.id === g.id) || {};
    const cA = new Set(g.cls.split(/\s+/).filter(Boolean)), oA = new Set((o.cls || '').split(/\s+/).filter(Boolean));
    // Kept in the page and opened by a class swap (grid), or put in and slid open to its height (list).
    const grid = g.innerKids > 0 && !/height:/.test(o.style || '') && [...oA].some(x => !cA.has(x));
    return { id: g.id, label: g.label, opened: !!o.expanded, kind: grid ? 'grid' : 'list', closedOnly: [...cA].filter(x => !oA.has(x)), openOnly: [...oA].filter(x => !cA.has(x)) };
  });
  for (const g of [...groups].reverse()) if (g.opened) await press(g.id);
  await p.mouse.move(4, 4); await recSettle(p, 700, 8000);
  if ((await recSig(p)) !== rest) REC.notes.push(`${state}: after the step groups the page isn't as it was; check the screen before going on`);
  REC.sides.groups.push({ app: A.id, state, closed: REC.states[state].snap, open: snap, button: sel, label: label || undefined, chevron: c.chevron || REC.opts.groups.chevron || undefined, groups });
  return { state, snap, groups: groups.map(g => `${g.label}: ${g.opened ? g.kind : "didn't open"}`) };
}
// A chip list that shows a few rows and then "+N" (record side chips): if the screen shows no "+N", the window is
// narrowed until it does (widths), the screen is captured there (the chip's markup, marked data-d1-plusmark), "+N" is
// clicked to see what it becomes ("Show less", its label), and clicked again; then the window goes back. Writes a
// chips layout rule. ARGS: { list?: selector, widths?: [px] }
async function recChips(A, state, c) {
  const p = A.page;
  const probe = () => p.mainFrame().evaluate(listSel => {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim();
    const vis = e => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1 && getComputedStyle(e).display !== 'none'; };
    for (const ul of document.querySelectorAll(listSel || 'ul,ol,[role=list]')) {
      const items = [...ul.children].filter(e => !/^(script|template|style)$/.test(e.localName));
      const plus = items.find(e => vis(e) && /^\+\d+$/.test(norm(e.textContent)));
      if (!plus) continue;
      plus.setAttribute('data-d1-plusmark', '');
      const btn = plus.querySelector('button,[role=button]') || plus;
      const shown = items.filter(vis);
      const rows = new Set(shown.map(e => Math.round(e.getBoundingClientRect().top))).size;
      const cs = getComputedStyle(ul);
      let gap = parseFloat(cs.columnGap);
      if (!(gap >= 0)) { const [a, b] = shown; gap = a && b ? Math.round(b.getBoundingClientRect().left - a.getBoundingClientRect().right) : 4; }
      const lm = ul.closest('aside,nav,main,header,footer,[role=complementary],[role=navigation],[role=main],[role=region][aria-label],section[aria-label]');
      const q = v => v.replace(/"/g, '\\"');
      const tagSel = e => e.localName + (e.getAttribute('role') ? `[role="${e.getAttribute('role')}"]` : '') + (e.getAttribute('aria-label') ? `[aria-label="${q(e.getAttribute('aria-label'))}"]` : '');
      const r = btn.getBoundingClientRect();
      return { list: (lm ? tagSel(lm) + ' ' : '') + tagSel(ul), item: tagSel(plus).replace(/\[aria-label="[^"]*"\]/, ''), tag: plus.localName, rows: Math.max(1, rows), gap, n: items.length - 1, label: btn.getAttribute('aria-label'), text: norm(btn.textContent), x: r.x + r.width / 2, y: r.y + r.height / 2, vw: innerWidth };
    }
    return null;
  }, c.list || null);
  const base = await p.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio }));
  const s = await ctx.newCDPSession(p);
  let found = await probe(), narrowed = false;
  try {
    for (const w of c.widths || [1366, 1280, 1180, 1100, 1024, 960, 900, 800, 700]) {
      if (found || w >= base.w) continue;
      await s.send('Emulation.setDeviceMetricsOverride', { width: w, height: base.h, deviceScaleFactor: base.dpr, mobile: false });
      narrowed = true;
      await sleep(500); await recSettle(p, 700, 8000);
      found = await probe();
    }
    if (!found) return { state, note: 'no "+N" chip on this screen at any width' };
    const snap = 'chips-' + state;
    // The page can draw the chip again at any time (a resize, a re-render): it's found again, and marked, each time:
    // "+N", else the item that's open, else the last one.
    const mark = () => p.mainFrame().evaluate(list => {
      const ul = document.querySelector(list); if (!ul) return null;
      document.querySelectorAll('[data-d1-plusmark]').forEach(e => e.removeAttribute('data-d1-plusmark'));
      const items = [...ul.children].filter(e => !/^(script|template|style)$/.test(e.localName));
      const m = items.find(e => /^\+\d+$/.test((e.textContent || '').replace(/\s+/g, ' ').trim())) || items.find(e => e.getAttribute('aria-expanded') === 'true' || e.querySelector('[aria-expanded="true"]')) || items[items.length - 1];
      if (!m) return null;
      m.setAttribute('data-d1-plusmark', '');
      const b = m.querySelector('button,[role=button]') || m, r = b.getBoundingClientRect();
      return { label: b.getAttribute('aria-label'), text: (b.textContent || '').replace(/\s+/g, ' ').trim(), expanded: b.getAttribute('aria-expanded'), x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, found.list);
    await p.mouse.move(2, 2); await sleep(300);
    await mark();
    // A source capture only: no screenshot (taking one can make the page draw the chip again, without the mark).
    await H.snap(p, snap, { shot: false });
    const read = mark, at = mark;
    let pt = await at();
    await p.mouse.move(pt.x, pt.y, { steps: 3 }); await sleep(150); await p.mouse.click(pt.x, pt.y); await sleep(300); await recSettle(p, 700, 8000);
    const open = await read();
    pt = await at();
    if (pt) { await p.mouse.move(pt.x, pt.y, { steps: 3 }); await sleep(150); await p.mouse.click(pt.x, pt.y); await sleep(300); await recSettle(p, 700, 8000); }
    const back = await read();
    await p.mainFrame().evaluate(() => document.querySelectorAll('[data-d1-plusmark]').forEach(e => e.removeAttribute('data-d1-plusmark'))).catch(() => {});
    if (!open || open.text === found.text) REC.notes.push(`${state}: clicking "${found.text}" didn't change it; the chips rule shows no "Show less"`);
    if (!back || back.text !== found.text) REC.notes.push(`${state}: "${found.text}" didn't go back after the second click; check the screen`);
    const more = found.label && /\d+/.test(found.label) ? found.label.replace(/\d+/, '{n}') : undefined;
    const rule = { app: A.id, state, list: found.list, item: found.item, rows: found.rows, gap: found.gap, plus: { from: snap, marker: 'data-d1-plusmark=""', tag: found.tag, less: open && open.text !== found.text ? open.text : undefined, labelMore: more, labelLess: open && open.label !== found.label ? open.label || undefined : undefined } };
    REC.sides.chips.push(rule);
    return { state, width: found.vw, rule: `${rule.list} > ${rule.item}: ${rule.rows} rows, gap ${rule.gap}, "${found.text}" → "${open && open.text}"`, labels: [rule.plus.labelMore, rule.plus.labelLess] };
  } finally {
    if (narrowed) { await s.send('Emulation.clearDeviceMetricsOverride').catch(() => {}); await recViewport(p); await sleep(500); }
    await s.detach().catch(() => {});
    await recSettle(p, 700, 8000);
  }
}
// Side paths, from the screen an app is on now. The recorder pauses while they run.
// One side path on the screen an app is on now (for record side, and the automatic ones while recording).
async function recSide(A, c) {
  const state = A.state, p = A.page;
  // Clicks, drags, groups and chips drive the page themselves: the recorder steps aside (off); the others only read.
  const drives = /^(clicks|drags|groups|chips)$/.test(c.kind);
  await (drives ? recSetOff(p, true) : recSetBusy(p, true));
  try {
    await p.bringToFront();
    if (c.kind === 'clicks') {
      const page = c.page || state;
      const out = await SIDE_CLICKS({ ...c, p, page, snapId: 'hov-click-' + page, skip: c.skip || REC.opts.groups.button });
      let frame = null;
      if (out.frameUrl) { const f = p.frames().find(x => x.url().split('?')[0] === out.frameUrl); if (f) frame = await recFrameKey(p, f); }
      const results = out.results.map(r => ({ name: r.name, n: r.n, restore: r.restore, ops: r.ops, portals: r.portals, lazyCss: r.lazyCss, skip: r.skip, effect: r.effect, navigated: r.navigated, error: r.error }));
      // Every control tried is known now (another screen of the app won't try it again); a page only if one opened.
      const seen = recSeen('clicks', A.id + (out.frameUrl || '')); for (const r of out.results) seen.add(r.name);
      if (results.some(r => r.restore)) REC.sides.clicks.push({ page, app: A.id, base: REC.states[state].snap, frame: frame || undefined, results });
      await recInstall(p); await recSettle(p, 900, 12000);
      if ((await recSig(p)) !== REC.states[state].sig) REC.notes.push(`${state}: after the click audit the page isn't as it was (a control it couldn't close?); check the screen before going on`);
      return { page, frame, controls: out.controls, clicks: results.filter(r => r.restore).map(r => `${r.name}: closes by ${r.restore}${r.lazyCss ? `, ${r.lazyCss} lazy stylesheet(s)` : ''}`), skipped: results.filter(r => !r.restore).map(r => `${r.name}: ${r.skip || r.effect || r.navigated || r.error || 'no effect'}`), secs: out.secs };
    }
    if (c.kind === 'groups') return await recGroups(A, state, c);
    if (c.kind === 'chips') return await recChips(A, state, c);
    if (c.kind === 'drags') {
      const out = await SIDE_DRAGS({ ...c, p, page: c.page || state });
      let frame = null;
      if (out.frameUrl) { const f = p.frames().find(x => x.url().split('?')[0] === out.frameUrl); if (f) frame = await recFrameKey(p, f); }
      const rules = [], why = [];
      for (const rec of out.recs || []) {
        const r = dragRule(rec);
        if (r.rule) rules.push({ app: A.id, frame: frame || undefined, state, ...r.rule, restoredOk: rec.restoredOk });
        else why.push(`${rec.label || rec.testid || 'handle'}: ${r.why}`);
        if (rec.restoredOk === false) REC.notes.push(`${state}: the ${rec.label || 'handle'} drag didn't go back to its size; check the pane`);
      }
      REC.sides.drags.push(...rules);
      await recInstall(p);
      return { found: out.found, rules: rules.map(r => `${r.handle}: ${r.write} ${r.mode}${r.min !== undefined ? ` ${r.min}–${r.max}` : ''} dir ${r.dir}`), skipped: why };
    }
    if (c.kind === 'hovers') {
      const out = await SIDE_HOVERS({ ...c, p, page: c.page || state });
      let frame = null;
      if (out.frameUrl) { const f = p.frames().find(x => x.url().split('?')[0] === out.frameUrl); if (f) frame = await recFrameKey(p, f); }
      const seen = recSeen('hovers', A.id + (out.frameUrl || '')); for (const k of out.keys || []) seen.add(k);
      if (out.n) REC.sides.hovers.push({ page: c.page || state, app: A.id, base: state, frame: frame || undefined });
      return { ...out, frame };
    }
    if (c.kind === 'list') {
      const out = await SIDE_LIST({ ...c, p, id: REC.states[state].snap });
      const sig = await recSig(p);
      REC.sigs[A.id].set(sig, state);
      REC.sides.lists.push({ app: A.id, state, ...out.list });
      return out;
    }
    if (c.kind === 'zoom') {
      const base = await p.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio }));
      const s = await ctx.newCDPSession(p);
      const out = [];
      try {
        for (const z of c.zooms || [110, 125, 150, 175, 200]) {
          if (z === 100) continue;
          const k = z / 100;
          const vw = Math.round(base.w / k), vh = Math.round(base.h / k);
          await s.send('Emulation.setDeviceMetricsOverride', { width: vw, height: vh, deviceScaleFactor: base.dpr * k, mobile: false });
          await sleep(600); await recSettle(p, 900, 12000);
          const id = `v${z}-${state}`;
          await H.snap(p, id);
          const lm = await p.evaluate(sel => { const o = {}; for (const q of sel) o[q] = [...document.querySelectorAll(q)].map(e => { const r = e.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; }).filter(b => b[2] > 0 && b[3] > 0).slice(0, 3); return o; }, c.landmarks || ['nav', 'main', 'aside', 'header', '[role=navigation]', '[role=main]', '[role=dialog]', '[role=grid]', '[contenteditable=true]', 'textarea', 'input[type=search]']);
          REC.sides.zoom.push({ app: A.id, state, z, snap: id, vw, vh, dpr: base.dpr * k, landmarks: lm });
          out.push(`${id} ${vw}x${vh}`);
        }
      } finally { await s.send('Emulation.clearDeviceMetricsOverride').catch(() => {}); await s.detach().catch(() => {}); await recViewport(p); await sleep(600); }
      await recSettle(p, 900, 12000);
      return { state, zooms: out };
    }
    throw new Error('side kind: hovers, clicks, drags, groups, chips, list or zoom');
  } finally { await (drives ? recSetOff(p, false) : recSetBusy(p, false)); }
}
// After a window override is cleared: a page with a Playwright viewport (headless) gets it back (the same size again
// is a no-op, hence the 1 px nudge), else the next
// screenshot puts it back late and the page redraws mid-capture (a virtualized list drops the rows it had placed).
async function recViewport(p) { const v = p.viewportSize(); if (v) { await p.setViewportSize({ width: v.width, height: v.height + 1 }).catch(() => {}); await p.setViewportSize(v).catch(() => {}); } }
OPS.recordSide = async c => {
  if (!REC.on) return { error: 'not recording' };
  const A = recApp(c.app || REC.active);
  while (REC.busyNow) await sleep(100);
  REC.paused = true;
  try { const r = await recSide(A, c); recCheckpoint(); return r; } finally { REC.paused = false; }
};
