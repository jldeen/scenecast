// Click audit: on one tab (or one frame of it), clicks each control that opens, closes, expands or toggles
// something, records what the real page did (capture/hover-page.js clickResult), then puts the page back the way
// the page itself does it (Escape, a second click, the control that reopens it, or waiting) and checks it's back.
// Never clicks anything that acts: Send, Like, Delete, menu items, links, dictation (and ARGS.block, a regex of more
// labels). Stylesheets a click brings in (styles that load only when a menu first opens) are kept with the click.
// Results go to the receiver as page "click-<page>"; ends with a snapshot (ARGS.snapId) for the page's CSS.
// Runs as the recorder's clicks side path (recordSide), or on its own with scenecast run.
// ARGS: { tab | p, page, frameRe?, controls?: [{ name, sel, text?, textStarts?, label?, in?, nth?, auto?: ms,
// snap?: id }], pick?: { region?, perLabel?, max? }, skip?: selector, probeSend?: { composer, send }, block?, snapId?,
// maxS?, skipNames?: [name] }. skip: controls pick leaves out (step groups, which the replica opens on its own:
// record side groups). skipNames: controls already audited on another screen of the app.
const p = ARGS.p || await H.pageFor(ARGS.tab);
await p.bringToFront();
let f = p.mainFrame();
const pickFrame = async () => {
  if (!ARGS.frameRe) return p.mainFrame();
  const re = new RegExp(ARGS.frameRe); let best = null, area = 0;
  for (const fr of p.frames()) { if (!re.test(fr.url())) continue; try { const bb = await (await fr.frameElement()).boundingBox(); if (bb && bb.width * bb.height > area) { area = bb.width * bb.height; best = fr; } } catch (e) {} }
  if (!best) throw new Error('no frame ' + ARGS.frameRe);
  return best;
};
f = await pickFrame();
let off = f === p.mainFrame() ? { x: 0, y: 0 } : await (await f.frameElement()).boundingBox();
const install = async () => { await f.evaluate(`(${HOVER_PAGE})()`); };
await install();
const ev = (fn, a) => f.evaluate(fn, a);
const move = (x, y, steps = 2) => p.mouse.move(off.x + x, off.y + y, { steps });
const quiet = async (ms, max) => { const s = Date.now(); while (Date.now() - s < max) { if ((await ev(() => window.__d1h.quietFor())) >= ms) return true; await H.poll(60); } return false; };
const vw = await ev(() => [innerWidth, innerHeight]);
const NEUTRAL = ARGS.neutral || [vw[0] - 4, Math.round(vw[1] / 2)];
const url0 = p.url();
const t0 = Date.now();
const out = { page: ARGS.page, n: 0, tried: 0, results: [] };
const BLOCK0 = /^(Send|Like|Dislike|Delete|Remove|Duplicate|Start dictation|Stop|Approve|Cancel|Sign out|Leave|Add to |Add group|Add file|Add skill|Add context|Find context|Suggest|New |Certified|Promoted|Rename|Archive|Pin|Unpin|Share|Retry|Regenerate|Run|Save|Upload|Publish|Block|Unblock|Deploy|Export|Install|Uninstall|Reply|Post|Join|Meet|Call|Video call|Audio call|Mute|Follow)/i;
const BLOCK = ARGS.block ? new RegExp(BLOCK0.source + '|' + ARGS.block, 'i') : BLOCK0;


// Controls: the listed ones, then (pick) every visible expander or menu button that isn't blocked.
let controls = ARGS.controls || [];
if (ARGS.pick) {
  const picked = await ev(([o, block]) => {
    const B = new RegExp(block, 'i');
    const vis = e => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2 && r.bottom > 0 && r.top < innerHeight && getComputedStyle(e).visibility !== 'hidden'; };
    const root = o.region ? document.querySelector(o.region) : document.body;
    const per = {}; const res = [];
    for (const e of (root || document.body).querySelectorAll('button[aria-expanded],button[aria-haspopup],[role=button][aria-expanded],[role=button][aria-haspopup]')) {
      if (!vis(e) || e.closest('[role=menu],[role=listbox]') || e.disabled || e.getAttribute('aria-disabled') === 'true') continue;
      if (o.skip && e.matches(o.skip)) continue;
      const label = e.getAttribute('aria-label') || (e.innerText || '').replace(/\s+/g, ' ').trim();
      if (!label || B.test(label)) continue;
      const k = label.slice(0, 40); per[k] = (per[k] || 0) + 1; if (per[k] > (o.perLabel || 1)) continue;
      const nth = [...document.querySelectorAll(e.localName + (e.getAttribute('role') ? `[role="${e.getAttribute('role')}"]` : ''))].filter(x => vis(x) && (x.getAttribute('aria-label') || (x.innerText || '').replace(/\s+/g, ' ').trim()) === label).indexOf(e);
      res.push(e.getAttribute('aria-label') ? { name: label, sel: e.localName + (e.getAttribute('role') ? `[role="${e.getAttribute('role')}"]` : ''), label, nth } : { name: label, sel: e.localName + (e.getAttribute('role') ? `[role="${e.getAttribute('role')}"]` : ''), text: label, nth });
    }
    return res.slice(0, o.max || 60);
  }, [{ ...ARGS.pick, skip: ARGS.skip }, BLOCK.source]);
  const have = new Set(controls.map(c => c.name));
  controls = controls.concat(picked.filter(c => !have.has(c.name)));
}
if (ARGS.skipNames) { const sk = new Set(ARGS.skipNames); out.skippedSeen = controls.filter(c => sk.has(c.name)).length; controls = controls.filter(c => !sk.has(c.name)); }
out.controls = controls.map(c => c.name);
// Nothing to click (none here, or all clicked on another screen): done, before any waiting.
if (!controls.length && !ARGS.probeSend) { out.frameUrl = f === p.mainFrame() ? null : f.url().split('?')[0]; out.secs = Math.round((Date.now() - t0) / 1000); return out; }
await move(...NEUTRAL, 4); await quiet(300, 2000);
await ev(() => window.__d1h.takeRest()); await sleep(1000);
out.noise = await ev(() => window.__d1h.noise());

async function settle(maxMs = 3000) {
  let last = await ev(() => window.__d1h.sig()), stable = Date.now(); const s = Date.now();
  while (Date.now() - s < maxMs) { await H.poll(150); const g = await ev(() => window.__d1h.sig()); if (g !== last) { last = g; stable = Date.now(); } else if (Date.now() - stable > 500) break; }
}
const vis = () => ev(() => window.__d1h.visibleOps());
async function backToRest() {
  // Reload as a last resort (the page's own state, nothing in the tenant).
  await p.goto(url0, { waitUntil: 'domcontentloaded' }); await sleep(ARGS.reloadWaitMs || 9000);
  // Teams opens the last conversation after a reload: back to the channel the audit was on.
  if (ARGS.reopenText) { for (let i = 0; i < 30; i++) { const el = p.getByText(ARGS.reopenText, { exact: true }).first(); if (await el.isVisible().catch(() => false)) { const b = await el.boundingBox(); await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2); await sleep(5000); break; } await sleep(1000); } }
  f = await pickFrame(); off = f === p.mainFrame() ? { x: 0, y: 0 } : await (await f.frameElement()).boundingBox();
  await install(); await move(...NEUTRAL); await quiet(400, 3000);
}

for (const c of controls) {
  if (Date.now() - t0 > (ARGS.maxS || 900) * 1000) { out.timedOut = true; break; }
  out.tried++;
  const r = { name: c.name };
  try {
    await move(...NEUTRAL); await quiet(300, 2000);
    const ctl = await ev(m => window.__d1h.markCtl(m), c);
    if (!ctl) { r.skip = 'not on screen'; out.results.push(r); continue; }
    await sleep(100);
    await ev(() => window.__d1h.takeRest());
    const urlBefore = p.url();
    await move(ctl.x, ctl.y, 3); await sleep(120);
    await p.mouse.down(); await sleep(60); await p.mouse.up();
    const tc = Date.now();
    await sleep(150); await move(...NEUTRAL); await settle(c.settleMs || 3000);
    r.ms = Date.now() - tc;
    if (p.url() !== urlBefore) { r.navigated = p.url().slice(0, 120); await p.goto(urlBefore, { waitUntil: 'domcontentloaded' }); await sleep(8000); f = await pickFrame(); await install(); out.results.push(r); continue; }
    r.visible = await vis();
    const res = await ev(rect => window.__d1h.clickResult(rect), ctl.rect);
    if (!res || !r.visible) { r.effect = 'none'; await ev(() => window.__d1h.unmark()); out.results.push(r); continue; }
    const ser = await f.evaluate(H.SERX({ parts: '[data-d1-hpart]' }));
    await ev(() => window.__d1h.unmark());
    try { await H.fetchResources(p, [{ urls: ser.urls, frame: f }]); } catch (e) {}
    let css = null;
    if (await ev(() => window.__d1h.markNewCss())) {
      const c2 = await f.evaluate(H.SERX({ parts: '[data-d1-hcss]' }));
      await ev(() => window.__d1h.unmarkCss());
      try { await H.fetchResources(p, [{ urls: c2.urls, frame: f }]); } catch (e) {}
      css = { parts: c2.parts, urls: c2.urls, inline: c2.inline };
      r.lazyCss = c2.parts.length;
    }
    const shot = (await p.screenshot({ timeout: 20000 })).toString('base64');
    const newCtls = await ev(() => window.__d1h.newControls());
    if (c.snap) { try { await H.snap(p, c.snap, { shot: false }); r.snap = c.snap; } catch (e) { r.snapError = String(e).slice(0, 120); } }
    // Putting it back, the way the page does.
    let restore = null, reopen = null, revertMs = null;
    if (c.auto) { const s = Date.now(); while (Date.now() - s < c.auto) { await sleep(150); if (!(await vis())) { restore = 'auto'; revertMs = Date.now() - tc; break; } } }
    if (!restore && !c.noEscape) { await p.keyboard.press('Escape'); await sleep(150); await settle(1500); if (!(await vis())) restore = 'escape'; }
    if (!restore) {
      const again = await ev(() => { const e = window.__d1h.ctl; if (!e || !e.isConnected) return null; const b = e.getBoundingClientRect(); return b.width > 2 ? { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) } : null; });
      if (again) { await move(again.x, again.y, 3); await sleep(100); await p.mouse.click(off.x + again.x, off.y + again.y); await sleep(200); await move(...NEUTRAL); await settle(2000); if (!(await vis())) restore = 'toggle'; }
    }
    // Only a control that says it opens, closes, expands or shows something: never a menu or list item.
    const cand = newCtls.find(x => /^(open|close|expand|show|collapse|hide|back)\b/i.test(x.label || ''));
    if (!restore && cand) {
      await move(cand.x, cand.y, 3); await sleep(100); await p.mouse.click(off.x + cand.x, off.y + cand.y); await sleep(200); await move(...NEUTRAL); await settle(2500);
      if (!(await vis())) { restore = 'reopen'; reopen = cand.spec; }
    }
    if (!restore) { restore = 'stuck'; r.stuckOps = await vis(); await backToRest(); }
    await H.post('/hover', { page: 'click-' + ARGS.page, n: out.n, kind: 'click', cand: { text: c.name }, ctl, res, parts: ser.parts, urls: ser.urls, inline: ser.inline, restore, reopen, revertMs, clickMs: r.ms, auto: c.auto || null, shot, css, frameUrl: f.url().split('?')[0], frameOff: off, viewport: vw });
    Object.assign(r, { n: out.n, restore, reopen: reopen && reopen.sel, ops: (res.ops || []).length, portals: (res.portals || []).length });
    out.n++;
  } catch (e) { r.error = String(e && e.message || e).slice(0, 200); try { await backToRest(); } catch (e2) {} }
  out.results.push(r);
}

// Send: what it looks like with the box empty, after typing, and when hovered; then the box is emptied again.
if (ARGS.probeSend) {
  const ps = ARGS.probeSend; const look = sel => ev(sel => { const e = document.querySelector(sel); if (!e) return null; const cs = getComputedStyle(e); return { attrs: Object.fromEntries([...e.attributes].filter(a => !/^(style|id)$/.test(a.name)).map(a => [a.name, a.value.slice(0, 160)])), bg: cs.backgroundColor, color: cs.color, cursor: cs.cursor, opacity: cs.opacity, html: e.outerHTML.slice(0, 1200) }; }, sel);
  const probe = { empty: await look(ps.send) };
  const box = await ev(sel => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x + 40), y: Math.round(b.y + b.height / 2) }; }, ps.composer);
  if (box) {
    await move(box.x, box.y); await p.mouse.click(off.x + box.x, off.y + box.y); await sleep(300);
    probe.focusedEmpty = await look(ps.send);
    await p.keyboard.type('x', { delay: 30 }); await sleep(600);
    probe.typed = await look(ps.send);
    const sb = await ev(sel => { const e = document.querySelector(sel); const b = e.getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; }, ps.send);
    await ev(() => window.__d1h.takeRest());
    await move(sb.x, sb.y, 4); await sleep(1200);
    probe.hoverTyped = await look(ps.send);
    const hres = await ev(([x, y]) => window.__d1h.result(x, y), [sb.x, sb.y]);
    probe.hoverResult = hres ? { ops: (hres.ops || []).length, portals: (hres.portals || []).map(q => q.text) } : null;
    if (hres) { const ser = await f.evaluate(H.SERX({ parts: '[data-d1-hpart]' })); await ev(() => window.__d1h.unmark()); await H.post('/hover', { page: 'click-' + ARGS.page, n: 900, kind: 'send-hover', cand: { text: 'Send (typed)' }, res: hres, parts: ser.parts, urls: ser.urls, inline: ser.inline, firstMs: 200, frameUrl: f.url().split('?')[0], frameOff: off, viewport: vw }); }
    await move(box.x, box.y); await p.mouse.click(off.x + box.x, off.y + box.y); await sleep(150);
    await p.keyboard.press('Backspace'); await sleep(500);
    probe.cleared = await look(ps.send);
    await move(...NEUTRAL);
    // Hovering Send while it's disabled.
    await ev(() => window.__d1h.takeRest());
    await move(sb.x, sb.y, 4); await sleep(1200);
    probe.hoverEmpty = await look(ps.send);
    const he = await ev(([x, y]) => window.__d1h.result(x, y), [sb.x, sb.y]);
    probe.hoverEmptyResult = he ? { ops: (he.ops || []).length, portals: (he.portals || []).map(q => q.text) } : null;
    if (he) { const ser = await f.evaluate(H.SERX({ parts: '[data-d1-hpart]' })); await ev(() => window.__d1h.unmark()); await H.post('/hover', { page: 'click-' + ARGS.page, n: 901, kind: 'send-hover', cand: { text: 'Send (empty)' }, res: he, parts: ser.parts, urls: ser.urls, inline: ser.inline, firstMs: 200, frameUrl: f.url().split('?')[0], frameOff: off, viewport: vw }); }
    await move(...NEUTRAL); await sleep(300);
    probe.boxText = await ev(sel => (document.querySelector(sel) || {}).innerText, ps.composer);
  }
  await H.post('/hover', { page: 'click-' + ARGS.page, n: 999, kind: 'send-probe', cand: { text: 'send probe' }, res: {}, probe });
  out.sendProbe = { empty: probe.empty && probe.empty.attrs, typed: probe.typed && probe.typed.attrs, boxText: probe.boxText };
}
await move(...NEUTRAL); await quiet(300, 1500);
if (ARGS.snapId && out.n) out.snap = (await H.snap(p, ARGS.snapId, { shot: false })).docs.slice(0, 3);
out.frameUrl = f === p.mainFrame() ? null : f.url().split('?')[0];
out.secs = Math.round((Date.now() - t0) / 1000);
return out;
