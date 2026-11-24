// The engine side of `scenecast ai` (the desktop app runs the same): GitHub Copilot sign-in, and the three AI modes.
//   ai status | sign-in | sign-out | models | runtime | settings [--set key=value]…
//   ai plan    --demo <dir>     draft plan.md from the goal (ai.json) or source material (source.md)
//   ai plan    --demo <dir> --script <file>             Make it from my script: plan.md from her talk track (Word,
//                               Markdown, RunLines or Do/Say lines), mapped to the recorded screens when there are any
//   ai plan    --demo <dir> --walkthrough <recording.json> [--script <file>]   the same from one walkthrough
//   ai approve --demo <dir>     approve plan.md as it is now (its writes included; any edit needs approving again)
//   ai reset   --demo <dir>     reset.md: the plan's writes undone, and a read-only checklist
//   ai reground --demo <dir> [--walk <dir>]   the plan's proofs again, on the screens a live walk read today
//                               (walk.json and walk-screens/): reground.md, and plan.reground.md (plan.md stays)
//   ai finish  --demo <dir>     after the build: her script for the guide, the beat keys, focus points, the review
//   ai record  --demo <dir>     Record for me: run the approved plan in the browser while recording; then the script
//   ai script  --demo <dir>     the talk track (script.md) from what was recorded
//   ai coach   --demo <dir>     Coach me: the next step and line, live, until the recording stops
//   ai answer  --demo <dir> <id> <do|self|skip|stop|done> [text]      answer a question the AI asked
//   ai stop    --demo <dir>     stop Record for me or the coach
//   ai sent    --demo <dir>     what was sent to the model
// Progress and questions: one `@ai {json}` line each on stdout. SCENECAST_AI_MODEL=stub runs on the deterministic
// stand-in (no network, no account); SCENECAST_AI_HOME is where sign-in, settings and the Copilot runtime live.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadDemo, arg } from '@stuntdouble/core/lib/demo.mjs';
import { makeModel } from './model.mjs';
import { readSettings, writeSettings } from './copilot.mjs';
import { aiDir, answer, stop } from './run.mjs';
// Exit once everything printed is out (a pipe to the app is written asynchronously; exiting at once cut it at 64 KB).
const exitWhenOut = code => process.stdout.write('', () => process.exit(code));

const args = process.argv.slice(2);
const sub = args[0];
const emit = e => console.log('@ai ' + JSON.stringify(e));
const pos = () => args.filter((a, i) => i > 0 && !a.startsWith('--') && !['--demo', '--from', '--set', '--model', '--plan', '--yes', '--script', '--walkthrough', '--walk'].includes(args[i - 1]));

async function main() {
  const settings = readSettings();
  const kind = arg(args, '--model', process.env.SCENECAST_AI_MODEL || 'copilot');
  const demo = () => loadDemo(args);
  const model = d => makeModel({ kind, sentDir: join(aiDir(d), 'sent'), settings, on: emit });
  switch (sub) {
    case 'status': {
      if (kind !== 'copilot') return { signedIn: true, login: kind, model: kind, settings };
      const { status } = await import('./copilot.mjs');
      return { ...(await status()), model: 'copilot', settings };
    }
    case 'runtime': { const { ensureRuntime } = await import('./copilot.mjs'); return ensureRuntime(emit); }
    case 'sign-in': { const { signIn } = await import('./copilot.mjs'); return signIn(emit); }
    case 'sign-out': { const { signOut } = await import('./copilot.mjs'); return signOut(); }
    case 'models': { const { models } = await import('./copilot.mjs'); return { models: await models() }; }
    case 'settings': {
      const patch = {};
      args.forEach((a, i) => { if (args[i - 1] === '--set') { const [k, ...v] = a.split('='); const val = v.join('='); patch[k] = val === 'true' ? true : val === 'false' ? false : val; } });
      return Object.keys(patch).length ? writeSettings(patch) : settings;
    }
    case 'plan': {
      const d = demo();
      const script = arg(args, '--script', null), walk = arg(args, '--walkthrough', null);
      if (walk) { const { planFromWalkthrough } = await import('./make.mjs'); const r = await planFromWalkthrough({ demo: d, file: walk, script, emit }); return { beats: r.review.beats, steps: r.review.steps, writes: r.review.writes.length, flags: [] }; }
      if (script) {
        // Copilot reads it with the screens when it's ready here (no download for this), else the rules alone.
        const { planFromScript } = await import('./make.mjs');
        const { runtimeState } = await import('./copilot.mjs');
        const m = kind === 'stub' || (kind === 'copilot' && !runtimeState().ready) ? null : await makeModel({ kind, sentDir: join(aiDir(d), 'sent'), settings, on: emit, cacheDir: join(aiDir(d), 'cache'), timeoutMs: 600000 });
        const r = await planFromScript({ demo: d, file: script, model: m, settings, emit });
        return { beats: r.review.beats, steps: r.review.steps, writes: r.review.writes.length, flags: r.review.flags, checked: r.review.checked, ...(r.review.model ? { copilot: r.review.model } : {}) };
      }
      const { draftPlan } = await import('./draft.mjs');
      return draftPlan({ demo: d, model: await model(d), settings, emit });
    }
    case 'approve': { const { approve } = await import('./make.mjs'); return approve(demo()); }
    case 'reset': { const { writeReset } = await import('./make.mjs'); const r = await writeReset(demo()); return { undo: r.reset.undo.length, checks: r.reset.checks.length, needs: r.reset.needs, file: 'reset.md' }; }
    case 'reground': { const { reground } = await import('./reground.mjs'); return reground(demo(), { from: arg(args, '--walk', null) }); }
    case 'finish': { const { finish } = await import('./finish.mjs'); return finish({ demo: demo(), emit }); }
    case 'record': {
      const d = demo();
      // The same readiness check as Record's (--checked: the app ran it just now).
      if (!args.includes('--checked')) {
        const pf = await import('@stuntdouble/core/lib/preflight.mjs');
        emit({ event: 'stage', name: 'check', label: 'Checking your browser and the app tabs' });
        const r = await pf.preflight(d, { fix: true });
        if (!r.ready) throw new Error(pf.notReady(r));
      }
      const { recordForMe } = await import('./drive.mjs');
      const { writeScript } = await import('./write.mjs');
      const m = await model(d);
      const r = await recordForMe({ demo: d, model: m, settings, emit });
      emit({ event: 'stage', name: 'script', label: 'Writing the talk track from what happened' });
      const s = await writeScript({ demo: d, model: m, settings, emit });
      return { ...r, script: { beats: s.beats, lines: s.lines } };
    }
    case 'bench': {
      const d = demo(), { bench } = await import('./bench.mjs');
      return bench({ demo: d, model: await model(d), settings, emit, plan: arg(args, '--plan', null), yes: arg(args, '--yes', null), build: args.includes('--build'), script: !args.includes('--no-script') });
    }
    case 'script': { const d = demo(); const { writeScript } = await import('./write.mjs'); const s = await writeScript({ demo: d, model: await model(d), settings, emit }); return { beats: s.beats, lines: s.lines, file: s.file }; }
    case 'coach': {
      const d = demo();
      const { coach } = await import('./coach.mjs');
      const stopFile = join(aiDir(d), 'stop');
      const { rmSync } = await import('node:fs');
      rmSync(stopFile, { force: true });
      return coach({ demo: d, model: await model(d), settings, emit, stopped: () => existsSync(stopFile) });
    }
    case 'answer': { const [id, a, ...text] = pos(); answer(demo(), id, { answer: a, text: text.join(' ') || undefined }); return { ok: true }; }
    case 'stop': stop(demo()); return { ok: true };
    case 'sent': {
      const dir = join(aiDir(demo()), 'sent');
      if (!existsSync(dir)) return { sent: [] };
      return { sent: readdirSync(dir).sort().map(f => { const r = JSON.parse(readFileSync(join(dir, f), 'utf8')); return { file: join(dir, f), task: r.task, model: r.model, at: r.at, chars: r.prompt.length, pageText: r.pageText }; }) };
    }
    default:
      console.log('scenecast ai status|sign-in|sign-out|models|runtime|settings|plan|approve|reset|reground|finish|record|bench|script|coach|answer|stop|sent');
      return null;
  }
}

try {
  const r = await main();
  if (r !== null) emit({ event: 'done', result: r });
  exitWhenOut(r === null ? 1 : 0);
} catch (e) {
  emit({ event: 'error', error: String(e && e.message || e) });
  if (process.env.SCENECAST_AI_DEBUG) console.error(e);
  exitWhenOut(2);
}
