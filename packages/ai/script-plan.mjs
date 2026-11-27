// Copilot reads her talk track with the screens recorded before, and proposes each line's steps and what it points
// at (model.mjs, task "script-plan"). The rules (from-script.mjs) then ground every step on the captured controls
// exactly as they ground Do lines she wrote: a step that isn't on its screen is bridged from the recording or
// flagged, a write is marked, a landing is checked. Without Copilot (not signed in, an error, an answer that doesn't
// fit), the rules alone make the plan.
//
// What's sent: her script (her own words), the apps, and for each recorded screen its title, headings, the names of
// the controls particular to it, and where each recorded step on it leads. A screen's words go only when page text
// is allowed (Settings → Copilot: "Send page text"); everything is redacted as every request is (model.mjs).
import { redact } from './model.mjs';
import { parseStep, formatStep } from './plan.mjs';
import { planFromTrack, promptFor } from './from-script.mjs';

const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const norm = s => clean(s).toLowerCase().replace(/[“”"'’‘]/g, '');
const lineId = (bi, li) => `${bi + 1}.${li + 1}`;

// draft: the rules' plan from her words (planFromTrack), shown line by line with what didn't fit, for Copilot to keep,
// fix and complete.
// How a run checks a step (landing.mjs's flags): not hers to fix, so not for Copilot either.
const PROOF_KINDS = new Set(['landing', 'number', 'message']);
export function scriptPlanInput(track, walker, { pageText = false, draft = null } = {}) {
  const R = s => redact(clean(s));
  const drafted = id => draft ? draft.plan.beats.flatMap(b => b.steps).filter(s => s.line === id).map(s => R(formatStep(s))) : [];
  // What didn't fit her words (how a run checks a step isn't hers to fix: those stay out).
  const issues = id => draft ? draft.flags.filter(f => f.at === id && !PROOF_KINDS.has(f.kind)).map(f => R(f.text).slice(0, 220)) : [];
  const script = {
    title: R(track.title),
    prompts: (track.prompts || []).map(p => ({ n: p.n, ...(p.label ? { label: R(p.label) } : {}), text: R(p.text) })),
    beats: track.beats.map((b, bi) => ({
      n: bi + 1, title: R(b.title), ...(b.time ? { time: b.time } : {}),
      ...(b.do.length ? { do: b.do.map(d => R(d.text)) } : {}), ...(b.screen ? { screen: R(b.screen) } : {}),
      lines: b.lines.map((l, li) => { const id = lineId(bi, li), d = drafted(id), x = issues(id); return { id, say: R(l.say), ...(l.do.length ? { do: l.do.map(R) } : {}), ...(l.screen ? { screen: R(l.screen) } : {}), ...(d.length ? { draft: d } : {}), ...(x.length ? { issues: x } : {}) }; }),
    })),
  };
  if (!walker) return { script, apps: [], screens: [] };
  const states = walker.flow.states || {};
  const answers = new Set(Object.values(walker.flow.streams || {}).map(s => s.to));
  // A control on most of an app's screens is its frame (the sidebar, the top bar): not worth sending each time.
  const seen = {}, count = {}, lines = {};
  const linesOf = sc => [...new Set(String(sc.text || '').split('\n').map(clean).filter(Boolean))];
  for (const id of walker.states) {
    const sc = walker.screen(id), app = (states[id] || {}).app;
    if (!sc || !app) continue;
    count[app] = (count[app] || 0) + 1;
    for (const n of new Set(sc.controls.map(c => c.name).filter(Boolean))) { const k = `${app}|${n}`; seen[k] = (seen[k] || 0) + 1; }
    if (pageText) for (const l of linesOf(sc)) { const k = `${app}|${l}`; lines[k] = (lines[k] || 0) + 1; }
  }
  const often = (app, k, tbl) => (tbl[`${app}|${k}`] || 0) > Math.max(1, (count[app] || 1) * 0.4);
  const screens = walker.states.map(id => {
    const st = states[id] || {}, sc = walker.screen(id) || walker.shown(id);
    if (!sc) return null;
    const moves = walker.moves(id).map(m => `${m.steps.map(s => s.kind === 'type' ? `Type${pageText && s.value ? ` "${R(s.value).slice(0, 120)}"` : ''} in "${R(s.target || 'the field')}"` : R(formatStep(s))).join(', then ')} → ${m.to}${answers.has(m.to) ? ' (an answer comes in)' : ''}`);
    const inMoves = new Set(walker.moves(id).flatMap(m => m.steps.map(s => s.target)));
    const controls = [...new Set(sc.controls.filter(c => c.name && c.name.length <= 90 && !inMoves.has(c.name) && !often(st.app, c.name, seen)).map(c => R(c.name)))].slice(0, 30);
    // Its words, when page text is allowed: the lines particular to it (not the app's frame), as the replica shows them
    // (focus points land there), and those its step lists show when opened. Redacted.
    let words = null, opened = null;
    if (pageText) {
      const shown = walker.shown(id) || sc;
      const mine = linesOf(shown).filter(l => !often(st.app, l, lines));
      words = R(mine.join(' | ')).slice(0, 3000);
      const o = walker.opened(id);
      if (o && o.label) { const had = new Set(mine); opened = { by: R(formatStep({ kind: 'click', target: o.label })), words: R(linesOf(o.screen).filter(l => !had.has(l) && !often(st.app, l, lines)).join(' | ')).slice(0, 2500) }; }
    }
    return { id, app: st.app, title: R(sc.title), headings: (sc.headings || []).slice(0, 10).map(R), ...(controls.length ? { controls } : {}), ...(moves.length ? { moves } : {}), ...(words ? { words } : {}), ...(opened && opened.words ? { opened } : {}) };
  }).filter(Boolean);
  const apps = walker.apps.map(a => ({ id: a.id, title: R(a.title || a.id), starts: walker.start(a.id) }));
  const first = (walker.flow.beats || [])[0];
  // The demo's beats as the replica has them (⌥1–⌥9 and on): the app and screen each one opens.
  const beats = (walker.flow.beats || []).map((b, n) => ({ n, app: b.active, screen: (b.states || {})[b.active] || null })).filter(b => b.app && b.screen);
  return { script, apps, ...(first ? { start: first.active } : {}), ...(beats.length > 1 ? { beats } : {}), screens };
}

// One proposed step, read the way the planner reads her words (from-script.mjs intents). Anything else isn't a step.
function intentOf(text, line, prompts) {
  const t = clean(text), from = line.do.length ? line.do.join('. ') : null;
  let m;
  if (/^fill each (box|field)\b/i.test(t)) return { fillEach: true, from };
  if ((m = /^beat (\d+)\.?$/i.exec(t))) return { beat: +m[1], from };
  if ((m = /^type in ["“](.+?)["”]\.?$/i.exec(t))) return { type: null, into: m[1], from };
  const s = parseStep(t);
  switch (s.kind) {
    case 'app': return { app: s.app, from };
    case 'click': return { click: s.target, from };
    case 'hover': return { hover: s.target, card: true, from };
    case 'type': {
      const p = promptFor(prompts, s.value);
      return p ? { prompt: { n: p.n, label: p.label || '', text: p.text }, from } : { type: s.value, into: s.target || null, from };
    }
    case 'press': return { key: s.key, from };
    case 'wait': return { wait: true, from };
    case 'scroll': return { scroll: s.dir, from };
    case 'manual': return { manual: s.what, from };
    default: return null;
  }
}

// Her track with Copilot's answer on its lines (steps as intents, and points), or null when the answer doesn't fit.
// A line Copilot gave no steps keeps the draft's (draft: the rules' plan).
export function trackFromAnswer(track, answer, draft = null) {
  if (!answer || !Array.isArray(answer.beats)) return null;
  const byId = new Map();
  for (const b of answer.beats) for (const l of (b && Array.isArray(b.lines) ? b.lines : [])) if (l && l.id != null) byId.set(String(l.id), l);
  if (!byId.size) return null;
  const prompts = track.prompts || [];
  return {
    ...track,
    beats: track.beats.map((b, bi) => ({
      ...b,
      lines: b.lines.map((l, li) => {
        const a = byId.get(lineId(bi, li));
        if (!a) return l;
        let steps = Array.isArray(a.steps) ? a.steps : [];
        if (!steps.length && draft) steps = draft.plan.beats.flatMap(b => b.steps).filter(s => s.line === lineId(bi, li)).map(formatStep);
        return { ...l, intents: steps.map(s => intentOf(s, l, prompts)).filter(Boolean), points: (Array.isArray(a.point) ? a.point : []).filter(p => p && (p.text || (Array.isArray(p.texts) && p.texts.length))).slice(0, 3) };
      }),
    })),
  };
}

// The plan from her talk track: Copilot's steps grounded by the rules, or the rules alone. `model` is makeModel()'s.
export async function planWithModel(track, { walker, model = null, packs = null, apps = [], settings = {}, emit = () => {} } = {}) {
  const draft = planFromTrack(track, { walker, apps, packs, open: false });
  const rules = info => ({ ...planFromTrack(track, { walker, apps, packs }), model: info });
  if (!model || !walker) return rules(null);
  const pageText = settings.pageText === true;
  const input = scriptPlanInput(track, walker, { pageText, draft });
  const st = model.stats || { calls: 0, cached: 0 }, before = { calls: st.calls, cached: st.cached };
  emit({ event: 'copilot', step: 'reading', screens: input.screens.length, pageText });
  const t0 = Date.now();
  let answer = null, error = null;
  // Kept by her script and the recording's screens, not by the rules' draft: the same script on the same recording gets
  // the same plan, whatever the rules learned since.
  const keyOf = scriptPlanInput(track, walker, { pageText, draft: null });
  try { answer = await model.ask('script-plan', input, { keyOf }); } catch (e) { error = String((e && e.message) || e).slice(0, 300); }
  const info = { model: model.kind, calls: (model.stats || st).calls - before.calls, cached: (model.stats || st).cached - before.cached, secs: +((Date.now() - t0) / 1000).toFixed(1), sentChars: JSON.stringify(input).length, pageText, ...(error ? { error } : {}) };
  const t2 = trackFromAnswer(track, answer, draft);
  if (!t2) { emit({ event: 'copilot', step: 'rules', why: error || 'no plan in the answer' }); return rules({ ...info, fallback: true }); }
  emit({ event: 'copilot', step: 'grounding', calls: info.calls, cached: info.cached, secs: info.secs });
  return { ...planFromTrack(t2, { walker, apps, packs }), model: info };
}
