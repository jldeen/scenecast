// Drag audit: for each resize handle on a page (capture/hover-page.js handles(), or ARGS.handles), holds it and
// moves the pointer in steps both ways, recording at each step the handle's place, its aria values, the panes'
// widths and every inline style the page wrote; then lets go where it started and checks the size is as before
// (and drags it back if not). Also one short drag that is let go, to see what the page keeps. Read-only apart
// from that, which it undoes. Runs as the recorder's drags side path (recordSide: it turns each handle's record into
// a flow.drags rule), or on its own with scenecast run.
// ARGS: { tab | p, page, frameRe?, only?: [label or testid], step?, range?, axis?, releaseDx?, maxHandles? }
const p = ARGS.p || await H.pageFor(ARGS.tab);
await p.bringToFront();
let f = p.mainFrame();
if (ARGS.frameRe) { const re = new RegExp(ARGS.frameRe); let area = 0; for (const fr of p.frames()) { if (!re.test(fr.url())) continue; try { const bb = await (await fr.frameElement()).boundingBox(); if (bb && bb.width * bb.height > area) { area = bb.width * bb.height; f = fr; } } catch (e) {} } }
const off = f === p.mainFrame() ? { x: 0, y: 0 } : await (await f.frameElement()).boundingBox();
await f.evaluate(`(${HOVER_PAGE})()`);
const ev = (fn, a) => f.evaluate(fn, a);
const STEP = ARGS.step || 40, RANGE = ARGS.range || 800;
const out = { page: ARGS.page, handles: [] };
let handles = await ev(() => window.__d1h.handles());
out.found = handles.map(h => (h.label || h.testid || h.cursor) + ' @' + Math.round(h.rect.x) + ',' + Math.round(h.rect.y) + ' ' + Math.round(h.rect.w) + 'x' + Math.round(h.rect.h));
if (ARGS.only) handles = handles.filter(h => ARGS.only.some(k => k === h.label || k === h.testid));
if (ARGS.maxHandles) handles = handles.slice(0, ARGS.maxHandles);

// In the page: what to watch while dragging. The handle's neighbours and their ancestors' siblings (the panes),
// and every style attribute written anywhere.
const setup = () => ev(() => {
  const h = document.querySelector('[data-d1-drag]');
  const watch = new Set();
  for (let e = h, i = 0; e && i < 6; e = e.parentElement, i++) for (const s of (e.parentElement ? e.parentElement.children : [])) watch.add(s);
  window.__d1w = [...watch].filter(e => e.getBoundingClientRect().width > 0);
  const ek = el => [...el.children].filter(c => !/^(script|noscript|template|base)$/.test(c.localName));
  const pathOf = el => { const pth = []; for (let e = el; e && e !== document.body; e = e.parentElement) pth.unshift(ek(e.parentElement).indexOf(e)); return pth.join('.'); };
  window.__d1styles = new Map();
  window.__d1orig = new Map();
  window.__d1mo = new MutationObserver(list => { for (const m of list) if (m.type === 'attributes' && m.target.nodeType === 1) { const t = m.target; if (!window.__d1orig.has(t)) window.__d1orig.set(t, {}); const o = window.__d1orig.get(t); if (!(m.attributeName in o)) o[m.attributeName] = m.oldValue; if (t.closest('[data-d1-drag]') && t !== document.querySelector('[data-d1-drag]')) continue; window.__d1styles.set(pathOf(t) + '|' + m.attributeName, { tag: t.localName, cls: (t.className && t.className.baseVal === undefined ? t.className : '').toString().slice(0, 80), attr: m.attributeName, value: (t.getAttribute(m.attributeName) || '').slice(0, 300), testid: t.getAttribute('data-testid') || t.getAttribute('data-tid') || '', label: t.getAttribute('aria-label') || '' }); } });
  window.__d1mo.observe(document.body, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['style', 'aria-valuenow', 'class', 'data-collapsed', 'data-state', 'hidden'] });
  return window.__d1w.length;
});
const sample = () => ev(() => {
  const h = document.querySelector('[data-d1-drag]');
  const hb = h ? h.getBoundingClientRect() : null;
  const sep = h && (h.matches('[role=separator],[role=slider]') ? h : h.querySelector('[role=separator],[role=slider]') || h.closest('[role=separator],[role=slider]'));
  return { handle: hb && [Math.round(hb.x * 10) / 10, Math.round(hb.y * 10) / 10, Math.round(hb.width), Math.round(hb.height)], now: sep && sep.getAttribute('aria-valuenow'), widths: window.__d1w.map(e => { const b = e.getBoundingClientRect(); return [Math.round(b.x * 10) / 10, Math.round(b.width * 10) / 10]; }), styles: Object.fromEntries([...window.__d1styles].map(([k, v]) => [k, v.value])) };
});
const panes = () => ev(() => window.__d1w.map(e => ({ tag: e.localName, testid: e.getAttribute('data-testid') || e.getAttribute('data-tid') || '', label: e.getAttribute('aria-label') || '', role: e.getAttribute('role') || '', cls: (e.className || '').toString().slice(0, 60), style: (e.getAttribute('style') || '').slice(0, 200), w: Math.round(e.getBoundingClientRect().width) })));

for (const h of handles) {
  const rec = { label: h.label, testid: h.testid, role: h.role, cursor: h.cursor, min: h.min, max: h.max, now0: h.now, rect: h.rect, samples: [] };
  try {
    const ok = await ev(spec => { document.querySelectorAll('[data-d1-drag]').forEach(e => e.removeAttribute('data-d1-drag')); const r = spec.rect; const e = [...document.querySelectorAll('*')].find(x => { const b = x.getBoundingClientRect(); return Math.abs(b.x - r.x) < 1 && Math.abs(b.y - r.y) < 1 && Math.abs(b.width - r.w) < 1 && Math.abs(b.height - r.h) < 1 && (x.getAttribute('aria-label') || null) === (spec.label || null) && (x.getAttribute('data-testid') || null) === (spec.testid || null); }); if (!e) return false; e.setAttribute('data-d1-drag', ''); return true; }, h);
    if (!ok) { rec.error = 'handle not found'; out.handles.push(rec); continue; }
    rec.watch = await setup();
    rec.panes = await panes();
    const vertical = (ARGS.axis || (h.rect.w <= h.rect.h ? 'x' : 'y')) === 'x';
    const cx = off.x + h.rect.x + h.rect.w / 2, cy = off.y + h.rect.y + h.rect.h / 2;
    const at = d => vertical ? [cx + d, cy] : [cx, cy + d];
    rec.start = await sample();
    await p.mouse.move(cx, cy, { steps: 3 }); await sleep(250);
    rec.hover = await sample();
    await p.mouse.down(); await sleep(150);
    const seq = [];
    for (let d = -STEP; d >= -RANGE; d -= STEP) seq.push(d);
    for (let d = -RANGE + STEP; d <= 0; d += STEP) seq.push(d);
    for (let d = STEP; d <= RANGE; d += STEP) seq.push(d);
    for (let d = RANGE - STEP; d >= 0; d -= STEP) seq.push(d);
    for (const d of seq) { await p.mouse.move(...at(d), { steps: 2 }); await sleep(90); const s = await sample(); s.d = d; rec.samples.push(s); }
    await p.mouse.up(); await sleep(500);
    rec.afterUp = await sample();
    // What each written element is, to name it in a rule.
    rec.styleMeta = await ev(() => Object.fromEntries([...window.__d1styles].map(([k, v]) => [k, { tag: v.tag, testid: v.testid, label: v.label, attr: v.attr, cls: v.cls }])));
    rec.vertical = vertical; rec.spec = h.spec; rec.vw = await ev(() => innerWidth);
    // A short drag that's let go: what the page keeps.
    const ds = ARGS.releaseDx || 100;
    for (const d of [ds, -ds]) {
      const s0 = await sample();
      const hb = await ev(() => { const e = document.querySelector('[data-d1-drag]'); const b = e.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; });
      const px = off.x + hb[0], py = off.y + hb[1];
      await p.mouse.move(px, py, { steps: 2 }); await sleep(150); await p.mouse.down(); await sleep(100);
      await p.mouse.move(vertical ? px + d : px, vertical ? py : py + d, { steps: 6 }); await sleep(150);
      await p.mouse.up(); await sleep(600);
      const s1 = await sample(); s1.d = d; s1.before = s0; (rec.release = rec.release || []).push(s1);
    }
    // Back where it was.
    const end = await sample();
    const moved = end.handle && rec.start.handle ? (vertical ? end.handle[0] - rec.start.handle[0] : end.handle[1] - rec.start.handle[1]) : 0;
    if (Math.abs(moved) > 0.5 || end.now !== rec.start.now) {
      const hb = await ev(() => { const e = document.querySelector('[data-d1-drag]'); const b = e.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; });
      await p.mouse.move(off.x + hb[0], off.y + hb[1], { steps: 2 }); await p.mouse.down(); await sleep(100);
      await p.mouse.move(off.x + hb[0] - (vertical ? moved : 0), off.y + hb[1] - (vertical ? 0 : moved), { steps: 8 }); await sleep(150); await p.mouse.up(); await sleep(500);
    }
    rec.restored = await sample();
    rec.restoredOk = rec.restored.now === rec.start.now && Math.abs((rec.restored.handle || [0])[0] - (rec.start.handle || [0])[0]) < 1.5;
    // Back to its size is not quite as it was: the page now holds the width it wrote (a pane pinned at 400 px no longer
    // narrows with the window, which the zoom and "+N" captures of later screens need). Put back what was there.
    if (rec.restoredOk) rec.unpinned = await ev(() => { window.__d1mo.takeRecords(); let n = 0; for (const [el, o] of window.__d1orig) for (const [a, v] of Object.entries(o)) { if (el.getAttribute(a) === v) continue; if (v === null) el.removeAttribute(a); else el.setAttribute(a, v); n++; } return n; });
    await ev(() => { window.__d1mo && window.__d1mo.disconnect(); });
  } catch (e) { rec.error = String(e && e.message || e).slice(0, 200); try { await p.mouse.up(); } catch (e2) {} }
  await H.post('/hover', { page: 'drag-' + ARGS.page, n: out.handles.length, kind: 'drag', cand: { text: h.label || h.testid || '' }, res: {}, drag: rec, frameUrl: f.url().split('?')[0], frameOff: off });
  out.handles.push({ label: h.label || h.testid, samples: rec.samples.length, restoredOk: rec.restoredOk, error: rec.error, now0: rec.now0, nowEnd: rec.restored && rec.restored.now });
  if (ARGS.p) (out.recs = out.recs || []).push(rec);
}
await p.mouse.move(off.x + 5, off.y + 5);
out.frameUrl = f === p.mainFrame() ? null : f.url().split('?')[0];
return out;
