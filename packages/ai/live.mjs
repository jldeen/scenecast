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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findItem, nameFits, composer, searchBox } from './find.mjs';
import { risk, formatStep, parseStep } from './plan.mjs';
import { appTab, settled, sleep } from './run.mjs';
import { landedOn } from '@stuntdouble/capture/browser.mjs';

const norm = s => String(s || '').toLowerCase().replace(/[“”"'’‘]/g, '').replace(/\s+/g, ' ').trim();
// The words of an app showing an error instead of what it should.
const TROUBLE = /could not be loaded|couldn['’]t (?:be )?load(?:ed)?|can['’]t load|something went wrong|failed to load|unable to (?:load|sign|connect)|having trouble connecting|trouble connecting/gi;
const hostOf = s => { try { return new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`).host; } catch (e) { return ''; } };

// The demo's packs as the walker uses them (@stuntdouble/apps): the one for a page's address, its writes and safe.
export async function walkerPacks() {
  try {
    const m = await import('@stuntdouble/apps/index.mjs');
    return { packFor: url => m.packFor(url), writeFor: m.writeFor, safeFor: m.safeFor, guardFor: m.guardFor, packsForDemo: m.packsForDemo };
  } catch (e) { return null; }
}

// Where each app starts in the demo: its own `start` in demo.json (an address that opens on the demo's first screen,
// for an app that opens where it was last, as Teams does), else its start screen in the recording (flow.json's first
// beat), else its address. The capture browser opens an app at its address; a demo starts on a page of its own.
export function startUrls(demo) {
  const out = Object.fromEntries((demo.cfg.apps || []).map(a => [a.id, a.url]));
  const own = new Set((demo.cfg.apps || []).filter(a => a.start).map(a => a.id));
  let flow; try { flow = JSON.parse(readFileSync(join(demo.dir, 'flow.json'), 'utf8')); } catch (e) { return out; }
  const S = flow.states || {};
  for (const [app, sig] of Object.entries(((flow.beats || [])[0] || {}).states || {})) {
    if (out[app] === undefined || own.has(app)) continue;
    const snap = (S[sig] || {}).snap || sig;
    for (const f of [demo.raw && join(demo.raw, 'snaps', snap + '.json'), join(demo.dir, 'data', 'snaps', snap + '.json')].filter(Boolean)) {
      try { const u = JSON.parse(readFileSync(f, 'utf8')).url; if (/^https?:/.test(u || '')) { out[app] = u; break; } } catch (e) {}
    }
  }
  for (const a of demo.cfg.apps || []) if (a.start) out[a.id] = a.start;
  return out;
}

export function liveWalker({ demo, cmd, packs = null, recording = false, log = () => {} }) {
  const apps = demo.cfg.apps || [];
  const appOf = name => { const ids = apps.map(a => a.id); return ids.find(a => a === name) || ids.find(a => a.startsWith(name) || name.startsWith(a)) || null; };
  const tab = id => appTab(demo, id);
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
  const inPage = async (id, name, kind) => {
    const sel = kind === 'field' ? 'input,textarea,[contenteditable=true],[role=textbox],[role=searchbox],[role=combobox]'
      : 'button,a[href],input,textarea,[contenteditable=true],[role=button],[role=link],[role=treeitem],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=switch],[role=radio],[role=textbox],[role=searchbox],[role=combobox]';
    // Each frame's controls (the page's own too), at their place on the page: the frame's box plus the control's place
    // in it.
    const items = await cmd('js', { tab: tab(id), code: `
      const out = [], frames = page.frames();
      for (const [fi, f] of frames.entries()) {
        const main = f === page.mainFrame();
        const fe = main ? null : await f.frameElement().catch(() => null), fb = main ? { x: 0, y: 0 } : fe ? await fe.boundingBox().catch(() => null) : null;
        if (!fb) continue;
        const list = await f.evaluate(sel => [...document.querySelectorAll(sel)].slice(0, 2000).map((e, ei) => {
          const r = e.getBoundingClientRect();
          if (!r.width || !r.height) return null;
          return { ei, name: (e.getAttribute('aria-label') || e.innerText || e.value || e.getAttribute('title') || '').replace(/\\s+/g, ' ').trim().slice(0, 200), role: e.getAttribute('role') || e.tagName.toLowerCase(), editable: e.isContentEditable || /^(INPUT|TEXTAREA)$/.test(e.tagName), disabled: !!e.disabled || e.getAttribute('aria-disabled') === 'true', x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }).filter(Boolean), ${JSON.stringify(sel)}).catch(() => []);
        const fh = main ? 'page' : (() => { try { return new URL(f.url()).host; } catch (e) { return 'a frame'; } })();
        for (const it of list) if (it.name) out.push({ ...it, x: Math.round(fb.x + it.x), y: Math.round(fb.y + it.y), frame: !main, fi, fh });
      }
      return out;` }, 60).catch(() => null);
    // By its name only (nameFits): a name that only contains it, a small part of it or a few shared words found the
    // wrong control in a frame.
    const el = Array.isArray(items) ? findItem(items, name, kind) : null;
    if (!el || !nameFits(el.name, name)) return null;
    // Where a person would click it: brought into view first (IQ scrolls inside its frame, so a wheel on the page
    // doesn't), then measured again.
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
  };
  const focusedField = o => (o.items || []).find(it => it.focused && (it.editable || /textbox|searchbox|combobox/.test(it.role))) || null;

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
  async function act(id, step, { write = false } = {}) {
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
        const { el, o } = await locate(id, step.target);
        if (!el) return { missing: true, why: `no "${step.target}" on this screen` };
        const hit = hitOf(el, step);
        if (step.kind === 'hover') { await send(id, 'hover', { x: el.x, y: el.y }, 30, hit); await settle(id, 30); return { did: 'hovered', on: el.name, hit }; }
        const w = writeOf(step, el, null, o.url);
        if (w && !write) refuse(step, w);
        const before = await actions();
        await send(id, 'click', { x: el.x, y: el.y }, 60, hit);
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
        if (!field.focused) { await send(id, 'click', { x: field.x, y: field.y }, 30, hit); await sleep(250); }
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
    const want = step.lands && step.lands.text;
    let wd = null;
    if (want && step.kind !== 'wait') {
      for (const t0 = Date.now(); ;) {
        wd = await words(id);
        if (norm(wd).includes(norm(want))) break;
        if (Date.now() - t0 > landsS * 1000) return { ok: false, kind: 'elsewhere', why: `"${want}" isn't on the screen`, trouble: troubleIn(wd) };
        await sleep(1000);
      }
    }
    // An error the app shows ("could not be loaded"): a held request, or the service, and a replica must never show
    // one the real product doesn't. Noted for whoever reads the walk.
    return { ok: true, screen: screenOf(id, o), trouble: troubleIn(wd === null ? await words(id) : wd) };
  }
  const troubleIn = t => { const m = String(t || '').match(TROUBLE); return m ? [...new Set(m.map(x => x.toLowerCase()))] : undefined; };
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
    if (step.kind === 'click') {
      const o = await controls(id);
      const same = (o.items || []).filter(it => !it.disabled && norm(it.name) === norm(step.target));
      if (same.length !== 1) return { missing: true, why: same.length ? `${same.length} controls called "${step.target}": a write needs exactly one` : `no "${step.target}" on this screen` };
    }
    if (step.kind === 'press' && step.key === 'Enter') {
      const o = await controls(id);
      if (!focusedField(o) && !lastField) return { missing: true, why: 'no box with the focus for Enter to send' };
    }
    const before = await controls(id).catch(() => ({}));
    let id1 = null;
    try { id1 = (await cmd('capOpen', { hosts: hosts || [...hostsOf(id)] }, 30)).id; } catch (e) { return { missing: true, why: 'no guard to open (the capture browser runs writes)' }; }
    let r;
    try { r = await act(id, step, { write: true }); } finally { await cmd('capClose', { id: id1 }, 30).catch(() => {}); }
    if (r.missing || r.needsYou) return r;
    const after = await controls(id).catch(() => ({}));
    const ids = (() => { try { return new URL(after.url).pathname.split('/').filter(x => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(x) || /^\d{4,}$/.test(x) || /^[A-Za-z0-9_-]{20,}$/.test(x) && /\d/.test(x)); } catch (e) { return []; } })();
    return { ...r, wrote: true, result: { url: after.url || null, title: after.title || null, ids, from: before.url || null, typed: step.kind === 'press' && lastTyped[id] ? lastTyped[id] : null } };
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
    if (!el.focused) { await send(id, 'click', { x: el.x, y: el.y }, 30, hit); await sleep(250); }
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
    current = id;
    const pre = await landsBefore(id, s);
    const r = await act(id, s);
    if (r.missing || r.needsYou) return { screen: screenOf(id, await controls(id)), landed: false, wrote: false, kind: r.missing ? 'missing' : 'needs-you', why: r.why };
    const c = await check(id, s);
    if (!c.ok) {
      if (c.kind === 'offplan') await goBack(id);
      return { screen: screenOf(id, await controls(id)), landed: false, wrote: false, kind: c.kind, why: c.why, hit: r.hit, trouble: c.trouble };
    }
    if (pre) return { screen: c.screen, landed: false, wrote: false, kind: 'unproven', why: pre, hit: r.hit, trouble: c.trouble };
    return { screen: c.screen, landed: true, wrote: false, did: r.did, hit: r.hit, trouble: c.trouble };
  }
  // Words a step lands on that were on the screen before it prove nothing ("Foundry IQ" on IQ's page before its picker
  // opens): why, for a step that moves between screens (click, hover, press), else null. Typing and scrolling stay on
  // the screen they started on.
  async function landsBefore(app, s) {
    const want = s.lands && s.lands.text;
    if (!want || !['click', 'hover', 'press'].includes(s.kind)) return null;
    const id = appOf(app) || app;
    return norm(await words(id)).includes(norm(want)) ? `"${want}" was on the screen before the step, so landing there proves nothing` : null;
  }
  // An app on its start screen: opened again at its address (a read), then its own startSteps in demo.json, for a
  // start screen no address reaches (Microsoft IQ's business plugin: a click on its sidebar item). They're read-only
  // steps: one that would write is refused.
  const starts = startUrls(demo);
  async function home(app) {
    const id = appOf(app) || app;
    await cmd('goto', { tab: tab(id), url: starts[id] }, 90).catch(e => log(`${id}: couldn't open its start screen (${e.message})`));
    await quiet(id, 800, 20000);
    const did = [];
    for (const text of (apps.find(a => a.id === id) || {}).startSteps || []) {
      const s = parseStep(text);
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
  return { start, step, act, write, check, goBack, writeOf, controls, words, quiet, hostsOf, appOf, tab, screenOf, focusedField, locate, home, clearTyped, landsBefore, typed: () => ({ ...typedIn }), inputs: () => inputs.slice() };
}
