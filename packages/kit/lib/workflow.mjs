// The fast-path workflow commands: text, status, save, release. (bin/replica.mjs dispatches here.)
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadDemo, arg, KIT } from './demo.mjs';
import { buildInputs, buildDiff } from './buildkey.mjs';
import { scan } from '../../checks/secrets.mjs';
import { compileFlow } from '../compile/flow.mjs';

const TRAILER = 'Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>';
const git = (dir, ...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
const ago = ms => { const s = Math.round(ms / 1000); return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };
const readJson = f => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch (e) { return null; } };
const ping = async url => { try { return (await fetch(url, { signal: AbortSignal.timeout(800) })).ok; } catch (e) { return false; } };

// scenecast text "<old>" "<new>" [--in id,id] [--remove]: a wording or date tweak, as one line in flow.overrides.mjs.
// It shows on the next reload of scenecast serve (no build); scenecast build bakes it in.
export function text(args) {
  const demo = loadDemo(args);
  const pos = args.filter((a, i) => !a.startsWith('--') && !['--demo', '--in'].includes(args[i - 1]));
  const remove = args.includes('--remove');
  const [from, to] = pos;
  if (!from || (!remove && to === undefined)) { console.log('scenecast text "<old text>" "<new text>" [--in snap,snap]   or   scenecast text "<sentence>" --remove'); return 1; }
  const inn = (arg(args, '--in', '') || '').split(',').filter(Boolean);
  const e = remove ? { remove: from } : { replace: [from, to] };
  if (inn.length) e.in = inn;
  const file = join(demo.dir, 'flow.overrides.mjs');
  let src = existsSync(file) ? readFileSync(file, 'utf8') : 'export default function overrides(flow) {\n}\n';
  const at = src.lastIndexOf('}');
  const line = `  flow.edits = (flow.edits || []).concat(${JSON.stringify(e)}); // scenecast text, ${new Date().toISOString().slice(0, 10)}\n`;
  src = src.slice(0, at) + line + src.slice(at);
  writeFileSync(file, src);
  console.log(`added to flow.overrides.mjs: ${JSON.stringify(e)}\nreload the replica to see it (no build needed); scenecast quick to check it`);
  return 0;
}

// scenecast status: where the demo is, and the next step. For picking up after an interruption.
export async function status(args) {
  const demo = loadDemo(args);
  const out = [], next = [];
  const say = (k, v) => out.push(`${k.padEnd(10)} ${v}`);
  say('demo', `${demo.cfg.title || demo.name}  (${demo.dir})`);
  // Git
  const head = git(demo.dir, 'log', '-1', '--format=%h %s (%cr)');
  if (head.status) { say('git', 'not a repository yet'); next.push('scenecast save "first recording" (it starts the repository)'); }
  else {
    const dirty = git(demo.dir, 'status', '--porcelain').stdout.split('\n').filter(Boolean).length;
    const ahead = git(demo.dir, 'rev-list', '--count', '@{u}..HEAD');
    say('git', `${head.stdout.trim()}${dirty ? `, ${dirty} file(s) not committed` : ', all committed'}${ahead.status ? ', no upstream' : +ahead.stdout ? `, ${ahead.stdout.trim()} commit(s) not pushed` : ''}`);
    if (dirty) next.push('scenecast save "<what changed>"');
  }
  // Recording
  const rec = readJson(join(demo.dir, 'recording.json')), partial = readJson(join(demo.raw, 'recording-partial.json'));
  const rawRec = readJson(join(demo.raw, 'recording.json'));
  if (rec) say('recording', `${Object.keys(rec.states || {}).length} screens, ${Object.keys(rec.streams || {}).length} answers, ${(rec.path || []).length} steps (${rec.recordedAt ? rec.recordedAt.slice(0, 16).replace('T', ' ') : ''})`);
  else if (rawRec) { say('recording', 'recorded, not built yet'); next.push('scenecast build --from-raw'); }
  else say('recording', 'none yet');
  if (partial && (!rawRec || partial.savedAt > (rawRec.savedAt || rawRec.recordedAt || ''))) { say('', `an unfinished recording (${Object.keys(partial.states || {}).length} screens, saved ${partial.savedAt.slice(11, 19)}): scenecast record start --resume continues it`); }
  if (!rec && !rawRec && !partial) next.push('record the demo (the skill, step 3)');
  // Build
  let flow = null;
  try { flow = (await compileFlow(demo)).flow; } catch (e) { say('flow', `flow.overrides.mjs fails: ${String(e.message || e).slice(0, 200)}`); next.unshift('fix flow.overrides.mjs'); }
  if (flow) {
    const d = buildDiff(readJson(join(demo.data, 'build.json')), buildInputs(demo, flow));
    say('build', d.needsBuild.length ? `needs a build: ${d.needsBuild.join(', ')}` : d.serveEdits.length ? `${d.serveEdits.length} text tweak(s) served live, not baked in (scenecast build bakes them)` : 'up to date');
    if (d.needsBuild.length) next.push('scenecast build');
  }
  // Checks
  const q = readJson(join(demo.out, 'quick.json')), f = readJson(join(demo.out, 'fidelity.json'));
  const lastChange = Math.max(...['flow.overrides.mjs', 'recording.json', 'demo.json'].map(n => { try { return statSync(join(demo.dir, n)).mtimeMs; } catch (e) { return 0; } }), (() => { try { return statSync(join(demo.data, 'build.json')).mtimeMs; } catch (e) { return 0; } })());
  const fmt = (r, name) => r ? `${name} ${r.pass ? 'passed' : 'FAILED'} ${ago(Date.now() - Date.parse(r.at))} in ${r.secs} s${Date.parse(r.at) < lastChange ? ' (before the last change)' : ''}` : `${name}: never run`;
  say('checks', `${fmt(q, 'quick')}; ${fmt(f, 'full')}`);
  if (!q || Date.parse(q.at) < lastChange || !q.pass) next.push('scenecast quick');
  if (f && !f.pass) next.push('fix what .out/fidelity.md lists, then scenecast quick');
  // Running
  const srv = await ping(demo.url + 'flow.json'), rx = await ping(`http://127.0.0.1:${process.env.REPLICA_RX_PORT || demo.cfg.receiverPort}/ping`);
  say('running', `replica ${srv ? demo.url : 'not served'}; receiver ${rx ? 'up' : 'down'}`);
  if (srv) { const st = await fetch(demo.url + '__replica/status').then(r => r.json()).catch(() => null); if (st && st.error) { say('', `flow error: ${st.error}`); next.unshift('fix flow.overrides.mjs (the replica serves the last good flow)'); } }
  console.log(out.join('\n'));
  console.log(`next      ${next.length ? [...new Set(next)].join('  →  ') : 'nothing pending (scenecast release when it should go out)'}`);
  return 0;
}

// scenecast save "<message>": secret scan, then commit everything in the demo folder (starts the repository if needed).
// Commit after every step that works, so an interruption costs at most that step.
export function save(args) {
  const demo = loadDemo(args);
  const msg = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--demo')[0] || 'replica: save';
  const leaks = scan([demo.dir]).filter(x => !x.file.startsWith('.out/'));
  if (leaks.length) { console.log('not saved: the secret scan found\n' + leaks.slice(0, 20).map(x => `  ${x.file}:${x.line} ${x.rule}`).join('\n')); return 1; }
  if (git(demo.dir, 'rev-parse', '--git-dir').status) {
    git(demo.dir, 'init', '-q', '-b', 'main');
    // No git identity set for everyone: the demo repository uses the kit checkout's.
    for (const k of ['user.name', 'user.email']) if (!git(demo.dir, 'config', k).stdout.trim() && !process.env[k === 'user.name' ? 'GIT_AUTHOR_NAME' : 'GIT_AUTHOR_EMAIL']) { const v = git(KIT, 'config', k).stdout.trim(); if (v) git(demo.dir, 'config', k, v); }
  }
  git(demo.dir, 'add', '-A');
  if (!git(demo.dir, 'status', '--porcelain').stdout.trim()) { console.log('nothing to save'); return 0; }
  const c = git(demo.dir, 'commit', '-q', '-m', msg, '-m', TRAILER);
  if (c.status) { console.log((c.stderr || c.stdout) + (/identity|email/i.test(c.stderr || '') ? '\nset one for this demo: git -C ' + demo.dir + ' config user.name "…" && git -C ' + demo.dir + ' config user.email "…"' : '')); return 1; }
  console.log(git(demo.dir, 'log', '-1', '--format=saved %h %s').stdout.trim());
  return 0;
}

// scenecast release [--push]: bake the tweaks in (build), the full checklist, a secret scan, commit; push with --push.
export async function release(args, node) {
  const demo = loadDemo(args);
  const t0 = Date.now(), step = (n, t) => console.log(`\n== ${n} (${Math.round((Date.now() - t0) / 1000)} s)`);
  step('build');
  if (await node('kit/compile/flow.mjs', ['--demo', demo.dir])) return 1;
  if (await node('recorder/process.mjs', ['--demo', demo.dir])) return 1;
  step('full checklist');
  const fid = await node('checks/fidelity.mjs', ['--demo', demo.dir, ...(arg(args, '--jobs') ? ['--jobs', arg(args, '--jobs')] : [])]);
  if (fid) { console.log('release stopped: the checklist failed (.out/fidelity.md)'); return 1; }
  step('save');
  if (save(['--demo', demo.dir, `release: ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`])) return 1;
  if (args.includes('--push')) {
    step('push');
    const up = !git(demo.dir, 'rev-parse', '--abbrev-ref', '@{u}').status;
    const p = up ? git(demo.dir, 'push', '-q') : git(demo.dir, 'push', '-q', '-u', 'origin', 'HEAD');
    if (p.status) { console.log((p.stderr || p.stdout).trim() + '\n(no remote yet? gh repo create <owner>/<name> --private --source . --push)'); return 1; }
  }
  console.log(`\nreleased in ${Math.round((Date.now() - t0) / 1000)} s`);
  return 0;
}
