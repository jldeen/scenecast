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
import { parsePlan, formatPlan, writesOf, stepCount } from './plan.mjs';
import { walkerFromDemo } from './walker.mjs';
import { planFromTrack } from './from-script.mjs';
import { planFromRecording } from './walkthrough.mjs';
import { resetFor, formatReset } from './reset.mjs';
import { readTalkTrack, talkTrackText } from '@scenecast/script/talk.mjs';
import { aiDir } from './run.mjs';

export const PLAN = 'plan.md', RESET = 'reset.md';
const sha = t => createHash('sha256').update(String(t)).digest('hex');

// The app packs (packages/apps): each app's names, writes and their undos. Optional: without them, plain rules.
export async function loadPacks(demo) {
  try {
    const m = await import('@stuntdouble/apps/index.mjs');
    return { forApp: m.packsForDemo(demo.cfg), writeFor: m.writeFor };
  } catch (e) { return null; }
}

function save(demo, plan, review) {
  const text = formatPlan(plan);
  writeFileSync(join(demo.dir, PLAN), text);
  mkdirSync(aiDir(demo), { recursive: true });
  writeFileSync(join(aiDir(demo), 'plan-review.json'), JSON.stringify(review, null, 1) + '\n');
  return text;
}

export async function planFromScript({ demo, file, packs, emit = () => {} }) {
  if (!existsSync(file)) throw new Error(`${file}: there\u2019s no such file`);
  const track = readTalkTrack(file);
  const lines = track.beats.reduce((n, b) => n + b.lines.length, 0);
  if (!lines) throw new Error(`${basename(file)}: no lines to say in it (a table with a Say column, > quotes, “quoted” lines, or Say: lines)`);
  emit({ event: 'read', beats: track.beats.length, lines, prompts: track.prompts.length });
  packs = packs === undefined ? await loadPacks(demo) : packs;
  const walker = walkerFromDemo(demo);
  emit({ event: 'screens', recorded: !!walker, screens: walker ? walker.states.length : 0 });
  const { plan, flags } = planFromTrack(track, { walker, apps: demo.cfg.apps || [], packs });
  const review = { at: new Date().toISOString(), from: basename(file), checked: walker ? walker.states.length : 0, beats: plan.beats.length, steps: stepCount(plan), writes: writesOf(plan), flags, prompts: track.prompts };
  const text = save(demo, plan, review);
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
  const plan = planFromRecording(rec, { walker, title: demo.cfg.title, track, packs });
  const review = { at: new Date().toISOString(), from: basename(file), walkthrough: true, checked: walker ? walker.states.length : 0, beats: plan.beats.length, steps: stepCount(plan), writes: writesOf(plan), flags: [] };
  const text = save(demo, plan, review);
  emit({ event: 'plan', beats: plan.beats.length, steps: review.steps, writes: review.writes.length, flags: 0, askFirst: (text.match(/ — ask first/g) || []).length });
  return { text, plan, review };
}

// The presenter's one approval: the plan's exact words and the writes it lets the capture pass do. Any edit to plan.md
// after it needs approving again (Phase 6's guard: a write runs only as approved).
export function approve(demo) {
  const f = join(demo.dir, PLAN);
  if (!existsSync(f)) throw new Error('make the plan first');
  const text = readFileSync(f, 'utf8');
  const a = { at: new Date().toISOString(), sha256: sha(text), writes: writesOf(parsePlan(text)).map(w => ({ beat: w.beat, step: w.step, text: w.text, writes: w.writes })) };
  mkdirSync(aiDir(demo), { recursive: true });
  writeFileSync(join(aiDir(demo), 'approved.json'), JSON.stringify(a, null, 1) + '\n');
  return a;
}
export function approval(demo) {
  const f = join(aiDir(demo), 'approved.json'), p = join(demo.dir, PLAN);
  if (!existsSync(f) || !existsSync(p)) return { approved: false };
  const a = JSON.parse(readFileSync(f, 'utf8'));
  return { ...a, approved: a.sha256 === sha(readFileSync(p, 'utf8')) };
}

export async function writeReset(demo, { packs } = {}) {
  const f = join(demo.dir, PLAN);
  if (!existsSync(f)) throw new Error('make the plan first');
  const plan = parsePlan(readFileSync(f, 'utf8'));
  packs = packs === undefined ? await loadPacks(demo) : packs;
  const r = resetFor(plan, { walker: walkerFromDemo(demo), packs });
  const text = formatReset(r);
  writeFileSync(join(demo.dir, RESET), text);
  return { text, reset: r };
}
