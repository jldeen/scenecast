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

// Bump when what readScreen() gives changes: screens cached by an older reader are read again.
const READER = 10;

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
  return { flow, apps, start, screen, view, shown, opened, step, recorded, moves, bridge, control, find, nameOf, save, states: Object.keys(S), streams: flow.streams || {}, path: flow.path || [] };
}
