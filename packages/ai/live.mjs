// The live walker: walker.mjs's interface on the real, signed-in apps (the capture browser), through the recorder's
// own commands, so the same steps run whether it's recording or only walking.
//   const w = liveWalker({ demo, cmd, packs })
//   w.start(app) → screen                   { app, url, sig, title } (sig: a hash of the screen's controls and title)
//   w.step(screen, step) → { screen, landed, wrote: false, why?, kind? }
//       A walker never writes: it throws (code 'WRITE') before a step that would, whatever says so: the plan's
//       Writes, the app's pack (writeFor), or the step itself (risk(): a send, a save, Enter in a message box). A
//       pack's safe entry (safeFor), or the plan's Safe, lets a picker or a menu through.
//       landed: false when the control isn't there (kind 'missing'), the step left the app's hosts, opened a window
//       or a dialog (kind 'offplan': it goes back, Escape then the page before), a sign-in page shows (kind 'signin':
//       never signed in here), or what the step lands on isn't on the screen (kind 'elsewhere').
//   w.act(app, step, { write }) → { did } | { missing, why } | { needsYou, why }   the step itself (write: the caller
//       has checked it may: planned, approved, re-matched, the guard open for it)
//   w.check(app, step) → { ok } | { ok: false, kind, why }                         where it landed
//   w.write(app, step, { hosts }) → { did, wrote, result } | { missing, why }      a planned write (see write())
//   w.writeOf(step, el, field, url) → { why, pack?, write? } | null                would it write
//   w.controls(app) → outline                                                     the screen's controls and words
// recording: the recorder is recording (it holds each click until it has captured the screen, so a step waits for
// it to have seen and done it).
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { findItem, nameFits, composer, searchBox, norm } from './find.mjs';
import { risk, formatStep, parseStep } from './plan.mjs';
import { appTab, settled, sleep } from './run.mjs';
import { landedOn } from '@stuntdouble/capture/browser.mjs';
import { CONTROL_NAME_SRC } from '@stuntdouble/capture/page-naming.mjs';
import { READ_DOCS_SRC } from '@stuntdouble/capture/page-read.mjs';
import { readScreen } from '@scenecast/script/html.mjs';
import { holds, pageWords, pnorm } from './landing.mjs';

// The words of an app showing an error instead of what it should.
// A step's proof that it landed (plan.mjs parseLands, docs/engine/plan-format.md "What proves a step"): words on the
// screen, a control (in a state), a box's text, or words gone. None (kind null): the step can't be proven (a walk
// says unproven; a run goes on only by its next control, and never into a write).
export const proofOf = s => {
  const l = s && s.lands;
  if (!l) return null;
  const kind = l.kind !== undefined ? l.kind : l.text ? 'words' : null;
  if (!kind || (kind === 'words' && !l.text)) return null;
  return { ...l, kind };
};
const NO_PROOF = 'the plan gives this step no proof of where it lands';
// What an app's start steps may be: navigation, nothing that types, presses or writes.
const NAVIGATION = new Set(['click', 'hover', 'scroll', 'wait']);
const isAddress = x => /^https?:\/\//i.test(String(x || '').trim());
// An app's start steps: apps[].start as a list (an address and/or plan steps), then the older startSteps.
export const startSteps = a => [...(Array.isArray(a && a.start) ? a.start.filter(x => !isAddress(x)) : []), ...((a && a.startSteps) || [])];
const startAddress = a => Array.isArray(a.start) ? a.start.find(isAddress) || null : isAddress(a.start) ? a.start : null;
// A control's role and name in a page, by the reader's own rule (controlOf, @stuntdouble/core/lib/control-name.mjs), so
// a plan's step finds the same control live as the reader named on the recorded screen.
const NAMING = CONTROL_NAME_SRC;
// What's at a point in one frame: the controls at it and around it, innermost first (by the same rule), else the
// element itself. A click there lands on the target when the target is one of them (the point is on it or inside it).
const HIT = `(() => { ${NAMING}
  const e = document.elementFromPoint(__X__, __Y__);
  if (!e) return null;
  const chain = [];
  for (let c = e; c && chain.length < 12; c = c.parentElement) { const d = domControl(c); if (d.control) chain.push({ name: d.name, role: d.role }); }
  return chain.length ? { ...chain[0], chain } : { name: '', role: e.localName, none: true, chain };
})()`;
// Every control in one frame, on screen or not: its name and role the reader's way (controlOf), its state, and
// what a box holds now (an input's or a text area's value, an editable area's words: never the value attribute,
// which doesn't change as you type).
const FRAME_CONTROLS = sel => `(() => { ${NAMING}
  return [...document.querySelectorAll(${JSON.stringify(sel)})].slice(0, 2000).map((e, ei) => {
    const r = e.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const c = domControl(e), field = /^(INPUT|TEXTAREA)$/.test(e.tagName);
    return { ei, name: c.name, role: c.role, editable: e.isContentEditable || field, disabled: !!e.disabled || e.getAttribute('aria-disabled') === 'true',
      selected: e.getAttribute('aria-selected'), expanded: e.getAttribute('aria-expanded'), pressed: e.getAttribute('aria-pressed'),
      checked: e.type === 'checkbox' || e.type === 'radio' ? String(!!e.checked) : e.getAttribute('aria-checked'),
      value: field ? String(e.value || '') : e.isContentEditable ? String(e.innerText || '') : null,
      x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }).filter(Boolean); })()`;
const TROUBLE = /could not be loaded|couldn['’]t (?:be )?load(?:ed)?|can['’]t load|something went wrong|failed to load|unable to (?:load|sign|connect)|having trouble connecting|trouble connecting/gi;
const hostOf = s => { try { return new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`).host; } catch (e) { return ''; } };

// The demo's packs as the walker uses them (@stuntdouble/apps): the one for a page's address, its writes and safe.
export async function walkerPacks() {
  try {
    const m = await import('@stuntdouble/apps/index.mjs');
    return { packFor: url => m.packFor(url), writeFor: m.writeFor, safeFor: m.safeFor, guardFor: m.guardFor, packsForDemo: m.packsForDemo, servicesFor: m.servicesFor };
  } catch (e) { return null; }
}

// Where each app starts in the demo: its own `start` in demo.json (an address that opens on the demo's first screen,
// for an app that opens where it was last, as Teams does), else its start screen in the recording (flow.json's first
// beat), else its address. The capture browser opens an app at its address; a demo starts on a page of its own.
export function startUrls(demo) {
  const out = Object.fromEntries((demo.cfg.apps || []).map(a => [a.id, a.url]));
  const own = new Set((demo.cfg.apps || []).filter(a => startAddress(a)).map(a => a.id));
  let flow; try { flow = JSON.parse(readFileSync(join(demo.dir, 'flow.json'), 'utf8')); } catch (e) { return out; }
  const S = flow.states || {};
  for (const [app, sig] of Object.entries(((flow.beats || [])[0] || {}).states || {})) {
    if (out[app] === undefined || own.has(app)) continue;
    const snap = (S[sig] || {}).snap || sig;
    for (const f of [demo.raw && join(demo.raw, 'snaps', snap + '.json'), join(demo.dir, 'data', 'snaps', snap + '.json')].filter(Boolean)) {
      try { const u = JSON.parse(readFileSync(f, 'utf8')).url; if (/^https?:/.test(u || '')) { out[app] = u; break; } } catch (e) {}
    }
  }
  for (const a of demo.cfg.apps || []) if (startAddress(a)) out[a.id] = startAddress(a);
  return out;
}

const SIG_SRC = "const out = []; for (const f of page.frames()) { const r = await f.evaluate(() => window.__rkrec ? window.__rkrec.sig() : null).catch(() => null); if (r) out.push((f === page.mainFrame() ? 'main' : 'frame') + '=' + r); } return out.sort().join(' ');";
// tabs: { app: mark } a tab of its own for an app instead of the app's (Set before's side tab, capTab).
export function liveWalker({ demo, cmd, packs = null, recording = false, tabs = null, log = () => {} }) {
  const apps = demo.cfg.apps || [];
  const appOf = name => { const ids = apps.map(a => a.id); return ids.find(a => a === name) || ids.find(a => a.startsWith(name) || name.startsWith(a)) || null; };
  const tab = id => (tabs && tabs[id]) || appTab(demo, id);
  // An app's own hosts: its address, its match, its pack's.
  const hostsOf = id => {
    const a = apps.find(x => x.id === id) || {};
    const out = new Set([hostOf(a.url), hostOf(a.match)].filter(Boolean));
    const p = packs && packs.packFor ? packs.packFor(a.url || a.match) : null;
    for (const m of (p && p.match) || []) { const h = hostOf(m); if (h && !h.includes('*')) out.add(h); }
    for (const h of ((p && p.guard) || {}).hosts || []) out.add(h);
    return out;
  };
  const onHosts = (host, id) => [...hostsOf(id)].some(h => host === h || host.endsWith('.' + h) || h.endsWith('.' + host));
  const controls = id => cmd('observe', { tab: tab(id) }, 30);
  // Every frame's words: the page's own and its frames' (IQ's Power BI report is in one).
  const words = id => cmd('js', { tab: tab(id), code: "let t = ''; for (const f of page.frames()) t += '\\n' + await f.evaluate(() => document.body ? document.body.innerText : '').catch(() => ''); return t;" }, 30).catch(() => '');
  const quiet = (id, ms = 600, maxMs = 8000) => cmd('js', { tab: tab(id), code: `return await H.waitQuiet(page, ${ms}, ${maxMs})` }, Math.ceil(maxMs / 1000) + 30).catch(() => false);
  const settle = async (id, maxS = 60) => recording ? settled(cmd, { maxS }) : quiet(id, 700, maxS * 1000);
  const sigOf = o => createHash('sha1').update(JSON.stringify([o.title, (o.headings || []).slice(0, 8), (o.items || []).map(i => `${i.role}:${i.name}`).slice(0, 60)])).digest('hex').slice(0, 12);
  const screenOf = (id, o) => ({ app: id, url: o.url, sig: sigOf(o), title: o.title });
  // The recorder, when it's recording, holds each action until it has captured the screen it was on: wait until it
  // has counted it (or is capturing now).
  const actions = async () => recording ? ((await cmd('recordStatus', {}, 30)).actions || 0) : 0;
  const seen = async (before, maxS = 30) => {
    if (!recording) return true;
    for (let t0 = Date.now(); Date.now() - t0 < maxS * 1000;) { const s = await cmd('recordStatus', {}, 30); if ((s.actions || 0) > before || s.busy || (s.typing || []).length) return true; await sleep(250); }
    log(`the recorder didn't see that step within ${maxS} s`);
    return false;
  };
  // A control by name, given a few seconds to show up: the page's own on screen, else one anywhere in the page or its
  // frames (Microsoft IQ's controls are in Power BI's; a long list can scroll a control off the screen), by the same
  // names, brought into view.
  const locate = async (id, name, kind) => {
    let o = null;
    for (let i = 0; i < 6; i++) {
      o = await controls(id);
      const el = kind === 'composer' ? composer(o.items) : findItem(o.items, name, kind);
      if (el) return { el, o };
      // The rest of the page and its frames get the same few seconds (IQ's draw late, in Power BI's frames).
      if (i > 0 && kind !== 'composer' && name) { const f = await inPage(id, name, kind).catch(() => null); if (f) return { el: f, o }; }
      if (i < 5) await sleep(800);
    }
    return { el: null, o };
  };
  const selFor = kind => kind === 'field' ? 'input,textarea,[contenteditable=true],[role=textbox],[role=searchbox],[role=combobox]'
    : 'button,a[href],input,textarea,[contenteditable=true],[role=button],[role=link],[role=treeitem],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=switch],[role=radio],[role=textbox],[role=searchbox],[role=combobox]';
  // Every control in the page and its frames, on screen or not, at its place on the page: the frame's box plus the
  // control's place in it.
  const pageControls = (id, kind) => { const sel = selFor(kind); return cmd('js', { tab: tab(id), code: `
      const out = [], frames = page.frames();
      for (const [fi, f] of frames.entries()) {
        const main = f === page.mainFrame();
        const fe = main ? null : await f.frameElement().catch(() => null), fb = main ? { x: 0, y: 0 } : fe ? await fe.boundingBox().catch(() => null) : null;
        if (!fb) continue;
        const list = await f.evaluate(${JSON.stringify(FRAME_CONTROLS(sel))}).catch(() => []);
        const fh = main ? 'page' : (() => { try { return new URL(f.url()).host; } catch (e) { return 'a frame'; } })();
        for (const it of list) if (it.name) out.push({ ...it, x: Math.round(fb.x + it.x), y: Math.round(fb.y + it.y), frame: !main, fi, fh });
      }
      return out;` }, 60); };
  const inPage = async (id, name, kind) => {
    const items = await pageControls(id, kind).catch(() => null);
    // By its name only (nameFits): a name that only contains it, a small part of it or a few shared words found the
    // wrong control in a frame.
    const el = Array.isArray(items) ? findItem(items, name, kind) : null;
    if (!el || !nameFits(el.name, name)) return null;
    return intoView(id, el, kind);
  };
  // Where a person would click it: brought into view first (IQ scrolls inside its frame, so a wheel on the page
  // doesn't), then measured again. null when it can't be.
  async function intoView(id, el, kind) {
    const sel = selFor(kind);
    const at = await cmd('js', { tab: tab(id), code: `
      const f = page.frames()[${el.fi}]; if (!f) return null;
      const main = f === page.mainFrame();
      const fe = main ? null : await f.frameElement().catch(() => null), fb = main ? { x: 0, y: 0 } : fe ? await fe.boundingBox().catch(() => null) : null;
      const vp = page.viewportSize() || await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      const r = await f.evaluate(([sel, ei]) => {
        const e = [...document.querySelectorAll(sel)][ei]; if (!e) return null;
        const b = e.getBoundingClientRect();
        if (b.top < 0 || b.left < 0 || b.bottom > innerHeight || b.right > innerWidth) e.scrollIntoView({ block: 'center', inline: 'nearest' });
        const c = e.getBoundingClientRect(); return { x: c.x + c.width / 2, y: c.y + c.height / 2 };
      }, [${JSON.stringify(sel)}, ${el.ei}]).catch(() => null);
      return r && fb ? { x: Math.round(fb.x + r.x), y: Math.round(fb.y + r.y), vw: vp.width, vh: vp.height } : null;` }, 30).catch(() => null);
    if (!at || at.x < 0 || at.y < 0 || at.x > at.vw || at.y > at.vh) return null;
    if (at.x !== el.x || at.y !== el.y) await sleep(400);
    return { ...el, x: at.x, y: at.y };
  }
  const focusedField = o => (o.items || []).find(it => it.focused && (it.editable || /textbox|searchbox|combobox/.test(it.role))) || null;
  // The controls in the page and its frames with exactly that name (and that role and frame, when given), one per place.
  async function exactControls(id, name, { role = null, frame = null, kind } = {}) {
    const items = await pageControls(id, kind).catch(() => null) || [];
    const seen = new Set();
    return items.filter(it => !it.disabled && norm(it.name) === norm(name) && (!role || it.role === role) && (!frame || (it.fh || 'page') === frame))
      .filter(it => { const k = `${it.fh || 'page'}|${Math.round(it.x / 4)},${Math.round(it.y / 4)}`; return seen.has(k) ? false : (seen.add(k), true); })
      .map(it => ({ ...it, fh: it.fh || 'page' }));
  }
  // One exact control, brought into view (a write's).
  async function exactInView(id, name, opts = {}) {
    const same = await exactControls(id, name, opts);
    if (same.length !== 1) return { same };
    const el = await intoView(id, same[0], opts.kind);
    return { same, el };
  }
  // What a click at x, y on the page would land on: down through the frames under it, the control there.
  const hitAt = (id, x, y) => cmd('js', { tab: tab(id), code: `
    const HIT = ${JSON.stringify(HIT)};
    let f = page.mainFrame(), ox = 0, oy = 0;
    for (let i = 0; i < 6; i++) {
      const lx = ${x} - ox, ly = ${y} - oy;
      const h = await f.evaluateHandle(([x, y]) => document.elementFromPoint(x, y), [lx, ly]).catch(() => null);
      const el = h && h.asElement();
      if (!el) return null;
      const cf = await el.contentFrame().catch(() => null);
      if (cf) { const b = await el.boundingBox(); if (!b) return null; ox = b.x; oy = b.y; f = cf; continue; }
      const r = await f.evaluate(HIT.replace('__X__', String(lx)).replace('__Y__', String(ly))).catch(() => null);
      let host = 'page'; if (f !== page.mainFrame()) { try { host = new URL(f.url()).host; } catch (e) { host = 'a frame'; } }
      return r && { ...r, frame: host };
    }
    return null;` }, 30);
  // Before a click: what's at the point has to be the control it means (the same role and name, in the same frame),
  // not whatever's on top of it (a toast, a banner, a dialog's backdrop, a sticky header after a scroll). Measured
  // again for up to 2 s; still covered, it isn't clicked.
  const sameControl = (h, el) => h && (h.frame || 'page') === (el.fh || 'page') && (h.chain || []).some(c => c.role === el.role && (norm(c.name) === norm(el.name) || nameFits(c.name, el.name)));
  async function uncovered(id, el, want, kind, relocate = null) {
    let h = null;
    for (const t0 = Date.now(); ;) {
      h = await hitAt(id, el.x, el.y).catch(() => null);
      if (sameControl(h, el)) { const t = h.chain.find(c => c.role === el.role && (norm(c.name) === norm(el.name) || nameFits(c.name, el.name))); return { ok: true, el, hit: { on: t.name, role: t.role, frame: h.frame, ...(t !== h.chain[0] ? { at: { on: h.name, role: h.role } } : {}) } }; }
      if (Date.now() - t0 > 2000) break;
      await sleep(250);
      const again = relocate ? await relocate() : want ? (await locate(id, want, kind)).el : null;
      if (again) el = again;
    }
    const by = !h ? 'nothing it can see' : h.none ? `a ${h.role}` : `"${h.name}" (${h.role})`;
    return { ok: false, el, hit: h && { on: h.name, role: h.role, frame: h.frame }, why: `"${el.name}" is covered by ${by}${h && h.frame && h.frame !== 'page' ? ` in ${h.frame}` : ''}` };
  }

  // Every input it sends (click, hover, key, typing, wheel), with what it was for and what it hit: the control's name,
  // its frame ('page', else the frame's host) and whether it's the one the step names (exact, fits, or near: a few of
  // the same words, on the page's own outline). Typing keeps its length, never the words.
  const inputs = [];
  const fitOf = (name, want) => !want ? null : norm(name) === norm(want) ? 'exact' : nameFits(name, want) ? 'fits' : 'near';
  const send = (id, kind, args, secs, note = {}) => {
    inputs.push({ at: new Date().toISOString(), app: id, kind, ...(args.x !== undefined ? { x: args.x, y: args.y } : {}), ...(args.key ? { key: args.key } : {}), ...(args.text !== undefined ? { chars: String(args.text).length } : {}), ...(args.dy !== undefined ? { dy: args.dy } : {}), ...note });
    return cmd(kind, { tab: tab(id), ...args }, secs);
  };
  const hitOf = (el, step, want = step.target) => ({ for: formatStep(step), on: el.name, frame: el.fh || 'page', fit: fitOf(el.name, want) });

  // Would this step write? The plan's word first, then the app's pack, then the step itself.
  function writeOf(step, el, field, url) {
    if (step.writes) {
      const tag = / · ([\w-]+):([\w-]+)$/.exec(step.writes);
      return { why: `the plan says it ${step.writes.replace(/ · [\w-]+:[\w-]+$/, '')}`, planned: true, pack: tag ? tag[1] : null, write: tag ? tag[2] : null };
    }
    const pack = packs && packs.packFor ? packs.packFor(url) : null;
    const pw = pack && packs.writeFor ? packs.writeFor(pack, step, field) : null;
    if (pw) return { why: `the ${pack.id} pack lists it as a write (${pw.id})`, pack: pack.id, write: pw.id };
    if (step.safe || (pack && packs.safeFor && packs.safeFor(pack, step, field))) return null;
    const r = risk(step, el, field);
    return r ? { why: r } : null;
  }
  const refuse = (step, w) => { throw Object.assign(new Error(`a walker doesn't write: ${formatStep(step)}: ${w.why}`), { code: 'WRITE', write: w }); };

  let lastField = null;
  async function act(id, step, { write = false, el: given = null } = {}) {
    switch (step.kind) {
      case 'app': { await cmd('front', { tab: tab(id) }, 30); await quiet(id, 500, 6000); return { did: 'switched' }; }
      case 'wait': await settle(id, 300); if (!recording) await quiet(id, 1500, 180000); return { did: 'waited' };
      case 'scroll': {
        const o = await controls(id);
        await send(id, 'wheel', { x: Math.round(o.vw / 2), y: Math.round(o.vh / 2), dy: step.dir === 'up' ? -600 : 600 }, 30, { for: formatStep(step) });
        await settle(id, 30);
        return { did: 'scrolled' };
      }
      case 'manual': return { needsYou: true, why: `"${formatStep(step)}" is the presenter's to do` };
      case 'free': return { needsYou: true, why: `"${step.text}" isn't a step it can do on its own` };
      case 'click': case 'hover': {
        const { el, o } = given ? { el: given, o: await controls(id) } : await locate(id, step.target);
        if (!el) return { missing: true, why: `no "${step.target}" on this screen` };
        const hit = hitOf(el, step);
        if (step.kind === 'hover') { await send(id, 'hover', { x: el.x, y: el.y }, 30, hit); await settle(id, 30); return { did: 'hovered', on: el.name, hit }; }
        const w = writeOf(step, el, null, o.url);
        if (w && !write) refuse(step, w);
        // A write's control is measured again exactly (its name, role and frame), never by a near name.
        const again = given ? async () => (await exactInView(id, given.name, { role: given.role, frame: given.fh || 'page' })).el || null : null;
        const u = await uncovered(id, el, step.target, undefined, again);
        if (!u.ok) return { missing: true, why: u.why, hit: { ...hit, covered: u.hit } };
        const before = await actions();
        await send(id, 'click', { x: u.el.x, y: u.el.y }, 60, { ...hit, landed: u.hit });
        await seen(before);
        await settle(id, 120);
        return { did: 'clicked', on: el.name, hit, wrote: !!w };
      }
      case 'type': {
        let field = null, o = null;
        if (step.target) { ({ el: field, o } = await locate(id, step.target, 'field')); if (!field) return { missing: true, why: `no "${step.target}" box on this screen` }; }
        else {
          o = await controls(id);
          field = focusedField(o) || composer(o.items) || searchBox(o.items);
          if (!field) return { missing: true, why: 'no box to type in on this screen' };
        }
        const hit = hitOf(field, step);
        if (!field.focused) {
          const u = await uncovered(id, field, step.target, 'field');
          if (!u.ok) return { missing: true, why: u.why, hit: { ...hit, covered: u.hit } };
          await send(id, 'click', { x: u.el.x, y: u.el.y }, 30, { ...hit, landed: u.hit }); await sleep(250);
        }
        await send(id, 'clear', {}, 30, { for: formatStep(step) }).catch(() => {});
        const before = await actions();
        await send(id, 'type', { text: step.value, delay: 18 }, 180, hit);
        await seen(before, 15);
        lastField = field; lastTyped[id] = step.value; typedIn[id] = field.name;
        await settle(id, 30);
        return { did: 'typed', in: field.name, on: field.name, hit };
      }
      case 'press': {
        const o = await controls(id);
        const field = focusedField(o) || (step.key === 'Enter' ? lastField : null);
        const w = writeOf(step, null, field, o.url);
        if (w && !write) refuse(step, w);
        const before = await actions();
        await send(id, 'press', { key: step.key }, 30, { for: formatStep(step), on: field ? field.name : null });
        if (/^(Enter|Escape)$/.test(step.key)) await seen(before);
        if (step.key === 'Enter') { lastField = null; delete typedIn[id]; }
        await settle(id, 120);
        return { did: 'pressed', key: step.key, wrote: !!w };
      }
      default: return { needsYou: true, why: `"${formatStep(step)}" isn't a step it knows` };
    }
  }

  // Where a step landed: still on the app's own hosts, no window or dialog the plan didn't ask for, not a sign-in,
  // and what the plan says it lands on is on the screen (given time: an answer streams in).
  let evSince = null;
  const events = async () => { try { const r = await cmd('capEvents', { since: evSince || 0 }, 30); const out = evSince === null ? [] : r.events; evSince = r.total; return out; } catch (e) { return []; } };
  async function check(id, step, { landsS = 20 } = {}) {
    const ev = (await events()).filter(e => e.kind === 'popup' || e.kind === 'dialog');
    if (ev.length) return { ok: false, kind: 'offplan', why: ev.map(e => e.kind === 'popup' ? `it opened a window on ${e.host}` : `a ${e.type} dialog came up (dismissed)`).join('; ') };
    let o;
    try { o = await controls(id); } catch (e) {
      // A tab that left for another site has lost its mark: the host still knows it.
      const u = await cmd('capUrl', { tab: tab(id) }, 30).catch(() => null);
      if (u && u.url && !onHosts(hostOf(u.url), id)) return { ok: false, kind: 'offplan', why: `it left ${id} for ${hostOf(u.url)}` };
      throw e;
    }
    const host = hostOf(o.url), text = landedOn(o.url, (o.text || '').slice(0, 4000), (apps.find(a => a.id === id) || {}).match);
    if (text.at === 'signin') {
      // The guard's doing, when it held the app's own requests: say so (only a real sign-in asks her to sign in again).
      const held = ((await cmd('capLog', {}, 30).catch(() => ({}))).held || []).filter(h => h.host && onHosts(h.host, id));
      if (held.length) return { ok: false, kind: 'guard', why: `the guard held ${id}'s sign-in: ${[...new Set(held.map(h => `${h.method} ${h.host}${h.path}`))].slice(0, 3).join(', ')}` };
      return { ok: false, kind: 'signin', why: `a sign-in page (${host}): Sign in again` };
    }
    if (text.at === 'blocked') return { ok: false, kind: 'signin', why: `a sign-in policy page (${host})` };
    if (!onHosts(host, id)) return { ok: false, kind: 'offplan', why: `it left ${id} for ${host}` };
    // Its proof, given time (an answer streams in): words, a control (in a state), a box's text, or words gone.
    const p = proofOf(step);
    let wd = null;
    if (p && step.kind !== 'wait') {
      for (const t0 = Date.now(); ;) {
        const r = await proofHolds(id, p, step);
        wd = r.words === undefined ? wd : r.words;
        if (r.ok) break;
        if (Date.now() - t0 > landsS * 1000) return { ok: false, kind: 'elsewhere', why: r.why, trouble: troubleIn(wd) };
        await sleep(1000);
      }
    }
    // An error the app shows ("could not be loaded"): a held request, or the service, and a replica must never show
    // one the real product doesn't. Noted for whoever reads the walk.
    return { ok: true, screen: screenOf(id, o), trouble: troubleIn(wd === null ? await words(id) : wd) };
  }
  const troubleIn = t => { const m = String(t || '').match(TROUBLE); return m ? [...new Set(m.map(x => x.toLowerCase()))] : undefined; };
  // One proof against the page now: { ok, why, words? }.
  // The page now as the reader reads a recorded screen (the recorder's serialization, every frame): a plan's proof
  // is checked on it with the reader's own rule (landing.mjs holds), so marks and invisible characters count alike.
  const readNow = async id => { const docs = await cmd('js', { tab: tab(id), code: READ_DOCS_SRC }, 90).catch(() => null); try { return Array.isArray(docs) ? readScreen(docs) : null; } catch (e) { return null; } };
  const hasWords = (sc, t) => !!pnorm(t) && pageWords(sc).includes(pnorm(t));
  async function proofHolds(id, p, step) {
    if (p.kind === 'words' || p.kind === 'control' || p.kind === 'box') {
      const sc = await readNow(id);
      if (!sc) return { ok: false, why: "it couldn't read the screen" };
      if (holds(sc, p)) return { ok: true };
      if (p.kind === 'words') return { ok: false, why: `"${p.text}" isn't on the screen` };
      const name = p.kind === 'box' ? p.box : p.control;
      const named = (sc.controls || []).filter(c => !c.shut && pnorm(c.name) === pnorm(name));
      if (!named.length) return { ok: false, why: `no ${p.kind === 'box' ? 'box' : 'control'} called "${name}" on the screen` };
      return { ok: false, why: p.kind === 'box' ? `"${name}" doesn't say "${p.says}"` : `"${name}" isn't ${p.state}` };
    }
    if (p.kind === 'gone') {
      const w = await words(id), sc = await readNow(id), b = goneBefore.get(step);
      if (!b || !b.there) return { ok: false, why: `"${p.gone}" wasn't on the screen before the step`, words: w };
      if (!sc || hasWords(sc, p.gone)) return { ok: false, why: sc ? `"${p.gone}" is still on the screen` : "it couldn't read the screen", words: w };
      // Words gone also pass on a blank page, an error or a wrong page: its still words (the page's own, there before
      // and after) have to be there, else (a plan without them) its recorded screen's heading; the same host, its
      // frames still there.
      const still = p.still || screenHeading(p.screen || (step.lands && step.lands.screen));
      if (!still) return { ok: false, why: `"${p.gone}" is gone, but the plan gives no words that stay (still "…") and the recording no heading for ${(step.lands && step.lands.screen) || 'its screen'}`, words: w };
      if (p.still && !b.still) return { ok: false, why: `"${p.still}" wasn't on the screen before the step, so it can't show it's the same page`, words: w };
      if (!hasWords(sc, still)) return { ok: false, why: `"${p.gone}" is gone, but so is "${still}"${p.still ? '' : ' (its screen\'s heading)'}`, words: w };
      const now = await where(id);
      if (now.host !== b.host) return { ok: false, why: `"${p.gone}" is gone, but the page is on ${now.host}, not ${b.host}`, words: w };
      const lost = b.frames.filter(f => !now.frames.includes(f));
      if (lost.length) return { ok: false, why: `"${p.gone}" is gone, and so is ${lost.join(', ')}`, words: w };
      return { ok: true, words: w };
    }
    return { ok: false, why: `a proof it doesn't know (${p.kind})` };
  }
  // The page's host and its frames' hosts.
  const where = id => cmd('js', { tab: tab(id), code: "const h = u => { try { return new URL(u).host; } catch (e) { return ''; } }; return { host: h(page.url()), frames: [...new Set(page.frames().filter(f => f !== page.mainFrame()).map(f => h(f.url())).filter(Boolean))] };" }, 30).catch(() => ({ host: '', frames: [] }));
  // A recorded screen's own first heading (the reader's), from its snapshot and its frames'.
  const headings = new Map();
  function screenHeading(screen) {
    if (!screen) return null;
    if (headings.has(screen)) return headings.get(screen);
    let h = null;
    try {
      const dir = join(demo.dir, 'data', 'snaps');
      const docs = readdirSync(dir).filter(f => f === `${screen}.html` || f.startsWith(`${screen}.f`) && f.endsWith('.html')).sort().map(f => ({ key: f === `${screen}.html` ? 'main' : f.slice(screen.length + 1, -5), html: readFileSync(join(dir, f), 'utf8') }));
      if (docs.length) h = (readScreen(docs).headings || [])[0] || null;
    } catch (e) {}
    headings.set(screen, h);
    return h;
  }
  const goneBefore = new WeakMap();
  // Back from an off-plan landing: Escape, then the page before.
  async function goBack(id) {
    await send(id, 'press', { key: 'Escape' }, 30, { for: 'back from an off-plan landing' }).catch(() => {});
    await sleep(500);
    const at = await cmd('capUrl', { tab: tab(id) }, 30).catch(() => null) || await controls(id).catch(() => null);
    if (at && at.url && !onHosts(hostOf(at.url), id)) await cmd('capBack', { tab: tab(id) }, 40).catch(() => {});
    await quiet(id, 500, 8000);
  }

  // A planned write, once the caller has checked it may (approved, its pack knows it): the control matched again on
  // the fresh screen (exactly one with its name: no near match for a write), the guard opened for this one step on
  // the app's own hosts, the step done, the guard closed. What it made (the page's address and title, ids in the
  // address) goes in its result, for the undo.
  async function write(id, step, { hosts = null } = {}) {
    let target = null;
    if (step.kind === 'click') {
      // Exactly one control by that name in the page and its frames (a write in IQ's Power BI frame too), the reader
      // agreeing about it in its own frame's markup.
      const { same, el } = await exactInView(id, step.target);
      if (same.length !== 1) return { missing: true, why: same.length ? `${same.length} controls called "${step.target}": a write needs exactly one` : `no "${step.target}" on this screen` };
      if (!el) return { missing: true, why: `"${step.target}" can't be brought into view` };
      target = el;
      const ra = await readerAgrees(id, step.target, target.role, target.fh || 'page');
      if (!ra.ok) return { missing: true, why: `${ra.why}: a write runs only where the reader and the page name its control alike` };
    }
    if (step.kind === 'press' && step.key === 'Enter') {
      const o = await controls(id);
      const field = focusedField(o) || lastField;
      if (!field) return { missing: true, why: 'no box with the focus for Enter to send' };
      const ra = await readerAgrees(id, field.name, field.role);
      if (!ra.ok) return { missing: true, why: `${ra.why}: a write runs only where the reader and the page name its control alike` };
    }
    const before = await controls(id).catch(() => ({}));
    let id1 = null;
    try { const o = await cmd('capOpen', { hosts: hosts || [...hostsOf(id)] }, 30); if (o.refused) return { missing: true, why: `the guard won't open: ${o.refused}` }; id1 = o.id; } catch (e) { return { missing: true, why: 'no guard to open (the capture browser runs writes)' }; }
    let r;
    try { r = await act(id, step, { write: true, el: target }); } finally { await cmd('capClose', { id: id1 }, 30).catch(() => {}); }
    if (r.missing || r.needsYou) return r;
    const after = await controls(id).catch(() => ({}));
    const ids = (() => { try { return new URL(after.url).pathname.split('/').filter(x => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(x) || /^\d{4,}$/.test(x) || /^[A-Za-z0-9_-]{20,}$/.test(x) && /\d/.test(x)); } catch (e) { return []; } })();
    return { ...r, wrote: true, result: { url: after.url || null, title: after.title || null, ids, from: before.url || null, typed: step.kind === 'press' && lastTyped[id] ? lastTyped[id] : null } };
  }
  // Until name-parity shows the reader and a live page name every control alike, a write runs only if the reader,
  // reading this screen's markup as it is now (each frame's), finds its control as the page does: one control by that
  // exact name, of the same role, in the same frame.
  async function readerAgrees(id, name, role, frame = 'page') {
    // The page as the reader reads a recorded screen: the recorder's serialization (open shadow roots, popover and
    // dialog state, form state), the one way a live page is read.
    const docs = await cmd('js', { tab: tab(id), code: READ_DOCS_SRC }, 90).catch(() => null);
    if (!Array.isArray(docs)) return { ok: false, why: "it couldn't read the screen's markup" };
    let rs; try { rs = readScreen(docs); } catch (e) { return { ok: false, why: `the reader couldn't read the screen (${e.message})` }; }
    const same = (rs.controls || []).filter(c => norm(c.name) === norm(name));
    if (same.length !== 1) return { ok: false, why: same.length ? `the reader finds ${same.length} controls called "${name}"` : `the reader finds no control called "${name}"` };
    const c = same[0], cf = c.frame || 'page';
    if (c.role !== role) return { ok: false, why: `the reader calls "${name}" a ${c.role}, the page a ${role}` };
    if (cf !== frame) return { ok: false, why: `the reader finds "${name}" in ${cf}, the page in ${frame}` };
    return { ok: true };
  }
  const lastTyped = {};
  // What it typed and hasn't sent, by app: a beat that stops before its Enter clears it, so no run leaves a draft.
  const typedIn = {};
  async function clearTyped(app) {
    const id = appOf(app) || app;
    const name = typedIn[id];
    if (!name) return null;
    const { el } = await locate(id, name, 'field');
    if (!el) return { cleared: false, why: `no "${name}" box to clear` };
    const hit = { for: `clear what it typed in "${name}"`, on: el.name, frame: el.fh || 'page', fit: fitOf(el.name, name) };
    if (!el.focused) {
      const u = await uncovered(id, el, name, 'field');
      if (!u.ok) return { cleared: false, in: name, why: u.why };
      await send(id, 'click', { x: u.el.x, y: u.el.y }, 30, { ...hit, landed: u.hit }); await sleep(250);
    }
    await send(id, 'clear', {}, 30, hit).catch(() => {});
    await quiet(id, 400, 4000);
    const left = await cmd('js', { tab: tab(id), code: "return await page.evaluate(() => { const e = document.activeElement; return e ? (e.value !== undefined ? e.value : e.innerText || '').trim() : ''; })" }, 30).catch(() => null);
    if (!left) delete typedIn[id];
    return { cleared: !left, in: name, ...(left ? { why: `"${String(left).slice(0, 40)}" is still there` } : {}) };
  }

  let current = null;
  async function start(app) {
    const id = appOf(app) || app;
    current = id;
    await cmd('front', { tab: tab(id) }, 30);
    await quiet(id, 600, 10000);
    await events();
    return screenOf(id, await controls(id));
  }
  async function step(at, s) {
    const id = s.kind === 'app' ? appOf(s.app) : (at && at.app) || current;
    if (!id) return { screen: at, landed: false, wrote: false, kind: 'missing', why: `no app called "${s.app}" in this demo` };
    const prev = current;
    current = id;
    const pre = await landsBefore(id, s, prev);
    const r = await act(id, s);
    if (r.missing || r.needsYou) return { screen: screenOf(id, await controls(id)), landed: false, wrote: false, kind: r.missing ? 'missing' : 'needs-you', why: r.why };
    const c = await check(id, s);
    if (!c.ok) {
      if (c.kind === 'offplan') await goBack(id);
      return { screen: screenOf(id, await controls(id)), landed: false, wrote: false, kind: c.kind, why: c.why, hit: r.hit, trouble: c.trouble };
    }
    const why = pre || (proofOf(s) ? null : NO_PROOF);
    if (why) return { screen: c.screen, landed: false, wrote: false, kind: 'unproven', why, hit: r.hit, trouble: c.trouble };
    return { screen: c.screen, landed: true, wrote: false, did: r.did, hit: r.hit, trouble: c.trouble };
  }
  // Words a step lands on that were on the screen before it prove nothing ("Foundry IQ" on IQ's page before its picker
  // opens): why, else null. The screen before is the one the plan was on: for "Go to X", the other app's (prev), never
  // X's own tab, which shows its words already; the first app has none before it.
  async function landsBefore(app, s, prev = null) {
    const p = proofOf(s);
    if (!p) return null;
    const id = appOf(app) || app;
    const on = s.kind === 'app' ? (prev && prev !== id ? prev : null) : id;
    if (!on) return null;
    const was = on !== id ? ` (${on})` : '';
    if (p.kind === 'gone') {
      const sc = await readNow(on);
      goneBefore.set(s, { there: !!sc && hasWords(sc, p.gone), still: !p.still || (!!sc && hasWords(sc, p.still)), ...(await where(on)) });
      return null;
    }
    const r = await proofHolds(on, p, s);
    if (!r.ok) return null;
    const what = p.kind === 'words' ? `"${p.text}"` : p.kind === 'box' ? `box "${p.box}" saying "${p.says}"` : `control "${p.control}"${p.state ? ` ${p.state}` : ''}`;
    return `${what} was on the screen before the step${was}, so landing there proves nothing`;
  }
  // After a step it couldn't prove, the next one goes on only if its control is the one: exactly one on the page or in
  // its frames with that exact name, of the step's kind (a box to type in, else something to click). A step with no
  // control of its own (a scroll, a wait, a key) can't show that.
  async function uniqueControl(app, s) {
    const id = appOf(app) || app;
    if (!['click', 'hover', 'type'].includes(s.kind) || !s.target) return { ok: false, why: `"${formatStep(s)}" has no control of its own to find` };
    const field = s.kind === 'type';
    const items = await pageControls(id, field ? 'field' : undefined).catch(() => null) || [];
    const at = new Set();
    const same = items.filter(it => !it.disabled && norm(it.name) === norm(s.target) && (!field || it.editable || /textbox|searchbox|combobox/.test(it.role))).filter(it => { const k = `${Math.round(it.x / 4)},${Math.round(it.y / 4)}`; return at.has(k) ? false : (at.add(k), true); });
    return same.length === 1 ? { ok: true } : { ok: false, why: same.length ? `${same.length} controls are called "${s.target}"` : `no control is called exactly "${s.target}"` };
  }
  // Each app's start screen as recorded: the words its first "Go to" in the plan lands on (the recording starts there).
  async function startCheck(app, plan) {
    const id = appOf(app) || app;
    const s = ((plan && plan.beats) || []).flatMap(b => b.steps).find(x => x.kind === 'app' && appOf(x.app) === id);
    if (!s) return { ok: true, skipped: 'the plan never goes to it' };
    const p = proofOf(s);
    if (!p) return { ok: false, why: `the plan gives ${id}'s start screen no proof` };
    if (p.kind !== 'words') return { ok: true, skipped: p.kind };
    for (const t0 = Date.now(); ;) {
      if (norm(await words(id)).includes(norm(p.text))) return { ok: true };
      if (Date.now() - t0 > 30000) return { ok: false, why: `${id} isn't on its recorded start screen: "${p.text}" isn't there` };
      await sleep(1500);
    }
  }
  // An app on its start screen: opened again at its address (a read), then its start steps in demo.json
  // (`apps[].start`: an address and/or plan steps; `startSteps`, the older name), for a start screen no address reaches
  // (Microsoft IQ's business plugin: a click on its sidebar item). Navigation only, under the guard: a click, a hover,
  // a scroll or a wait; anything else is refused, and so is a step that would write.
  const starts = startUrls(demo);
  async function home(app) {
    const id = appOf(app) || app;
    await cmd('goto', { tab: tab(id), url: starts[id] }, 90).catch(e => log(`${id}: couldn't open its start screen (${e.message})`));
    await quiet(id, 800, 20000);
    const did = [];
    for (const text of startSteps(apps.find(a => a.id === id))) {
      const s = parseStep(text);
      if (!NAVIGATION.has(s.kind)) { did.push({ step: text, why: 'start steps are navigation only (a click, a hover, a scroll or a wait)', refused: true }); log(`${id}: its start step "${text}" isn't navigation: not run`); break; }
      // Its control, given time to draw (IQ's Power BI takes a while): up to 30 s.
      if (s.target) for (let i = 0; i < 5 && !(await locate(id, s.target, s.kind === 'type' ? 'field' : undefined)).el; i++) await sleep(1500);
      const r = await act(id, s).catch(e => ({ missing: true, why: e.message }));
      did.push({ step: text, ...(r.missing || r.needsYou ? { why: r.why } : { did: r.did }) });
      if (r.missing || r.needsYou) { log(`${id}: its start step "${text}": ${r.why}`); break; }
    }
    // The pointer off what it clicked (its hover state isn't the start screen's).
    if (did.length) { const o = await controls(id).catch(() => ({})); await send(id, 'hover', { x: (o.vw || 1600) - 3, y: (o.vh || 900) - 3 }, 30, { for: 'the pointer off the start step' }).catch(() => {}); await quiet(id, 500, 5000); }
    return did;
  }
  // A screen as it is now, for re-grounding a plan on today's product: its words in every frame, and every control in
  // the page and its frames (name, role, frame, state, what a box holds).
  async function screenNow(app) {
    const id = appOf(app) || app;
    const o = await controls(id).catch(() => ({}));
    const items = await pageControls(id).catch(() => []) || [];
    return { app: id, url: o.url || null, title: o.title || null, words: String(await words(id)).split('\n').map(x => x.trim()).filter(Boolean),
      controls: items.map(it => ({ name: it.name, role: it.role, frame: it.fh || 'page', ...(it.selected != null ? { selected: it.selected === 'true' } : {}), ...(it.expanded != null ? { open: it.expanded === 'true' } : {}), ...(it.checked != null ? { on: it.checked === 'true' } : it.pressed != null ? { on: it.pressed === 'true' } : {}), ...(it.value != null ? { value: it.value } : {}), ...(it.disabled ? { disabled: true } : {}) })) };
  }
  // The screen in the reader's shape, twice about gapMs apart once it's quiet ([{ at, docs: [{ key, html }] }, …]):
  // for readScreen and the landing rules, as on a recorded screen; words that differ between the two come and go by
  // themselves (an answer still streaming, a toast, a clock).
  // The recorder's screen signature of an app's tab now (recorder.js recSig: each frame's __rkrec.sig()), null when
  // the recorder isn't in it.
  async function sigNow(app) {
    const id = appOf(app) || app;
    const v = await cmd('js', { tab: tab(id), code: SIG_SRC }, 30).catch(() => null);
    return typeof v === 'string' && v ? v : null;
  }
  async function reads(app, { n = 2, gapMs = 1000 } = {}) {
    const id = appOf(app) || app;
    await quiet(id, 800, 15000);
    const out = [];
    for (let i = 0; i < n; i++) {
      if (i) await sleep(gapMs);
      const docs = await cmd('js', { tab: tab(id), code: READ_DOCS_SRC }, 90).catch(() => null);
      out.push({ at: new Date().toISOString(), docs: Array.isArray(docs) ? docs : [] });
    }
    return out;
  }
  return { start, step, act, write, check, goBack, writeOf, controls, words, quiet, hostsOf, appOf, tab, screenOf, focusedField, locate, home, clearTyped, landsBefore, uniqueControl, startCheck, proofOf, screenNow, reads, sigNow, typed: () => ({ ...typedIn }), inputs: () => inputs.slice() };
}
