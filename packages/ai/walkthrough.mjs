// A walkthrough (recording.json from clicking through once) as the same plan a script makes: each recorded step in
// plain words, the screen it reached, what it wrote, beats where the demo moves to another app or an answer comes in.
// With the presenter's script, its lines go on the beats (beat by beat when the counts match).
import { formatStep } from './plan.mjs';
import { specName } from './walker.mjs';
import { writeOf, packWrite } from './from-script.mjs';

const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;

export function planFromRecording(rec, { walker = null, title = '', track = null, packs = null } = {}) {
  const flow = walker ? walker.flow : null;
  const S = (flow && flow.states) || rec.states || {};
  const streamEnds = new Set(Object.values((flow && flow.streams) || rec.streams || {}).map(s => s.to));
  const appTitle = id => ((walker ? walker.apps : rec.apps || []).find(a => a.id === id) || {}).title || id;
  const plan = { title: title || (track && track.title) || rec.title || 'Demo', beats: [] };
  let beat = null, app = null, typed = '', field = null, prompts = 0;
  const cur = {};
  const startBeat = t => { beat = { title: t, steps: [], say: [], lines: [] }; plan.beats.push(beat); };
  const appOf = id => (S[id] || {}).app;
  for (const p of rec.path || []) {
    const to = p.checkpoint || null;
    const before = app ? cur[app] : null;
    let step = null;
    if (p.app || (to && !app)) {
      const a = p.app || appOf(to);
      if (a && a !== app) { app = a; startBeat(cap(appTitle(a))); step = { kind: 'app', app: a }; }
    } else if (p.click) step = { kind: 'click', target: specName(p.click) || (walker && before ? walker.nameOf(before, p.click) : null) || clean(p.click.sel) };
    else if (p.type) { typed = p.text || ''; field = specName(p.type) || null; step = { kind: 'type', value: typed, target: field }; }
    else if (p.enter) step = { kind: 'press', key: 'Enter' };
    else if (p.key) step = { kind: 'press', key: p.key };
    if (to && app) cur[app] = to;
    if (!step) continue;
    if (!beat) startBeat(cap(appTitle(app)));
    // What the step wrote: the same rules as a script's plan, on the screens the recording reached.
    const sc = walker && before ? walker.screen(before) : null;
    const el = step.kind === 'click' && sc ? (walker.control(sc, step.target) || {}).el : step.kind === 'press' && sc ? sc.controls.find(c => c.editable && c.multiline && (!field || c.name === field)) || null : null;
    // A prompt is what's sent from a message box: the review's text boxes and a search box aren't prompts.
    if (step.kind === 'press' && step.key === 'Enter' && typed && el && el.multiline) prompts++;
    let w = writeOf(step, el, { next: to && to !== before ? S[to] : null, nextScreen: walker && to && to !== before ? walker.screen(to) : null, prompt: step.kind === 'press' && typed ? { n: prompts, label: '', text: typed } : null, appTitle: appTitle(app) });
    const pack = ((packs || {}).forApp || {})[app];
    const pw = pack && packs.writeFor ? packWrite(packs.writeFor, pack, step, el, el) : null;
    const safe = !pw && pack && packs.writeFor && (pack.safe || []).length ? packWrite(packs.writeFor, { ...pack, writes: pack.safe }, step, el, el) : null;
    if (safe) { step.safe = `${safe.what.replace(/\.$/, '')} · ${pack.id}:${safe.id}`; w = null; }
    if (w || pw) step.writes = `${w ? w.what : pw.what.split(/[;:(]/)[0].trim()}${pw ? ` · ${pack.id}:${pw.id}` : ''}`;
    if (to && to !== before && step.kind !== 'app') step.lands = { screen: to, text: walker ? landWords(walker, before, to) : null };
    if (step.kind === 'app' && to) step.lands = { screen: to, text: walker ? landWords(walker, null, to) : null };
    step.text = formatStep(step);
    beat.steps.push(step);
    // An answer came in: the next steps are a new beat, as the replica's beats are.
    if (step.kind === 'press' && step.key === 'Enter' && to && streamEnds.has(to)) { beat.steps.push({ kind: 'wait', text: 'Wait for the answer' }); startBeat(`${cap(appTitle(app))}: the answer`); typed = ''; }
  }
  plan.beats = plan.beats.filter(b => b.steps.length);
  // Her lines, beat by beat, when the script has as many beats.
  if (track && track.beats.length === plan.beats.length) track.beats.forEach((tb, i) => { plan.beats[i].title = tb.title || plan.beats[i].title; for (const l of tb.lines) { plan.beats[i].say.push(l.say); plan.beats[i].lines.push({ text: l.say, focus: [] }); } });
  return plan;
}

function landWords(walker, from, to) {
  const a = from ? walker.screen(from) : null, b = walker.screen(to);
  if (!b) return null;
  const had = new Set(a ? [...a.headings, ...a.items.map(i => i.text)] : []);
  const h = b.headings.find(x => !had.has(x) && x.split(' ').length >= 2 && x.length < 70) || (a ? null : b.headings[0]);
  return h || (b.items.find(i => !had.has(i.text) && i.text.split(' ').length >= 2 && i.text.length < 70) || {}).text || null;
}
