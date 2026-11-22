// The benchmark: a saved plan run start to finish by Record for me, unattended, with every phase timed, so a speed
// change can be measured on a real demo without anyone at the keyboard (or an outside agent driving it).
//   scenecast ai bench --demo <dir> --plan <plan.md> [--yes "<regex>"] [--build] [--no-script]
// Every "May I?" is answered from --yes: a step whose words match is done, any other is skipped (never a guess). A
// question ("I need a hand") is skipped too. Writes <demo>/.out/bench.json: each phase's wall time, the take's own
// split (recording.json timing), and what was skipped. Anything the demo needs first (a tenant reset, tabs opened)
// is outside it: that's the demo's prep, not Scenecast's time.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { answer, aiDir } from './run.mjs';

export async function bench({ demo, model, settings = {}, plan, yes, build = false, script = true, emit = () => {} }) {
  const out = { at: new Date().toISOString(), demo: demo.dir, plan, phases: [], skipped: [], answered: [] };
  const allow = yes ? new RegExp(yes, 'i') : null;
  const phase = async (name, fn) => {
    const t0 = Date.now();
    emit({ event: 'stage', name, label: `bench: ${name}` });
    try { const r = await fn(); out.phases.push({ name, secs: +((Date.now() - t0) / 1000).toFixed(1), ok: true }); return r; }
    catch (e) { out.phases.push({ name, secs: +((Date.now() - t0) / 1000).toFixed(1), ok: false, error: String(e.message || e).slice(0, 300) }); throw e; }
  };
  const save = () => { mkdirSync(join(demo.dir, '.out'), { recursive: true }); writeFileSync(join(demo.dir, '.out', 'bench.json'), JSON.stringify(out, null, 1) + '\n'); };
  const t0 = Date.now();
  try {
    if (plan) copyFileSync(plan, join(demo.dir, 'plan.md'));
    const pf = await import('../kit/lib/preflight.mjs');
    await phase('check', async () => { const r = await pf.preflight(demo, { fix: true }); if (!r.ready) throw new Error(pf.notReady(r)); });
    const { recordForMe } = await import('./drive.mjs');
    // The presenter, played by the plan's --yes: answers land in the same answer files the app writes.
    const say = e => {
      emit(e);
      if (e.event === 'confirm') { const ok = !!allow && allow.test(e.step); (ok ? out.answered : out.skipped).push(`${e.step} (${e.app})`); answer(demo, e.id, { answer: ok ? 'do' : 'skip' }); }
      else if (e.event === 'question' || e.event === 'you-do') { out.skipped.push(`${e.step || ''}: ${e.text || ''}`.trim()); answer(demo, e.id, { answer: 'skip' }); }
    };
    out.record = await phase('record', () => recordForMe({ demo, model, settings, emit: say }));
    if (script) {
      const { writeScript } = await import('./write.mjs');
      await phase('script', () => writeScript({ demo, model, settings, emit }));
    }
    if (build) {
      const bin = process.env.SCENECAST_BIN || 'scenecast';
      await phase('build', () => new Promise((res, rej) => { const p = spawn(bin, ['build', '--demo', demo.dir], { stdio: 'inherit' }); p.on('error', rej); p.on('close', c => c ? rej(new Error(`build exit ${c}`)) : res()); }));
    }
  } finally {
    out.secs = +((Date.now() - t0) / 1000).toFixed(1);
    const rec = [join(demo.dir, 'recording.json'), join(demo.raw || '', 'recording.json')].find(f => f && existsSync(f));
    if (rec) { try { const r = JSON.parse(readFileSync(rec, 'utf8')); out.take = r.timing; out.screens = Object.keys(r.states || {}).length; out.streams = Object.keys(r.streams || {}).length; } catch (e) {} }
    save();
  }
  return out;
}
export const benchFile = demo => join(demo.dir, '.out', 'bench.json');
export { aiDir };
