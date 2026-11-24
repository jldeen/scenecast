// The capture host's own commands, added to the recorder's (OPS) in the capture browser only: what an unattended run
// needs and the extension can't give. Each takes the command's arguments, as the recorder's do.
//   capInfo()                       { capture: true, mode }
//   capGuard({ hosts, allow, mode }) the read-only guard on (browser.mjs guard): every request that isn't a read,
//                                    to a guarded host, held before it leaves; mode 'watch' only logs
//   capOpen({ hosts }) → { id }     a planned write's way through, for its one step, on those hosts (none: refused,
//                                    { id: null, refused }); capClose({ id })
//   capGuardOff()
//   capLog({ since })               what the guard held (method, host, path shape; never a body), from `since`, and every
//                                   non-read it let through (passed: method, host, path shape, by: allowed | a planned write)
//   capEvents({ since })            what happened that a plan can't: a page opening another window, a native dialog
//                                    (dismissed: a confirm is never accepted), a tab leaving for another host
//                                    (navigated), a tab's new document (loaded: a real load, not an in-page route)
//   capShot({ tab, file })          a picture of a tab, for a stop
//   capBack({ tab })                the tab's previous page (the walker's way back from an off-plan landing)
//   capUrl({ tab })                 where a tab is now (one that left the app has lost its mark)
//   capNet({ on: true, watch? } | { since })  requests that failed other than by the guard, answers ≥ 400 (tab,
//                                   frame), and every answer from a watched service ({ name, match }), tagged service
//   capAuthWatch({ host | hostPattern, from? } | { off: true })   arm (or disarm) catching the app's own session
//   capApi({ tab, open, host | hostPattern, from?, method, path, body, pick, armed? })
//                                   a pack's API check (GET, HEAD: the guard as it is; only pick's number and true/false
//                                   fields come back) or API undo in the app's own signed-in session (from: the
//                                   frame's host whose calls it takes the session from, and calls from): its page opened (a read), the
//                                   Authorization the page sends to that host caught (in memory, for the one call,
//                                   never written), then the call from the page or frame that made the app's own
//                                   call, the guard open for that call only (its method and exact address). path:
//                                   already filled and encoded; one that leaves the origin or that the address would
//                                   change (dot segments, a backslash) is refused
//                                   → { ok, status, method, host, path, from, picked? } | { ok: false, why }
//   capActive({ tab, origins })     a person at the app: idle detection allowed on its sites and the page told its
//                                    user is active and the screen unlocked (the capture browser has no person)
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { allowedBy } from './browser.mjs';

const originOf = u => { try { return new URL(u).origin; } catch (e) { return null; } };
const hostRe = c => c.hostPattern ? new RegExp(c.hostPattern) : new RegExp(`^${String(c.host || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
// An API undo's address: path on origin, only when it's a plain path there that a URL parser leaves as it is (no dot
// segments, backslash, second origin or fragment). Else null.
export function apiTarget(path, origin) {
  const s = String(path || '');
  if (!/^\//.test(s)) return null;
  let t; try { t = new URL(s, origin); } catch (e) { return null; }
  return t.origin === origin && t.pathname + t.search === s && !t.hash ? t : null;
}

export function hostOps(cb, { log = () => {}, base = null } = {}) {
  const events = [];
  const at = () => new Date().toISOString();
  const hostOf = u => { try { return new URL(u).host; } catch (e) { return ''; } };
  const watched = new WeakSet();
  const watch = p => {
    if (watched.has(p)) return;
    watched.add(p);
    p.on('popup', q => { events.push({ kind: 'popup', from: hostOf(p.url()), host: hostOf(q.url()), at: at() }); });
    p.on('dialog', d => { events.push({ kind: 'dialog', type: d.type(), host: hostOf(p.url()), at: at() }); d.dismiss().catch(() => {}); });
    p.on('framenavigated', f => { if (f === p.mainFrame()) events.push({ kind: 'navigated', host: hostOf(f.url()), path: (() => { try { return new URL(f.url()).pathname; } catch (e) { return ''; } })(), at: at() }); });
    // A new document in the tab (a real load or reload; an in-page route change is only navigated): where a delayed
    // effect of a held request ends.
    p.on('load', () => { let path = ''; try { path = new URL(p.url()).pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, '{id}'); } catch (e) {} events.push({ kind: 'loaded', host: hostOf(p.url()), path, at: at() }); });
  };
  for (const p of cb.ctx.pages()) watch(p);
  cb.ctx.on('page', watch);
  // A tab by part of its address (the demo's match), as the recorder finds one.
  // Each one found is remembered: a tab that left for another host (an off-plan landing) has neither the address nor
  // its mark (sessionStorage is per site), and the walker still needs its picture and its way back.
  const known = new Map();
  const tabOf = async spec => {
    const pages = cb.ctx.pages().filter(p => /^https?:/.test(p.url()));
    if (!spec) return pages[0];
    let hit = pages.find(p => p.url().includes(spec));
    for (const p of hit ? [] : pages) { const m = await p.evaluate(() => sessionStorage.getItem('d1tab')).catch(() => null); if (m === spec) { hit = p; break; } }
    if (hit) { known.set(spec, hit); return hit; }
    const k = known.get(spec);
    if (k && !k.isClosed()) return k;
    throw new Error(`no tab for ${spec}`);
  };
  let guard = null, opens = new Map(), n = 0;
  // Requests that failed other than by the guard, and answers of 400 or more, from every tab and frame (capNet): how
  // a service error shows up in a walk. Address shapes only (IDs out), never a body.
  let net = null, services = [];
  // A pack-named service ({ name, match }: match as a guard entry, over "METHOD host/path"): every answer, any status.
  const serviceOf = (method, url) => { const e = allowedBy({ method, url }, services.map(w => w.match)); return e ? services.find(w => w.match === e).name : null; };
  const shape = p => String(p || '').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, '{id}').replace(/\d{5,}/g, '{n}');
  const sentBy = r => { let tab = null, frame = null; try { const f = r.frame(); frame = hostOf(f.url()); tab = hostOf(f.page().url()); } catch (e) {} return { tab, frame }; };
  const netOn = () => {
    if (net) return;
    net = [];
    cb.ctx.on('requestfailed', r => {
      const why = (r.failure() || {}).errorText || 'failed';
      if (/BLOCKED_BY_CLIENT/.test(why)) return;
      try { const u = new URL(r.url()), service = services.length ? serviceOf(r.method(), r.url()) : null; if (/^https?:$/.test(u.protocol)) net.push({ at: at(), method: r.method(), host: u.host, path: shape(u.pathname), failed: why, ...sentBy(r), ...(service ? { service } : {}) }); } catch (e) {}
    });
    cb.ctx.on('response', r => {
      const q = r.request(), service = services.length ? serviceOf(q.method(), r.url()) : null;
      if (r.status() < 400 && !service) return;
      try { const u = new URL(r.url()); net.push({ at: at(), method: q.method(), host: u.host, path: shape(u.pathname), status: r.status(), ...sentBy(q), ...(service ? { service } : {}) }); } catch (e) {}
    });
  };
  const active = new Map();
  return {
    // { on: true } starts recording; { since } reads what came since.
    // { on: true, watch?: [{ name, match }] } starts recording (watch: services whose every answer is kept, tagged
    // service); { since } reads what came since.
    async capNet(c) { if (c.on) { netOn(); if (Array.isArray(c.watch)) services = c.watch.filter(w => w && w.name && w.match); return { on: true, total: net.length }; } return { net: (net || []).slice(c.since || 0), total: (net || []).length }; },
    async capInfo() { return { capture: true, mode: cb.mode, guarded: !!base }; },
    async capGuard(c) {
      // It replaces the guard that's on (the start's, or a run's) with no gap between them.
      guard = await cb.guard({ hosts: c.hosts || null, allow: c.allow || [], stayHeld: c.stayHeld || [], keepBodies: c.keepBodies || [], mode: c.mode || 'hold', local: !!c.local });
      log(`guard on (${c.mode || 'hold'}): ${(c.hosts || ['every web host']).join(', ')}; ${(c.allow || []).length} allowed, ${(c.stayHeld || []).length} held even for a write`);
      return { on: true };
    },
    async capOpen(c) {
      if (!guard) return { id: null };
      if (!Array.isArray(c.hosts) || !c.hosts.length) return { id: null, refused: 'a write opens the guard only on named hosts' };
      const id = `w${++n}`;
      let close;
      const opened = new Promise(r => { close = r; });
      opens.set(id, close);
      guard.pass(() => opened, { hosts: c.hosts });
      log(`guard open for one write (${id}): ${c.hosts.join(', ')}`);
      return { id };
    },
    async capClose(c) { const close = opens.get(c.id); if (close) { close(); opens.delete(c.id); } return { closed: !!close }; },
    // Back to the start's guard (in before the run's comes out), or none.
    async capGuardOff() { for (const close of opens.values()) close(); opens.clear(); if (base) await base(); else if (guard) await guard.stop(); guard = null; return { on: !!base }; },
    // A run's guard, else the one on from the start.
    async capLog(c) { const g = guard || (base && base.guard); const held = g ? g.held() : []; return { held: held.slice(c.since || 0), total: held.length, counts: g ? g.counts() : {}, passed: g && g.passed ? g.passed() : [], bodies: g && g.bodies ? g.bodies() : [] }; },
    async capEvents(c) { return { events: events.slice(c.since || 0), total: events.length }; },
    // Arm catching the app's own session for a pack check after a write (the write's own calls carry it): capApi
    // with armed then uses it without opening the page again. { off: true } disarms.
    async capAuthWatch(c) {
      const g = guard || (base && base.guard);
      if (!g || !g.watchAuth) return { on: false };
      if (c.off) { g.watchAuth(null); return { on: false }; }
      g.watchAuth(hostRe(c), c.from || null);
      return { on: true };
    },
    async capApi(c) {
      const g = guard || (base && base.guard);
      if (!g || !g.watchAuth) return { ok: false, why: "no guard to see the app's own calls (API undos run in the capture browser)" };
      const p = await tabOf(c.tab);
      // armed (capAuthWatch before a write): the session its calls carried, the page left where it is. Else the page
      // opened (open) and its first signed-in call caught.
      if (!c.armed) g.watchAuth(hostRe(c), c.from || null);
      try {
        if (!c.armed) await p.goto(c.open, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
        for (const t0 = Date.now(); !g.peekAuth() && Date.now() - t0 < (c.waitS || 20) * 1000;) await new Promise(r => setTimeout(r, 250));
        const auth = g.takeAuth();
        if (!auth) return { ok: false, why: `the page made no signed-in call to ${c.hostPattern || c.host}${c.from ? ` from ${c.from}` : ''}` };
        // The address: the path on the origin the session came from, exactly as given (nothing a URL parser would
        // change, nowhere else).
        const target = apiTarget(c.path, auth.origin);
        if (!target) return { ok: false, why: `"${c.path}" isn't a plain path on ${auth.host}` };
        const method = String(c.method || '').toUpperCase();
        const read = /^(GET|HEAD)$/.test(method);
        if (!read && !/^(DELETE|PATCH|POST|PUT)$/.test(method)) return { ok: false, why: `an API call here is a pack's check (GET, HEAD) or undo (DELETE, PATCH, POST, PUT), not "${c.method}"` };
        // From the page or frame that made the app's own call, as the app does (the API's CORS rules allow that one;
        // IQ's API answers its Power BI frame, not the portal around it), with the browser's own credentials mode.
        // With from (the pack names the frame), only that frame: never the page around it instead.
        const frame = (auth.from && p.frames().find(f => originOf(f.url()) === auth.from)) || (c.from ? null : p.mainFrame());
        if (!frame) return { ok: false, why: `no frame from ${c.from} to call from` };
        // A check's answer: its status, and only the number and true/false fields it names (pick), never text.
        const call = () => frame.evaluate(async ({ url, method, auth, body, pick }) => {
          try {
            const res = await fetch(url, { method, headers: { authorization: auth, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
            let picked;
            if (pick && pick.length) { const j = await res.json().catch(() => null); picked = {}; for (const k of pick) if (j && (typeof j[k] === 'number' || typeof j[k] === 'boolean')) picked[k] = j[k]; }
            return { status: res.status, picked };
          } catch (e) { return { error: String((e && e.message) || e) }; }
        }, { url: target.href, method, auth: auth.value, body: read ? null : (c.body || null), pick: Array.isArray(c.pick) ? c.pick.map(String) : null });
        const from = hostOf(frame.url());
        const done = r => {
          log(`API ${read ? 'check' : 'undo'}: ${method} ${auth.host}${String(c.path).replace(/[0-9a-f-]{16,}|\d{4,}/gi, '{id}')} from ${from}: ${r.status || r.error}`);
          return r.status ? { ok: r.status >= 200 && r.status < 300, status: r.status, method, host: auth.host, path: c.path, from, ...(r.picked ? { picked: r.picked } : {}) } : { ok: false, why: r.error, from };
        };
        // A read passes the guard as it is; an undo opens its one call only.
        if (read) return done(await call());
        let close; const opened = new Promise(r => { close = r; });
        g.pass(() => opened, { hosts: [auth.host], method, url: target.href });
        try { return done(await call()); } finally { close(); }
      } finally { g.watchAuth(null); }
    },
    async capActive(c) {
      const p = await tabOf(c.tab);
      const perms = [];
      for (const origin of c.origins || []) perms.push(await cb.top.send('Browser.setPermission', { permission: { name: 'idle-detection' }, setting: 'granted', origin }).then(() => 'granted', e => e.message));
      // Its own session, kept: an override lasts as long as the session that set it, reloads included.
      if (!active.has(p)) active.set(p, await cb.ctx.newCDPSession(p));
      await active.get(p).send('Emulation.setIdleOverride', { isUserActive: true, isScreenUnlocked: true });
      return { perms, active: true };
    },
    async capUrl(c) { const p = await tabOf(c.tab); return { url: p.url(), title: await p.title().catch(() => '') }; },
    async capShot(c) { const p = await tabOf(c.tab); mkdirSync(dirname(c.file), { recursive: true }); writeFileSync(c.file, await p.screenshot()); return { file: c.file }; },
    async capBack(c) { const p = await tabOf(c.tab); await p.goBack({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null); return { url: p.url() }; },
  };
}
