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
//                                   frame), and every answer from a watched service ({ name, match }), tagged service.
//                                   A watched service's cards ({ texts, suffix }): each 2xx answer read for them
//                                   (cards.mjs): cards: { <text>: the row's name | null }, shown: what its list holds.
//                                   keep: a local folder its answers' bodies are written to (a person's check only)
//   capAuthWatch({ host | hostPattern, from? } | { off: true })   arm (or disarm) catching the app's own session
//   capApi({ tab, open, host | hostPattern, from?, method, path, body, pick, find?, armed? })
//                                   find ({ list, name, id, names, where? }, a GET's only): the ids of the answer's list
//                                   items whose name is exactly one of names (and whose where fields match), never
//                                   their text: a reset's undo of the script's own leftovers by name
//                                   a pack's API check (GET, HEAD: the guard as it is; only pick's number and true/false
//                                   fields come back) or API undo in the app's own signed-in session (from: the
//                                   frame's host whose calls it takes the session from, and calls from): its page opened (a read), the
//                                   Authorization the page sends to that host caught (in memory, for the one call,
//                                   never written), then the call from the page or frame that made the app's own
//                                   call, the guard open for that call only (its method and exact address). path:
//                                   already filled and encoded; one that leaves the origin or that the address would
//                                   change (dot segments, a backslash) is refused
//                                   → { ok, status, method, host, path, from, picked? } | { ok: false, why }
//   capTab({ open, mark } | { close: mark })   a tab of its own for a moment, in the same signed-in browser under the
//                                    same guard (Set before: a state set off camera), marked so a lookup by an app's
//                                    address never takes it for the app's own tab; its events say side: mark
//   capActive({ tab, origins })     a person at the app: idle detection allowed on its sites and the page told its
//                                    user is active and the screen unlocked (the capture browser has no person)
//   capLeaveOut({ rules, words, check, shots })   reset.md's Leave out, from here on, in every tab, frame and worker:
//                                    response rules (leave-out.mjs) filter what the page is given; DOM rules
//                                    (leave-out-page.js) mark and hide a list's items the app draws from its own store,
//                                    in each document from its start and now in what's open. And before the recorder
//                                    saves anything (a screen, a hover's parts, a stream's frame), the negative check:
//                                    words ({ app: [...] }: her lines' words) and the items the filters took out, by
//                                    their own text, nowhere on it (check: the module that reads a screen for it, by
//                                    package name, its leaveHits). One that shows them stops the take there: nothing
//                                    more is saved, and its picture goes in shots. A filter whose response can't be read
//                                    or has lost its list stops it too, before that app's next save. { rules: [] }: off
//                                    → { on, rules, dom } | { on: false, refused }
//   capLeaveLog()                   per rule: the requests it filtered (method, host, path shape, how many it took out),
//                                    what it took out (field, value, shows), failures; the checks run; the leak, if any
//   capOwnStatus({ apps, shots, everyMs } | { read } | { since })   her own status (Teams' avatar: Available, Away), by
//                                    each app's pack (ownStatus): apps { <app>: { name (a /pattern/ over the control's
//                                    name, by the reader's rule; its group the status), role, expect, waitS, label } }.
//                                    From here on, before the recorder saves a screen of one of them (before Leave
//                                    out's check), its status is read; one not in expect is read again every everyMs
//                                    for up to waitS, and then the take stops there: that screen isn't saved, nor
//                                    anything after it, and its picture goes in shots. A screen without the control
//                                    saves as it is. { apps: {} }: off → { on, apps }
//                                    { read: { tab, name, role } }: the status on that tab now → { found, status? }
//                                    { since }: what it read before each save, the one it's waiting on, the stop
//   capHoverFloor({ apps, shots } | {})   the demo's recorded hovers as a floor: apps { <app>: [{ id, anchor, scope,
//                                    rect, card }] } (each as its build keeps it, card: its words). From here on the
//                                    recorder's hovers sweep finds their controls (by place, else by words), never skips
//                                    them for their kind, tries each twice (the second time for 2.5 s) until one shows its
//                                    card, and says how it went; one whose card was captured anywhere in its app isn't
//                                    looked for again; a picture of the screen when a control showed nothing goes in shots.
//                                    { apps: {} }: off → { on, apps }. {}: → { on, log: [{ app, state, page, floor, found,
//                                    tries, cards }] }, one per sweep
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { allowedBy } from './browser.mjs';
import { READ_DOCS_SRC } from './page-read.mjs';
import { CONTROL_NAME_SRC } from './page-naming.mjs';
import { cardIn, shownIn } from './cards.mjs';
import { cardMatch } from './hover-card.mjs';

const LEAVE_PAGE = readFileSync(new URL('./leave-out-page.js', import.meta.url), 'utf8').replace(/^\/\/.*\n/gm, '');
const AsyncFn = Object.getPrototypeOf(async () => {}).constructor;
const readDocs = new AsyncFn('page', READ_DOCS_SRC);
// The negative check's first pass, in each frame: is any of the words (letters and digits only, lower case) in its
// text or a name-like attribute, outside what's marked left out? Looser than the reader, so it never misses what the
// reader would find; only a hit is read as the reader reads it (leaveHits).
const loose = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const LEAVE_SCAN = words => {
  const lo = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const parts = [];
  const walk = root => {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, { acceptNode: n => n.nodeType === 1 && (n.hasAttribute('data-d1-leaveout') || /^(SCRIPT|NOSCRIPT|TEMPLATE|STYLE)$/.test(n.tagName)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (n.nodeType === 3) { parts.push(n.nodeValue); continue; }
      for (const a of ['aria-label', 'aria-description', 'title', 'alt', 'placeholder', 'value']) { const v = n.getAttribute(a); if (v) parts.push(v); }
      if (typeof n.value === 'string' && n.value) parts.push(n.value);
      const sr = n.shadowRoot || (window.__scShadow && window.__scShadow.get && window.__scShadow.get(n));
      if (sr) walk(sr);
    }
  };
  if (document.documentElement) walk(document.documentElement);
  const hay = lo(parts.join(' '));
  return words.some(w => w && hay.includes(w));
};
const unEntity = h => String(h || '').replace(/<[^>]*>/g, ' ').replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d)).replace(/&#x([0-9a-f]+);/gi, (m, x) => String.fromCodePoint(parseInt(x, 16))).replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (m, k) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" })[k]);
// Her own status in a page (capOwnStatus): the first control of that role whose name (the reader's rule) the pattern
// matches, its group the status; the element kept for the next read. Only the status leaves the page, never the name.
export function ownStatusConfig(a) {
  const m = /^\/(.+)\/([a-z]*)$/.exec(String((a && a.name) || ''));
  if (!m) return null;
  return { re: m[1], flags: m[2].replace(/g/g, ''), role: a.role || null, expect: [].concat(a.expect || []).map(String), waitS: a.waitS === undefined ? 90 : +a.waitS, label: a.label || 'The app' };
}
const OWN_READ = a => `(() => {
${CONTROL_NAME_SRC}
const a = ${JSON.stringify({ re: a.re, flags: a.flags, role: a.role })}, rx = new RegExp(a.re, a.flags);
const hit = el => { try { const c = domControl(el); if (!c.control || (a.role && c.role !== a.role)) return null; const m = rx.exec(c.name); return m ? String(m[1] === undefined ? m[0] : m[1]).trim() : null; } catch (e) { return null; } };
let el = window.__sdOwnStatusEl, s = el && el.isConnected ? hit(el) : null;
if (s === null) { el = null; for (const e of document.querySelectorAll('*')) { s = hit(e); if (s !== null) { el = e; break; } } window.__sdOwnStatusEl = el; }
return s === null ? { found: false } : { found: true, status: s };
})()`;

// A notice an app shows for a while (capNotices; a pack's notices): in a page's own text, or a saved part's.
export const noticeIn = (text, words) => { const n = x => String(x || '').replace(/\s+/g, ' ').trim().toLowerCase(); return !!n(words) && n(text).includes(n(words)); };
// Its own close button: the smallest element whose text has the notice's words, then up to four parents for a
// visible button whose name (aria-label, title, else its text) the pattern matches. → { x, y } or null.
const NOTICE_CLOSE = `([words, re, flags]) => {
  const n = x => String(x || '').replace(/\\s+/g, ' ').trim().toLowerCase(), w = n(words), rx = new RegExp(re, flags);
  let box = null;
  for (const e of document.body ? document.body.querySelectorAll('*') : []) { const t = n(e.innerText); if (t.includes(w) && (!box || t.length < n(box.innerText).length)) box = e; }
  const shown = e => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2 && getComputedStyle(e).visibility !== 'hidden'; };
  for (let a = box, i = 0; a && i < 5; a = a.parentElement, i++) {
    for (const b of a.querySelectorAll('button,[role=button]')) {
      const name = b.getAttribute('aria-label') || b.getAttribute('title') || n(b.innerText);
      if (shown(b) && rx.test(name)) { const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; }
    }
  }
  return null;
}`;
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

// A tab by its mark first (the host marks each app's tab with its match), else by part of its address, never one marked
// as something else: a second tab of the app at the same address (Set before's) doesn't stand in for the app's own,
// whatever order the browser lists them in. pages: [{ url }], marks: each page's mark (null: none). → index or -1
export function pickTab(pages, spec, marks) {
  const own = marks.findIndex(m => m === spec);
  if (own >= 0) return own;
  return pages.findIndex((p, i) => String(p.url || '').includes(spec) && !marks[i]);
}

export function hostOps(cb, { log = () => {}, base = null } = {}) {
  const events = [];
  const at = () => new Date().toISOString();
  const hostOf = u => { try { return new URL(u).host; } catch (e) { return ''; } };
  const watched = new WeakSet(), sides = new Map(), sideOf = new WeakMap();
  // A side tab's events (capTab) say so: they're not the app's own tab.
  const push = (p, e) => events.push(sideOf.has(p) ? { ...e, side: sideOf.get(p) } : e);
  const watch = p => {
    if (watched.has(p)) return;
    watched.add(p);
    p.on('popup', q => { push(p, { kind: 'popup', from: hostOf(p.url()), host: hostOf(q.url()), at: at() }); });
    p.on('dialog', d => { push(p, { kind: 'dialog', type: d.type(), host: hostOf(p.url()), at: at() }); d.dismiss().catch(() => {}); });
    p.on('framenavigated', f => { if (f === p.mainFrame()) push(p, { kind: 'navigated', host: hostOf(f.url()), path: (() => { try { return new URL(f.url()).pathname; } catch (e) { return ''; } })(), at: at() }); });
    // A new document in the tab (a real load or reload; an in-page route change is only navigated): where a delayed
    // effect of a held request ends.
    p.on('load', () => { let path = ''; try { path = new URL(p.url()).pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, '{id}'); } catch (e) {} push(p, { kind: 'loaded', host: hostOf(p.url()), path, at: at() }); });
  };
  for (const p of cb.ctx.pages()) watch(p);
  cb.ctx.on('page', watch);
  // A tab by part of its address (the demo's match), as the recorder finds one.
  // Each one found is remembered: a tab that left for another host (an off-plan landing) has neither the address nor
  // its mark (sessionStorage is per site), and the walker still needs its picture and its way back.
  const known = new Map();
  const markOf = p => Promise.race([p.evaluate(() => sessionStorage.getItem('d1tab')), new Promise(r => setTimeout(() => r(null), 3000))]).then(m => typeof m === 'string' && m ? m : null, () => null);
  const tabOf = async spec => {
    const pages = cb.ctx.pages().filter(p => /^https?:/.test(p.url()));
    if (!spec) return pages[0];
    const marks = await Promise.all(pages.map(markOf));
    const i = pickTab(pages.map(p => ({ url: p.url() })), spec, marks), hit = i >= 0 ? pages[i] : null;
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
    let kept = 0;
    cb.ctx.on('response', async r => {
      const q = r.request(), service = services.length ? serviceOf(q.method(), r.url()) : null;
      if (r.status() < 400 && !service) return;
      let e;
      try { const u = new URL(r.url()); e = { at: at(), method: q.method(), host: u.host, path: shape(u.pathname), status: r.status(), ...sentBy(q), ...(service ? { service } : {}) }; } catch (x) { return; }
      const w = service && services.find(x => x.name === service);
      // Its body, read before the entry is listed, when the service has cards or a folder to keep it in.
      if (w && (w.keep || (w.cards && r.status() >= 200 && r.status() < 300))) {
        const text = await r.text().catch(() => null);
        if (w.keep && text !== null) { try { mkdirSync(w.keep, { recursive: true }); writeFileSync(`${w.keep}/${e.at.replace(/[:.]/g, '-')}-${++kept}-${r.status()}.json`, text); } catch (x) {} }
        if (w.cards && r.status() >= 200 && r.status() < 300) {
          let j = null; try { j = JSON.parse(text); } catch (x) {}
          e.cards = Object.fromEntries((w.cards.texts || []).map(t => [t, j ? cardIn(j, t, { suffix: w.cards.suffix || '' }) : null]));
          e.shown = j ? shownIn(j) : null;
          if (!j) e.unread = text === null ? "its body couldn't be read" : "its body isn't JSON";
        }
      }
      net.push(e);
    });
  };
  const active = new Map();
  // Leave out (capLeaveOut): the filters on, the DOM rules' script, the words per app, and what the checks found.
  let leave = null;
  const leaveStop = async () => {
    if (!leave) return;
    globalThis.__stuntdoubleLeaveOut = undefined;
    await leave.filter.stop().catch(() => {});
    if (leave.script) await leave.script.dispose().catch(() => {});
    for (const p of cb.ctx.pages()) for (const f of p.frames()) await f.evaluate(`window.__d1lo && window.__d1lo.set([])`).catch(() => {});
    leave = null;
  };
  // What a save of this app must not show: her lines' words, and what the filters took out of its responses so far.
  const leaveWords = app => {
    const words = (leave.words[app] || []).slice();
    const exact = [...new Set(leave.filter.log().filter(r => r.app === app).flatMap(r => r.removed.map(x => x.shows)).filter(Boolean))];
    return { words, exact };
  };
  const leaveLeak = async (p, app, what, why, hits) => {
    let picture = null;
    if (p && leave.shots) { try { picture = `${leave.shots}/leave-out-${app}-${leave.checks.n}.png`; mkdirSync(leave.shots, { recursive: true }); writeFileSync(picture, await p.screenshot({ timeout: 30000 })); } catch (e) { picture = null; } }
    leave.leak = { at: at(), app, what, why, ...(hits ? { hits } : {}), picture };
    log(`leave out: stopped before saving ${what} (${app}): ${why}`);
  };
  const leaveGate = async (p, app, what, html = null) => {
    const L = leave;
    if (!L) return;
    if (L.leak) throw new Error(`Leave out stopped the take: ${L.leak.why}`);
    // A filter of this app that couldn't do its work: its response may have reached the page as it came.
    const bad = L.filter.log().find(r => r.app === app && r.failures.length);
    if (bad) { await leaveLeak(p, app, what, `${bad.id}: ${bad.failures[0].why}`); throw new Error(`Leave out stopped the take: ${L.leak.why}`); }
    const { words, exact } = leaveWords(app);
    if (!words.length && !exact.length) return;
    const lw = [...words, ...exact].map(loose).filter(Boolean);
    L.checks.n++;
    let seen = false;
    if (html !== null) seen = lw.some(w => loose(unEntity(html)).includes(w));
    else for (const f of p.frames()) { if (await f.evaluate(LEAVE_SCAN, lw).catch(() => false)) { seen = true; break; } }
    if (!seen) { L.checks.clean++; return; }
    const docs = html !== null ? [{ key: 'main', html: `<html><body>${html}</body></html>` }] : await readDocs(p);
    const hits = L.check(docs, { words, exact });
    if (!hits.length) { L.checks.clean++; L.checks.read++; return; }
    const h = hits[0];
    await leaveLeak(p, app, what, `"${h.value}" is on the screen (${h.role || 'text'}: "${h.text}"${h.frame !== 'main' ? `, in ${h.frame}` : ''})`, hits.slice(0, 6));
    throw new Error(`Leave out stopped the take: ${L.leak.why}`);
  };
  // Her own status (capOwnStatus): per app, its control and what a save may show; what it read before each save; the
  // one it's waiting on; the stop.
  let own = null;
  // The recorded hovers (capHoverFloor): per app, their controls; how each went.
  let floor = null;
  // Notices a replica never keeps (capNotices): per app, their words and close buttons; what each save found; the stop.
  let notices = null;
  // Counts a page loads after itself (capCounts): per app, the recording's controls named with a count or status
  // ("Notifications, 1 unread items"); the first save after each page load waits for them.
  let counts = null;
  const pageText = p => p.mainFrame().evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
  const noticeStop = () => { throw new Error(`A notice stopped the take: ${notices.stopped.why}`); };
  const noticeGate = async (p, app, what, html = null) => {
    const S = notices;
    if (!S) return;
    if (S.stopped) noticeStop();
    const a = S.apps[app];
    if (!a || !p) return;
    const showing = t => a.notices.find(x => noticeIn(t, x.words)) || null;
    let hit = showing(html !== null ? unEntity(html) : await pageText(p));
    if (!hit) return;
    const was = hit, t0 = Date.now();
    let closed = false;
    S.waiting = { app, what, notice: hit.words, since: at() };
    log(`notice: ${app} shows "${hit.words}" before saving ${what}; waiting up to ${hit.waitS} s for it to go`);
    try {
      while (hit && Date.now() - t0 < hit.waitS * 1000) { await new Promise(res => setTimeout(res, 1000)); hit = showing(await pageText(p)); }
      // Still there: its own close button, pressed as a person would (nothing the guard doesn't allow is sent).
      const m = hit && hit.close ? /^\/(.+)\/([a-z]*)$/.exec(hit.close) : null;
      const pt = m ? await p.mainFrame().evaluate(`(${NOTICE_CLOSE})(${JSON.stringify([hit.words, m[1], m[2].replace(/g/g, '')])})`).catch(() => null) : null;
      if (pt) {
        // Past the recorder's page script (it holds clicks while a screen is captured, and records the rest): this
        // click isn't hers.
        await p.mainFrame().evaluate(() => { if (window.__rkrec) window.__rkrec.pass++; }).catch(() => {});
        await p.mouse.click(pt.x, pt.y);
        closed = true;
        for (let i = 0; i < 6 && hit; i++) { await new Promise(res => setTimeout(res, 500)); hit = showing(await pageText(p)); }
        log(`notice: closed "${was.words}" in ${app} with its own button${hit ? ', and it stayed' : ''}`);
      }
    } finally { S.waiting = null; }
    const waitedS = Math.round((Date.now() - t0) / 1000);
    S.seen.push({ at: at(), app, what, notice: was.words, waitedS, closed, ok: !hit });
    // Gone (waited out, or closed): true, so a caller holding the page as it was reads it again.
    if (!hit) return true;
    let picture = null;
    if (S.shots) { try { picture = `${S.shots}/notice-${app}.png`; mkdirSync(S.shots, { recursive: true }); writeFileSync(picture, await p.screenshot({ timeout: 30000 })); } catch (e) { picture = null; } }
    S.stopped = { at: at(), app, what, notice: hit.words, waitedS, closed, label: a.label, why: `${a.label} showed "${hit.words}…" for ${waitedS} s before ${what} was saved${closed ? ', and closing it didn\'t take it away' : hit.close ? ', and its close button wasn\'t found' : ''}`, picture };
    log(`notice: stopped before saving ${what} (${app}): ${S.stopped.why}`);
    noticeStop();
  };
  const ownRead = (p, a) => p.evaluate(OWN_READ(a)).catch(e => ({ found: false, error: String(e.message).split('\n')[0] }));
  const ownStop = () => { throw new Error(`Own status stopped the take: ${own.stopped.why}`); };
  const ownGate = async (p, app, what) => {
    const O = own;
    if (!O) return;
    if (O.stopped) ownStop();
    const a = O.apps[app];
    if (!a || !p) return;
    const t0 = Date.now(), fine = r => !r.found || a.expect.includes(r.status);
    let r = await ownRead(p, a);
    if (!fine(r)) {
      O.waiting = { app, what, status: r.status, since: at() };
      log(`own status: ${app} shows ${r.status} before saving ${what}; reading it again for up to ${a.waitS} s`);
      try { while (!fine(r) && Date.now() - t0 < a.waitS * 1000) { await new Promise(res => setTimeout(res, O.everyMs)); r = await ownRead(p, a); } } finally { O.waiting = null; }
    }
    const waitedS = Math.round((Date.now() - t0) / 1000);
    O.reads.push({ at: at(), app, what, ...(r.found ? { status: r.status } : { found: false }), ok: fine(r), ...(waitedS ? { waitedS } : {}) });
    if (fine(r)) return;
    let picture = null;
    if (O.shots) { try { picture = `${O.shots}/own-status-${app}.png`; mkdirSync(O.shots, { recursive: true }); writeFileSync(picture, await p.screenshot({ timeout: 30000 })); } catch (e) { picture = null; } }
    O.stopped = { at: at(), app, what, status: r.status, expect: a.expect, waitedS, label: a.label, why: `${a.label} showed ${r.status}, not ${a.expect.join(' or ')}, for ${waitedS} s before ${what} was saved`, picture };
    log(`own status: stopped before saving ${what} (${app}): ${O.stopped.why}`);
    ownStop();
  };
  return {
    // { on: true } starts recording; { since } reads what came since.
    // { on: true, watch?: [{ name, match }] } starts recording (watch: services whose every answer is kept, tagged
    // service); { since } reads what came since.
    async capNet(c) { if (c.on) { netOn(); if (Array.isArray(c.watch)) services = c.watch.filter(w => w && w.name && w.match).map(w => ({ name: w.name, match: w.match, ...(w.cards && (w.cards.texts || []).length ? { cards: { texts: w.cards.texts.map(String), suffix: String(w.cards.suffix || '') } } : {}), ...(w.keep ? { keep: String(w.keep) } : {}) })); return { on: true, total: net.length }; } return { net: (net || []).slice(c.since || 0), total: (net || []).length }; },
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
        const call = () => frame.evaluate(async ({ url, method, auth, body, pick, find }) => {
          try {
            const res = await fetch(url, { method, headers: { authorization: auth, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
            let picked;
            if (pick && pick.length) { const j = await res.json().catch(() => null); picked = {}; for (const k of pick) if (j && (typeof j[k] === 'number' || typeof j[k] === 'boolean')) picked[k] = j[k]; }
            if (find) {
              const j = await res.json().catch(() => null), at = (o, p) => String(p).split('.').reduce((x, k) => x == null ? x : x[k], o);
              const n = t => String(t == null ? '' : t).replace(/\s+/g, ' ').trim().toLowerCase(), want = new Set((find.names || []).map(n));
              const list = at(j, find.list);
              if (!Array.isArray(list)) return { status: res.status, found: null };
              const ok = it => want.has(n(at(it, find.name))) && Object.entries(find.where || {}).every(([k, v]) => at(it, k) === v);
              return { status: res.status, found: list.filter(ok).map(it => String(at(it, find.id))).slice(0, 50) };
            }
            return { status: res.status, picked };
          } catch (e) { return { error: String((e && e.message) || e) }; }
        }, { url: target.href, method, auth: auth.value, body: read ? null : (c.body || null), pick: Array.isArray(c.pick) ? c.pick.map(String) : null, find: read && c.find ? c.find : null });
        const from = hostOf(frame.url());
        const done = r => {
          log(`API ${read ? 'check' : 'undo'}: ${method} ${auth.host}${String(c.path).replace(/[0-9a-f-]{16,}|\d{4,}/gi, '{id}')} from ${from}: ${r.status || r.error}`);
          return r.status ? { ok: r.status >= 200 && r.status < 300, status: r.status, method, host: auth.host, path: c.path, from, ...(r.picked ? { picked: r.picked } : {}), ...('found' in r ? { found: r.found } : {}) } : { ok: false, why: r.error, from };
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
    async capLeaveOut(c) {
      const rules = Array.isArray(c.rules) ? c.rules : [];
      let check = null;
      if (rules.length) {
        // The negative check reads a screen as the reader does: a module by its package name, never a path.
        if (!/^@[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+\.mjs$/.test(String(c.check || ''))) return { on: false, refused: 'Leave out needs its negative check: a module by package name' };
        try { check = (await import(c.check)).leaveHits; } catch (e) { return { on: false, refused: `its negative check (${c.check}) didn't load: ${String(e.message).split('\n')[0]}` }; }
        if (typeof check !== 'function') return { on: false, refused: `${c.check} has no leaveHits` };
      }
      await leaveStop();
      if (!rules.length) return { on: false };
      const dom = rules.filter(r => r.kind === 'dom').map(({ id, hosts, list, values }) => ({ id, hosts, list, values }));
      const filter = await cb.leaveOut(rules.filter(r => r.kind !== 'dom'));
      let script = null;
      if (dom.length) {
        const src = `(${LEAVE_PAGE.trim()})(${JSON.stringify(dom)})`;
        script = await cb.ctx.addInitScript(src);
        for (const p of cb.ctx.pages()) for (const f of p.frames()) await f.evaluate(src).catch(() => {});
      }
      leave = { filter, script, words: c.words || {}, check, shots: c.shots || null, checks: { n: 0, clean: 0, read: 0 }, leak: null };
      // The recorder's hook (recorder.js): it calls these before it saves anything.
      globalThis.__stuntdoubleLeaveOut = { gate: (p, app, what) => leaveGate(p, app, what), gateHtml: (html, app, what, p = null) => leaveGate(p, app, what, String(html || '')) };
      log(`leave out on: ${rules.map(r => `${r.id} (${r.values.length})`).join(', ')}`);
      return { on: true, rules: rules.length - dom.length, dom: dom.length };
    },
    async capLeaveLog() {
      if (!leave) return { on: false, rules: [], checks: null, leak: null };
      const marked = [];
      for (const p of cb.ctx.pages()) { let n = 0; for (const f of p.frames()) n += +(await f.evaluate(() => document.querySelectorAll('[data-d1-leaveout]').length).catch(() => 0)); if (n) marked.push({ host: hostOf(p.url()), marked: n }); }
      return { on: true, rules: leave.filter.log(), dom: marked, checks: { ...leave.checks }, leak: leave.leak };
    },
    async capOwnStatus(c) {
      if (c.read) { const a = ownStatusConfig(c.read); if (!a) return { found: false, error: 'name is a /pattern/' }; return ownRead(await tabOf(c.read.tab), a); }
      if (c.apps) {
        const apps = {};
        for (const [id, x] of Object.entries(c.apps)) { const a = ownStatusConfig(x); if (a && a.expect.length) apps[id] = a; }
        if (!Object.keys(apps).length) { own = null; globalThis.__stuntdoubleOwnStatus = undefined; return { on: false }; }
        own = { apps, shots: c.shots || null, everyMs: Math.max(200, +c.everyMs || 2000), reads: [], stopped: null, waiting: null };
        // The recorder's hook (recorder.js): gate before it saves a screen; after for what it saves of one (a hover's
        // parts, a stream's frame): nothing once the take has stopped; waiting for its status (a save it holds).
        globalThis.__stuntdoubleOwnStatus = { gate: (p, app, what) => ownGate(p, app, what), after: () => { if (own && own.stopped) ownStop(); }, waiting: () => (own && own.waiting) || null };
        log(`own status on: ${Object.entries(apps).map(([id, a]) => `${id} (${a.expect.join(', ')})`).join(', ')}`);
        return { on: true, apps: Object.keys(apps) };
      }
      if (!own) return { on: false, reads: [], total: 0, stopped: null, waiting: null };
      return { on: true, reads: own.reads.slice(c.since || 0), total: own.reads.length, stopped: own.stopped, waiting: own.waiting };
    },
    // { apps: { <app>: { label, notices: [{ words, close, waitS }] } }, shots } arms the gate the recorder calls before
    // each save; { apps: {} } disarms it; { read: { tab, notices } } says which shows on a tab now (a walk, a check:
    // noted, never a stop); {} reads what each save found, and the stop.
    // The first save of a page after it loads (a start screen, the first save after a reload) waits up to waitS (20 s)
    // while a control the recording names with a count or status shows only its bare name (admin's bell: "Notifications"
    // until its count loads, "Notifications, 1 unread items" in the recording), then saves; one that never gets one is
    // a note, not a stop. c.apps: { <app>: [{ base, name }] }; {} → the log.
    async capCounts(c) {
      if (c.apps) {
        const apps = Object.fromEntries(Object.entries(c.apps).map(([id, l]) => [id, [].concat(l || []).filter(x => x && typeof x.base === 'string' && x.base && typeof x.name === 'string')]).filter(([, l]) => l.length));
        if (!Object.keys(apps).length) { counts = null; globalThis.__stuntdoubleCounts = undefined; return { on: false }; }
        counts = { apps, waitS: c.waitS === undefined ? 20 : +c.waitS, loads: new WeakMap(), log: [] };
        const gate = async (p, app, what) => {
          const S = counts, list = S && S.apps[app];
          if (!list || !p) return null;
          // Once per page load (its document's time origin).
          const origin = await p.evaluate(() => performance.timeOrigin).catch(() => null);
          if (origin !== null && S.loads.get(p) === origin) return null;
          if (origin !== null) S.loads.set(p, origin);
          const bare = () => p.evaluate(l => {
            const vis = e => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1 && getComputedStyle(e).visibility !== 'hidden'; };
            const names = [...document.querySelectorAll('button,[role=button],a[href],[role=link],[role=tab],[aria-label]')].filter(vis).map(e => (e.getAttribute('aria-label') || e.innerText || '').replace(/\s+/g, ' ').trim());
            return l.filter(x => names.includes(x.base) && !names.some(n => n.startsWith(x.base + ',') || n.startsWith(x.base + ' (')));
          }, list).catch(() => []);
          const t0 = Date.now();
          let missing = await bare();
          if (!missing.length) return null;
          while (missing.length && Date.now() - t0 < S.waitS * 1000) { await new Promise(r => setTimeout(r, 1000)); missing = await bare(); }
          const e = { at: at(), app, what, waitedS: Math.round((Date.now() - t0) / 1000), missing: missing.map(x => ({ base: x.base, name: x.name })) };
          S.log.push(e);
          log(`counts: ${app} ${what}: ${missing.length ? `no count on ${missing.map(x => `"${x.base}"`).join(', ')} after ${e.waitedS} s` : `counts in after ${e.waitedS} s`}`);
          return e;
        };
        globalThis.__stuntdoubleCounts = { gate };
        log(`counts on: ${Object.entries(apps).map(([id, l]) => `${id} (${l.map(x => `"${x.base}"`).join(', ')})`).join(', ')}`);
        return { on: true, apps: Object.fromEntries(Object.entries(apps).map(([id, l]) => [id, l.length])) };
      }
      return counts ? { on: true, log: counts.log.slice() } : { on: false, log: [] };
    },
    async capNotices(c) {
      if (c.read) { const t = await pageText(await tabOf(c.read.tab)); return { showing: [].concat(c.read.notices || []).filter(x => noticeIn(t, x.words)).map(x => x.words) }; }
      if (c.apps) {
        const apps = Object.fromEntries(Object.entries(c.apps).filter(([, a]) => a && (a.notices || []).length).map(([id, a]) => [id, { label: a.label || id, notices: a.notices.map(x => ({ words: String(x.words), close: x.close || null, waitS: x.waitS === undefined ? 60 : +x.waitS })) }]));
        if (!Object.keys(apps).length) { notices = null; globalThis.__stuntdoubleNotices = undefined; return { on: false }; }
        notices = { apps, shots: c.shots || null, seen: [], stopped: null, waiting: null };
        // The recorder's hook (recorder.js): before it saves a screen, or a stream's frame, of one of these apps.
        globalThis.__stuntdoubleNotices = { gate: (p, app, what) => noticeGate(p, app, what), gateHtml: (html, app, what, p = null) => noticeGate(p, app, what, String(html || '')), waiting: () => (notices && notices.waiting) || null };
        log(`notices on: ${Object.entries(apps).map(([id, a]) => `${id} (${a.notices.map(x => `"${x.words}"`).join(', ')})`).join(', ')}`);
        return { on: true, apps: Object.keys(apps) };
      }
      if (!notices) return { on: false, seen: [], stopped: null, waiting: null };
      return { on: true, seen: notices.seen.slice(c.since || 0), total: notices.seen.length, stopped: notices.stopped, waiting: notices.waiting };
    },
    async capHoverFloor(c) {
      if (c.apps) {
        const ok = f => f && typeof f.id === 'string' && f.anchor && typeof f.anchor.sel === 'string' && (f.scope === undefined || Array.isArray(f.scope));
        const apps = Object.fromEntries(Object.entries(c.apps).map(([id, fs]) => [id, [].concat(fs || []).filter(ok).map(f => ({ id: f.id, anchor: f.anchor, scope: f.scope || [], ...(f.rect ? { rect: f.rect } : {}), card: String(f.card || '') }))]).filter(([, fs]) => fs.length));
        // The recording's menus (c.clicks: { <app>: [{ id, name, ctl, ctlRect, restore, frame }] }): a floor too.
        const okc = f => f && typeof f.id === 'string' && typeof f.name === 'string' && f.ctl && typeof f.ctl.sel === 'string';
        const menus = Object.fromEntries(Object.entries(c.clicks || {}).map(([id, fs]) => [id, [].concat(fs || []).filter(okc).map(f => ({ id: f.id, name: f.name, ctl: f.ctl, ...(f.ctlRect ? { ctlRect: f.ctlRect } : {}), restore: f.restore || null, frame: f.frame || null }))]).filter(([, fs]) => fs.length));
        // The clicks the demo's build dropped (c.drop: { <app>: [name] }): the sweep's own picks leave them out.
        const drop = Object.fromEntries(Object.entries(c.drop || {}).map(([id, ns]) => [id, [].concat(ns || []).filter(n => typeof n === 'string' && n)]).filter(([, ns]) => ns.length));
        if (!Object.keys(apps).length && !Object.keys(menus).length && !Object.keys(drop).length) { floor = null; globalThis.__stuntdoubleHoverFloor = undefined; return { on: false }; }
        floor = { apps, menus, drop, shots: c.shots || null, log: [], clickLog: [] };
        const shot = async (p, name) => {
          if (!floor || !floor.shots || !p) return null;
          try { const f = `${floor.shots}/hover-missed-${String(name).replace(/[^\w.-]+/g, '-')}.png`; mkdirSync(floor.shots, { recursive: true }); writeFileSync(f, await p.screenshot({ timeout: 30000 })); return f; } catch (e) { return null; }
        };
        // An app's recorded hovers still to capture: not one whose card a sweep of the app has captured (any card, for
        // one whose card has no words: a control of its showed).
        const keys = app => {
          if (!floor) return [];
          const log = floor.log.filter(e => e.app === app), cards = log.flatMap(e => e.cards.flatMap(x => x.cards));
          return (floor.apps[app] || []).filter(f => !(f.card ? cards.some(x => cardMatch(f.card, x)) : log.some(e => e.floor[f.id] && e.floor[f.id].shown)));
        };
        // An app's recorded menus still to capture (in the main frame, or in frames): not one a sweep has opened.
        const clicks = (app, inFrame = false) => {
          if (!floor) return [];
          const done = new Set(floor.clickLog.filter(e => e.app === app).flatMap(e => Object.entries(e.floor || {}).filter(([, v]) => v && v.shown).map(([id]) => id)));
          return (floor.menus[app] || []).filter(f => !done.has(f.id) && !!f.frame === inFrame);
        };
        // A picture of a screen by name (the recorder's put-back: what was left open).
        const pic = async (p, name) => { if (!floor || !floor.shots || !p) return null; try { const f = `${floor.shots}/${String(name).replace(/[^\w.-]+/g, '-')}.png`; mkdirSync(floor.shots, { recursive: true }); writeFileSync(f, await p.screenshot({ timeout: 30000 })); return f; } catch (e) { return null; } };
        const dropped = app => (floor && floor.drop[app]) || [];
        globalThis.__stuntdoubleHoverFloor = { keys, clicks, dropped, pic, seen: e => { if (floor) floor.log.push({ at: at(), ...e }); }, seenClicks: e => { if (floor) floor.clickLog.push({ at: at(), ...e }); }, shot, match: cardMatch };
        log(`hover floor on: ${Object.entries(apps).map(([id, ks]) => `${id} ${ks.length}`).join(', ')}${Object.keys(menus).length ? `; menus: ${Object.entries(menus).map(([id, ks]) => `${id} ${ks.length}`).join(', ')}` : ''}`);
        return { on: true, apps: Object.fromEntries(Object.entries(apps).map(([id, ks]) => [id, ks.length])), menus: Object.fromEntries(Object.entries(menus).map(([id, ks]) => [id, ks.length])) };
      }
      return floor ? { on: true, log: floor.log.slice(), clickLog: floor.clickLog.slice() } : { on: false, log: [], clickLog: [] };
    },
    async capTab(c) {
      if (c.close) { const p = sides.get(c.close); sides.delete(c.close); if (p && !p.isClosed()) await p.close().catch(() => {}); return { closed: !!p }; }
      if (!c.mark || !c.open) throw new Error('capTab: open and mark, or close');
      const mark = String(c.mark), put = p => p.evaluate(k => { try { sessionStorage.setItem('d1tab', k); } catch (e) {} }, mark).catch(() => {});
      const p = await cb.open('about:blank');
      sideOf.set(p, mark); sides.set(mark, p);
      p.on('framenavigated', f => { if (f === p.mainFrame()) put(p); });
      await p.goto(c.open, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(e => log(`side tab ${mark}: ${String(e.message).split('\n')[0]}`));
      await put(p);
      return { mark, url: p.url() };
    },
    async capUrl(c) { const p = await tabOf(c.tab); return { url: p.url(), title: await p.title().catch(() => '') }; },
    async capShot(c) { const p = await tabOf(c.tab); mkdirSync(dirname(c.file), { recursive: true }); writeFileSync(c.file, await p.screenshot()); return { file: c.file }; },
    async capBack(c) { const p = await tabOf(c.tab); await p.goBack({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null); return { url: p.url() }; },
  };
}
