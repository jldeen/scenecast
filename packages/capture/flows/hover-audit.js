// Hover audit: on one tab (or one frame of it), hovers every candidate on screen, at each scroll position, and
// records what the real page shows (capture/hover-page.js). Read-only: it only moves the pointer and scrolls.
// Ends with a full snapshot of the page (its CSS holds every rule the hovers used).
// Runs as the recorder's hovers side path (recordSide), or on its own with cli.mjs run.
// ARGS: { tab | p, page, frameRe?, region?, sel?, perSel?, scroll?: { sel, steps }, only?: [{ sel, text?, textStarts? }],
//         neutral?: [[x, y]], waitMs?, maxS?, snapId?, skipKeys?: [key], max? }
// skipKeys: controls already audited on another screen of the app ("sel|text"), not hovered again; out.keys are the
// ones this run hovered. max: at most this many controls.
// floor: the demo's recorded hovers ([{ id, anchor, scope, rect, card }]): the controls that are theirs on this screen
// (hover-page floorTargets: by place, else by words) are hovered first, never skipped for their kind (skipSels) or
// past max, maxS or perSel, and when nothing shows in waitMs, hovered once more for floorWaitMs (2.5 s); until one of
// a hover's controls shows its card (floorMatch(card, words): the same words, numbers aside; any card when the
// recorded one has no words). out.floorFound: { <id>: 'place' | 'words' }, the recorded hovers whose anchor is here.
// out.floor: per recorded hover, { shown, retried, why? }, or { tried: false } when its controls were there and not
// hovered. out.floorTries: each of their controls hovered ({ key, ids, result: card | other card | nothing, retried,
// picture? }; floorShot(name): a picture of the screen as it showed nothing). out.cards: every hover that showed,
// its card's words ({ key, cards }). out.floorMissKeys: the controls ("sel|text") that showed nothing, to be hovered
// again on the app's next screens.
const p = ARGS.p || await H.pageFor(ARGS.tab);
await p.bringToFront();
let f = p.mainFrame();
if (ARGS.frameRe) {
  const re = new RegExp(ARGS.frameRe); let best = null, area = 0;
  for (const fr of p.frames()) { if (!re.test(fr.url())) continue; try { const bb = await (await fr.frameElement()).boundingBox(); if (bb && bb.width * bb.height > area) { area = bb.width * bb.height; best = fr; } } catch (e) {} }
  if (!best) throw new Error('no frame ' + ARGS.frameRe);
  f = best;
}
const off = f === p.mainFrame() ? { x: 0, y: 0 } : await (await f.frameElement()).boundingBox();
await f.evaluate(`(${HOVER_PAGE})()`);
const ev = (fn, a) => f.evaluate(fn, a);
const move = (x, y, steps = 2) => p.mouse.move(off.x + x, off.y + y, { steps });
const quiet = async (ms, max) => { const s = Date.now(); while (Date.now() - s < max) { if ((await ev(() => window.__d1h.quietFor())) >= ms) return true; await H.poll(60); } return false; };
const t0 = Date.now();
const out = { page: ARGS.page, n: 0, tried: 0, steps: [], neutral: null, floor: {}, floorMissKeys: [], floorTries: [], cards: [] };
const floorShown = new Set(), entries = new Map((ARGS.floor || []).map(e => [e.id, e]));
const fl = c => (c.floor || []).some(id => !floorShown.has(id));
const cardsMatch = ARGS.floorMatch || ((a, b) => { const n = x => String(x || '').toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim(); return !!n(a) && n(a) === n(b); });
const partText = h => String(h || '').replace(/<[^>]*>/g, ' ');
const vw = await ev(() => [innerWidth, innerHeight]);
if (entries.size) out.floorFound = await ev(fl0 => window.__d1h.floorFound(fl0), ARGS.floor).catch(() => ({}));

// Nothing new to hover on this screen (every control was hovered on another): done, before any waiting.
if (!ARGS.scroll && !ARGS.only) {
  const skip0 = new Set(ARGS.skipKeys || []);
  const c0 = await ev(o => window.__d1h.candidates(o), { region: ARGS.region, sel: ARGS.sel, perSel: ARGS.perSel, floor: ARGS.floor });
  if (!c0.some(c => !skip0.has(c.sel + '|' + c.text))) return { page: ARGS.page, n: 0, tried: 0, skipped: c0.length, ...(out.floorFound ? { floorFound: out.floorFound, floor: {}, floorTries: [], cards: [] } : {}), steps: [0], keys: [], frameUrl: f === p.mainFrame() ? null : f.url().split('?')[0], secs: Math.round((Date.now() - t0) / 1000) };
}
// ARGS.ctx: the neutral spot and the noise this app showed on its last screen (the recorder keeps them): the spot is
// used again and the noise only topped up, instead of finding both from scratch on every screen.
if (ARGS.ctx && ARGS.ctx.neutral) {
  out.neutral = ARGS.ctx.neutral;
  await move(...out.neutral, 4); await quiet(300, 2000);
  await ev(sigs => { sigs.forEach(x => window.__d1h.noiseSigs.add(x)); window.__d1h.takeRest(); }, ARGS.ctx.noise || []);
  await sleep(400);
  out.noise = await ev(() => window.__d1h.noise());
} else {
  // Churn that happens with no hover at all (timers, presence) is noise.
  const tries = ARGS.neutral || [[vw[0] - 4, Math.round(vw[1] / 2)], [Math.round(vw[0] / 2), vw[1] - 4], [vw[0] - 4, vw[1] - 4], [4, vw[1] - 4], [Math.round(vw[0] * 0.6), Math.round(vw[1] * 0.55)]];
  await move(...tries[0], 4); await quiet(300, 2000);
  await ev(() => window.__d1h.takeRest()); await sleep(1000);
  out.noise = await ev(() => window.__d1h.noise());
  // A neutral spot: moving there from elsewhere changes nothing (a hover there would show within waitMs).
  for (const pt of tries) {
    await ev(() => window.__d1h.takeRest());
    await move(...pt, 3);
    let moved = false; const s0 = Date.now();
    while (Date.now() - s0 < (ARGS.waitMs || 900)) { await H.poll(80); if (await ev(() => window.__d1h.sig())) { moved = true; break; } }
    if (!moved) { out.neutral = pt; break; }
    await quiet(300, 1500);
  }
  if (!out.neutral) out.neutral = tries[0];
}

const steps = ARGS.scroll ? ARGS.scroll.steps : 0;
for (let step = 0; step <= steps; step++) {
  if (step) {
    const top = await ev(sel => { const e = sel ? document.querySelector(sel) : document.scrollingElement; if (!e) return -1; const was = e.scrollTop; e.scrollTop += Math.round(e.clientHeight * 0.75); return e.scrollTop === was ? -1 : e.scrollTop; }, ARGS.scroll.sel || null);
    if (top < 0) break;
    await sleep(700);
  }
  const cands = ARGS.only
    ? await ev(only => only.map(m => { const els = [...document.querySelectorAll(m.sel)].filter(e => { const t = (e.innerText || '').replace(/\s+/g, ' ').trim(); return (m.text === undefined || t === m.text) && (m.textStarts === undefined || t.startsWith(m.textStarts)); }); const e = els[m.nth || 0]; if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x + Math.min(r.width / 2, 40)), y: Math.round(r.y + r.height / 2), id: -1, sel: m.sel, text: m.text || m.textStarts || '' }; }).filter(Boolean), ARGS.only)
    : await ev(o => window.__d1h.candidates(o), { region: ARGS.region, sel: ARGS.sel, perSel: ARGS.perSel, floor: ARGS.floor });
  const skip = new Set(ARGS.skipKeys || []), skipSels = new Set(ARGS.skipSels || []);
  const todo = cands.filter(c => !skip.has(c.sel + '|' + c.text) && (!skipSels.has(c.sel) || fl(c)));
  // The recording's own hovers first (the next one is always one of theirs while any is left), so a screen's cap or
  // time never cuts them.
  out.skippedKinds = (out.skippedKinds || 0) + cands.filter(c => skipSels.has(c.sel) && !fl(c)).length;
  out.skipped = (out.skipped || 0) + cands.length - todo.length;
  out.steps.push(todo.length);
  // After a control that showed nothing (not one change in the page since the rest copy), the page is still at
  // rest: straight on to the next one, without the trip back to the neutral spot.
  let atRest = false;
  while (todo.length) {
    const next = todo.findIndex(fl), c = todo.splice(next < 0 ? 0 : next, 1)[0];
    const key = c.sel + '|' + c.text, inFloor = fl(c);
    // In the list only for a recorded hover that's since been captured: its kind's learned skip applies again.
    if (!inFloor && skipSels.has(c.sel)) { out.skippedKinds = (out.skippedKinds || 0) + 1; continue; }
    if (ARGS.max && out.tried >= ARGS.max && !inFloor) { out.capped = true; break; }
    (out.keys = out.keys || []).push(key);
    if (Date.now() - t0 > (ARGS.maxS || 900) * 1000 && !inFloor) { out.timedOut = true; break; }
    out.tried++;
    if (!atRest) { await move(...out.neutral); await quiet(250, 1500); await ev(() => window.__d1h.takeRest()); }
    atRest = false;
    if (c.id > 0) await ev(id => window.__d1h.markDone(id), c.id);
    await move(c.x, c.y);
    let s = Date.now(), first = null, retried = false;
    const waitShow = async ms => { while (Date.now() - s < ms) { await sleep(70); if ((await ev(() => window.__d1h.count())) > 0 && (await ev(() => window.__d1h.sig()))) return Date.now() - s; } return null; };
    first = await waitShow(ARGS.waitMs || 1300);
    // A recorded hover that showed nothing: once more, from the neutral spot, waiting longer (a slow card on a busy
    // computer).
    if (first === null && inFloor) {
      retried = true;
      await move(...out.neutral); await quiet(250, 1500); await ev(() => window.__d1h.takeRest());
      await move(c.x, c.y);
      s = Date.now();
      first = await waitShow(ARGS.floorWaitMs || 2500);
    }
    const floorMiss = async why => {
      const picture = ARGS.floorShot ? await ARGS.floorShot(`${ARGS.page}-${out.tried}`).catch(() => null) : null;
      for (const id of c.floor || []) if (!(out.floor[id] && out.floor[id].shown)) out.floor[id] = { shown: false, retried, why };
      out.floorTries.push({ key, ids: c.floor, result: why === 'nothing showed' ? 'nothing' : 'unreadable', retried, picture });
      out.floorMissKeys.push(key);
    };
    // Per kind of control (its selector), how often it was tried and showed something: the recorder stops trying a
    // kind that never shows anything in this app (sweep by sweep, ARGS.skipSels).
    const kind = (out.kinds = out.kinds || {})[c.sel] = (out.kinds || {})[c.sel] || { tried: 0, shown: 0 }; kind.tried++;
    if (first === null) { if (inFloor) await floorMiss('nothing showed'); atRest = (await ev(() => window.__d1h.count())) === 0; continue; }
    kind.shown++; (out.firsts = out.firsts || []).push(first);
    let farMs = null;
    const settleRead = async () => {
      let last = await ev(() => window.__d1h.sig()), stable = Date.now();
      farMs = null;
      while (Date.now() - s < (ARGS.settleMaxMs || 4000)) {
        if (farMs === null && await ev(([x, y]) => window.__d1h.farVisible(x, y), [c.x, c.y])) farMs = Date.now() - s;
        await sleep(farMs === null ? 50 : 150);
        const g = await ev(() => window.__d1h.sig()); if (g !== last) { last = g; stable = Date.now(); } else if (Date.now() - stable > 500 && (farMs !== null || Date.now() - s > 1500)) break;
      }
      return ev(([x, y]) => window.__d1h.result(x, y), [c.x, c.y]);
    };
    let res = await settleRead();
    // A recorded hover whose card couldn't be read: once more, the same way.
    if (!res && inFloor && !retried) {
      retried = true;
      await move(...out.neutral); await quiet(250, 1500); await ev(() => window.__d1h.takeRest());
      await move(c.x, c.y);
      s = Date.now();
      first = await waitShow(ARGS.floorWaitMs || 2500);
      res = first === null ? null : await settleRead();
      if (first === null) { await floorMiss('nothing showed'); atRest = (await ev(() => window.__d1h.count())) === 0; continue; }
    }
    if (!res) { if (inFloor) await floorMiss("what it showed couldn't be read"); continue; }
    const ser = await f.evaluate(H.SERX({ parts: '[data-d1-hpart]' }));
    await ev(() => window.__d1h.unmark());
    try { await H.fetchResources(p, [{ urls: ser.urls, frame: f }]); } catch (e) {}
    // A picture of the hover (the element and whatever it showed), for the side-by-side check.
    const boxes = [res.anchorRect, ...(res.portals || []).map(q => q.pos ? q.pos.rect : q.rect), ...(res.portals || []).map(q => q.triggerRect)].filter(b => b && b.w > 0 && b.h > 0);
    let shot = null;
    if (boxes.length) {
      const x0 = Math.max(0, Math.min(...boxes.map(b => b.x)) - 40 + off.x), y0 = Math.max(0, Math.min(...boxes.map(b => b.y)) - 40 + off.y);
      const x1 = Math.min(off.x + vw[0], Math.max(...boxes.map(b => b.x + b.w)) + 40 + off.x), y1 = Math.min(off.y + vw[1], Math.max(...boxes.map(b => b.y + b.h)) + 40 + off.y);
      if (x1 - x0 > 4 && y1 - y0 > 4) { try { shot = (await p.screenshot({ clip: { x: x0, y: y0, width: Math.min(x1 - x0, 1900), height: Math.min(y1 - y0, 1060) }, timeout: 20000 })).toString('base64'); res.shotClip = { x: x0 - off.x, y: y0 - off.y, w: x1 - x0, h: y1 - y0 }; } catch (e) {} }
    }
    await H.post('/hover', { page: ARGS.page, n: out.n, firstMs: first, farMs, cand: c, step, res, parts: ser.parts, urls: ser.urls, inline: ser.inline, shot, frameUrl: f.url().split('?')[0], frameOff: off, viewport: vw });
    out.n++;
    // Its card's words: each popup's, and what changed in place.
    const cards = [...(res.portals || []).map(q => q.text || ''), (res.ops || []).map(o => o.kind === 'add' ? partText((ser.parts || [])[o.part]) : o.kind === 'addText' || o.kind === 'text' ? (o.text || '') : '').join(' ')].map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
    out.cards.push({ key, cards });
    // A recorded hover of this control: shown when it's that card (any card, when the recording's has no words).
    if (c.floor && c.floor.length) {
      const results = {};
      for (const id of c.floor) {
        const e = entries.get(id), same = !e || !e.card || cards.some(x => cardsMatch(e.card, x));
        results[id] = same ? 'card' : 'other card';
        if (same) { out.floor[id] = { shown: true, retried }; floorShown.add(id); }
        else if (!(out.floor[id] && out.floor[id].shown)) out.floor[id] = { shown: false, retried, why: 'it showed another card' };
      }
      out.floorTries.push({ key, ids: c.floor, results, result: Object.values(results).includes('card') ? 'card' : 'other card', retried });
    }
  }
  for (const c of todo) for (const id of c.floor || []) if (!out.floor[id]) out.floor[id] = { tried: false };
  if (out.timedOut) break;
}
await move(...out.neutral); await quiet(400, 2500);
if (ARGS.scroll && ARGS.scroll.sel !== undefined) { await ev(sel => { const e = sel ? document.querySelector(sel) : document.scrollingElement; if (e) e.scrollTop = 0; }, ARGS.scroll.sel || null); await sleep(600); }
// The page's CSS, for the hovers' parts (none to keep when nothing showed).
if (out.n || ARGS.snapAlways) { const snap = await H.snap(p, ARGS.snapId || ('hov-' + ARGS.page), { shot: false }); out.snap = snap.docs.slice(0, 3); }
out.ctx = { neutral: out.neutral, noise: await ev(() => [...window.__d1h.noiseSigs]).catch(() => []) };
out.frameUrl = f === p.mainFrame() ? null : f.url().split('?')[0];
out.secs = Math.round((Date.now() - t0) / 1000);
return out;
