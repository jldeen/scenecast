// A plan's proofs, grounded again on the product as it is today (docs/engine/plan-format.md, "Proofs on today's
// product"). A live walk (walk.mjs, in the capture browser, read-only) saves each screen it reaches, read twice once
// the page is quiet, and each app's start screen, as its frames' markup. Each step's proof is chosen again by
// landing.mjs's rules, on those reads and the recording: it holds on the recording and on every read of the step's
// screen today, and on none of the screens before it, the recording's or today's. Where nothing does, a proof on
// today's reads alone, marked: the product changed since the recording. A step the walk didn't reach keeps its
// recorded proof, marked: behind a write it didn't make, or not reached.
//   regroundPlan(plan, { walker, walk, reads }) → { plan, rows }   the plan with its new proofs; a row per step
//   walkReads(dir)                                  a walk's saved screens, read by the recording's reader
//   formatReground(rows)                            the proofs before and after, for whoever adopts them
//   reground(demo, { from, plan, packs })           .out/ai/reground.md and .json, and plan.reground.md
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { readScreen } from '@scenecast/script/html.mjs';
import { chooseProof, holds, proofWords, pageWords, pnorm, changes, presence } from './landing.mjs';
import { formatLands, formatPlan, formatStep, parsePlan } from './plan.mjs';
import { walkerFromDemo, inPlace } from './walker.mjs';
import { aiDir } from './run.mjs';

const PLAN = 'plan.md';
// A walk's steps that ran, so their screens were read (walk.mjs's statuses).
const RAN = new Set(['reached', 'drifted', 'unproven']);

// The screens a walk saved (walk-screens/, as the live walk writes them: unattended.mjs): <beat>-<step>.reads.json.gz
// (both from 1) and start-<app>.reads.json.gz, each gzipped JSON [{ at, docs: [{ key, html }] }, …]: the page read
// twice, about a second apart once quiet, as its documents (its own, key "main", then each frame's, by its host) the
// way the recorder's serializer writes them (serialize.js, without CSS). <beat>-<step>.json beside it holds the walk's
// words and controls, which this doesn't use, and what the guard held while the step ran (held: [{ method, host, path
// }]), when the walk says. → step(beat, step) / start(app): the reads as the reader reads them, or null; at(beat, step)
// / startAt(app): when each read was taken (ms), or null; held(beat, step): the walk's held list, or null; why(beat,
// step): why there are no reads.
export function walkReads(dir) {
  const memo = new Map(), whys = new Map();
  const load = name => {
    if (!memo.has(name)) {
      let got = null, at = null;
      const gz = join(dir, `${name}.reads.json.gz`);
      if (existsSync(gz)) {
        try {
          const rs = JSON.parse(gunzipSync(readFileSync(gz)).toString('utf8')).filter(r => r && Array.isArray(r.docs) && r.docs.some(x => x && x.html));
          got = rs.map(r => readScreen(r.docs));
          at = rs.map(r => Date.parse(r.at)).filter(Number.isFinite);
        } catch (e) { whys.set(name, `the reader couldn't read its screen (${e.message})`); }
      }
      if (!(got && got.length) && !whys.has(name)) whys.set(name, existsSync(join(dir, `${name}.json`)) ? 'the walk saved its screen without the page\u2019s markup' : 'the walk saved no screen for it');
      memo.set(name, got && got.length ? { got, at: at && at.length ? at : null } : null);
    }
    return memo.get(name);
  };
  const heldOf = name => { try { const h = JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')).held; return Array.isArray(h) ? h : null; } catch (e) { return null; } };
  const one = name => (load(name) || {}).got || null, when = name => (load(name) || {}).at || null;
  return { step: (beat, step) => one(`${beat}-${step}`), start: app => one(`start-${app}`), at: (beat, step) => when(`${beat}-${step}`), startAt: app => when(`start-${app}`),
    held: (beat, step) => heldOf(`${beat}-${step}`), why: (beat, step) => whys.get(`${beat}-${step}`) || null };
}

// A request the guard held, as a kind: its method, host and path, with ids as * (POST api.example.com/items/*/query).
const idLike = p => /^(?:\d{3,}|[0-9a-f]{16,})$/i.test(p) || /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(p) || (/%3a|:/i.test(p) && /\d{4}/.test(p));
export const heldKind = h => `${String(h.method || 'GET').toUpperCase()} ${h.host || ''}${String(h.path || '').split('?')[0].split('/').map(p => idLike(p) ? '*' : p).join('/')}`;
// What an app sends whatever it shows, and that shows nothing: telemetry, logs and reports.
const TELEMETRY = /^(?:[\w-]+\.)*(?:events\.data\.microsoft\.com|pipe\.aria\.microsoft\.com|applicationinsights\.azure\.com|dc\.services\.visualstudio\.com)\/|\/(?:onecollector|collector|events|track|telemetry|instrument|logclient|logflight|beacon|metrics|ping|report)(?:\/|$)/i;
export const isTelemetry = kind => TELEMETRY.test(String(kind).slice(String(kind).indexOf(' ') + 1));
// A pack's guard entry (@stuntdouble/apps: a host/path prefix, or a /regex/ over "METHOD host/path") against a held
// request; "… when body /regex/" is checked on the request alone (a held request's body isn't kept).
const reOf = e => typeof e === 'string' && /^\/.+\/[a-z]*$/.test(e) ? new RegExp(e.slice(1, e.lastIndexOf('/')), e.slice(e.lastIndexOf('/') + 1)) : null;
const reviews = (entry, h) => {
  const req = String(entry).split(' when body ')[0], re = reOf(req), at = `${h.host || ''}${String(h.path || '').split('?')[0]}`;
  return re ? re.test(`${String(h.method || 'GET').toUpperCase()} ${at}`) : at.startsWith(req);
};
const hostIs = (h, x) => !!h && !!x && (h === x || h.endsWith('.' + x));
const urlHost = u => { try { return new URL(u).host; } catch (e) { return null; } };
// Each app's hosts (its address, its pack's match and guard hosts) and the requests its pack has reviewed as staying
// held (guard.stayHeld).
function sitesOf(apps = [], packs = null) {
  return apps.map(a => {
    const p = ((packs && packs.forApp) || {})[a.id] || {}, g = p.guard || {};
    return { id: a.id, hosts: [urlHost(a.url), ...(p.match || []).map(m => String(m).split('/')[0]), ...(g.hosts || [])].filter(Boolean), stayHeld: g.stayHeld || [] };
  });
}
// What the guard held once the walk had read its apps' start screens, each { t, h, kind, app }: the app it was for is
// the walk's own (a held request's app, or its frame's host), else the app whose hosts it went to, else the app of the
// step it was held in (from the step's first input, else the step before's last read, to its own last read). A step's
// own held list (walk-screens' <beat>-<step>.json held), when the walk gives one, is that step's.
// → { held, windows: Map '<beat>-<step>' → { from, end } }
// Which app a request was for: the walk's own word (its app, or its frame's host), else the app whose hosts it went to.
const appOfRequest = (sites, h) => ((h.app && sites.find(a => a.id === h.app)) || sites.find(a => a.hosts.some(x => hostIs(h.frame || h.frameHost, x))) || sites.find(a => a.hosts.some(x => hostIs(h.host, x))) || {}).id || null;
function heldDuring(walk, reads, steps, rowOf, appAt, sites) {
  const inputs = ((walk && walk.inputs) || []).map(i => ({ t: Date.parse(i.at), for: i.for })).filter(i => Number.isFinite(i.t));
  const starts = ((walk && walk.starts) || []).flatMap(st => (reads.startAt && reads.startAt(st.app)) || []);
  const begun = starts.length ? Math.max(...starts) : -Infinity;
  const appFor = h => appOfRequest(sites, h);
  const windows = new Map(), held = [];
  let last = begun;
  for (const [k, { s, bi, si }] of steps.entries()) {
    const r = rowOf(bi, si), at = r && RAN.has(r.status) && reads.at ? reads.at(bi + 1, si + 1) : null;
    if (!at || !at.length) continue;
    const end = Math.max(...at), text = formatStep(s), mine = inputs.filter(i => i.for === text && i.t > last && i.t <= end).map(i => i.t);
    const w = { from: mine.length ? Math.min(...mine) : last, after: last, end, app: appAt[k], own: reads.held ? reads.held(bi + 1, si + 1) : null };
    windows.set(`${bi + 1}-${si + 1}`, w);
    for (const h of w.own || []) held.push({ t: end, h, kind: heldKind(h), app: appFor(h) || w.app });
    last = end;
  }
  for (const h of (walk && walk.guard && walk.guard.held) || []) {
    const t = Date.parse(h.at);
    if (!Number.isFinite(t) || t <= begun) continue;
    const w = [...windows.values()].find(x => t >= x.from && t > x.after && t <= x.end);
    if (w && w.own) continue;
    const app = appFor(h) || (w && w.app) || null;
    if (app) held.push({ t, h, kind: heldKind(h), app });
  }
  return { held, windows };
}
// An error a page shows: one of these, or anything in an alert.
const ERROR = /\b(?:could(?:n['’]?t| not) (?:be )?load(?:ed)?|can['’]?t (?:be )?load(?:ed)?|(?:failed|unable) to load|check your connection|try again|something went wrong)\b/i;
const short = t => (t = String(t).replace(/\s+/g, ' ').trim()).length > 80 ? `${t.slice(0, 77)}…` : t;
const q = t => `“${cell(short(t))}”`, qs = xs => xs.map(q).join(', ');
function errorsOn(got, rec) {
  const was = rec ? pageWords(rec) : '', out = [];
  for (const g of got) for (const i of g.items || []) if (!i.shut && i.text && (ERROR.test(i.text) || i.role === 'alert') && !was.includes(pnorm(i.text)) && !out.some(x => pnorm(x) === pnorm(i.text))) out.push(i.text);
  return out.filter(t => !out.some(u => u !== t && pnorm(u).length < pnorm(t).length && pnorm(t).includes(pnorm(u))));
}
// A screen's items a run can count on, as the proofs' (not in a closed dialog, a live region, a time, a message or a
// text area), one per text.
function soundItems(sc, keep) {
  const its = [], seen = new Set();
  for (const i of sc.items || []) {
    const n = pnorm(i.text);
    if (!n || i.shut || i.live || i.time || i.tag === 'textarea' || i.article !== undefined || seen.has(n) || !keep(i.text, i, sc)) continue;
    seen.add(n);
    its.push(i);
  }
  return its;
}
// Innermost only: a box holding words that are missing (or extra) is too.
const innermost = its => its.filter(x => !its.some(u => u !== x && pnorm(u.text).length < pnorm(x.text).length && pnorm(x.text).includes(pnorm(u.text))));
const lostFrom = (was, got, keep) => innermost(soundItems(was, keep)).map(i => i.text).filter(t => t.split(/\s+/).length >= 2 && got.every(g => !pageWords(g).includes(pnorm(t))));
const inList = x => ({ ...(x.list !== undefined ? { list: x.list } : {}), ...(x.row !== undefined ? { row: x.row } : {}), ...(x.restored ? { restored: true } : {}), ...(x.described ? { described: true } : {}), ...(x.nav ? { nav: true } : {}) });
// A row's own control named by everything in it (an option "Fabrikam Orders Daily orders Plugin", "AC Avery Chen
// People", a grid row): what's in the row counts, each on its own.
const ROWISH = /^(option|row|listitem|treeitem|menuitem|menuitemcheckbox|menuitemradio)$/;
const whole = (sc, c) => { if (!ROWISH.test(c.role || '')) return false; const l = rowLabel(sc, c); return !!l && pnorm(c.name).length > pnorm(l).length && pnorm(c.name).includes(pnorm(l)); };
// What a capture of today's product would lose: the words and controls the recorded screen has that both of today's
// reads lack, each { kind: 'words' | 'control', text, role, list, row } (list, row: where it is in a list on the
// recorded screen). A control's own words count once, as the control.
function missingFrom(rec, got, keep) {
  const names = got.map(g => new Set((g.controls || []).filter(c => !c.shut).map(c => pnorm(c.name))));
  const out = [], seen = new Set();
  for (const c of rec.controls || []) {
    const n = pnorm(c.name);
    if (!n || c.shut || c.live || c.time || c.name.length >= 80 || seen.has(n) || !keep(c.name) || names.some(x => x.has(n)) || whole(rec, c)) continue;
    seen.add(n);
    out.push({ kind: 'control', text: c.name, role: c.role, ...inList(c) });
  }
  for (const i of innermost(soundItems(rec, keep).filter(i => !seen.has(pnorm(i.text)) && got.every(g => !pageWords(g).includes(pnorm(i.text)))))) out.push({ kind: 'words', text: i.text, role: i.role, ...inList(i) });
  return out;
}
// What a capture of today's product would show that the recording doesn't: the words and controls both of today's
// reads have that none of the recording's captures of the screen show, as words or as a control (caps), as
// missingFrom's (list, row: on today's first read). skip: what's accounted for already.
function extraFrom(caps, got, keep, skip) {
  const words = caps.map(pageWords), named = caps.map(c => new Set((c.controls || []).map(x => pnorm(x.name))));
  const recorded = n => named.some(x => x.has(n)) || words.some(w => w.includes(n));
  const names = got.map(g => new Set((g.controls || []).filter(c => !c.shut).map(c => pnorm(c.name))));
  const out = [], seen = new Set();
  for (const c of got[0].controls || []) {
    const n = pnorm(c.name);
    if (!n || c.shut || c.live || c.time || c.name.length >= 80 || seen.has(n) || !keep(c.name) || skip(c.name) || recorded(n) || !names.every(x => x.has(n)) || whole(got[0], c)) continue;
    seen.add(n);
    out.push({ kind: 'control', text: c.name, role: c.role, ...inList(c) });
  }
  for (const i of innermost(soundItems(got[0], keep).filter(i => !seen.has(pnorm(i.text)) && !skip(i.text) && !recorded(pnorm(i.text)) && got.every(g => pageWords(g).includes(pnorm(i.text)))))) out.push({ kind: 'words', text: i.text, role: i.role, ...inList(i) });
  return out;
}
// A screen's lists, as the reader marks them: list → its rows in page order, each row → its label (its first words with
// two letters in a row, in any script, that aren't someone's initials before their name, else its control's name).
const listed = new WeakMap();
const initialsOf = t => { const w = String(t).split(/\s+/).filter(x => /^\p{L}/u.test(x)); return w.length ? [w.map(x => x[0]).join(''), w.length > 1 ? w[0][0] + w[w.length - 1][0] : null].filter(Boolean).map(x => x.toUpperCase()) : []; };
function listsOf(sc) {
  if (listed.has(sc)) return listed.get(sc);
  const m = new Map(), put = (l, r, t) => { if (!m.has(l)) m.set(l, new Map()); const rows = m.get(l); if (!rows.has(r)) rows.set(r, t); };
  const its = (sc.items || []).filter(i => i.list !== undefined && i.row !== undefined && !i.shut && /\p{L}{2}/u.test(i.text));
  for (const [k, i] of its.entries()) {
    const t = i.text.trim(), next = its[k + 1];
    if (/^[A-Z]{2,3}$/.test(t) && next && next.row === i.row && initialsOf(next.text).includes(t)) continue;
    put(i.list, i.row, i.text);
  }
  for (const c of sc.controls || []) if (c.list !== undefined && c.row !== undefined && !c.shut && c.name) put(c.list, c.row, c.name);
  for (const [l, rows] of m) m.set(l, new Map([...rows].sort((a, b) => a[0] - b[0])));
  listed.set(sc, m);
  return m;
}
const rowLabel = (sc, e) => e.list !== undefined && e.row !== undefined ? ((listsOf(sc).get(e.list)) || new Map()).get(e.row) || null : null;
// The list on another screen that one is: the one sharing the most rows with it, else the one with its name and role.
// → where it starts there, or null.
function sameListAt(sc, list, other) {
  const want = new Set([...((listsOf(sc).get(list)) || new Map()).values()].map(pnorm));
  let best = null;
  for (const [at, rows] of listsOf(other)) { const n = [...rows.values()].filter(t => want.has(pnorm(t))).length; if (n && (!best || n > best.n)) best = { at, n }; }
  if (best) return best.at;
  const [name, role] = (sc.lists || {})[list] || [];
  const same = name && Object.entries(other.lists || {}).find(([, v]) => v[0] === name && v[1] === role);
  return same ? +same[0] : null;
}
const sameList = (sc, list, other) => { const at = sameListAt(sc, list, other); return at === null ? null : [...((listsOf(other).get(at)) || new Map()).values()]; };
// Whether an entry's row is gone from every one of the other screens: none has its name, as words or a control.
const hasText = (o, n) => (o.items || []).some(i => !i.shut && pnorm(i.text) === n) || (o.controls || []).some(c => !c.shut && pnorm(c.name) === n);
const rowGone = (sc, e, others) => { const l = rowLabel(sc, e); return !!l && others.every(o => !hasText(o, pnorm(l))); };
// A list's rows a capture put back (restored), and how it's named in reground.md: its name, else its first rows.
const restoredRows = (sc, list) => new Set([...(sc.items || []), ...(sc.controls || [])].filter(x => x.list === list && x.restored).map(x => x.row));
// The names of the rows a capture put back, on any of a screen's captures.
const restoredNames = caps => new Set(caps.flatMap(c => [...listsOf(c)].flatMap(([list, rows]) => { const back = restoredRows(c, list); return [...rows].filter(([r]) => back.has(r)).map(([, t]) => pnorm(t)); })));
const listName = (sc, list) => { const n = ((sc.lists || {})[list] || [])[0]; if (n) return `the list ${q(n)}`; const f = [...((listsOf(sc).get(list)) || new Map()).values()].slice(0, 2); return f.length ? `the list starting ${qs(f)}` : 'a list'; };
// A list that says how many rows it has (aria-rowcount, aria-setsize), here and on each of today's reads, when they
// differ: a number that changed ("486" → "500").
function sizesFrom(rec, got) {
  const out = [];
  for (const [at, [, , size]] of Object.entries(rec.lists || {})) {
    if (!size) continue;
    const now = got.map(g => { const id = sameListAt(rec, +at, g); return id === null ? null : ((g.lists || {})[id] || [])[2] || null; });
    if (now[0] && now.every(n => n === now[0]) && now[0] !== size) out.push({ kind: 'size', cls: 'number', text: String(size), now: String(now[0]), name: listName(rec, +at) });
  }
  return out;
}
// Rows of a list that are gone (or new) as one entry per list and class: a row is gone when no screen on the other side
// (today's reads, for what's missing; the recording's captures, for what's extra) has its label as words or a control,
// and what's in it goes with it, in the class of its label (else of what's first in it). { kind: 'list', cls, name,
// count, total, entries, rows (the first five of them), first (the list's first five on this screen), other: { total,
// first } | null (the same list on the other side) }. What's gone from rows still there, in two rows or more of a list,
// is one entry too: { kind: 'list', changed: true, cls, name, count, total, entries, texts (the first five) }. Then
// entries that start the same way ("Name: …", three or more) are one: { kind: 'like', cls, prefix, count, texts }.
function collapse(classed, sc, others) {
  const heads = new Map(), key = e => `${e.list}|${e.row}`;
  const gone = new Map();
  for (const e of classed) {
    const l = rowLabel(sc, e), k = key(e);
    if (!l) continue;
    if (!gone.has(k)) gone.set(k, rowGone(sc, e, others));
    if (gone.get(k) && (!heads.has(k) || (pnorm(l) === pnorm(e.text) && pnorm(heads.get(k).text) !== pnorm(l)))) heads.set(k, e);
  }
  const out = [], groups = new Map(), whyOf = es => { const w = [...new Set(es.map(x => x.write).filter(Boolean))], y = [...new Set(es.map(x => x.why).filter(Boolean))]; return { ...(w.length ? { write: w.join('; ') } : {}), ...(y.length ? { why: y.join('; ') } : {}) }; };
  for (const e of classed) {
    const h = heads.get(key(e)), kept = !h && rowLabel(sc, e);
    if (!h && !kept) { out.push(e); continue; }
    const k = h ? `gone|${h.cls}|${e.list}` : `kept|${e.cls}|${e.list}`;
    if (!groups.has(k)) groups.set(k, { h: h || e, gone: !!h, es: [] });
    groups.get(k).es.push(e);
  }
  for (const { h, gone, es } of groups.values()) {
    const rows = [...new Set(es.map(e => e.row))].sort((a, b) => a - b);
    if (rows.length < 2) { out.push(...es); continue; }
    if (!gone) {
      const nows = es.map(e => e.now).filter(Boolean);
      out.push({ kind: 'list', changed: true, cls: h.cls, name: ((sc.lists || {})[h.list] || [])[0] || null, count: rows.length, total: (listsOf(sc).get(h.list) || new Map()).size, entries: es.length,
        texts: [...es.filter(e => e.kind === 'words'), ...es.filter(e => e.kind !== 'words')].slice(0, 5).map(e => e.text), ...(nows.length ? { nows } : {}), ...whyOf(es) });
      continue;
    }
    const all = listsOf(sc).get(h.list) || new Map(), there = others[0] ? sameList(sc, h.list, others[0]) : null, hs = rows.map(r => heads.get(`${h.list}|${r}`)), back = restoredRows(sc, h.list);
    out.push({ kind: 'list', cls: h.cls, name: ((sc.lists || {})[h.list] || [])[0] || null, count: rows.length, total: all.size, ...(back.size ? { inView: all.size - back.size } : {}), entries: es.length,
      rows: rows.map(r => all.get(r)).slice(0, 5), first: [...all.values()].slice(0, 5), other: there ? { total: there.length, first: there.slice(0, 5) } : null, ...whyOf(hs) });
  }
  const like = new Map(), rest = [];
  for (const e of out) {
    const m = e.kind !== 'list' && /^([^:]{1,40}?):\s+\S/.exec(e.text), p = m && m[1].trim().split(/\s+/).length <= 3 ? m[1].trim() : null;
    if (!p) { rest.push(e); continue; }
    const k = `${e.cls}|${p}`;
    if (!like.has(k)) like.set(k, { p, es: [] });
    like.get(k).es.push(e);
  }
  for (const { p, es } of like.values()) es.length < 3 ? rest.push(...es) : rest.push({ kind: 'like', cls: es[0].cls, prefix: p, count: es.length, texts: es.slice(0, 5).map(e => e.text), ...whyOf(es) });
  return rest;
}
// What's missing since the recording, by why (formatReground's classes), in this order:
//   beyond    in a row the recording's capture scrolled to and put back (restored), when today's reads don't have the
//             row: a walk doesn't scroll, so it's beyond its view, not missing
//   varies    someone's presence, or words in the page's own content the recording's captures show differently (a
//             greeting)
//   expected  made by a write the walk didn't make: the recording first shows it, in path order, after that write (the
//             app's last before it), and shows its place without it before the write (the write's own screen, an
//             earlier screen of the app at the same address, or the app's frame, for something in it); or it's in a
//             row named by words the recording's writes made (a skill it saved). A name with more after it ("…,
//             unread") is first shown where its name is.
//   varies    words in the app's frame the recording's captures show differently (a title in Recent)
//   number    the same words today, but for a number ("Plugins: 485" → "Plugins: 529"); each of today's words once,
//             the one sharing the most of the recorded numbers first. So are the rows a list says it has (sizesFrom).
//   renamed   a control today, of the same role, has the recorded name and more after it ("Credits in use, 99%
//             remaining"), and the recorded screen has no control by that name
//   missing   the rest, with what may have broken its app's page (why)
// Then a list's rows, and entries that start the same way, are one line each (collapse).
const digitless = t => pnorm(t).replace(/\d+(?:[.,]\d+)*/g, '#');
const MORE = /^\s*[,:;(\-–—|·]/;
const numbers = t => String(t).match(/\d+(?:[.,]\d+)*/g) || [];
function missingClasses(entries, { rec, got, app, why, madeBy, varies }) {
  const used = got.map(() => new Set()), had = new Set((rec.controls || []).map(c => pnorm(c.name)));
  const shown = new Set([...(rec.items || []).map(i => pnorm(i.text)), ...had]);
  const one = e => {
    if (e.restored && rowGone(rec, e, got)) return { ...e, cls: 'beyond', why: 'the recording\u2019s capture scrolled the list to them; a walk doesn\u2019t scroll' };
    // Someone's presence, or a greeting, before a write: words that vary in the page's own content aren't a write's.
    // In the app's frame they may be (a chat a write started, its title in Recent).
    const v = varies(e.text, app);
    if (v && (presence(e.text) || !e.nav)) return { ...e, cls: 'varies', why: v };
    const w = madeBy(e, app, rec);
    if (w) return { ...e, cls: 'expected', write: w };
    if (v) return { ...e, cls: 'varies', why: v };
    if (/\d/.test(e.text)) {
      const d = digitless(e.text), mine = numbers(e.text), near = t => numbers(t).filter((x, i) => x === mine[i]).length;
      const now = got.map((g, k) => (e.kind === 'control' ? (g.controls || []).filter(c => !c.shut && c.role === e.role).map(c => c.name) : (g.items || []).filter(i => !i.shut).map(i => i.text))
        .filter(t => digitless(t) === d && !used[k].has(pnorm(t)) && !shown.has(pnorm(t))).map((t, i) => ({ t, i, n: near(t) })).sort((a, b) => b.n - a.n || a.i - b.i)[0]);
      if (now.every(Boolean)) { now.forEach((m, k) => used[k].add(pnorm(m.t))); return { ...e, cls: 'number', now: now[0].t }; }
    }
    if (e.kind === 'control') {
      const n = pnorm(e.text);
      const now = got.map(g => (g.controls || []).find(c => !c.shut && c.role === e.role && pnorm(c.name).startsWith(n) && MORE.test(pnorm(c.name).slice(n.length)) && !had.has(pnorm(c.name))));
      if (now.every(Boolean)) return { ...e, cls: 'renamed', now: now[0].name };
    }
    return { ...e, cls: 'missing', ...(why ? { why } : {}) };
  };
  return collapse([...entries.map(one), ...sizesFrom(rec, got)], rec, got);
}

// Words in a place where the recording's captures differ (a greeting that changes on each visit): what a read today
// shows there instead can't be counted on either. Each read is compared with the recording of the same step only.
const wn = t => String(t || '').toLowerCase().replace(/[^a-z0-9$%]+/g, ' ').trim();
function shakyToday(rec, got, walker, app) {
  const swaps = [];
  if (rec && walker.unstable) for (const g of got) for (const [x, y] of (inPlace(rec, g) || { changed: [] }).changed) {
    const was = x.split(' | ');
    if (was.some(t => walker.unstable(t, app))) swaps.push({ x: was, y: y.split(' | ') });
  }
  return t => {
    const n = wn(t), long = n.split(' ').length >= 3;
    if (!n) return false;
    const has = side => side.includes(n) || (long && side.some(u => ` ${u} `.includes(` ${n} `)));
    return swaps.some(c => has(c.x) !== has(c.y));
  };
}

// walk: walk.json ({ beats: [{ steps: [{ step, text, status, why, needs }] }], guard: { held: [{ method, host, path, at,
// app?, frame? }] }, inputs: [{ at, for }], starts: [{ app }], events: [{ kind, app?, host, at }] }, a row per plan
// step, step from 0); reads: walkReads();
// apps: the demo's ({ id, url }; else the walker's); packs: make.mjs loadPacks()'s, for each app's hosts and the
// requests its pack has reviewed as staying held. Each row: { beat, step, text, screen, status, was, now, basis, why,
// changed, number, held, missing, extra }, missing: what the recorded screen has that today's reads lack, each in a
// class (missingClasses); extra: what today's reads have that no capture of the screen in the recording has.
// basis one of
//   both       its proof holds today and in the recording (changed: a new one, why says what was wrong)
//   today      on today's reads only: the product changed since the recording (or the recording typed other words)
//   none       nothing tells today's screen from the one before: a run can't check it (Needs you)
//   suspect    its app's page may be broken today, not by the product: since a request the guard held that isn't
//              telemetry and that no pack has reviewed (held: their kinds), an error the recording doesn't show, or
//              words lost while nothing ran in it. A step that didn't land as planned then, or whose proof would
//              change, keeps its proof (Needs you, with the reason).
//   write      behind a write the walk didn't make (or needs one: a step it missed for one, the steps after that miss,
//              a step whose words may be its doing): the recording's proof stays
//   missed     the walk didn't land it (why says why): the recording's proof stays
//   unreached  the walk didn't get here, or ran it and saved no screen: the recording's proof stays
export function regroundPlan(plan0, { walker, walk, reads, apps = null, packs = null }) {
  const plan = JSON.parse(JSON.stringify(plan0));
  const steps = plan.beats.flatMap((b, bi) => b.steps.map((s, si) => ({ s, bi, si })));
  const rowOf = (bi, si) => ((((walk && walk.beats) || [])[bi] || {}).steps || []).find(r => r.step === si) || null;
  const other = steps.find(({ s, bi, si }) => { const r = rowOf(bi, si); return r && r.text && r.text !== formatStep(s); });
  if (other) throw new Error(`the walk was of another plan (beat ${other.bi + 1}, step ${other.si + 1} was “${rowOf(other.bi, other.si).text}”, now “${formatStep(other.s)}”): walk this plan first`);
  const typedAll = [...(walker.typedTexts ? walker.typedTexts() : []), ...steps.map(({ s }) => s.kind === 'type' ? s.value : null).filter(Boolean)];
  // Each step's app: the one the plan was in.
  const appAt = [];
  { let a = null; for (const { s } of steps) { if (s.kind === 'app') a = s.app; appAt.push(a); } }
  const sites = sitesOf(apps || walker.apps || [], packs);
  // What may have broken an app's page today, from when until the page loads again (a new document of the app's, in
  // walk.events: { kind: 'loaded', app?, host, at }), else to the end of the walk: a held request that isn't telemetry
  // and that no pack has reviewed as staying held, for the app it was for; a response of 500 or more to a step's own
  // app in the step's window; an error a read shows that the recording doesn't; words an app lost while nothing ran
  // in it.
  const { held, windows } = heldDuring(walk, reads, steps, rowOf, appAt, sites);
  const reviewed = h => sites.some(a => a.stayHeld.some(e => reviews(e, h)));
  const reasons = held.filter(x => !isTelemetry(x.kind) && !reviewed(x.h)).map(x => ({ app: x.app, t: x.t, held: x.kind, why: `the guard held ${x.kind}` }));
  // When each step began: its first input (the walk's window for it, else its reads'). Its window runs to the next
  // step's start. A response of 500 or more in it (walk.net: { at, method, host, path, status, app?, frame? }), for the
  // step's own app and not telemetry, means the service it names was down for the step, from its start.
  const ownWindow = (bi, si, end) => { const r = rowOf(bi, si), t = r && r.window ? Date.parse(r.window[end]) : NaN; return Number.isFinite(t) ? t : null; };
  const begins = steps.map(({ bi, si }) => { const w = windows.get(`${bi + 1}-${si + 1}`); return ownWindow(bi, si, 'from') ?? (w ? w.from : null); });
  for (const n of (walk && walk.net) || []) {
    const t = Date.parse(n.at), app = appOfRequest(sites, n), kind = heldKind(n);
    if (!(+n.status >= 500) || !Number.isFinite(t) || !app || isTelemetry(kind)) continue;
    let k = -1;
    for (const [j, b] of begins.entries()) if (b !== null && b <= t) k = j;
    if (k >= 0 && appAt[k] === app) reasons.push({ app, t: begins[k], why: `${kind} answered ${n.status}` });
  }
  const loads = ((walk && walk.events) || []).filter(e => e && e.kind === 'loaded').map(e => ({ t: Date.parse(e.at), app: e.app || (sites.find(a => a.hosts.some(x => hostIs(e.host, x))) || {}).id || null }))
    .filter(e => Number.isFinite(e.t) && e.app);
  const reloaded = (app, from, to) => loads.some(e => e.app === app && e.t > from && e.t <= to);
  // When each step was: its last read; one without, the end of the walk's window for it (a step it missed), else just
  // before the next step began.
  const when = [];
  { let next = Infinity; for (let k = steps.length - 1; k >= 0; k--) { const { bi, si } = steps[k], w = windows.get(`${bi + 1}-${si + 1}`); when[k] = w ? w.end : ownWindow(bi, si, 'to') ?? next - 1; if (begins[k] !== null) next = begins[k]; } }
  // What a proof never uses (landing.mjs), as words lost or missing: not times, keys, Copilot's words or another
  // step's typing. Listing what's missing, someone's presence and words that vary between captures stay, as varying.
  const varies = (t, app) => presence(t) ? "someone's presence" : walker.unstable && walker.unstable(t, app) ? "the recording's captures of this screen differ there" : null;
  const keep = (app, listing = false) => (t, i, sc) => /[a-z]/i.test(t) && !(changes(t) && !(listing && presence(t))) && !(walker.written && walker.written(t)) && !(i && sc && walker.writtenItem && walker.writtenItem(i, sc))
    && !(!listing && walker.unstable && walker.unstable(t, app)) && !typedAll.some(v => pnorm(t).length > 3 && pnorm(v).includes(pnorm(t)));
  // The recording in path order (the plan's steps), for what a write the walk didn't make explains: each step's app,
  // its screen, the screen's address, and whether it's such a write.
  const order = steps.map(({ s, bi, si }, k) => {
    const to = s.lands && s.lands.screen, r = rowOf(bi, si);
    return { app: appAt[k] || (to && (walker.flow.states[to] || {}).app) || null, sc: to ? walker.screen(to) : null, url: to && walker.view ? (walker.view(to) || {}).url || null : null,
      write: !!s.writes && !(r && RAN.has(r.status)), what: `${formatStep(s)} (step ${bi + 1}-${si + 1})` };
  });
  const seenOn = new WeakMap();
  const seen = sc => { if (!seenOn.has(sc)) seenOn.set(sc, { words: new Set((sc.items || []).filter(i => !i.shut).map(i => pnorm(i.text))), names: new Set((sc.controls || []).filter(c => !c.shut).map(c => pnorm(c.name))),
    nav: new Set([...(sc.items || []).filter(i => i.nav && !i.shut).map(i => pnorm(i.text)), ...(sc.controls || []).filter(c => c.nav && !c.shut).map(c => pnorm(c.name))]) }); return seenOn.get(sc); };
  const shows = (sc, e) => !!sc && seen(sc)[e.kind === 'control' ? 'names' : 'words'].has(pnorm(e.text));
  const madeBy = (e, app, sc) => {
    const m = /^(.+?)(?:\s*[,;|·]\s|\s+[-–—]\s|\s+\()/.exec(e.text), base = m && m[1].trim().split(/\s+/).length >= 3 ? pnorm(m[1]) : null;
    const on = x => x.app === app && !!x.sc && (shows(x.sc, e) || (!!base && (seen(x.sc).words.has(base) || seen(x.sc).names.has(base))));
    const first = order.findIndex(on);
    if (first < 0) return null;
    let w = first;
    while (w >= 0 && !(order[w].app === app && order[w].write)) w--;
    if (w < 0) return null;
    const label = sc ? rowLabel(sc, e) : null;
    if (label && pnorm(label) !== pnorm(e.text) && walker.written && walker.written(label)) return order[w].what;
    const F = order[first], nav = seen(F.sc).nav.has(pnorm(e.text)) || (!!base && seen(F.sc).nav.has(base));
    return order.slice(0, w).some(x => x.app === app && x.sc && (w === first || nav || (!!F.url && x.url === F.url))) ? order[w].what : null;
  };
  const lastRead = {};
  const rows = [];
  // Today's screen before a step: the reads after the step before it; before anything ran, its app's start screen
  // (nothing, before a first "Go to"); null when that screen wasn't read (a miss, or nothing saved).
  // A write the walk didn't make, in this app, that a step needs (walk.mjs `needs`, on a missed or drifted step): what
  // isn't there may be that write's doing. The steps after such a miss, in its beat, need it too.
  let cur = null, prev = [], started = false;
  const missNeeds = {};
  for (const [k, { s, bi, si }] of steps.entries()) {
    const r0 = rowOf(bi, si), status = r0 ? r0.status : null;
    const needs = (r0 && r0.needs) || (status === 'after-miss' ? missNeeds[bi] : null) || null;
    if (status === 'missed' && needs) missNeeds[bi] = needs;
    const ran = RAN.has(status), got = ran ? reads.step(bi + 1, si + 1) : null;
    const to = s.lands && s.lands.screen, from = cur;
    const app = appAt[k] || ((walker.flow.states[to] || {}).app || null);
    const before = started ? prev : s.kind !== 'app' && app ? reads.start(app) : [];
    if (ran || status === 'missed') { started = true; prev = got; }
    if (got && app) {
      const at = (reads.at && reads.at(bi + 1, si + 1)) || [], t0 = at.length ? Math.min(...at) : when[k];
      for (const e of errorsOn(got, to ? walker.screen(to) : null)) reasons.push({ app, t: t0, why: `today's screen shows an error the recording doesn't: “${short(e)}”` });
      const was = lastRead[app] || { got: reads.start(app), from: 'its start screen' };
      if (s.kind === 'app' && was.got) {
        const lost = lostFrom(was.got[was.got.length - 1], got, keep(app));
        if (lost.length) reasons.push({ app, t: t0, why: `${app} lost words while nothing ran in it, since ${was.from}: “${short(lost[0])}”${lost.length > 1 ? ` and ${lost.length - 1} more` : ''}` });
      }
      lastRead[app] = { got, from: `step ${bi + 1}-${si + 1}` };
    }
    const active = app ? [...new Map(reasons.filter(x => x.app === app && x.t <= when[k] && !reloaded(app, x.t, when[k])).map(x => [x.why, x])).values()] : [];
    const suspect = () => ({ basis: 'suspect', held: active.filter(x => x.held).map(x => x.held), why: `${active.map(x => x.why).join('; ')}; check ${active.some(x => x.held) ? 'the pack' : 'the app'} before adopting` });
    if (!to) continue;
    cur = to;
    const was = { ...s.lands };
    const row = { beat: bi + 1, step: si + 1, text: formatStep(s), screen: to, status: status || 'not walked', was: formatLands(was) };
    rows.push(row);
    if (!got) {
      const behind = status === 'write' || status === 'after-write' || (!ran && !!needs);
      Object.assign(row, { now: row.was, changed: false, basis: behind ? 'write' : status === 'missed' ? 'missed' : 'unreached',
        why: ran ? (reads.why && reads.why(bi + 1, si + 1)) || 'the walk saved no screen for it' : status === 'write' ? `a write: ${r0.why}`
          : needs && status !== 'after-write' ? `needs ${needs}${status === 'missed' && r0.why ? ` (the walk: ${r0.why})` : ''}` : (r0 && r0.why) || "the walk didn't get here" });
      if (row.basis === 'missed' && active.length) { const sp = suspect(); Object.assign(row, sp, { why: `${sp.why} (the walk: ${r0.why || 'missed'})` }); }
      continue;
    }
    row.read = true;
    const rec = walker.screen(to), unstable = shakyToday(rec, got, walker, app);
    if (rec) {
      row.missing = missingClasses(missingFrom(rec, got, keep(app, true)), { rec, got, app, why: active.map(x => x.why).join('; '), madeBy, varies });
      // What today shows that no capture of the screen in the recording does, apart from today's side of what's
      // renamed or a number that changed, and words in a place that varies between runs.
      const paired = new Set(row.missing.flatMap(e => e.nows || (e.now ? [e.now] : [])).map(pnorm));
      // Nor what describes a row the recording has only as one its capture put back: a row's tooltip is in a portal
      // the capture doesn't copy.
      const caps = walker.captures ? walker.captures(to) : [rec], back = restoredNames(caps);
      row.extra = collapse(extraFrom(caps, got, keep(app), t => paired.has(pnorm(t)) || unstable(t)).filter(e => !(e.described && back.has(pnorm(rowLabel(got[0], e) || ''))))
        .map(e => ({ ...e, cls: 'extra' })), got[0], caps);
    }
    // A step that didn't land as planned while its app's page may be broken keeps its proof: what's missing may not be
    // the product's doing.
    if (active.length && status !== 'reached') { Object.assign(row, { now: row.was, changed: false }, suspect()); continue; }
    const next = (steps.slice(k + 1).find(({ s: x }) => !/^(wait|scroll)$/.test(x.kind)) || {}).s || null;
    const opts = { typed: typedAll.filter(v => !(s.kind === 'type' && v === s.value)), next };
    let r = chooseProof(s, from, to, walker, { ...opts, live: { afters: got, befores: before || [], unstable } }), alone = false;
    // Nothing holds on both: today's reads alone, when today's screen before the step was read, unless a write the walk
    // didn't make comes first (then the recording's proof stays).
    if (!r.lands.kind && needs) { Object.assign(row, { now: row.was, changed: false, basis: 'write', why: `needs ${needs}` }); continue; }
    if (!r.lands.kind && before) { const t = chooseProof(s, from, to, walker, { ...opts, live: { afters: got, befores: before, unstable, only: true } }); if (t.lands.kind) { r = t; alone = true; } }
    s.lands = { screen: to, ...r.lands, text: r.lands.kind === 'words' ? r.lands.text : null };
    row.now = formatLands(s.lands);
    row.changed = row.now !== row.was;
    row.basis = !r.lands.kind ? 'none' : alone || !(rec && holds(rec, s.lands) === true) ? 'today' : 'both';
    if (r.number) row.number = true;
    // Landed as planned, but its proof would change while its app's page may be broken: never a new proof from it.
    if (active.length && row.changed) { s.lands = { ...was }; Object.assign(row, { now: row.was, changed: false, number: undefined }, suspect()); continue; }
    const today = was.kind && got.every(g => holds(g, was) === true), early = was.kind && (before || []).some(b => holds(b, was) === true);
    const old = !row.changed ? null : !was.kind ? 'it had no proof' : !today ? `${proofWords(was)} isn't on today's screen`
      : early ? `${proofWords(was)} is on today's screen before it too` : `today, ${proofWords(was)} isn't words a run can count on`;
    row.why = row.basis === 'none' ? [old, r.why].filter(Boolean).join('; ') : row.basis === 'today' && s.kind === 'type' && rec && holds(rec, s.lands) !== true ? [old, 'the recording has other words typed here'].filter(Boolean).join('; ') : old;
  }
  return { plan, rows };
}

const BASIS = {
  both: 'Holds today and in the recording',
  today: "Today's product only: it changed since the recording",
  suspect: "Its app's page may be broken today",
  none: 'Nothing proves it today',
  write: "Behind a write the walk didn't make",
  missed: 'Missed today',
  unreached: 'Not reached today',
};
const cell = t => String(t || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
// The counts reground.md starts with, and reground() returns.
export const regroundCounts = rows => {
  const n = f => rows.filter(f).length;
  return { steps: rows.length, kept: n(r => r.basis === 'both' && !r.changed), changed: n(r => r.basis === 'both' && r.changed), today: n(r => r.basis === 'today'),
    suspect: n(r => r.basis === 'suspect'), none: n(r => r.basis === 'none'), write: n(r => r.basis === 'write'), missed: n(r => r.basis === 'missed'), unreached: n(r => r.basis === 'unreached') };
};
// What's missing (or extra) since the recording, as reground.md lists it: by class, the same entry on several steps once,
// each { cls, what, now, write, why, entries (what it stands for), at: Map screen → steps }.
const CLASSES = [['missing', 'Missing: look at these'], ['renamed', 'Renamed'], ['number', 'A number changed'], ['expected', 'Made by a write the walk didn\u2019t make'], ['varies', 'Varies between runs'],
  ['beyond', 'Beyond the walk\u2019s view: rows of a list it didn\u2019t scroll']];
function whatOf(e) {
  if (e.kind === 'control') return `${q(e.text)} (${e.role})`;
  if (e.kind === 'size') return `The rows ${e.name} says it has: ${q(e.text)}`;
  if (e.kind === 'like') return `${e.count} like “${cell(e.prefix)}: …”, starting ${qs(e.texts)}`;
  if (e.kind === 'list' && e.changed) return `${e.entries} in ${e.count} of ${e.total} rows of ${e.name ? `the list ${q(e.name)}` : 'a list'} that ${e.cls === 'extra' ? 'the recording has too' : 'are still there'}, starting ${qs(e.texts)}`;
  if (e.kind !== 'list') return q(e.text);
  const same = e.rows.length === e.first.length && e.rows.every((r, i) => r === e.first[i]), extra = e.cls === 'extra';
  const list = e.name ? `the list ${q(e.name)}` : 'a list';
  if (e.cls === 'beyond') return `${e.count} of ${e.total} rows of ${list}, from ${qs(e.rows)}`;
  return (e.inView ? `${e.count} rows of ${list}, of the ${e.inView} in view (${e.total} with the ones its capture scrolled to)` : `${e.count}${e.total > e.count ? ` of ${e.total}` : ''} rows of ${list}`)
    + (e.count <= 5 ? `: ${qs(e.rows)}` : `${same ? '' : `, from ${qs(e.rows)}`}. ${extra ? 'Today' : 'Recorded'}, it starts ${qs(e.first)}`)
    + (e.other ? `. ${extra ? 'Recorded' : 'Today'}: ${e.other.total} rows${e.other.total ? `, starting ${qs(e.other.first)}` : ''}` : extra ? '. The recording doesn\u2019t have it' : '. Today it isn\u2019t there');
}
function missingLines(rows, field = 'missing') {
  const lines = new Map();
  for (const r of rows) for (const e of r[field] || []) {
    const what = whatOf(e), now = e.now ? q(e.now) : e.nows ? qs(e.nows.slice(0, 5)) : null, k = [e.cls, what, now || '', e.write || '', e.cls === 'varies' ? e.why : ''].join('\u0001');
    if (!lines.has(k)) lines.set(k, { cls: e.cls, what, now, write: e.write || null, why: new Set(), entries: e.kind === 'list' ? (e.changed ? e.entries : e.count) : e.kind === 'like' ? e.count : 1, at: new Map() });
    const l = lines.get(k);
    if (e.why) for (const w of e.why.split('; ')) l.why.add(w);
    if (!l.at.has(r.screen)) l.at.set(r.screen, []);
    l.at.get(r.screen).push(`${r.beat}-${r.step}`);
  }
  return [...lines.values()];
}
const where = l => [...l.at].map(([sc, st]) => `${sc} (${st.join(', ')})`).join('; ');
// Per class, and what's extra: { entries (each word, control or list row), lines }.
export const missingCounts = rows => {
  const ls = [...missingLines(rows), ...missingLines(rows, 'extra')], n = c => ({ entries: ls.filter(l => l.cls === c).reduce((k, l) => k + l.entries, 0), lines: ls.filter(l => l.cls === c).length });
  return Object.fromEntries([...CLASSES.map(([c]) => [c, n(c)]), ['extra', n('extra')]]);
};
export function formatReground(rows) {
  const c = regroundCounts(rows);
  const read = rows.filter(r => r.read).length;
  const out = ["# Proofs on today's product", '', `${rows.length} steps land on a screen. Today's walk read ${read} of them.`, '', '| | Steps |', '|---|---|',
    `| Kept: it holds today and in the recording | ${c.kept} |`,
    `| New: it holds today and in the recording | ${c.changed} |`,
    `| ${BASIS.today} | ${c.today} |`,
    `| ${BASIS.suspect} (Needs you) | ${c.suspect} |`,
    `| ${BASIS.none} (Needs you) | ${c.none} |`,
    `| ${BASIS.write}: the recording's proof stays | ${c.write} |`,
    `| ${BASIS.missed}: the recording's proof stays | ${c.missed} |`,
    `| ${BASIS.unreached}: the recording's proof stays | ${c.unreached} |`, ''];
  const changed = rows.filter(r => (r.basis === 'both' || r.basis === 'today') && (r.changed || r.basis === 'today'));
  if (changed.length) {
    out.push('## What changed', '', '| Beat | Step | Was | Now | Why |', '|---|---|---|---|---|');
    for (const r of changed) out.push(`| ${r.beat} | ${cell(r.text)} | ${cell(r.was)} | ${cell(r.now)}${r.basis === 'today' ? ' (today only)' : ''}${r.number ? ' (a number)' : ''} | ${cell(r.why)} |`);
    out.push('');
  }
  const guarded = rows.filter(r => r.basis === 'suspect'), unproven = rows.filter(r => r.basis === 'none');
  if (guarded.length || unproven.length) out.push('## Needs you', '');
  if (guarded.length) {
    out.push('These steps\u2019 pages may have been broken today by something other than the product, so their proofs stay as they are: check first.', '', '| Beat | Step | Proof | Why |', '|---|---|---|---|');
    for (const r of guarded) out.push(`| ${r.beat} | ${cell(r.text)} | ${cell(r.now)} | ${cell(r.why)} |`);
    out.push('');
  }
  if (unproven.length) {
    out.push('Nothing on today\u2019s screen tells these steps apart from the one before, so a run can\u2019t check them.', '', '| Beat | Step | Was | Why |', '|---|---|---|---|');
    for (const r of unproven) out.push(`| ${r.beat} | ${cell(r.text)} | ${cell(r.was)} | ${cell(r.why)} |`);
    out.push('');
  }
  // What a capture of today's product would lose, by why.
  const lines = missingLines(rows);
  if (lines.length) {
    const n = missingCounts(rows);
    out.push('## Missing since the recording', '', 'Words, controls and list rows a recorded screen has that both of today\u2019s reads lack. A list\u2019s rows are one line.', '',
      '| | Entries | Lines |', '|---|---|---|', ...CLASSES.map(([k, t]) => `| ${t} | ${n[k].entries} | ${n[k].lines} |`), '');
    const head = { missing: ['What', 'Why it may be'], renamed: ['Recorded', 'Today'], number: ['Recorded', 'Today'], expected: ['What', 'The write'], varies: ['What', 'Why'], beyond: ['What', 'Why'] };
    for (const [k, t] of CLASSES) {
      const ls = lines.filter(l => l.cls === k);
      if (!ls.length) continue;
      out.push(`### ${t}`, '', `| ${head[k][0]} | ${head[k][1]} | Screen (steps) |`, '|---|---|---|');
      for (const l of ls) out.push(`| ${l.what} | ${l.now || cell(l.write || [...l.why].join('; '))} | ${where(l)} |`);
      out.push('');
    }
  }
  // What a capture of today's product would show that the recording doesn't: tenant clutter to clear first, or what's new.
  const extra = missingLines(rows, 'extra');
  if (extra.length) {
    const n = missingCounts(rows).extra;
    out.push('## Extra since the recording', '', `Words, controls and list rows both of today\u2019s reads have that no capture of the screen in the recording has: ${n.entries} in ${n.lines} lines. A capture now would show them.`, '',
      '| What | Screen (steps) |', '|---|---|', ...extra.map(l => `| ${l.what} | ${where(l)} |`), '');
  }
  const kept = rows.filter(r => r.basis === 'write' || r.basis === 'missed' || r.basis === 'unreached');
  if (kept.length) {
    out.push('## Not checked today', '', '| Beat | Step | Proof | Why |', '|---|---|---|---|');
    for (const r of kept) out.push(`| ${r.beat} | ${cell(r.text)} | ${cell(r.now)} | ${cell(r.why)} |`);
    out.push('');
  }
  return out.join('\n');
}

// from: the folder holding walk.json and walk-screens/ (a walk's own: .out/ai). plan: the plan the walk walked, when
// it isn't the demo's plan.md now. plan.md stays as it is: until --adopt (after stage F: plan-format.md, "Approval"),
// adopting plan.reground.md means approving it again.
export function reground(demo, { from = null, plan: planFile = null, packs = null } = {}) {
  const dir = from || aiDir(demo), wf = join(dir, 'walk.json'), pf = planFile || join(demo.dir, PLAN);
  if (!existsSync(pf)) throw new Error(planFile ? `${planFile}: there\u2019s no such file` : 'make the plan first');
  if (!existsSync(wf)) throw new Error("there's no walk to ground the plan on: walk it in the capture browser first");
  const walker = walkerFromDemo(demo);
  if (!walker) throw new Error("there's no recording to compare today's screens with");
  const { plan, rows } = regroundPlan(parsePlan(readFileSync(pf, 'utf8')), { walker, walk: JSON.parse(readFileSync(wf, 'utf8')), reads: walkReads(join(dir, 'walk-screens')), apps: (demo.cfg && demo.cfg.apps) || null, packs });
  walker.save();
  mkdirSync(aiDir(demo), { recursive: true });
  writeFileSync(join(aiDir(demo), 'reground.md'), formatReground(rows));
  writeFileSync(join(aiDir(demo), 'reground.json'), JSON.stringify({ at: new Date().toISOString(), walk: wf, plan: pf, rows }, null, 1) + '\n');
  writeFileSync(join(aiDir(demo), 'plan.reground.md'), formatPlan(plan));
  return { ...regroundCounts(rows), file: 'reground.md', plan: 'plan.reground.md' };
}
