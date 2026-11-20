// The engine side of `scenecast ai` (the desktop app runs the same): GitHub Copilot sign-in, and the three AI modes.
//   ai status | sign-in | sign-out | models | runtime | settings [--set key=value]…
//   ai plan    --demo <dir>     draft plan.md from the goal (ai.json) or source material (source.md)
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
import { loadDemo, arg } from '../kit/lib/demo.mjs';
import { makeModel } from './model.mjs';
import { readSettings, writeSettings } from './copilot.mjs';
import { aiDir, answer, stop } from './run.mjs';
// Exit once everything printed is out (a pipe to the app is written asynchronously; exiting at once cut it at 64 KB).
const exitWhenOut = code => process.stdout.write('', () => process.exit(code));

const args = process.argv.slice(2);
const sub = args[0];
const emit = e => console.log('@ai ' + JSON.stringify(e));
const pos = () => args.filter((a, i) => i > 0 && !a.startsWith('--') && !['--demo', '--from', '--set', '--model'].includes(args[i - 1]));

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
    case 'plan': { const d = demo(); const { draftPlan } = await import('./draft.mjs'); return draftPlan({ demo: d, model: await model(d), settings, emit }); }
    case 'record': {
      const d = demo();
      // The same readiness check as Record's (--checked: the app ran it just now).
      if (!args.includes('--checked')) {
        const pf = await import('../kit/lib/preflight.mjs');
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
      console.log('scenecast ai status|sign-in|sign-out|models|runtime|settings|plan|record|script|coach|answer|stop|sent');
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
