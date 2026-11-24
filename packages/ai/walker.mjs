// The screens a plan is mapped onto before anything is recorded again: a demo recorded before (its flow.json says
// where each click, typing and Enter leads) with its captures (the product's own pages: the raw snaps, else the built
// ones). The interface is the live walker's (the capture browser, Phase 6), agreed Nov 22:
//   start(app) → screen                      a screen: { app, url, sig, title } (offline, sig is the capture's name)
//   step(screen, step) → { screen, landed, wrote: false }   a read-only step; it throws before any step that has
//                                            `writes` (a walker never writes)
// Offline there's more, from the recording:
//   recorded(screen, step) → { screen, landed, wrote: false }   where the recording went from here, writes included
//                                            (nothing is done: it's what was captured)
//   view(sig) / shown(sig) / opened(sig)     the product's controls and words / the replica's / with step groups open
//   nameOf(sig, matcher)                     the name of the control a recorded matcher picks there
//   moves(sig) / bridge(sig, goal)           what the recording did from a screen / its way to a screen that has goal
//                                            (goal(screen, sig, lastMove, path so far))
import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readScreen } from '@scenecast/script/html.mjs';
import { findItem } from './find.mjs';
import { holds, proofWords, isBox } from './landing.mjs';

// Bump when what readScreen() gives changes: screens cached by an older reader are read again.
const READER = 18;

const norm = s => String(s || '').toLowerCase().replace(/[“”"'’]/g, '').replace(/\s+/g, ' ').trim();

// A recorded matcher's name and what it pins down: its aria-label, test id, text.
export function specParts(m) {
  if (!m) return {};
  const sel = m.sel || '';
  const label = /\[aria-label(\^?)="([^"]+)"\]/.exec(sel), testid = /\[data-testid(\^?)="([^"]+)"\]/.exec(sel);
  return { frame: m.frame, label: label && label[2], labelPrefix: !!(label && label[1]), testid: testid && testid[2], testidPrefix: !!(testid && testid[1]), text: m.text, textStarts: m.textStarts, sel };
}
export const specName = m => { const p = specParts(m); return p.text || p.label || (p.textStarts ? p.textStarts + '…' : '') || ''; };
// A recorded matcher as a key: what the reader resolved it to on a screen (picks) is kept under it.
const specKey = m => JSON.stringify([m.frame ?? null, m.sel ?? null, m.in ?? null, m.label ?? null, m.labelStarts ?? null, m.testid ?? null, m.text ?? null, m.textStarts ?? null, m.nth ?? 0]);
function specMatches(m, c, sc) {
  // The control the matcher's selector picks on this capture, when the reader found one.
  if (sc && sc.picks) { const k = sc.picks[specKey(m)]; if (k !== undefined && k >= 0) return c.i === k; }
  const p = specParts(m);
  if ((p.frame || undefined) !== (c.frame || undefined)) return false;
  if (p.testid && c.testid) return p.testidPrefix ? c.testid.startsWith(p.testid) : c.testid === p.testid;
  if (p.label) return p.labelPrefix ? c.name.startsWith(p.label) : c.name === p.label;
  if (p.text) return norm(c.name) === norm(p.text) || norm(c.name).endsWith(': ' + norm(p.text));
  if (p.textStarts) return norm(c.name).startsWith(norm(p.textStarts)) && (!/role=row/.test(p.sel) || c.role === 'row');
  // A selector with nothing to name it by (the message box): any control of its kind.
  if (/contenteditable|role=textbox|^textarea|^input/.test(p.sel)) return !!c.editable;
  return false;
}

// Two captures of one screen, item by item in page order: the items that changed in place (up to three for up to
// three, between items both have): [what one says, what the other says].
export function inPlace(a, b) {
  const seq = sc => (sc.items || []).filter(i => !i.shut).map(i => ({ t: String(i.text || '').toLowerCase().replace(/[^a-z0-9$%]+/g, ' ').trim() })).filter(x => x.t);
  const A0 = seq(a), B0 = seq(b);
  let i = 0, j = 0;
  while (i < A0.length && i < B0.length && A0[i].t === B0[i].t) i++;
  while (j < A0.length - i && j < B0.length - i && A0[A0.length - 1 - j].t === B0[B0.length - 1 - j].t) j++;
  const A = A0.slice(i, A0.length - j), B = B0.slice(i, B0.length - j);
  if (A.length * B.length > 4e6) return null;
  const W = B.length + 1, L = new Uint16Array((A.length + 1) * W);
  for (let x = A.length - 1; x >= 0; x--) for (let y = B.length - 1; y >= 0; y--) L[x * W + y] = A[x].t === B[y].t ? L[(x + 1) * W + y + 1] + 1 : Math.max(L[(x + 1) * W + y], L[x * W + y + 1]);
  const changed = [], hunk = { del: [], ins: [] };
  const close = () => {
    // A number that changed is the number rule's (landing.mjs), not this one's: "× 1" for "× 2" isn't counted.
    const was = hunk.del.map(x => x.t).join(' | '), now = hunk.ins.map(x => x.t).join(' | ');
    if (hunk.del.length && hunk.ins.length && hunk.del.length <= 3 && hunk.ins.length <= 3 && was.replace(/\d+/g, '#') !== now.replace(/\d+/g, '#')) changed.push([was, now]);
    hunk.del = []; hunk.ins = [];
  };
  let x = 0, y = 0;
  while (x < A.length || y < B.length) {
    if (x < A.length && y < B.length && A[x].t === B[y].t) { close(); x++; y++; }
    else if (y >= B.length || (x < A.length && L[(x + 1) * W + y] >= L[x * W + y + 1])) hunk.del.push(A[x++]);
    else hunk.ins.push(B[y++]);
  }
  close();
  return { changed };
}

export function walkerFromDemo(demo, { cache = true } = {}) {
  const flowPath = join(demo.dir, 'flow.json');
  if (!existsSync(flowPath)) return null;
  const flow = JSON.parse(readFileSync(flowPath, 'utf8'));
  const S = flow.states || {};
  const apps = (flow.apps || []).map(a => ({ id: a.id, key: a.key || null, title: a.title || a.id, ...(((demo.cfg || {}).apps || []).find(x => x.id === a.id) || {}) }));
  const cacheFile = join(demo.out || join(demo.dir, '.out'), 'ai', 'screens.json');
  let saved = {};
  if (cache) try { saved = JSON.parse(readFileSync(cacheFile, 'utf8')); } catch (e) { saved = {}; }
  let dirty = false;
  // A capture's documents: the product's own (the raw snap: what the app showed), or the replica's (the built page
  // and its frames, with the demo's edits in).
  const rawOf = snap => {
    const raw = demo.raw && join(demo.raw, 'snaps', snap + '.json');
    return raw && existsSync(raw) ? { from: raw, docs: () => JSON.parse(readFileSync(raw, 'utf8')).docs || [] } : null;
  };
  const builtOf = snap => {
    const built = join(demo.dir, 'data', 'snaps', snap + '.html');
    if (!existsSync(built)) return null;
    return { from: built, docs: () => {
      const meta = (() => { try { return JSON.parse(readFileSync(join(demo.dir, 'data', 'snaps', snap + '.json'), 'utf8')); } catch (e) { return {}; } })();
      return [{ key: 'main', html: readFileSync(built, 'utf8') }, ...(meta.frames || []).map(f => ({ key: f.key, file: join(demo.dir, 'data', 'snaps', `${snap}.${f.key}.html`) })).filter(f => existsSync(f.file)).map(f => ({ key: f.key, html: readFileSync(f.file, 'utf8') }))];
    } };
  };
  const memo = new Map();
  const load = (id, kind) => {
    const k = `${kind}:${id}`;
    if (memo.has(k)) return memo.get(k);
    const st = S[id];
    if (!st) return null;
    const snap = st.snap || id;
    const src = kind === 'shown' ? builtOf(snap) || rawOf(snap) : rawOf(snap) || builtOf(snap);
    let sc = { controls: [], items: [], headings: [], text: '' };
    if (src) {
      // The recorded matchers on this screen (its clicks, fields and Enter), resolved as the screen is read.
      const ms = [];
      for (const t of transitions(id)) for (const kk of ['click', 'type', 'enter', 'hover']) if (t[kk] && typeof t[kk] === 'object') ms.push(t[kk]);
      for (const f of st.fill || []) ms.push(f);
      const specs = [...new Map(ms.map(m => [specKey(m), { ...m, key: specKey(m) }])).values()];
      const key = `${READER}:${src.from}:${statSync(src.from).mtimeMs}:${createHash('sha1').update(specs.map(m => m.key).join('\n')).digest('hex').slice(0, 12)}`;
      if (saved[k] && saved[k].key === key) sc = saved[k].screen;
      else { sc = readScreen(src.docs(), { specs }); saved[k] = { key, screen: sc }; dirty = true; }
    }
    // The page's own title (a Copilot task's name), from the build's record of the capture.
    let title = st.title || null;
    if (!title) try { title = JSON.parse(readFileSync(join(demo.dir, 'data', 'snaps', snap + '.json'), 'utf8')).title || null; } catch (e) {}
    const out = { id, app: st.app, title: title || id, ...sc, fills: (st.fill || []).map(f => ({ ...f, name: specName(f) })), captured: !!src };
    memo.set(k, out);
    return out;
  };
  // The product's screen (to map steps to its real controls) and the replica's (what focus points land on).
  const screen = id => load(id, 'product');
  const shown = id => load(id, 'shown');
  // The same screen with its step groups open ("21 items complete"), where the recording captured that: { screen,
  // label } (label: the group's button, what ⌥F opens first).
  const opened = id => {
    const st = S[id];
    if (!st) return null;
    for (const g of flow.groups || []) for (const o of g.open || []) if (o.closed === (st.snap || id) && g.app === st.app) {
      const k = `${id}~open`;
      if (!memo.has(k)) { const src = builtOf(o.open) || rawOf(o.open); memo.set(k, src ? { id, app: st.app, ...readScreen(src.docs()), fills: [] } : null); }
      return memo.get(k) ? { screen: memo.get(k), label: (g.template || {}).label || null } : null;
    }
    return null;
  };
  const save = () => { if (!dirty || !cache) return; mkdirSync(join(cacheFile, '..'), { recursive: true }); writeFileSync(cacheFile, JSON.stringify(saved)); dirty = false; };
  const b0 = (flow.beats || [])[0];
  const start = app => (b0 && b0.states && b0.states[app]) || Object.keys(S).find(k => S[k].app === app) || null;
  const appOn = (app, id) => ((flow.apps || []).find(a => a.id === app) || {}).on || [];
  // The recording's own path (flow.path, else recording.json's): where each of its steps led within an app, as moves the
  // screens don't list (a player key that typed the change, → to the next slide, a click the build left out).
  const recPath = (flow.path || []).some(s => s.checkpoint) ? flow.path : (() => { try { return JSON.parse(readFileSync(join(demo.dir, 'recording.json'), 'utf8')).path || []; } catch (e) { return []; } })();
  const pathOn = {};
  let prevCp = null;
  for (const p of recPath) {
    const cp = p.checkpoint;
    if (!cp) continue;
    if (prevCp && prevCp !== cp && S[prevCp] && S[cp] && S[prevCp].app === S[cp].app) {
      const t = p.key && !/^(Enter|Escape)$/.test(p.key) ? { key: p.key, to: cp, fromPath: true } : p.click ? { click: p.click, to: cp, fromPath: true } : p.type && p.text != null ? { type: p.type, text: p.text, to: cp, fromPath: true } : null;
      const own = S[prevCp].on || [];
      const known = t && (t.key ? false : own.some(o => (o.click || o.type) && JSON.stringify(o.click || o.type) === JSON.stringify(t.click || t.type)));
      if (t && !known && !(pathOn[prevCp] || []).some(o => o.to === t.to && JSON.stringify(o) === JSON.stringify(t))) (pathOn[prevCp] = pathOn[prevCp] || []).push(t);
    }
    prevCp = cp;
  }
  const transitions = id => [...(S[id].on || []), ...appOn(S[id].app).filter(t => !t.when || t.when.includes(id)), ...(pathOn[id] || [])];
  const toOf = (t, id, typed) => {
    if (t.query) { const q = norm(typed); const k = Object.keys(t.query).sort((a, b) => b.length - a.length).find(k => k && q.includes(norm(k))) ?? ''; return t.query[k] || id; }
    if (t.stream) return ((flow.streams || {})[t.stream] || {}).to || id;
    return t.to || id;
  };
  // Which screens of an app have a control by this name.
  const find = (app, name) => Object.keys(S).filter(k => S[k].app === app && !S[k].fallback).filter(k => { const h = control(screen(k), name); return h && h.score >= 50; });

  // A control by name, scored: exact 100, its start 60, inside it 50, words 30 (packages/ai/find.mjs finds it). Among
  // controls that fit as well (four "Add content to …" buttons), the one the recording clicked here wins.
  const fit = (a0, b0) => {
    const a = norm(a0), b = norm(b0);
    if (a === b) return 100;
    const edge = (x, y) => x.startsWith(y) && !/[a-z0-9-]/.test(x[y.length] || '');
    if (edge(a, b) || edge(b, a) && a.length > 2) return 60;
    if (new RegExp(`(^|[^a-z0-9-])${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9-])`).test(a)) return 50;
    // The same words, said a little differently ("Show more under Get started", "Show more in Get started").
    const A = new Set(a.split(/[^a-z0-9$.%-]+/).filter(w => w.length > 1)), B = b.split(/[^a-z0-9$.%-]+/).filter(w => w.length > 1);
    const both = B.filter(w => A.has(w)).length;
    return B.length >= 2 && both / Math.max(A.size, B.length) >= 0.75 ? 55 : 30;
  };
  function control(sc, name, kind, id) {
    if (!sc || !name) return null;
    const el = findItem(sc.controls, name, kind);
    if (!el) return null;
    const score = fit(el.name, name);
    if (id && S[id]) {
      const clicks = transitions(id).filter(t => t.click);
      if (!clicks.some(t => specMatches(t.click, el, sc))) {
        const rival = sc.controls.find(c => !c.disabled && c !== el && fit(c.name, name) >= Math.min(score, 50) && clicks.some(t => specMatches(t.click, c, sc)) && findItem([c], name, kind));
        if (rival) return { el: rival, score: fit(rival.name, name) };
      }
    }
    return { el, score };
  }
  function follow(id, s, typed = '') {
    const st = S[id];
    if (!st) return { to: id, why: `no screen ${id}` };
    const sc = screen(id), on = transitions(id);
    if (s.kind === 'click' || s.kind === 'hover') {
      const hit = control(sc, s.target, undefined, id);
      let c = hit && hit.score >= (s.strict ? 50 : 30) ? hit.el : null;
      let t = s.kind !== 'click' ? null : c ? on.find(x => x.click && specMatches(x.click, c, sc)) : on.find(x => x.click && norm(specName(x.click)) === norm(s.target));
      // "Click the plugin row": the row the recording clicked here.
      if (s.kind === 'click' && !t && s.role) {
        const re = s.role === 'button' ? /^button\b/ : new RegExp(`role="?${s.role}\\b`);
        const r = on.filter(x => x.click && re.test(x.click.sel || ''));
        if (r.length === 1) { t = r[0]; c = sc.controls.find(x => specMatches(t.click, x, sc)) || c; }
      }
      if (t) return { to: toOf(t, id, typed), control: c || sc.controls.find(x => specMatches(t.click, x, sc)) || null, recorded: specName(t.click), stream: t.stream || null };
      return c ? { to: id, control: c } : { to: id, control: null, why: 'not-here' };
    }
    if (s.kind === 'type') {
      const hit = s.target ? control(sc, s.target, 'field') : null;
      const field = hit ? hit.el : null;
      const ts = on.filter(x => x.type);
      const t = field ? ts.find(x => specMatches(x.type, field, sc)) || (ts.length === 1 ? ts[0] : null) : ts.length === 1 ? ts[0] : null;
      const fieldOf = t ? sc.controls.find(c => specMatches(t.type, c, sc)) : null;
      return { to: t ? t.to || id : id, control: field || fieldOf || null, why: field || fieldOf || !s.target ? null : 'not-here' };
    }
    if (s.kind === 'press') {
      if (s.key === 'Enter') { const t = on.find(x => x.enter); return t ? { to: toOf(t, id, typed), stream: t.stream || null } : { to: id }; }
      if (s.key === 'Escape' && st.esc) return { to: st.esc };
      const k = on.find(x => x.key && x.key === s.key);
      return k ? { to: k.to } : { to: id };
    }
    return { to: id };
  }
  // What the recording did from a screen, as plan steps: each click it knows, and typing what ⌥P types (then Enter
  // where Enter goes somewhere).
  function moves(id) {
    const st = S[id], sc = screen(id), out = [];
    if (!st || !sc) return out;
    const fills = st.fill || [];
    for (const t of transitions(id)) {
      if (t.click) {
        const c = sc.controls.find(x => specMatches(t.click, x, sc));
        const name = c ? c.name : specName(t.click);
        if (name && !t.snap) out.push({ steps: [{ kind: 'click', target: name }], to: toOf(t, id, ''), control: c || null, recorded: specName(t.click) });
      } else if (t.type && t.to) {
        const f = fills.find(f => specMatches(t.type, { name: specName(f), testid: (specParts(f).testid || undefined), frame: f.frame, editable: true })) || fills[0];
        const c = sc.controls.find(x => specMatches(t.type, x, sc));
        const value = f ? f.value : t.text;
        if (value != null) out.push({ steps: [{ kind: 'type', value, target: c ? c.name : specName(t.type) || null }], to: t.to });
      } else if (t.key && t.to) out.push({ steps: [{ kind: 'press', key: t.key }], to: t.to });
    }
    const enter = transitions(id).find(t => t.enter);
    if (enter && enter.query && fills.length) {
      const c = sc.controls.find(x => specMatches(enter.enter, x, sc));
      out.push({ steps: [{ kind: 'type', value: fills[0].value, target: c ? c.name : null }, { kind: 'press', key: 'Enter' }], to: toOf(enter, id, fills[0].value) });
    } else if (enter && !enter.query) out.push({ steps: [{ kind: 'press', key: 'Enter' }], to: toOf(enter, id, '') });
    return out.filter(m => m.to && m.to !== id);
  }
  // The recording's way from a screen to one where goal(screen) holds: its steps, shortest first (up to `max`).
  // avoid(move): a move the way mustn't take (a step that would write, when the plan didn't ask for one).
  function bridge(from, goal, max = 10, avoid = null) {
    const seen = new Set([from]), queue = [{ id: from, steps: [], path: [] }];
    while (queue.length) {
      const n = queue.shift();
      if (n.path.length >= max) continue;
      for (const m of moves(n.id)) {
        if (avoid && avoid(m)) continue;
        if (seen.has(m.to)) continue;
        seen.add(m.to);
        const next = { id: m.to, steps: [...n.steps, ...m.steps.map((s, i) => ({ ...s, lands: i === m.steps.length - 1 ? m.to : null, recorded: m.recorded, control: m.control }))], path: [...n.path, m.to] };
        if (goal(screen(m.to), m.to, m, next)) return next;
        queue.push(next);
      }
    }
    return null;
  }
  // The agreed shape on top: screens as { app, url, sig, title }, steps as { screen, landed, wrote }.
  const view = sig => { const sc = screen(sig); return sc ? { ...sc, sig, url: urlOf(sig) } : null; };
  const urlOf = sig => { const st = S[sig]; if (!st) return null; try { return JSON.parse(readFileSync(join(demo.dir, 'data', 'snaps', (st.snap || sig) + '.json'), 'utf8')).url || null; } catch (e) { return null; } };
  const sigOf = x => typeof x === 'string' ? x : x && (x.sig || x.id);
  const shaped = (from, r) => ({ ...r, screen: { app: (S[r.to] || {}).app, sig: r.to, title: (S[r.to] || {}).title || r.to, url: urlOf(r.to) }, landed: !r.why, wrote: false });
  function step(at, s, typed = '') {
    if (s && s.writes) throw Object.assign(new Error(`a walker doesn't write: "${s.text || s.kind}" ${s.writes}`), { code: 'WRITE' });
    return shaped(sigOf(at), follow(sigOf(at), s, typed));
  }
  const recorded = (at, s, typed = '') => shaped(sigOf(at), follow(sigOf(at), s, typed));
  // The name of the control a recorded matcher picks on a screen (one recorded by its test id has no name of its own).
  const nameOf = (sig, m) => { for (const sc of [screen(sig), shown(sig)]) { const c = sc && sc.controls.find(x => specMatches(m, x, sc)); if (c && c.name) return c.name; } return null; };
  // Words Copilot wrote as the recording ran, which a run gets differently: its answers (what a stream added inside the
  // message it wrote: an article holding new sentences), what it named in words (a heading a stream added, or a
  // button, named in three words or more, a button's without a number: a chat's or a task's title), and the names it
  // made up (weekly-risk-review, a report's file name), wherever they show. What the app shows around an answer (a count, a status, a side panel)
  // isn't Copilot's: a count is a number that can change (landing.mjs), the rest stays.
  let wrote = null;
  const wnorm = t => String(t || '').toLowerCase().replace(/[^a-z0-9$%]+/g, ' ').trim();
  const words = t => wnorm(t).split(' ').filter(Boolean).length;
  const writtenSets = () => {
    if (wrote) return wrote;
    const answers = new Set(), titles = new Set(), names = new Set();
    for (const [name, st] of Object.entries(flow.streams || {})) {
      let first = null;
      try { const f = JSON.parse(readFileSync(join(demo.dir, 'data', 'streams', name + '.json'), 'utf8')).frames[0]; first = readScreen([{ key: 'main', html: readFileSync(join(demo.dir, 'data', 'streams', name, f.file), 'utf8') }]); } catch (e) {}
      const to = first && st.to && screen(st.to);
      if (!to) continue;
      const had = wnorm(first.text), added = to.items.filter(i => wnorm(i.text) && !had.includes(wnorm(i.text)));
      const said = new Set(added.filter(i => i.article !== undefined && words(i.text) >= 4).map(i => i.article));
      for (const i of added) {
        if (i.article !== undefined && said.has(i.article)) answers.add(wnorm(i.text));
        else if ((i.kind === 'control' && words(i.text) >= 3 && !/\d/.test(i.text)) || (i.role === 'heading' && words(i.text) >= 3)) titles.add(wnorm(i.text));
        for (const m of String(i.text).toLowerCase().matchAll(/\b[a-z0-9]+(?:-[a-z0-9]+)+(?:\.(?:md|html|txt|json|csv|docx|xlsx|pptx))?\b/g)) if (m[0].split('-').length >= 3 || m[0].length >= 12) names.add(wnorm(m[0]));
      }
    }
    return (wrote = { answers: [...answers], titles: [...titles], names: [...names] });
  };
  const named = n => { const { names } = writtenSets(); return names.some(x => ` ${n} `.includes(` ${x} `)); };
  const written = t => {
    const n = wnorm(t);
    if (!n) return false;
    const { answers, titles } = writtenSets();
    if (answers.includes(n) || titles.includes(n) || (words(n) >= 4 && answers.some(x => x.includes(n)))) return true;
    return named(n);
  };
  // An item on a screen Copilot wrote: written words, or inside something named by a name it made up (the skill it
  // wrote, shown in a section named weekly-risk-review).
  const writtenItem = (i, sc) => {
    if (written(i.text)) return true;
    for (let r = i.region, k = 0; r !== undefined && r !== null && k < 20; k++) { const [label, up] = (sc.regions || {})[r] || []; if (label === undefined) break; if (named(wnorm(label))) return true; r = up; }
    return false;
  };
  // Words that differ between captures of one screen, which a run can't count on: a greeting that changes on each
  // visit, a title in Recent. A screen's captures: its own and its variants (flow.variants: zoom levels v200-teams,
  // toggles tog-home-collapsed, plugins-more), taken at other moments. Only what changed in place counts (one
  // item for another between items both have), not what one capture adds, and not a number (that's a number that can
  // change). Another screen at the same address isn't a capture of this one: what a step changed (the cart before and
  // after adding a ticket) would count, and those are the words that prove it.
  let shaky = null;
  const snapScreen = snap => {
    const src = rawOf(snap) || builtOf(snap);
    if (!src) return null;
    const k = `snap:${snap}`, key = `${READER}:${src.from}:${statSync(src.from).mtimeMs}`;
    if (saved[k] && saved[k].key === key) return saved[k].screen;
    const sc = readScreen(src.docs());
    saved[k] = { key, screen: sc }; dirty = true;
    return sc;
  };
  const variantOf = v => { const m = /^v\d+-(.+)$/.exec(v) || /^tog-(.+)-[a-z]+$/.exec(v) || /^(.+)-(?:more|open)$/.exec(v); return m && S[m[1]] ? m[1] : null; };
  // Every capture the recording has of a screen: its own, then its variants'.
  const captures = sig => [screen(sig), ...(flow.variants || []).filter(v => variantOf(v) === sig).map(snapScreen)].filter(Boolean);
  const unstableSet = () => {
    if (shaky) return shaky;
    const set = [], pairs = [];
    for (const v of flow.variants || []) {
      const id = variantOf(v);
      if (!id) continue;
      const a = screen(id), b = snapScreen(v);
      if (a && b) pairs.push([a, b, S[id].app]);
    }
    for (const [a, b, app] of pairs) {
      const d = inPlace(a, b);
      if (d) set.push(...d.changed.map(([x, y]) => ({ app, x: x.split(' | '), y: y.split(' | ') })));
    }
    save();
    return (shaky = set);
  };
  // Words one capture of a place in the app shows and the other doesn't: a whole item that changed, or three words or
  // more of one.
  const unstable = (t, app = null) => {
    const n = wnorm(t), long = n.split(' ').length >= 3;
    if (!n) return false;
    const has = side => side.includes(n) || (long && side.some(u => ` ${u} `.includes(` ${n} `)));
    return unstableSet().some(c => (!app || c.app === app) && has(c.x) !== has(c.y));
  };
  // Every text the recording typed (its boxes' values, the path's typing): another step's words, never a proof.
  const typedTexts = () => [...new Set([...Object.values(S).flatMap(st => (st.fill || []).map(f => f.value)), ...recPath.filter(p => p.type && p.text).map(p => p.text)].filter(v => typeof v === 'string' && v.trim()))];
  // Whether a step landed as its plan says, on the screen a walk reached (`at`): the screen its "Lands on" names, and
  // its proof holding there, checked the way a run checks the live page (landing.mjs). → { ok, why }: ok is true or
  // false (a walk counts anything else as a miss); why says what's wrong, or what wasn't checked. A step with nothing
  // to land on passes. Typing the recording didn't capture with these words (the plan's own prompt where another was
  // recorded) passes with a note: the recording can't show it, a run checks it.
  function landed(at, s) {
    const sig = sigOf(at), l = s && s.lands;
    if (!l || (!l.screen && !l.kind)) return { ok: true, why: null };
    if (l.screen && sig !== l.screen) return { ok: false, why: `on ${sig}, not ${l.screen}` };
    const sc = screen(sig);
    if (!sc) return { ok: false, why: `no screen ${sig}` };
    if (!l.kind) return { ok: true, why: 'nothing to check this step by' };
    if (s.kind === 'type' && (s.differs || (l.kind === 'box' && !sc.controls.some(c => isBox(c) && c.value)))) return { ok: true, why: `the recording has other words typed here${s.differs ? `: ${s.differs}` : ''}` };
    return holds(sc, l) ? { ok: true, why: null } : { ok: false, why: `${proofWords(l)} isn't on ${sig}` };
  }
  return { flow, apps, start, screen, captures, view, shown, opened, step, recorded, landed, written, writtenItem, unstable, typedTexts, moves, bridge, control, find, nameOf, save, states: Object.keys(S), streams: flow.streams || {}, path: flow.path || [] };
}
