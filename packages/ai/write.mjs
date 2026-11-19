// The talk track from what actually happened (Record for me, I'll click you script it, Coach me): the recording's
// steps grouped into beats (a new beat when the demo moves to another app or an answer streams in, or the plan's beats
// after Record for me), each with what was done and what its last screen showed; the model writes the beats' titles,
// what to do and the lines to say, using the screens' own words, and it's saved as the demo's script.md. The usual
// Script step then puts each line on its screen, makes the focus points and the presenter guide.
import { existsSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { aiDir, screenOf, nameOfSpec } from './run.mjs';
import { readGoal, readPlan } from './draft.mjs';

// Sentences, line by line (a line without a full stop is a label or a menu, not a sentence).
const sentencesOf = t => String(t || '').split('\n').flatMap(l => l.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+/g) || []).map(s => s.trim()).filter(s => s.split(' ').length >= 3);
// The words that appeared between two screens: an answer that streamed in, a pane that opened.
function newWords(before, after) {
  const had = new Set(sentencesOf(before && before.text));
  return sentencesOf(after && after.text).filter(s => !had.has(s)).join(' ').slice(0, 1500);
}

function actionOf(p) {
  if (p.type) return `Type "${p.text || ''}" in "${nameOfSpec(p.type)}"`;
  if (p.enter) return 'Press Enter';
  if (p.click) return `Click "${nameOfSpec(p.click)}"`;
  if (p.key) return `Press ${p.key}`;
  if (p.clear) return `Clear "${nameOfSpec(p.clear)}"`;
  return null;
}

// The beats, as the replica has them (the recorder starts one at the start, when the demo moves to another app, and
// when an answer has streamed in): script beat n is the replica's beat n (⌥n), so each line's focus point is on a
// beat the presenter guide has. Each beat: how it starts (its landing screen, and the answer that streamed in), then
// what was done on it and what each step showed.
export function beatsFromRecording(demo, rec) {
  const streamEnds = new Set(Object.values(rec.streams || {}).map(s => s.to));
  const first = (rec.path || [])[0];
  let active = first && first.app || (rec.apps || [])[0] && rec.apps[0].id;
  const states = Object.fromEntries((rec.apps || []).map(a => [a.id, a.start || `${a.id}-start`]));
  const beats = [];
  let last = '';
  const push = (how, from = null) => {
    const key = active + JSON.stringify(states);
    if (key === last) return false;
    last = key;
    beats.push({ app: active, how, landing: states[active], from, actions: [], steps: [], end: states[active] });
    return true;
  };
  push('start');
  for (const p of rec.path || []) {
    if (p.app) {
      if (p.app === active && beats.length === 1 && !beats[0].actions.length) { states[p.app] = p.checkpoint; beats[0].landing = beats[0].end = p.checkpoint; continue; }
      active = p.app; states[active] = p.checkpoint;
      if (push('switch')) beats[beats.length - 1].actions.push(`Go to ${active}`);
      continue;
    }
    const b = beats[beats.length - 1];
    const a = actionOf(p, rec);
    if (a) { b.actions.push(a); b.steps.push({ action: a, state: p.checkpoint }); }
    const before = states[active];
    states[active] = p.checkpoint; b.end = p.checkpoint;
    if (streamEnds.has(p.checkpoint)) push('answer', before);
  }
  return beats;
}

export async function writeScript({ demo, model, settings = {}, emit = () => {} }) {
  const recFile = join(demo.raw, 'recording.json');
  if (!existsSync(recFile)) throw new Error('record the demo first');
  const rec = JSON.parse(readFileSync(recFile, 'utf8'));
  const raw = beatsFromRecording(demo, rec);
  const goal = readGoal(demo).goal || '';
  const plan = readPlan(demo);
  const runFile = join(aiDir(demo), 'run.json');
  const ran = existsSync(runFile) && statSync(runFile).mtimeMs >= statSync(recFile).mtimeMs - 5000;
  const words = sc => ({ headings: sc.headings, dialog: sc.dialog, ...(settings.pageText !== false ? { text: String(sc.text || '').slice(0, 1500) } : {}) });
  const beats = raw.map(b => {
    const land = screenOf(demo, rec, b.landing) || {};
    const starts = { how: b.how, title: land.title, ...words(land) };
    if (b.how === 'answer' && b.from) starts.answer = newWords(screenOf(demo, rec, b.from), land);
    let prev = land;
    const then = b.steps.map(st => { const sc = screenOf(demo, rec, st.state) || {}; const out = { after: st.action, headings: sc.headings, dialog: sc.dialog, new: newWords(prev, sc).slice(0, 600) }; prev = sc; return out; });
    return { app: b.app, actions: b.actions, starts, then };
  });
  emit({ event: 'writing', beats: beats.length });
  const r = await model.ask('script', { title: (plan && plan.title) || demo.cfg.title || '', goal, plan: plan && ran ? plan.beats.map(b => ({ title: b.title, say: b.say })) : undefined, beats });
  // One script beat per replica beat, in order: a beat the model left out keeps its place, with what was done.
  const out = { title: r.title, beats: beats.map((b, i) => (r.beats || [])[i] || { title: `Beat ${i + 1}`, do: b.actions.join(', '), lines: [] }) };
  const md = scriptMarkdown(out, demo);
  for (const f of ['script.txt', 'script.sk']) rmSync(join(demo.dir, f), { force: true });
  writeFileSync(join(demo.dir, 'script.md'), md);
  const lines = out.beats.reduce((n, b) => n + (b.lines || []).length, 0);
  emit({ event: 'script', beats: out.beats.length, lines });
  return { file: join(demo.dir, 'script.md'), beats: out.beats.length, lines, text: md };
}

export function scriptMarkdown(r, demo) {
  const out = [`# ${r.title || demo.cfg.title || 'Demo'}`, '', '<!-- Written by Scenecast from the recording. Edit it freely: > lines are what you say, Do is what you click. -->', ''];
  (r.beats || []).forEach((b, i) => {
    out.push(`## Beat ${i + 1} · ${String(b.title || `Beat ${i + 1}`).replace(/\s+/g, ' ').trim()}`, '');
    if (b.do) out.push(`**Do:** ${String(b.do).replace(/\s+/g, ' ').trim()}`, '');
    for (const l of b.lines || []) if (String(l).trim()) out.push(`> ${String(l).replace(/\s+/g, ' ').trim()}`, '');
  });
  return out.join('\n');
}
