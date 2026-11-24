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
import { findItem, composer, searchBox } from './find.mjs';
import { risk, formatStep } from './plan.mjs';
import { appTab, settled, sleep } from './run.mjs';
import { landedOn } from '@stuntdouble/capture/browser.mjs';

const norm = s => String(s || '').toLowerCase().replace(/[“”"'’‘]/g, '').replace(/\s+/g, ' ').trim();
const hostOf = s => { try { return new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`).host; } catch (e) { return ''; } };

// The demo's packs as the walker uses them (@stuntdouble/apps): the one for a page's address, its writes and safe.
export async function walkerPacks() {
  try {
    const m = await import('@stuntdouble/apps/index.mjs');
    return { packFor: url => m.packFor(url), writeFor: m.writeFor, safeFor: m.safeFor, guardFor: m.guardFor, packsForDemo: m.packsForDemo };
  } catch (e) { return null; }
}

// Where each app starts in the demo: its start screen in the recording (flow.json's first beat), else its address.
// The capture browser opens an app at its address; a demo starts on a page of its own (a list, a workspace).
export function startUrls(demo) {
  const out = Object.fromEntries((demo.cfg.apps || []).map(a => [a.id, a.url]));
  let flow; try { flow = JSON.parse(readFileSync(join(demo.dir, 'flow.json'), 'utf8')); } catch (e) { return out; }
  const S = flow.states || {};
  for (const [app, sig] of Object.entries(((flow.beats || [])[0] || {}).states || {})) {
    if (out[app] === undefined) continue;
    const snap = (S[sig] || {}).snap || sig;
    for (const f of [demo.raw && join(demo.raw, 'snaps', snap + '.json'), join(demo.dir, 'data', 'snaps', snap + '.json')].filter(Boolean)) {
      try { const u = JSON.parse(readFileSync(f, 'utf8')).url; if (/^https?:/.test(u || '')) { out[app] = u; break; } } catch (e) {}
    }
  }
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
  // A control by name, given a few seconds to show up.
  const locate = async (id, name, kind) => {
    let o = null;
    for (let i = 0; i < 6; i++) {
      o = await controls(id);
      const el = kind === 'composer' ? composer(o.items) : findItem(o.items, name, kind);
      if (el) return { el, o };
      if (i < 5) await sleep(800);
    }
    return { el: null, o };
  };
  const focusedField = o => (o.items || []).find(it => it.focused && (it.editable || /textbox|searchbox|combobox/.test(it.role))) || null;

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
        await cmd('wheel', { tab: tab(id), x: Math.round(o.vw / 2), y: Math.round(o.vh / 2), dy: step.dir === 'up' ? -600 : 600 }, 30);
        await settle(id, 30);
        return { did: 'scrolled' };
      }
      case 'manual': return { needsYou: true, why: `"${formatStep(step)}" is the presenter's to do` };
      case 'free': return { needsYou: true, why: `"${step.text}" isn't a step it can do on its own` };
      case 'click': case 'hover': {
        const { el, o } = await locate(id, step.target);
        if (!el) return { missing: true, why: `no "${step.target}" on this screen` };
        if (step.kind === 'hover') { await cmd('hover', { tab: tab(id), x: el.x, y: el.y }, 30); await settle(id, 30); return { did: 'hovered', on: el.name }; }
        const w = writeOf(step, el, null, o.url);
        if (w && !write) refuse(step, w);
        const before = await actions();
        await cmd('click', { tab: tab(id), x: el.x, y: el.y }, 60);
        await seen(before);
        await settle(id, 120);
        return { did: 'clicked', on: el.name, wrote: !!w };
      }
      case 'type': {
        let field = null, o = null;
        if (step.target) { ({ el: field, o } = await locate(id, step.target, 'field')); if (!field) return { missing: true, why: `no "${step.target}" box on this screen` }; }
        else {
          o = await controls(id);
          field = focusedField(o) || composer(o.items) || searchBox(o.items);
          if (!field) return { missing: true, why: 'no box to type in on this screen' };
        }
        if (!field.focused) { await cmd('click', { tab: tab(id), x: field.x, y: field.y }, 30); await sleep(250); }
        await cmd('clear', { tab: tab(id) }, 30).catch(() => {});
        const before = await actions();
        await cmd('type', { tab: tab(id), text: step.value, delay: 18 }, 180);
        await seen(before, 15);
        lastField = field; lastTyped[id] = step.value; typedIn[id] = field.name;
        await settle(id, 30);
        return { did: 'typed', in: field.name };
      }
      case 'press': {
        const o = await controls(id);
        const field = focusedField(o) || (step.key === 'Enter' ? lastField : null);
        const w = writeOf(step, null, field, o.url);
        if (w && !write) refuse(step, w);
        const before = await actions();
        await cmd('press', { tab: tab(id), key: step.key }, 30);
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
    if (text.at === 'signin') return { ok: false, kind: 'signin', why: `a sign-in page (${host}): Sign in again` };
    if (text.at === 'blocked') return { ok: false, kind: 'signin', why: `a sign-in policy page (${host})` };
    if (!onHosts(host, id)) return { ok: false, kind: 'offplan', why: `it left ${id} for ${host}` };
    const want = step.lands && step.lands.text;
    if (want && step.kind !== 'wait') {
      for (const t0 = Date.now(); ;) {
        if (norm(await words(id)).includes(norm(want))) break;
        if (Date.now() - t0 > landsS * 1000) return { ok: false, kind: 'elsewhere', why: `"${want}" isn't on the screen` };
        await sleep(1000);
      }
    }
    return { ok: true, screen: screenOf(id, o) };
  }
  // Back from an off-plan landing: Escape, then the page before.
  async function goBack(id) {
    await cmd('press', { tab: tab(id), key: 'Escape' }, 30).catch(() => {});
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
    if (!el.focused) { await cmd('click', { tab: tab(id), x: el.x, y: el.y }, 30); await sleep(250); }
    await cmd('clear', { tab: tab(id) }, 30).catch(() => {});
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
    const r = await act(id, s);
    if (r.missing || r.needsYou) return { screen: screenOf(id, await controls(id)), landed: false, wrote: false, kind: r.missing ? 'missing' : 'needs-you', why: r.why };
    const c = await check(id, s);
    if (!c.ok) {
      if (c.kind === 'offplan') await goBack(id);
      return { screen: screenOf(id, await controls(id)), landed: false, wrote: false, kind: c.kind, why: c.why };
    }
    return { screen: c.screen, landed: true, wrote: false, did: r.did };
  }
  // An app on its start screen (a read: the page is opened again at its address).
  const starts = startUrls(demo);
  async function home(app) {
    const id = appOf(app) || app;
    await cmd('goto', { tab: tab(id), url: starts[id] }, 90).catch(e => log(`${id}: couldn't open its start screen (${e.message})`));
    await quiet(id, 800, 20000);
  }
  return { start, step, act, write, check, goBack, writeOf, controls, words, quiet, hostsOf, appOf, tab, screenOf, focusedField, locate, home, clearTyped, typed: () => ({ ...typedIn }) };
}
