// The automatic finish, once the demo is built: everything the presenter would otherwise write by hand, from her talk
// track and the plan.
//   script.md          her script as the guide and Script read it (docs/presenter.md): each beat's Do lines in
//                      presenter keys (⌥ app keys, ⌥P for a prompt, ⌥F for each focus point), her Say lines word for word
//   flow.editor.json   the beat keys: ⌥1–⌥9 start her beats 1–9, on the screens they start on
//   focus.json         a focus point for each Focus the plan has (source "plan"; the editor's and Script's are kept)
//   .out/review/       the one page to look at: the contact sheet, the timings, and what needs her
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePlan, formatStep } from './plan.mjs';
import { aiDir } from './run.mjs';
import { walkerFromDemo, specName } from './walker.mjs';
import { parseTalkTrack } from '@scenecast/script/talk.mjs';
import { cleanTarget } from './from-script.mjs';
import { readFocusJson, readEditorOverrides, writeJsonAtomic, checkFocusJson, FOCUS_JSON, EDITOR_JSON } from '@stuntdouble/core/lib/overrides.mjs';
import { proofWords } from './landing.mjs';

const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
const norm = s => clean(s).toLowerCase().replace(/[“”"'’‘]/g, '');
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28) || 'point';
export const MARK = '<!-- Made by Scenecast from your talk track and the plan. Edit it freely; Make it from my script again replaces it. -->';
// The element around words a Focus names: "the card around …", "the row around …".
const AROUND = { card: 'section,article,[role=group],[role=article],[role=region],[role=dialog]', row: 'li,tr,[role=row],[role=listitem]', list: 'ul,ol,[role=list]', item: 'li,[role=listitem],[role=option]', button: 'button,[role=button],a', pane: 'aside,[role=complementary],[role=region]', section: 'section,[role=region]' };

// Each beat of the plan, where it starts: { active, states } (the screens every app is on when it begins).
export function beatStarts(plan, flow) {
  const b0 = (flow.beats || [])[0];
  if (!b0) return [];
  const cur = { ...b0.states };
  let active = b0.active;
  return plan.beats.map(b => {
    const first = b.steps.find(s => s.kind === 'app');
    const start = { active: first && b.steps.indexOf(first) === 0 ? first.app : active, states: { ...cur } };
    for (const s of b.steps) { if (s.kind === 'app') active = s.app; if (s.lands && s.lands.screen && (flow.states || {})[s.lands.screen]) { cur[flow.states[s.lands.screen].app] = s.lands.screen; active = flow.states[s.lands.screen].app; } }
    return start;
  });
}

// The plan's Focus lines as focus points (packages/player/app/focus.js): the words, the element around them, an arrow,
// a step group to open first, or `via` for a screen one step on.
export function pointsFromPlan(plan, flow) {
  const S = flow.states || {}, out = [], ids = new Set();
  const groups = (flow.groups || []).map(g => (g.template || {}).label).filter(Boolean);
  // The screens a click (by its name) leads to `to` from.
  const fromOf = (to, step) => {
    const hits = [];
    for (const [id, st] of Object.entries(S)) for (const t of [...(st.on || []), ...(((flow.apps || []).find(a => a.id === st.app) || {}).on || []).filter(x => !x.when || x.when.includes(id))]) {
      if (t.click && (t.to === to || ((flow.streams || {})[t.stream] || {}).to === to) && norm(specName(t.click)) && (norm(step.target).includes(norm(specName(t.click))) || norm(specName(t.click)).includes(norm(step.target)))) hits.push(id);
    }
    return [...new Set(hits)];
  };
  plan.beats.forEach((b, bi) => (b.lines || []).forEach((l, li) => (l.focus || []).forEach(f => {
    if (!f.on || !S[f.on] || !(f.texts || []).length) return;
    const p = { beat: Math.min(bi + 1, 9), app: S[f.on].app, states: [f.on] };
    if (f.around && AROUND[f.around]) p.union = f.texts.map(t => ({ text: t, up: AROUND[f.around] }));
    else if (f.texts.length > 1) p.union = f.texts.slice();
    else p.find = f.texts[0];
    if (f.mark === 'arrow') { p.mark = 'arrow'; p.dir = f.dir || 'sw'; }
    if (f.via && f.via.kind === 'click') {
      const g = groups.find(x => norm(f.via.target).startsWith(norm(x)));
      if (g) p.open = [g];
      else { const from = fromOf(f.on, f.via); if (from.length) p.via = { from, to: f.on }; }
    }
    let id = `plan-${bi + 1}-${li + 1}-${slug(f.texts[0])}`, n = 2;
    while (ids.has(id)) id = `plan-${bi + 1}-${li + 1}-${slug(f.texts[0])}-${n++}`;
    ids.add(id);
    out.push({ id, ...p, line: `${bi + 1}.${li + 1}`, label: f.texts.join(' + ').slice(0, 80), source: 'plan' });
  })));
  return out;
}

// A control as her script names it, when that's how the product's name starts ("Work IQ", not the chip's whole label).
function shortName(s) {
  const m = /^(?:hover(?: over| on)?|click|open|select|choose|tap)\s+(.+)$/i.exec(clean(s.script || ''));
  const said = m ? cleanTarget(m[1]) : '';
  return said && norm(s.target).startsWith(norm(said)) ? s.target.slice(0, said.length) : s.target;
}
// A plan step in presenter terms: the keys she presses on the stage.
function presenterStep(s, flow, apps = []) {
  const app = id => ({ ...((flow.apps || []).find(a => a.id === id) || { id }), ...(apps.find(a => a.id === id) || {}) });
  if (s.kind === 'app') { const a = app(s.app); return `Switch to **${a.title || a.id}**${a.key ? ` (**⌥${a.key.toUpperCase()}**)` : ''}`; }
  if (s.kind === 'click') return `Click **${shortName(s)}**`;
  if (s.kind === 'hover') return `Hover over **${shortName(s)}**`;
  if (s.kind === 'type') return `Type \`${s.value.length > 90 ? s.value.slice(0, 87) + '…' : s.value}\` (**⌥P** types it)`;
  if (s.kind === 'press') return s.key === 'Enter' ? 'Press **Enter**' : `Press **${s.key}**`;
  if (s.kind === 'wait') return 'The answer streams in';
  if (s.kind === 'scroll') return `Scroll ${s.dir}`;
  return formatStep(s);
}

// Her script in the guide's format: beats with times, Do (presenter keys, ⌥F points), Say (her words).
export function guideScript(track, plan, flow, { keys = [], apps = [] } = {}) {
  const md = [`# ${track.title || plan.title || 'Demo'}`, '', MARK, ''];
  track.beats.forEach((tb, i) => {
    const b = plan.beats[i] || { steps: [], lines: [] };
    md.push(`## ${i + 1}. ${tb.title}${tb.time ? ` · ${tb.time}` : ''}`, '');
    const screen = tb.screen || '';
    if (screen || keys[i]) md.push(`*Screen:* ${screen || 'where the beat starts'}${keys[i] ? ` (**${keys[i]}**)` : ''}`, '');
    const steps = b.steps.map(s => presenterStep(s, flow, apps));
    const focus = (b.lines || []).flatMap(l => (l.focus || []).filter(f => f.on).map(f => `**⌥F**: ${f.texts.join(', ')}`));
    if (steps.length || focus.length) { md.push('**Do**', ''); for (const s of [...steps, ...focus]) md.push(`- ${s}`); md.push(''); }
    if (tb.stage.length) { md.push('**Watch**', ''); for (const s of tb.stage) md.push(`- ${s}`); md.push(''); }
    md.push('**Say**', '');
    tb.lines.forEach((l, k) => { md.push(`> ${l.say}`); if (k < tb.lines.length - 1) md.push('>'); });
    md.push('');
  });
  return md.join('\n');
}

// ---- the one-page review -----------------------------------------------------------------------------------------
const readJson = f => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch (e) { return null; } };
// Steps the plan took from her own recording that aren't writes (a search the recording made before a click): for
// information, not for her to do.
const INFO = new Set(['restored']);
export const addedFromRecording = planReview => ((planReview && planReview.flags) || []).filter(f => INFO.has(f.kind)).map(f => ({ where: f.line ? `line ${f.line}` : f.beat ? `beat ${f.beat}` : '', text: f.text }));
// What the capture sets off camera just before a step, because her script says it's already so (reset.md's Set
// before): for information, in place of a step to add.
export const setOffCamera = reset => ((reset && reset.before) || []).flatMap(b => b.items.map(i => ({
  where: `beat ${b.beat}`,
  text: `${i.kind === 'choice' ? `Picks "${i.value}" (${i.subject})` : `Switches "${i.subject}" ${i.value}`} in ${reset.appTitle ? reset.appTitle(i.app) : i.app}, just before ${b.text}${b.n ? ` (step ${b.n})` : ''}`,
})));
export function needsYou({ planReview, reset, plan, fidelity, points }) {
  const out = [];
  const KIND = { added: 'Added from the recording', order: 'Not where your script says', landing: "A run can't check this step", number: 'A number that can change', message: 'Words in a message' };
  for (const f of ((planReview && planReview.flags) || []).filter(f => !INFO.has(f.kind))) out.push({ kind: KIND[f.kind] || 'Differs from your script', where: f.line ? `line ${f.line}` : f.beat ? `beat ${f.beat}` : '', text: f.text });
  for (const n of (reset && reset.needs) || []) out.push({ kind: n.kind === 'start' ? 'A step is missing' : 'Reset', where: `beat ${n.beat}`, text: n.text });
  plan.beats.forEach((b, bi) => (b.lines || []).forEach((l, li) => { if (!(l.focus || []).some(f => f.on)) out.push({ kind: 'No focus point', where: `line ${bi + 1}.${li + 1}`, text: `Nothing on its screens backs “${l.text.slice(0, 80)}${l.text.length > 80 ? '…' : ''}”. Add one in the editor if it needs one.` }); }));
  for (const i of ((fidelity && fidelity.items) || []).filter(i => i.status === 'fail' || i.status === 'manual')) out.push({ kind: i.status === 'fail' ? 'Check failed' : 'Look yourself', where: '', text: `${i.title}: ${(i.detail || '').split('\n')[0]}` });
  if (points && !points.length) out.push({ kind: 'No focus point', where: '', text: 'The plan has no focus points yet: build the demo, then finish again.' });
  return out;
}
export function reviewHtml({ title, beats, timings, needs, added = [], offCamera = [], stats }) {
  const card = s => `<figure><div class="img">${s.img ? `<img loading="lazy" src="${esc(s.img)}" alt="">` : '<span>No picture</span>'}</div><figcaption><b>${esc(s.step)}</b>${s.words ? `<span>${esc(s.words)}</span>` : ''}</figcaption></figure>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}: review</title><style>
body{margin:0;padding:24px 28px;font:14px/1.45 -apple-system,"Segoe UI",system-ui,sans-serif;color:#1b1b1b;background:#fff}
h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;text-transform:uppercase;letter-spacing:.05em;margin:26px 0 8px;border-bottom:2px solid #1b1b1b;padding-bottom:5px}
.sum{color:#444;margin-bottom:6px}.sum b{color:#1b1b1b}.needs{list-style:none;padding:0;margin:0}.needs li{padding:7px 0;border-top:1px solid #e3e5e8}.needs .k{display:inline-block;min-width:190px;font-weight:600}.needs .w{color:#666;margin-right:8px}
.ok{color:#0b6b2f;font-weight:600}.beat{margin:14px 0 4px;font-weight:700}.sheet{display:flex;flex-wrap:wrap;gap:10px}figure{margin:0;width:236px}.img{width:236px;height:133px;border:1px solid #cfd3d8;background:#f4f5f7;display:flex;align-items:center;justify-content:center;overflow:hidden}.img img{width:100%;height:100%;object-fit:cover;object-position:top}
figcaption{font-size:12px;margin-top:4px}figcaption span{display:block;color:#666}table{border-collapse:collapse}td,th{padding:4px 12px 4px 0;text-align:left;border-bottom:1px solid #eee;font-variant-numeric:tabular-nums}</style></head><body>
<h1>${esc(title)}</h1><div class="sum">${stats.map(([k, v]) => `<b>${esc(v)}</b> ${esc(k)}`).join(' · ')}</div>
<h2>Needs you</h2>${needs.length ? `<ul class="needs">${needs.map(n => `<li><span class="k">${esc(n.kind)}</span><span class="w">${esc(n.where)}</span>${esc(n.text)}</li>`).join('')}</ul>` : '<p class="ok">Nothing. It\u2019s ready to present.</p>'}
${added.length ? `<h2>Added from your recording</h2><p class="sum">Steps your script leaves out, done as you recorded them. Nothing to do.</p><ul class="needs">${added.map(a => `<li><span class="w">${esc(a.where)}</span>${esc(a.text)}</li>`).join('')}</ul>` : ''}
${offCamera.length ? `<h2>Set off camera</h2><p class="sum">Your script has these already set when you get there. The capture sets each one off camera, just before that step, and the cleanup puts it back. Nothing to do.</p><ul class="needs">${offCamera.map(a => `<li><span class="w">${esc(a.where)}</span>${esc(a.text)}</li>`).join('')}</ul>` : ''}
<h2>Timings</h2><table>${timings.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>
<h2>Every screen</h2>${beats.map(b => `<div class="beat">Beat ${b.n} · ${esc(b.title)}</div><div class="sheet">${b.shots.map(card).join('')}</div>`).join('')}
</body></html>`;
}

// How long each beat's lines take to say, at a steady stage pace, against the time her script gives the beat
// ("~40s", "~1m15s", "0:45–1:30", "2 min").
const WPM = 150;
export function slotSecs(t) {
  const s = String(t || '');
  let m;
  if ((m = /(\d+):(\d{2})\s*[–—-]\s*(\d+):(\d{2})/.exec(s))) return (+m[3] * 60 + +m[4]) - (+m[1] * 60 + +m[2]);
  const min = /(\d+(?:\.\d+)?)\s*(?:m(?![a-z])|mins?\b|minutes?\b)/i.exec(s), sec = /(\d+)\s*(?:s(?![a-z])|secs?\b|seconds?\b)/i.exec(s);
  if (min || sec) return Math.round((min ? +min[1] * 60 : 0) + (sec ? +sec[1] : 0));
  if ((m = /^~?\s*(\d+):(\d{2})$/.exec(s.trim()))) return +m[1] * 60 + +m[2];
  return null;
}
export function beatTimings(plan, slots = []) {
  const rows = plan.beats.map((b, i) => {
    const said = Math.round((b.lines || []).reduce((n, l) => n + String(l.text || '').split(/\s+/).filter(Boolean).length, 0) / WPM * 60);
    const slot = slotSecs(slots[i]);
    return [`Beat ${i + 1} · ${b.title}`, `about ${said} s to say${slot ? `, in ${slot} s${said > slot * 1.2 ? ' (long)' : ''}` : ''}`, said, slot];
  });
  const said = rows.reduce((n, r) => n + r[2], 0), slot = rows.every(r => r[3]) ? rows.reduce((n, r) => n + r[3], 0) : null;
  const mins = x => `${Math.floor(x / 60)}:${String(x % 60).padStart(2, '0')}`;
  return [...rows.map(r => [r[0], r[1]]), ['All of it', `about ${mins(said)} to say${slot ? `, in ${mins(slot)}` : ''}`]];
}

// The review, with each screen's picture (the capture's own screenshot) copied next to it.
export function writeReview(demo, { plan, planReview, reset, flow, slots = [], out = join(demo.out, 'review') }) {
  mkdirSync(join(out, 'shots'), { recursive: true });
  const S = flow ? flow.states || {} : {};
  const shotOf = id => {
    const snap = (S[id] || {}).snap || id;
    for (const f of [join(demo.raw || '', 'shots', snap + '.png'), join(demo.dir, 'presenter', 'shots', snap + '.png')]) if (existsSync(f)) { copyFileSync(f, join(out, 'shots', snap + '.png')); return `shots/${snap}.png`; }
    return null;
  };
  // Under each step, what a run checks it by (plan-format.md, "What proves a step").
  const beats = plan.beats.map((b, i) => ({ n: i + 1, title: b.title, shots: b.steps.filter(s => s.lands && s.lands.screen).map(s => ({ step: formatStep(s), words: s.lands.kind ? `Checks ${proofWords(s.lands)}` : 'Nothing a run can check', img: shotOf(s.lands.screen) })) }));
  const fidelity = readJson(join(demo.out, 'fidelity.json')), bench = readJson(join(demo.out, 'bench.json'));
  const rec = readJson(join(demo.dir, 'recording.json')) || readJson(join(demo.raw || '', 'recording.json'));
  const timings = [];
  if (planReview) timings.push(['Plan', `${planReview.steps} steps from ${planReview.from}, checked against ${planReview.checked} captured screens`]);
  const cm = planReview && planReview.model;
  if (cm && !cm.fallback) timings.push(['Copilot', cm.calls ? `${cm.calls} question${cm.calls === 1 ? '' : 's'}, ${cm.secs} s` : 'the answer from last time (nothing asked)']);
  else if (cm && cm.fallback) timings.push(['Copilot', `not used (${cm.error ? 'it couldn\u2019t answer' : 'its answer didn\u2019t fit'}): the plan is from your Do lines`]);
  if (rec && rec.timing) timings.push(['Recording', `${Math.round(rec.timing.totalSecs || rec.timing.secs || 0)} s (the product ${Math.round(rec.timing.productSecs || 0)} s, the recorder ${Math.round(rec.timing.recorderSecs || 0)} s)`]);
  if (bench) for (const p of bench.phases || []) timings.push([`Unattended: ${p.name}`, `${p.secs} s${p.ok ? '' : ' (failed)'}`]);
  if (fidelity) timings.push(['Checks', `${fidelity.secs} s · ${fidelity.items.filter(i => i.status === 'pass').length} of ${fidelity.items.length} pass`]);
  timings.push(...beatTimings(plan, slots));
  const points = (readFocusJson(demo.dir).points || []).filter(p => p.source === 'plan');
  const needs = needsYou({ planReview, reset, plan, fidelity, points }), added = addedFromRecording(planReview), offCamera = setOffCamera(reset);
  const writes = plan.beats.flatMap(b => b.steps).filter(s => s.writes).length;
  const html = reviewHtml({ title: `${demo.cfg.title || plan.title}: review`, beats, timings, needs, added, offCamera, stats: [['beats', plan.beats.length], ['screens', beats.reduce((n, b) => n + b.shots.length, 0)], ['writes', writes], ['focus points', points.length], ['things for you', needs.length]] });
  writeFileSync(join(out, 'index.html'), html);
  return { file: join(out, 'index.html'), needs, added, offCamera };
}

export async function finish({ demo, packs, emit = () => {} }) {
  const planFile = join(demo.dir, 'plan.md');
  if (!existsSync(planFile)) throw new Error('make the plan first');
  const plan = parsePlan(readFileSync(planFile, 'utf8'));
  const walker = walkerFromDemo(demo);
  if (!walker) throw new Error('build the demo first: the finish needs its screens');
  const flow = walker.flow;
  const planReview = readJson(join(aiDir(demo), 'plan-review.json'));
  const result = { script: null, beats: 0, points: 0 };
  let slots = [];
  // Her script for the guide: from her talk track (source.md, kept when the plan was made), unless she wrote her own.
  const src = join(demo.dir, 'source.md');
  if (existsSync(src)) {
    const text = readFileSync(src, 'utf8'), name = (/^<!-- From: (.+?) -->/.exec(text) || [, 'source.md'])[1];
    const track = parseTalkTrack(text.replace(/^<!-- From: .+? -->\s*/, ''), name.replace(/\.docx$/i, '.md'));
    slots = plan.beats.map((b, i) => (track.beats.find(tb => norm(tb.title) === norm(b.title)) || track.beats[i] || {}).time);
    const starts = beatStarts(plan, flow);
    // The beat keys: ⌥n starts her beat n where it starts (flow.editor.json; edits and other beats kept).
    const ed = readEditorOverrides(demo.dir);
    starts.slice(0, 9).forEach((st, i) => { ed.beats[String(i + 1)] = { active: st.active, states: st.states }; });
    writeJsonAtomic(join(demo.dir, EDITOR_JSON), { version: 1, ...ed });
    result.beats = Math.min(9, starts.length);
    const keys = starts.map((st, i) => i < 9 ? `⌥${i + 1}` : null);
    const sf = join(demo.dir, 'script.md');
    if (!existsSync(sf) || readFileSync(sf, 'utf8').includes(MARK)) { writeFileSync(sf, guideScript(track, plan, flow, { keys, apps: walker.apps })); result.script = 'script.md'; }
    emit({ event: 'finish', step: 'script', beats: result.beats });
  }
  // Focus points from the plan's Focus lines (the editor's and Script's own points are kept).
  const points = pointsFromPlan(plan, flow);
  const kept = readFocusJson(demo.dir).points.filter(p => p.source !== 'plan');
  const value = { version: 1, ...readFocusJson(demo.dir), points: [...kept, ...points] };
  const bad = checkFocusJson(value);
  if (bad.length) throw new Error(`focus points: ${bad.slice(0, 3).join('; ')}`);
  writeJsonAtomic(join(demo.dir, FOCUS_JSON), value);
  result.points = points.length;
  emit({ event: 'finish', step: 'focus', points: points.length });
  const { resetFor } = await import('./reset.mjs');
  const { loadPacks } = await import('./make.mjs');
  const reset = existsSync(join(demo.dir, 'reset.md')) ? resetFor(plan, { walker, packs: packs === undefined ? await loadPacks(demo) : packs }) : null;
  const r = writeReview(demo, { plan, planReview, reset, flow, slots });
  emit({ event: 'finish', step: 'review', needs: r.needs.length });
  return { ...result, review: r.file, needs: r.needs.length };
}
