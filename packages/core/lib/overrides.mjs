// The two files the script matcher and the editor write in a demo folder (people adjust them in the replica; by hand
// is fine too):
//   focus.json         { version: 1, script, points: [focus point…] }   points from `scenecast script` (source: 'script'),
//                      the editor's dots (source: 'dot') and script points moved in the editor (source: 'edited')
//   flow.editor.json   { version: 1, edits: [{ replace: [a, b] }…], beats: { "<n>": { active, states: { app: state }, label? } } }
//                      (a beat with a label is one of the show's own beats, as the plan the take ran names them)
// Both are read by the flow compiler (compile/flow.mjs) after flow.overrides.mjs, and served live (no build).
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const FOCUS_JSON = 'focus.json';
export const EDITOR_JSON = 'flow.editor.json';
const read = f => { if (!existsSync(f)) return null; const v = JSON.parse(readFileSync(f, 'utf8')); if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${f}: not a JSON object`); return v; };
// Written to a temporary file first, so a crash never leaves half a file.
export function writeJsonAtomic(file, value) {
  const tmp = file + '.tmp-' + process.pid;
  writeFileSync(tmp, JSON.stringify(value, null, 1) + '\n');
  renameSync(tmp, file);
}

export function readFocusJson(dir) {
  const v = read(join(dir, FOCUS_JSON)) || {};
  return { version: 1, ...v, points: Array.isArray(v.points) ? v.points : [] };
}
export function readEditorOverrides(dir) {
  const v = read(join(dir, EDITOR_JSON)) || {};
  return { version: 1, edits: Array.isArray(v.edits) ? v.edits : [], beats: v.beats && typeof v.beats === 'object' ? v.beats : {} };
}

const str = (v, max = 4000) => typeof v === 'string' && v.length > 0 && v.length <= max;
const MATCHER_KEYS = new Set(['sel', 'text', 'up', 'in', 'frame', 'nth', 'label', 'testid']);
// What the editor may write: checked before it reaches the demo folder (the server takes it from the page).
export function checkFocusJson(v) {
  const bad = [];
  if (!v || typeof v !== 'object' || !Array.isArray(v.points)) return ['focus.json needs points: […]'];
  const ids = new Set();
  for (const p of v.points) {
    const w = `point ${p && p.id}`;
    if (!p || typeof p !== 'object') { bad.push('a point that is not an object'); continue; }
    if (!str(p.id, 96) || !/^[A-Za-z0-9][\w.-]*$/.test(p.id) || ids.has(p.id)) bad.push(`${w}: needs an id of its own (letters, digits, - _ .)`);
    ids.add(p.id);
    if (!Number.isInteger(p.beat) || p.beat < 0 || p.beat > 9) bad.push(`${w}: beat 0–9`);
    if (!str(p.app, 120)) bad.push(`${w}: app`);
    if (!Array.isArray(p.states) || !p.states.length || !p.states.every(s => str(s, 200))) bad.push(`${w}: states`);
    if (!(str(p.find) || (Array.isArray(p.union) && p.union.length && p.union.every(u => str(u) || (u && typeof u === 'object' && Object.keys(u).every(k => MATCHER_KEYS.has(k))))))) bad.push(`${w}: find or union`);
    if (p.mark !== undefined && !['rect', 'arrow', 'box', 'zoom'].includes(p.mark)) bad.push(`${w}: mark`);
    if (p.dir !== undefined && !['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].includes(p.dir)) bad.push(`${w}: dir`);
    if (p.via !== undefined && !(p.via && Array.isArray(p.via.from) && p.via.from.length && p.via.from.every(s => str(s, 200)) && str(p.via.to, 200))) bad.push(`${w}: via is { from: [states], to: state }`);
  }
  return bad;
}
export function checkEditorOverrides(v) {
  const bad = [];
  if (!v || typeof v !== 'object') return ['flow.editor.json: not an object'];
  for (const e of v.edits || []) if (!e || !Array.isArray(e.replace) || e.replace.length !== 2 || !str(e.replace[0], 2000) || typeof e.replace[1] !== 'string' || e.replace[1].length > 2000) bad.push(`edit ${JSON.stringify(e).slice(0, 80)}: { replace: [old, new] }`);
  for (const [n, b] of Object.entries(v.beats || {})) {
    if (!/^[1-9]$/.test(n)) bad.push(`beat ${n}: 1–9`);
    if (!b || !str(b.active, 120) || !b.states || typeof b.states !== 'object' || !Object.values(b.states).every(s => str(s, 200))) bad.push(`beat ${n}: { active, states }`);
  }
  return bad;
}

// The editor's edits go after the flow's own; its beat starts replace a beat's screens (a new beat after the last
// takes the last beat's other screens). Named beats (the plan's) are the show's beats: the recording's after the last
// of them go, so ⌥n never jumps to a screen the show doesn't have as a beat.
export function applyEditorOverrides(flow, o) {
  if (o.edits.length) flow.edits = [...(flow.edits || []), ...o.edits.map(e => ({ replace: [e.replace[0], e.replace[1]] }))];
  let last = 0, named = false;
  for (const [n, b] of Object.entries(o.beats).sort((a, b) => +a[0] - +b[0])) {
    const k = +n, beats = flow.beats || (flow.beats = []);
    if (k > beats.length) continue;
    const prev = beats[k] || { label: `${k} ${b.active}`, states: { ...(beats[k - 1] || beats[0] || { states: {} }).states } };
    beats[k] = { ...prev, active: b.active, states: { ...prev.states, ...b.states }, ...(b.label ? { label: `${k} ${b.label}` } : {}) };
    last = k; named = named || !!b.label;
  }
  if (named && flow.beats.length > last + 1) flow.beats.length = last + 1;
  return flow;
}
