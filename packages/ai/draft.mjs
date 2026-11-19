// Drafting the plan (Record for me, and Coach me without one): the goal or source material, and each app's start
// screen as the AI sees it, to the model; back a plan in plain words (plan.md) for the presenter to read, edit and
// approve in the app.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePlan, parseStep, formatPlan, stepCount } from './plan.mjs';
import { compactOutline } from './model.mjs';
import { rx, observe } from './run.mjs';

export const PLAN = 'plan.md';
export const readGoal = demo => { try { return JSON.parse(readFileSync(join(demo.dir, 'ai.json'), 'utf8')); } catch (e) { return {}; } };
export const readSource = demo => { for (const f of ['source.md', 'source.txt', 'source.sk']) if (existsSync(join(demo.dir, f))) return readFileSync(join(demo.dir, f), 'utf8'); return ''; };

export async function draftPlan({ demo, model, settings = {}, emit = () => {} }) {
  const ai = readGoal(demo);
  const source = readSource(demo);
  if (!ai.goal && !source.trim()) throw new Error('say what the demo should show first (a goal, or notes, a doc or a script)');
  const cmd = rx(demo);
  const apps = [];
  for (const a of demo.cfg.apps) {
    let outline = null;
    try { outline = compactOutline(await observe(cmd, demo, a.id), settings); } catch (e) { emit({ event: 'note', text: `${a.id}: couldn't read its start screen (${e.message}); the plan is from your words only` }); }
    apps.push({ id: a.id, url: a.url, outline });
  }
  emit({ event: 'drafting', apps: apps.length });
  const r = await model.ask('plan', { title: demo.cfg.title || '', goal: ai.goal || '', source: source.slice(0, 20000), apps });
  const plan = { title: r.title || demo.cfg.title || 'Demo', beats: (r.beats || []).map(b => ({ title: b.title || '', steps: (b.steps || []).map(s => parseStep(String(s))), say: (b.say || []).map(String) })).filter(b => b.steps.length || b.say.length) };
  if (!plan.beats.length) throw new Error('the plan came back empty: say a bit more about what the demo should show');
  const text = formatPlan(plan);
  writeFileSync(join(demo.dir, PLAN), text);
  emit({ event: 'plan', beats: plan.beats.length, steps: stepCount(plan), askFirst: (text.match(/ — ask first/g) || []).length });
  return { text, plan };
}

export function readPlan(demo) {
  const f = join(demo.dir, PLAN);
  return existsSync(f) ? parsePlan(readFileSync(f, 'utf8')) : null;
}
