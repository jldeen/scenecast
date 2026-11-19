// Coach me: while the presenter clicks through the demo with the recorder on, the next suggested step and the line
// to say, live. It follows the plan (plan.md; drafted from the goal first if there isn't one): each step the
// recorder sees is matched to the plan, and the next one is suggested. When the presenter goes their own way, the
// model suggests the next step from the goal and the screen. Shown in the app's Record step, and in the coach window
// (the receiver's /coach page: a separate window for the laptop screen, never on the stage).
import { formatStep } from './plan.mjs';
import { compactOutline } from './model.mjs';
import { rx, observe, sleep, nameOfSpec } from './run.mjs';
import { readPlan, readGoal, draftPlan } from './draft.mjs';

const norm = s => String(s || '').toLowerCase().replace(/[“”"']/g, '').replace(/\s+/g, ' ').trim();
const near = (a, b) => { a = norm(a); b = norm(b); return !!a && !!b && (a === b || a.includes(b) || b.includes(a)); };

// Does what the recorder saw (a path entry) do this plan step?
export function matches(step, p) {
  if (!step || !p) return false;
  switch (step.kind) {
    case 'app': return !!p.app && near(p.app, step.app);
    case 'click': return !!p.click && near(nameOfSpec(p.click), step.target);
    case 'type': return !!p.type && (near(p.text, step.value) || !step.value);
    case 'press': return step.key === 'Enter' ? !!p.enter || (!!p.click && !!p.typedFrom) : p.key === step.key;
    default: return false;
  }
}

export async function coach({ demo, model, settings = {}, emit = () => {}, stopped = () => false }) {
  let plan = readPlan(demo);
  const goal = readGoal(demo).goal || '';
  if (!plan && goal) { emit({ event: 'stage', name: 'plan', label: 'Drafting a plan from your goal' }); plan = (await draftPlan({ demo, model, settings, emit })).plan; }
  if (!plan) throw new Error('give the coach a goal or a plan first');
  const cmd = rx(demo);
  const steps = plan.beats.flatMap((b, bi) => b.steps.map(s => ({ ...s, beat: bi })));
  const port = process.env.REPLICA_RX_PORT || demo.cfg.receiverPort;
  let k = 0, seen = 0, off = 0, wasRecording = false, lastKey = '', suggestion = null, sugFor = '';
  const publish = async extra => {
    const cur = steps[k];
    const beat = cur ? plan.beats[cur.beat] : null;
    const msg = { event: 'coach', at: Date.now(), done: k, of: steps.length, beat: cur ? cur.beat : plan.beats.length, beatTitle: beat ? beat.title : 'Done', next: suggestion ? suggestion.step : cur ? (cur.kind === 'app' && steps[k + 1] && steps[k + 1].kind !== 'app' ? `${formatStep(cur)}, then ${formatStep(steps[k + 1])[0].toLowerCase()}${formatStep(steps[k + 1]).slice(1)}` : formatStep(cur)) : null, say: suggestion ? suggestion.say : beat ? beat.say[0] || null : null, beatSay: beat ? beat.say : [], offPlan: !!suggestion, finished: !cur && !suggestion, ...extra };
    const key = JSON.stringify([msg.done, msg.next, msg.say, msg.recording, msg.offPlan]);
    if (key === lastKey) return;
    lastKey = key;
    emit(msg);
    await fetch(`http://127.0.0.1:${port}/coach`, { method: 'POST', body: JSON.stringify(msg) }).catch(() => {});
  };
  emit({ event: 'stage', name: 'coach', label: 'Coaching: start recording, then follow the suggestions' });
  while (!stopped()) {
    let s;
    try { s = await cmd('recordStatus', {}, 30); } catch (e) { await sleep(1500); continue; }
    if (wasRecording && !s.recording) break;
    if (s.recording && !wasRecording) { wasRecording = true; seen = 0; }
    if (s.recording) {
      const total = s.steps || 0, recent = s.recent || [];
      const fresh = recent.slice(Math.max(0, recent.length - (total - seen)));
      seen = total;
      for (const p of fresh) {
        const at = steps.slice(k, k + 4).findIndex(st => matches(st, p));
        if (at >= 0) { k += at + 1; off = 0; suggestion = null; }
        else if (!p.app) off++;
      }
      // Waits are done once the recorder has settled.
      while (steps[k] && steps[k].kind === 'wait' && !s.busy) k++;
      if (off >= 2 && goal && s.active) {
        const state = (s.states || {})[s.active];
        if (state !== sugFor && !s.busy) {
          sugFor = state;
          try {
            const o = compactOutline(await observe(cmd, demo, s.active), settings);
            const done = steps.slice(0, k).map(formatStep);
            const r = await model.ask('next', { goal, done, app: s.active, outline: o });
            suggestion = r && r.step ? { step: r.step, say: r.say || null } : null;
          } catch (e) { emit({ event: 'note', text: `no suggestion: ${e.message}` }); }
        }
      }
    }
    await publish({ recording: !!s.recording, busy: !!s.busy });
    await sleep(800);
  }
  await publish({ recording: false, ended: true });
  return { followed: k, of: steps.length };
}
