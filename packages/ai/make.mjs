// Make it from my script: the presenter's talk track (Word, Markdown, RunLines or plain Do and Say lines) or one
// walkthrough, made into the plan Record for me and the capture pass run; her one approval; the reset from the plan's
// writes; and the finish (her script for the guide, the beat keys, focus points, the one-page review).
//   planFromScript({ demo, file })        plan.md, .out/ai/plan-review.json (what differs, what was added), source.md
//   planFromWalkthrough({ demo, file })   the same from a recording.json
//   approve(demo) / approval(demo)        the approval, tied to plan.md's exact text (sha256): an edit needs a new one
//   writeReset(demo)                      reset.md from the plan's writes
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parsePlan, formatPlan, formatStep, writesOf, stepCount } from './plan.mjs';
import { walkerFromDemo } from './walker.mjs';
import { planFromTrack } from './from-script.mjs';
import { planFromRecording } from './walkthrough.mjs';
import { resetFor, formatReset, parseReset, leaveOutSection } from './reset.mjs';
import { fallbackSteps, undoGroups } from './reset-run.mjs';
import { checkable, checkValues } from './check-lines.mjs';
import { readTalkTrack, talkTrackText } from '@scenecast/script/talk.mjs';
import { aiDir } from './run.mjs';

export const PLAN = 'plan.md', RESET = 'reset.md';
const sha = t => createHash('sha256').update(String(t)).digest('hex');

// The app packs (@stuntdouble/apps): each app's names, writes and their undos. Optional: without them, plain rules.
export async function loadPacks(demo) {
  try {
    const m = await import('@stuntdouble/apps/index.mjs');
    return { forApp: m.packsForDemo(demo.cfg), writeFor: m.writeFor, safeFor: m.safeFor || null };
  } catch (e) { return null; }
}

// A new plan, a new reset.md: the last one's undo and checks are the last plan's (its screens, its writes), so a run's
// start check would stop on them, or its reset would undo the wrong things. Her Leave out stays as she wrote it.
export async function resetFollows(demo, packs) {
  if (existsSync(join(demo.dir, RESET))) await writeReset(demo, { packs });
}

function save(demo, plan, review) {
  const text = formatPlan(plan);
  writeFileSync(join(demo.dir, PLAN), text);
  mkdirSync(aiDir(demo), { recursive: true });
  writeFileSync(join(aiDir(demo), 'plan-review.json'), JSON.stringify(review, null, 1) + '\n');
  return text;
}

// model: makeModel()'s, to have Copilot read the script with the screens (script-plan.mjs); without one, the rules alone.
export async function planFromScript({ demo, file, packs, model = null, settings = {}, emit = () => {} }) {
  if (!existsSync(file)) throw new Error(`${file}: there\u2019s no such file`);
  const track = readTalkTrack(file);
  const lines = track.beats.reduce((n, b) => n + b.lines.length, 0);
  if (!lines) throw new Error(`${basename(file)}: no lines to say in it (a table with a Say column, > quotes, “quoted” lines, or Say: lines)`);
  emit({ event: 'read', beats: track.beats.length, lines, prompts: track.prompts.length });
  packs = packs === undefined ? await loadPacks(demo) : packs;
  const walker = walkerFromDemo(demo);
  emit({ event: 'screens', recorded: !!walker, screens: walker ? walker.states.length : 0 });
  const { planWithModel } = await import('./script-plan.mjs');
  const { plan, flags, model: asked } = model && walker ? await planWithModel(track, { walker, model, packs, apps: demo.cfg.apps || [], settings, emit }) : planFromTrack(track, { walker, apps: demo.cfg.apps || [], packs });
  const review = { at: new Date().toISOString(), from: basename(file), checked: walker ? walker.states.length : 0, beats: plan.beats.length, steps: stepCount(plan), writes: writesOf(plan), flags, prompts: track.prompts, ...(asked ? { model: asked } : {}) };
  const text = save(demo, plan, review);
  await resetFollows(demo, packs);
  // Her words stay with the demo: the source the plan came from (the app shows it as the material). Material she wrote
  // herself isn't replaced.
  const src = join(demo.dir, 'source.md');
  if (!existsSync(src) || /^<!-- From: /.test(readFileSync(src, 'utf8'))) writeFileSync(src, `<!-- From: ${basename(file)} -->\n\n${talkTrackText(file)}`);
  emit({ event: 'plan', beats: plan.beats.length, steps: review.steps, writes: review.writes.length, flags: flags.length, askFirst: (text.match(/ — ask first/g) || []).length });
  return { text, plan, review, track };
}

export async function planFromWalkthrough({ demo, file, script = null, packs, emit = () => {} }) {
  const rec = JSON.parse(readFileSync(file, 'utf8'));
  if (!(rec.path || []).length) throw new Error(`${basename(file)}: the recording has no steps`);
  packs = packs === undefined ? await loadPacks(demo) : packs;
  const walker = walkerFromDemo(demo);
  const track = script ? readTalkTrack(script) : null;
  const flags = [];
  const plan = planFromRecording(rec, { walker, title: demo.cfg.title, track, packs, flags });
  const review = { at: new Date().toISOString(), from: basename(file), walkthrough: true, checked: walker ? walker.states.length : 0, beats: plan.beats.length, steps: stepCount(plan), writes: writesOf(plan), flags };
  const text = save(demo, plan, review);
  await resetFollows(demo, packs);
  emit({ event: 'plan', beats: plan.beats.length, steps: review.steps, writes: review.writes.length, flags: flags.length, askFirst: (text.match(/ — ask first/g) || []).length });
  return { text, plan, review };
}

// The presenter's one approval: the plan's exact words and the writes it lets the capture pass do, and the reset's
// (reset.md: its undo and set-first steps, which change the tenant too). The approval screen lists every one of them
// by beat and step; list256 is their hash, so the list approved is the list that runs. Any edit to plan.md or reset.md
// after it needs approving again (a write runs only as approved).
export function writeList(demo) {
  const f = join(demo.dir, PLAN);
  if (!existsSync(f)) throw new Error('make the plan first');
  const text = readFileSync(f, 'utf8');
  const writes = writesOf(parsePlan(text)).map(w => ({ beat: w.beat, step: w.step, text: w.text, writes: w.writes }));
  const rf = join(demo.dir, RESET), resetText = existsSync(rf) ? readFileSync(rf, 'utf8') : null;
  const reset = resetText ? resetSteps(resetText) : [];
  // What she leaves out of the replica: listed apart from the writes (it changes nothing in the tenant); reset256 binds
  // its text.
  const leaveOut = resetText ? (parseReset(resetText).leaveOut || []).map(l => ({ app: l.app, what: l.what, from: l.from, label: `Left out of the replica: ${l.what}` })) : [];
  return { text, writes, resetText, reset, leaveOut };
}
// The reset's steps that change something: each undo step (but Go to, which only switches), each set first, and each
// set before.
export function resetSteps(resetText) {
  const r = parseReset(resetText), out = [];
  r.undo.beats.forEach((b, bi) => b.steps.forEach((s, si) => { if (s.kind !== 'app') out.push({ part: 'undo', app: b.title, n: bi, step: si, text: formatStep(s) }); }));
  // An API undo's Note can give steps for when it can't run: they're listed too, so they run only as approved.
  for (const g of undoGroups(resetText)) for (const s of g.steps) if (s.kind === 'free' && /^undo with the app pack:/i.test(s.text || '')) {
    for (const t of fallbackSteps(g.note)) out.push({ part: 'undo', app: g.title, of: s.text, text: t, fallback: true });
    // With nothing a run recorded (the reset before), the script's own leftovers found by these names and undone.
    if ((g.names || []).length) out.push({ part: 'undo', app: g.title, of: s.text, text: `Find by name: ${g.names.map(x => `"${x}"`).join(', ')}`, byName: g.names });
  }
  r.set.forEach((x, i) => out.push({ part: 'set', n: i, text: x.what, set: x.set || null }));
  // Set before: off camera, just before its step, an approved write too (listed only when reset.md has them).
  for (const b of r.before || []) b.items.forEach((x, i) => out.push({ part: 'before', beat: b.beat, before: b.text, ...(b.n ? { stepN: b.n } : {}), n: i, text: x.what, set: x.set || null, label: `off camera, before ${b.text}: ${x.what}` }));
  return out;
}
const listSha = (writes, reset) => sha(JSON.stringify({ writes, reset }));
// reset.md's Check lines a run can't check (check-lines.mjs checkable): [{ text, why }].
export async function uncheckable(demo, { packs, resetText = null, plan = null } = {}) {
  const rt = resetText !== null ? resetText : (existsSync(join(demo.dir, RESET)) ? readFileSync(join(demo.dir, RESET), 'utf8') : '');
  if (!rt) return [];
  plan = plan || parsePlan(readFileSync(join(demo.dir, PLAN), 'utf8'));
  packs = packs === undefined ? await loadPacks(demo) : packs;
  const walker = (() => { try { return walkerFromDemo(demo); } catch (e) { return null; } })();
  const ctx = { plan, packs, cfg: demo.cfg, walker, values: checkValues({ plan, walker, cfg: demo.cfg }), appIds: (demo.cfg.apps || []).map(a => a.id) };
  return parseReset(rt).checks.map(c => ({ text: `${c.app}${c.screen ? ` on ${c.screen}` : ''}: ${c.text}`, r: checkable(c, ctx) })).filter(x => !x.r.ok).map(x => ({ text: x.text, why: x.r.why }));
}
// Refused when a Check line can't be checked: a run would stop at it, after she's said go.
export async function approve(demo, { packs } = {}) {
  const { text, writes, resetText, reset, leaveOut } = writeList(demo);
  const bad = await uncheckable(demo, { packs, resetText: resetText || '' });
  if (bad.length) throw new Error(`reset.md has ${bad.length === 1 ? 'a check' : `${bad.length} checks`} a run can't check: ${bad.map(b => `"${b.text}" (${b.why})`).join('; ')}. Make the reset again (ai reset), or fix those lines`);
  const a = { at: new Date().toISOString(), sha256: sha(text), writes, ...(resetText ? { reset256: sha(resetText), reset } : {}), ...(leaveOut.length ? { leaveOut } : {}), list256: listSha(writes, reset) };
  mkdirSync(aiDir(demo), { recursive: true });
  writeFileSync(join(aiDir(demo), 'approved.json'), JSON.stringify(a, null, 1) + '\n');
  return a;
}
// approved: the plan is word for word the one approved; full: the reset too, and the list hash (an unattended run
// needs full).
export function approval(demo) {
  const f = join(aiDir(demo), 'approved.json'), p = join(demo.dir, PLAN);
  if (!existsSync(f) || !existsSync(p)) return { approved: false, full: false };
  const a = JSON.parse(readFileSync(f, 'utf8'));
  const approved = a.sha256 === sha(readFileSync(p, 'utf8'));
  let full = false, why = approved ? null : 'plan.md changed since it was approved';
  if (approved) {
    const now = writeList(demo);
    const resetOk = now.resetText ? a.reset256 === sha(now.resetText) : !a.reset256;
    if (!resetOk) why = now.resetText ? 'reset.md changed since it was approved' : 'reset.md was approved and is gone';
    else if (a.list256 !== listSha(now.writes, now.reset)) why = 'the approval doesn\'t list these writes (approve again)';
    else full = true;
  }
  return { ...a, approved, full, ...(why ? { why } : {}) };
}

export async function writeReset(demo, { packs } = {}) {
  const f = join(demo.dir, PLAN);
  if (!existsSync(f)) throw new Error('make the plan first');
  const plan = parsePlan(readFileSync(f, 'utf8'));
  packs = packs === undefined ? await loadPacks(demo) : packs;
  const rf = join(demo.dir, RESET), was = existsSync(rf) ? readFileSync(rf, 'utf8') : '';
  const r = resetFor(plan, { walker: walkerFromDemo(demo), packs });
  // Her Leave out, word for word: it's hers, not the generator's.
  r.leaveOutText = leaveOutSection(was);
  // A check a run can't check isn't one: it's listed for her instead.
  const walker = (() => { try { return walkerFromDemo(demo); } catch (e) { return null; } })();
  const ctx = { plan, packs, cfg: demo.cfg, walker, values: checkValues({ plan, walker, cfg: demo.cfg }), appIds: (demo.cfg.apps || []).map(a => a.id) };
  const keep = [];
  for (const c of r.checks) { const k = checkable(c, ctx); if (k.ok) keep.push(c); else r.needs.push({ kind: 'check', text: `Check "${c.app}${c.screen ? ` on ${c.screen}` : ''}: ${c.text}" can't be checked by a run: ${k.why}` }); }
  r.checks = keep;
  const text = formatReset(r);
  writeFileSync(rf, text);
  return { text, reset: r };
}
