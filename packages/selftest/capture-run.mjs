// The unattended capture pass (Record for me, unattended: packages/ai/unattended.mjs) on the fixture's tasks app, whose
// server keeps what its writes change, so the test sees what reached it. In the capture browser (off the screen on
// macOS and Windows, headless on Linux), with nobody there:
//   1. the approved plan runs: the reset before (a task an earlier run left, Sync left on), the pre-approved write
//      (a new task), a step the plan calls read-only whose request the guard holds (Refresh posts), the reset after;
//      the two apps' start sweeps side by side
//   1b. the reader and the served replica name the run's recorded controls alike (name-parity.mjs)
//   1c. a write inside a frame (another host): the reader agrees in the frame, the guard opens the pack's hosts for it
//   1d. an API undo in the page's own session; when it can't, the Note's steps
//   1e. the capture start waits for a slow sign-in, and refuses one that never comes
//   2. a write the plan didn't approve (Archive all) stops the run before it, with a picture
//   3. a step that leaves the app (Help, on another host) stops it
//   3b. a step it can't prove (its words were there before): it goes on only by its next control, and stops
//       before a write; a walk notes it as unproven
//   4. a plan edited after it was approved doesn't run at all
//   5. a read-only live walk of the plan: it stops at the write and goes on with the next beat
//   6. the same plan through the recorder extension (Record for me, attended) records the same screens
//   node packages/selftest/capture-run.mjs [--keep] [--no-extension]
import './reap.mjs';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, readdirSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startTasks, startFixture } from '../../examples/fixture-app/server.mjs';
import { browserApp } from '@stuntdouble/capture/browser.mjs';
import { selftestGuard } from './guard.mjs';
import { nameParity } from './name-parity.mjs';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = process.env.SCENECAST_BIN ? resolvePath(process.env.SCENECAST_BIN) : join(KIT, '..', 'target', 'debug', process.platform === 'win32' ? 'scenecast.exe' : 'scenecast');
if (!existsSync(BIN)) { console.log(`no scenecast binary at ${BIN}: cargo build -p stuntdouble-cli first (or set SCENECAST_BIN)`); process.exit(1); }
const channel = process.env.CAPTURE_CHANNEL || 'chrome';
if (!browserApp(channel)) { console.log(`SKIP no ${channel} installed`); process.exit(0); }
const keep = process.argv.includes('--keep');
const withExtension = !process.argv.includes('--no-extension');
// Receiver ports away from every other test's and the app's (47621–47630): a recorder extension looks for its receiver
// on its own port and the nine after it, so two tests' within ten of each other can find each other's.
const RX = 47741, RX_EXT = 47751, RX_SIGN = 47743, REPLICA_PORT = 4741, PARITY_PORT = 4742, TASKS = 47821, CHAT = 47822, ADMIN = 47823, NOTES = 47824;
const tmp = mkdtempSync(join(tmpdir(), 'scenecast-run-'));
await selftestGuard({ tmp, receivers: [RX, RX_EXT, RX_SIGN], extensions: [RX_EXT], ports: [REPLICA_PORT, PARITY_PORT, TASKS, CHAT, ADMIN, NOTES] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fails = [], times = {};
const check = (name, ok, detail) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? `: ${String(detail).slice(0, 2000)}` : '')); if (!ok) fails.push(name); };
const GIT_ID = { GIT_AUTHOR_NAME: 'scenecast run test', GIT_AUTHOR_EMAIL: 'run-test@localhost', GIT_COMMITTER_NAME: 'scenecast run test', GIT_COMMITTER_EMAIL: 'run-test@localhost' };
const ENV = { ...process.env, ...GIT_ID, REPLICA_RX_PORT: String(RX), REPLICA_NO_OPEN: '1', SCENECAST_AI_MODEL: 'stub', SCENECAST_AI_HOME: join(tmp, 'ai-home'), STUNTDOUBLE_PACKS: join(tmp, 'packs') };
const run = (args, opts = {}) => new Promise(res => {
  const p = spawn(BIN, args, { cwd: opts.cwd || tmp, env: { ...ENV, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
  p.on('close', code => res({ code, out }));
});
const json = s => { const i = s.indexOf('{'); return JSON.parse(s.slice(i)); };
// A long-running `scenecast ai …`: each @ai event to onEvent as it comes.
function aiProc(args, cwd, env, onEvent = () => {}) {
  const p = spawn(BIN, ['ai', ...args], { cwd, env: { ...ENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const events = []; let buf = '', err = '';
  p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.startsWith('@ai ')) { const e = JSON.parse(l.slice(4)); if (process.env.SCENECAST_AI_TRACE) console.log('  @ai ' + l.slice(4, 300)); events.push(e); onEvent(e); } } });
  p.stderr.on('data', d => { err += d; });
  return new Promise(res => p.on('close', code => res({ code, events, err, done: events.find(e => e.event === 'done'), error: events.find(e => e.event === 'error') })));
}


// The tasks app's pack (an external one, as a demo's own would be): its writes and what it sends while looked at. Its
// notes panel is a frame on a host of its own (hosts: a write opens it too).
const HOST = `127.0.0.1:${TASKS}`, NOTES_HOST = `127.0.0.1:${NOTES}`;
mkdirSync(join(tmp, 'packs', 'fixture-tasks'), { recursive: true });
// apiPath: new-task's API undo (as a private pack's), on the page's own session; null: none.
const writePack = ({ frameHost = true, apiPath = null } = {}) => writeFileSync(join(tmp, 'packs', 'fixture-tasks', 'pack.json'), JSON.stringify({
  kind: 'stuntdouble-app-pack', version: 1, id: 'fixture-tasks', title: 'Fixture Tasks', names: ['Tasks'], match: [HOST],
  writes: [
    { id: 'new-task', what: 'Adds a task', on: { kind: 'press', key: 'Enter', field: 'New task' }, makes: 'task', undo: { steps: ['Click "Delete {typed}"'], ...(apiPath ? { api: { use: 'tasks', method: 'DELETE', path: apiPath } } : {}) } },
    { id: 'delete-task', what: 'Deletes a task', on: { kind: 'click', target: '/^Delete /' }, undo: null },
    { id: 'sync', what: 'Turns Sync on or off', on: { kind: 'switch', target: 'Sync' }, undo: { same: 'sync' } },
    { id: 'pin-note', what: 'Pins the note', on: { kind: 'click', target: 'Pin note' }, undo: { steps: ['Click "Unpin note"'] } },
    { id: 'unpin-note', what: 'Unpins the note', on: { kind: 'click', target: 'Unpin note' }, undo: null },
  ],
  guard: { allow: [`${HOST}/api/telemetry`], ...(frameHost ? { hosts: [NOTES_HOST] } : {}) },
  apis: { tasks: { open: `http://${HOST}/`, host: HOST } },
}, null, 1));
writePack();

const PLAN = extra => `# Tasks demo

## Beat 1 · A new task

- Go to tasks
  Lands on: "No tasks yet"
- Type "Call Kestrel" in "New task"
  Lands on: box "New task" says "Call Kestrel"
- Press Enter — ask first
  Writes: adds the task "Call Kestrel" · fixture-tasks:new-task
  Lands on: "Task saved: Call Kestrel"

## Beat 2 · A look around

- Click "Refresh"
  Lands on: "Up to date: 1 task"
${extra}`;
const RESET = `# Reset: Tasks demo

## Undo · Tasks

- Go to tasks
- Click "Delete Call Kestrel"
  Undoes: beat 1, Press Enter

## Set first

- tasks: "Sync" is off
  Set: "Sync" · fixture-tasks:sync

## Check

- tasks: no "Call Kestrel"
- tasks: "Sync" is off
- tasks: shows "No tasks yet"
`;

const tasks = startTasks({ port: TASKS, notesPort: NOTES });
const fx = startFixture({ chatPort: CHAT, adminPort: ADMIN });
const procs = [];
let ctx = null;
async function newDemo(name, rx, capture, apps = [['tasks', tasks.url], ['admin', fx.admin]]) {
  const r = await run(['new', name, '--dir', tmp, '--title', 'Tasks demo', '--port', String(REPLICA_PORT), ...apps.flatMap(([id, url]) => ['--app', `${id}=${url}`])]);
  check(`${name}: scaffold`, r.code === 0, r.out);
  const DEMO = join(tmp, name);
  const cfg = JSON.parse(readFileSync(join(DEMO, 'demo.json'), 'utf8'));
  Object.assign(cfg, { raw: join(tmp, name + '-raw'), receiverPort: rx, viewport: { width: 1600, height: 900, dpr: 1 }, zooms: [150] });
  Object.assign(cfg.record, { settleMs: 1200, typeIdleMs: 700, everyMs: 250, streamMinMs: 1200, auto: { hoverMax: 6, clickMax: 3, maxS: 25, zoom: false, drags: false, chips: false } });
  if (capture) Object.assign(cfg, { recorder: 'capture', capture: { guard: 'hold', profile: join(tmp, 'capture-profile'), window: process.env.SCENECAST_CAPTURE_WINDOW || 'auto', ...(process.env.CI ? { mockKeychain: true } : {}) } });
  writeFileSync(join(DEMO, 'demo.json'), JSON.stringify(cfg, null, 2));
  writeFileSync(join(DEMO, 'plan.md'), PLAN(''));
  if (capture) writeFileSync(join(DEMO, 'reset.md'), RESET);
  procs.push(spawn(BIN, ['receiver', '--demo', DEMO], { cwd: DEMO, env: { ...ENV, REPLICA_RX_PORT: String(rx) }, stdio: 'ignore' }));
  return DEMO;
}
const count = (log, line) => log.filter(l => l === line).length;
const readRun = DEMO => JSON.parse(readFileSync(join(DEMO, '.out', 'ai', 'run.json'), 'utf8'));

try {
  // ---- The capture browser, the approved plan, nobody there --------------------------------------------------------
  const DEMO = await newDemo('run', RX, true);
  const E = { REPLICA_RX_PORT: String(RX) };
  let t0 = Date.now();
  const pf = json((await run(['preflight', '--json'], { cwd: DEMO, env: E })).out);
  times.preflight = Math.round((Date.now() - t0) / 1000);
  check('preflight starts the capture browser with both apps', pf.ready, JSON.stringify(pf));
  let r = await run(['ai', 'approve', '--demo', DEMO], { env: E });
  check('the plan and its reset approved, every write listed', r.code === 0 && /new-task/.test(readFileSync(join(DEMO, '.out', 'ai', 'approved.json'), 'utf8')), r.out);

  // 1 · What an earlier run left: a task, Sync on. The reset puts it back first; the write runs as approved.
  tasks.seed({ tasks: ['Call Kestrel'], sync: true });
  tasks.log.length = 0;
  t0 = Date.now();
  let res = await aiProc(['record', '--demo', DEMO, '--unattended', '--checked'], DEMO, E);
  times.run = Math.round((Date.now() - t0) / 1000);
  let rj = existsSync(join(DEMO, '.out', 'ai', 'run.json')) ? readRun(DEMO) : {};
  check('runs the approved plan to the end, unattended', res.code === 0 && res.done && !res.done.result.stopped && res.done.result.writes === 1, JSON.stringify({ code: res.code, err: res.err.slice(-1500), stopped: rj.stopped, done: res.done }));
  check('the reset before: the leftover task deleted, Sync turned off, then checked', rj.reset && rj.reset.before && rj.reset.before.ok && rj.reset.before.did.join('|') === 'tasks: Click "Delete Call Kestrel"|tasks: Click "Sync"', JSON.stringify(rj.reset && rj.reset.before));
  const w = (rj.writes || [])[0] || {};
  check('the approved write ran, and run.json keeps what it made (for the undo)', w.write === 'new-task' && w.result && w.result.ids.length === 1 && /^\d{6}$/.test(w.result.ids[0]) && w.result.typed === 'Call Kestrel', JSON.stringify(w));
  const held = (rj.guard && rj.guard.held) || [];
  check('the guard held the read-only step\'s POST, and it never reached the server', held.some(h => h.method === 'POST' && h.path === '/api/refresh' && h.held) && !tasks.log.includes('POST /api/refresh') && tasks.state().refreshes === 0, JSON.stringify({ held, log: tasks.log }));
  check('the pack\'s allow-list let the app\'s telemetry through', tasks.log.includes('POST /api/telemetry') && !held.some(h => h.path === '/api/telemetry'), JSON.stringify({ held, log: tasks.log }));
  check('the server saw exactly the writes approved: one task, two deletes (before and after), Sync once', count(tasks.log, 'POST /api/tasks') === 1 && count(tasks.log, 'DELETE /api/tasks/{id}') === 2 && count(tasks.log, 'POST /api/sync') === 1, tasks.log.join(', '));
  check('the reset after: the demo as it started', rj.reset.after && rj.reset.after.ok && tasks.state().tasks.length === 0 && tasks.state().sync === false, JSON.stringify({ after: rj.reset.after, state: tasks.state() }));
  const recA = existsSync(join(tmp, 'run-raw', 'recording.json')) ? JSON.parse(readFileSync(join(tmp, 'run-raw', 'recording.json'), 'utf8')) : null;
  check('the recording is the recorder\'s own (raw/recording.json)', recA && Object.keys(recA.states || {}).length >= 3, recA ? Object.keys(recA.states).join(', ') : readdirSync(join(tmp)).join(', '));
  if (recA) cpSync(join(tmp, 'run-raw'), join(tmp, 'raw-unattended'), { recursive: true });
  // The two apps' start sweeps ran side by side (each in its own window).
  const sweeps = ((recA && recA.timeline) || []).filter(t => t.what === 'sweep' && t.why === 'start');
  const spans = ['tasks', 'admin'].map(a => { const s = sweeps.filter(t => t.app === a); return s.length ? [Math.min(...s.map(t => t.at)), Math.max(...s.map(t => t.at + (t.ms || 0)))] : null; });
  check('the start sweeps of both apps ran side by side', spans.every(Boolean) && spans[0][0] < spans[1][1] && spans[1][0] < spans[0][1], JSON.stringify({ spans, n: sweeps.length }));
  times.startSweeps = spans.every(Boolean) ? +((Math.max(spans[0][1], spans[1][1]) - Math.min(spans[0][0], spans[1][0])) / 1000).toFixed(1) : null;

  // 1b · The reader (what plans name controls by) and a live page name every control on the run's recorded screens
  // alike: built, served, and read both ways (name-parity.mjs).
  const builtRun = await run(['build', '--from-raw'], { cwd: DEMO, env: E });
  const np = builtRun.code === 0 ? await nameParity({ demo: DEMO, port: PARITY_PORT }).catch(e => ({ error: e.message })) : null;
  check('the reader and the served replica name every recorded control alike', np && !np.error && np.screens > 0 && np.differ.length === 0, JSON.stringify(np || builtRun.out.slice(-800)));

  // 1c · A write inside a frame (the notes panel, on its own host): the reader agrees about its control in that frame's
  // markup, the click is hit-tested through the frame, and the guard opens the app's hosts with the frame's (the
  // pack's hosts) for that one step. The reset after unpins it, in the frame too.
  const PIN_PLAN = `# Tasks demo\n\n## Beat 1 · A pinned note\n\n- Go to tasks\n  Lands on: "No tasks yet"\n- Click "Pin note" — ask first\n  Writes: pins the note · fixture-tasks:pin-note\n  Lands on: "Note is pinned"\n`;
  const PIN_RESET = `# Reset: Tasks demo\n\n## Undo · Tasks\n\n- Go to tasks\n- Click "Unpin note"\n  Undoes: beat 1, Click "Pin note"\n\n## Check\n\n- tasks: no "Note is pinned"\n`;
  writeFileSync(join(DEMO, 'plan.md'), PIN_PLAN); writeFileSync(join(DEMO, 'reset.md'), PIN_RESET);
  await run(['ai', 'approve', '--demo', DEMO], { env: E });
  tasks.log.length = 0;
  res = await aiProc(['record', '--demo', DEMO, '--unattended', '--checked'], DEMO, E);
  rj = readRun(DEMO);
  const pinIn = (rj.inputs || []).find(i => i.kind === 'click' && i.on === 'Pin note');
  check('a write inside a frame: the reader agrees in its frame, the click lands on it, the guard opens the frame\'s host for it', res.code === 0 && !rj.stopped && rj.writes.length === 1 && rj.writes[0].write === 'pin-note' && count(tasks.log, 'POST notes/api/pin') === 1 && pinIn && pinIn.frame === NOTES_HOST && pinIn.landed && pinIn.landed.frame === NOTES_HOST, JSON.stringify({ stopped: rj.stopped, writes: rj.writes, pinIn, log: tasks.log.filter(l => !l.startsWith('GET')) }));
  check('and the reset after unpins it, in the frame', count(tasks.log, 'POST notes/api/unpin') === 1 && rj.reset.after && rj.reset.after.ok && tasks.state().pinned === false, JSON.stringify({ after: rj.reset.after, state: tasks.state() }));
  // Without the frame's host in the pack, the write's POST to it is held: it never reaches the notes server.
  writePack({ frameHost: false });
  tasks.log.length = 0;
  res = await aiProc(['record', '--demo', DEMO, '--unattended', '--checked'], DEMO, E);
  rj = readRun(DEMO);
  check('a frame\'s host the pack doesn\'t name stays held: the write never reaches it, and the run stops', rj.stopped && count(tasks.log, 'POST notes/api/pin') === 0 && tasks.state().pinned === false && (rj.guard.held || []).some(h => h.host === NOTES_HOST && h.path === '/api/pin'), JSON.stringify({ stopped: rj.stopped, held: (rj.guard.held || []).filter(h => h.host === NOTES_HOST), log: tasks.log.filter(l => !l.startsWith('GET')) }));
  writePack();
  writeFileSync(join(DEMO, 'reset.md'), RESET);

  // 1d · An API undo (a private pack's): "Undo with the app pack" runs the pack's call in the page's own signed-in
  // session (the server refuses a delete without it), with the task id the run recorded. If it can't (here, a path
  // the server doesn't know), the Note's steps run instead, as approved.
  const RESET_API = RESET.replace('- Click "Delete Call Kestrel"\n  Undoes: beat 1, Press Enter', '- Undo with the app pack: fixture-tasks:new-task\n  Undoes: beat 1, Press Enter\n  Note: an API call in the capture browser\'s own signed-in session, with {taskId} from the run; if it can\'t: Click "Delete {typed}"');
  writeFileSync(join(DEMO, 'plan.md'), PLAN('')); writeFileSync(join(DEMO, 'reset.md'), RESET_API);
  writePack({ apiPath: '/api/tasks/{taskId}' });
  await run(['ai', 'approve', '--demo', DEMO], { env: E });
  tasks.log.length = 0;
  res = await aiProc(['record', '--demo', DEMO, '--unattended', '--checked'], DEMO, E);
  rj = readRun(DEMO);
  const apiDid = ((rj.reset.after || {}).did || []).join(' | ');
  check('an API undo: the run\'s task deleted by the pack\'s call, in the page\'s own session', !rj.stopped && rj.reset.after && rj.reset.after.ok && /Undo with the app pack: fixture-tasks:new-task \(DELETE, 200\)/.test(apiDid) && count(tasks.log, 'DELETE /api/tasks/{id}') === 1 && !tasks.log.some(l => / 401$/.test(l)) && tasks.state().tasks.length === 0, JSON.stringify({ stopped: rj.stopped, after: rj.reset.after, log: tasks.log.filter(l => !l.startsWith('GET')) }));
  writePack({ apiPath: '/api/nope/{taskId}' });
  tasks.log.length = 0;
  res = await aiProc(['record', '--demo', DEMO, '--unattended', '--checked'], DEMO, E);
  rj = readRun(DEMO);
  const fbDid = ((rj.reset.after || {}).did || []).join(' | ');
  check('and when the call can\'t, the Note\'s steps undo it', !rj.stopped && rj.reset.after && rj.reset.after.ok && /Click "Delete Call Kestrel"/.test(fbDid) && count(tasks.log, 'DELETE /api/nope/{id}') === 1 && count(tasks.log, 'DELETE /api/tasks/{id}') === 1 && tasks.state().tasks.length === 0, JSON.stringify({ after: rj.reset.after, log: tasks.log.filter(l => !l.startsWith('GET')) }));
  writePack();
  writeFileSync(join(DEMO, 'reset.md'), RESET);

  // 1e · The capture start waits for each app's sign-in to settle (capture.signInSettleS, 60 s by default) before the
  // tenant check, and still refuses when it never does.
  const TID = '11111111-2222-3333-4444-555555555555';
  const SIGN = await newDemo('signin', RX_SIGN, true, [['tasks', `${tasks.url}?signin=25000&tid=${TID}`]]);
  const signCfg = (url, profile, settle) => { const f = join(SIGN, 'demo.json'), c = JSON.parse(readFileSync(f, 'utf8')); c.apps[0].url = url; Object.assign(c.capture, { tenant: TID, profile: join(tmp, profile) }); if (settle) c.capture.signInSettleS = settle; else delete c.capture.signInSettleS; writeFileSync(f, JSON.stringify(c, null, 2)); };
  const SE = { REPLICA_RX_PORT: String(RX_SIGN) };
  signCfg(`${tasks.url}?signin=25000&tid=${TID}`, 'signin-profile-1', null);
  let sst = json((await run(['capture', 'start', '--demo', SIGN], { env: SE })).out);
  check('the capture start waits for a sign-in that takes 25 s, and goes on', sst.ok === true, JSON.stringify(sst));
  await run(['capture', 'stop', '--demo', SIGN], { env: SE });
  signCfg(`${tasks.url}?signin=never&tid=${TID}`, 'signin-profile-2', 12);
  sst = json((await run(['capture', 'start', '--demo', SIGN], { env: SE })).out);
  check('and refuses when it never settles', sst.ok === false && /couldn't tell which tenant tasks is signed in to/.test(sst.error || ''), JSON.stringify(sst));
  await run(['capture', 'stop', '--demo', SIGN], { env: SE });

  // 2 · A write the plan didn't approve: the run stops before it, with a picture; nothing reaches the server.
  writeFileSync(join(DEMO, 'plan.md'), PLAN('- Click "Archive all"\n'));
  await run(['ai', 'approve', '--demo', DEMO], { env: E });
  tasks.log.length = 0;
  res = await aiProc(['record', '--demo', DEMO, '--unattended', '--checked'], DEMO, E);
  rj = readRun(DEMO);
  check('a write that isn\'t approved stops the run before it, with a picture', rj.stopped && rj.stopped.kind === 'unapproved' && /Archive all/.test(rj.stopped.why) && rj.stopped.picture && existsSync(rj.stopped.picture), JSON.stringify(rj.stopped));
  check('and it never reached the server; the reset after deleted the run\'s task', tasks.state().archives === 0 && !tasks.log.includes('POST /api/archive') && rj.reset.after && rj.reset.after.ok && tasks.state().tasks.length === 0, JSON.stringify({ state: tasks.state(), log: tasks.log, after: rj.reset.after }));

  // 3 · A step that leaves the app: it stops, with a picture.
  writeFileSync(join(DEMO, 'plan.md'), PLAN('- Click "Help"\n  Lands on: "Tasks"\n'));
  await run(['ai', 'approve', '--demo', DEMO], { env: E });
  res = await aiProc(['record', '--demo', DEMO, '--unattended', '--checked'], DEMO, E);
  rj = readRun(DEMO);
  check('leaving the app (another host) stops the run, with a picture', rj.stopped && rj.stopped.kind === 'offplan' && /localhost/.test(rj.stopped.why) && rj.stopped.picture && existsSync(rj.stopped.picture), JSON.stringify(rj.stopped));
  check('and the reset after still puts it back', rj.reset.after && rj.reset.after.ok && tasks.state().tasks.length === 0, JSON.stringify({ state: tasks.state(), after: rj.reset.after }));

  // 3b · A step it can't prove (its words were on the screen before it): logged, and the run goes on only by the next
  // step's control (one, by its exact name), never into a write. A walk notes it as unproven.
  const UNPROVEN = PLAN('- Click "Refresh"\n  Lands on: "Up to date: 1 task"\n- Click "Delete Call Kestrel"\n  Writes: deletes the task "Call Kestrel" · fixture-tasks:delete-task\n  Lands on: "No tasks yet"\n').replace('Lands on: "Up to date: 1 task"', 'Lands on: "Sync is off"');
  writeFileSync(join(DEMO, 'plan.md'), UNPROVEN);
  await run(['ai', 'approve', '--demo', DEMO], { env: E });
  tasks.log.length = 0;
  res = await aiProc(['record', '--demo', DEMO, '--unattended', '--checked'], DEMO, E);
  rj = readRun(DEMO);
  const un = (rj.unprovable || []).map(u => u.text);
  check('a step it can\'t prove: it goes on by the next control, and stops before a write, with a picture', rj.stopped && rj.stopped.kind === 'unprovable' && /a write never follows/.test(rj.stopped.why) && /Delete Call Kestrel/.test(rj.stopped.at && rj.stopped.at.text || '') && rj.stopped.picture && existsSync(rj.stopped.picture) && un.length === 2 && un.every(t => t === 'Click "Refresh"'), JSON.stringify({ stopped: rj.stopped, unprovable: rj.unprovable }));
  check('and the delete never ran: the reset after removed the run\'s task', count(tasks.log, 'DELETE /api/tasks/{id}') === 1 && rj.reset.after && rj.reset.after.ok && tasks.state().tasks.length === 0, JSON.stringify({ log: tasks.log, after: rj.reset.after }));
  res = await aiProc(['walk', '--demo', DEMO, '--live'], DEMO, E);
  const wu = existsSync(join(DEMO, '.out', 'ai', 'walk.json')) ? JSON.parse(readFileSync(join(DEMO, '.out', 'ai', 'walk.json'), 'utf8')) : { beats: [] };
  const su = (wu.beats[1] && wu.beats[1].steps[0]) || {};
  check('and a walk reports it as unproven, with every input it sent and what each click hit', su.status === 'unproven' && (wu.inputs || []).some(i => i.kind === 'click' && i.on === 'Refresh' && i.fit === 'exact' && i.frame === 'page' && i.landed && i.landed.on === 'Refresh' && i.landed.role === 'button'), JSON.stringify({ su, inputs: wu.inputs }));

  // 4 · An edit after the approval: nothing runs.
  writeFileSync(join(DEMO, 'plan.md'), PLAN('').replace('Call Kestrel"', 'Call Kestrel now"'));
  tasks.log.length = 0;
  res = await aiProc(['record', '--demo', DEMO, '--unattended', '--checked'], DEMO, E);
  check('a plan edited after its approval doesn\'t run at all', res.code !== 0 && res.error && /approve the plan first/.test(res.error.message || res.error.text || JSON.stringify(res.error)) && !tasks.log.some(l => !l.startsWith('GET')), JSON.stringify({ code: res.code, error: res.error, log: tasks.log }));

  // 5 · A read-only live walk: at the write it skips the rest of that beat and goes on.
  writeFileSync(join(DEMO, 'plan.md'), PLAN(''));
  tasks.log.length = 0;
  res = await aiProc(['walk', '--demo', DEMO, '--live'], DEMO, E);
  const wj = existsSync(join(DEMO, '.out', 'ai', 'walk.json')) ? JSON.parse(readFileSync(join(DEMO, '.out', 'ai', 'walk.json'), 'utf8')) : { beats: [] };
  const st = wj.beats.map(b => b.steps.map(s => s.status).join(','));
  check('a live walk: reached, then the write not run, then the next beat (its words need that write)', res.code === 0 && st[0] === 'reached,reached,write' && st[1] === 'drifted' && /Up to date: 1 task/.test(wj.beats[1].steps[0].why || '') && wj.beats[1].steps[0].needs === 'beat 1\'s write: Press Enter', JSON.stringify({ st, b2: wj.beats[1], err: res.err.slice(-800) }));
  check('and it wrote nothing', !tasks.log.some(l => !l.startsWith('GET') && l !== 'POST /api/telemetry') && tasks.state().tasks.length === 0, tasks.log.join(', '));
  const typedScreen = (() => { try { return JSON.parse(readFileSync(join(DEMO, '.out', 'ai', 'walk-screens', '1-2.json'), 'utf8')); } catch (e) { return null; } })();
  check('and it kept each screen it landed on: its words, its controls, what a box holds', typedScreen && typedScreen.words.includes('No tasks yet') && typedScreen.controls.some(c => c.name === 'New task' && c.role === 'textbox' && c.value === 'Call Kestrel') && typedScreen.controls.some(c => c.name === 'Pin note' && c.frame === NOTES_HOST), JSON.stringify(typedScreen && { words: typedScreen.words.slice(0, 6), controls: typedScreen.controls.slice(0, 12) }));
  const cl = (wj.beats[0] && wj.beats[0].steps[2] && wj.beats[0].steps[2].cleared) || {};
  check('the beat stopped at the write: what it typed for it is cleared, no draft left', cl.cleared === true && cl.in === 'New task', JSON.stringify(wj.beats[0] && wj.beats[0].steps[2]));
  await run(['capture', 'stop', '--demo', DEMO], { env: E });

  // ---- 6 · The same plan through the recorder extension: the same screens -------------------------------------------
  if (withExtension) {
    const EXT = await newDemo('ext', RX_EXT, false);
    const X = { REPLICA_RX_PORT: String(RX_EXT) };
    r = await run(['extension', join(tmp, 'ext-build')], { env: X });
    const ext = join(tmp, 'ext-build');
    // Never the app's receiver: built for this test's port only.
    const built = existsSync(join(ext, 'sw.js')) ? readFileSync(join(ext, 'sw.js'), 'utf8') : '';
    check('extension builds, for this test\'s receiver only', r.code === 0 && built.includes(`const DEFAULT_PORT = ${RX_EXT};`), r.out);
    if (!built.includes(`const DEFAULT_PORT = ${RX_EXT};`)) throw new Error('the extension isn\'t built for this test\'s receiver');
    ctx = await chromium.launchPersistentContext(join(tmp, 'ext-profile'), { channel: 'chromium', headless: true, viewport: null, colorScheme: 'light', ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--silent-debugger-extension-api', '--force-device-scale-factor=1', '--window-size=1700,1100', '--screen-info={0,0 2560x1600}', '--disable-features=DisableLoadExtensionCommandLineSwitch', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
    if (!ctx.serviceWorkers().length) await ctx.waitForEvent('serviceworker', { timeout: 30000 });
    const page = await ctx.newPage(); await page.goto(tasks.url);
    for (const p of ctx.pages()) if (p !== page) await p.close();
    const s = await ctx.newCDPSession(page);
    const { windowId } = await s.send('Browser.getWindowForTarget');
    for (let i = 0; i < 4; i++) { const [iw, ih, ow, oh] = await page.evaluate(() => [innerWidth, innerHeight, outerWidth, outerHeight]); if (iw === 1600 && ih === 900) break; await s.send('Browser.setWindowBounds', { windowId, bounds: { width: ow + 1600 - iw, height: oh + 900 - ih } }); await sleep(300); }
    const admin = await ctx.newPage(); await admin.goto(fx.admin);
    await page.bringToFront();
    let e = {};
    for (let i = 0; i < 60 && !e.version; i++) { await sleep(500); try { e = json((await run(['cmd', 'extension'], { cwd: EXT, env: X })).out); } catch (er) { e = {}; } }
    check('extension: the recorder connects', !!e.version, JSON.stringify(e));
    // The same start as the unattended run's recording had (its reset before: no tasks, Sync off; the same next id).
    tasks.seed({ tasks: [], sync: false, next: +w.result.ids[0] });
    await page.reload();
    res = await aiProc(['record', '--demo', EXT, '--checked'], EXT, X, async ev => { if (ev.event === 'confirm' || ev.event === 'question') await run(['ai', 'answer', '--demo', EXT, ev.id, 'do'], { env: X }); });
    check('extension: Record for me runs the same plan', res.code === 0 && res.done && !res.done.result.stopped, JSON.stringify({ code: res.code, err: res.err.slice(-1500), events: res.events.filter(x => /error|stopped|done/.test(x.event)) }));
    const recB = existsSync(join(tmp, 'ext-raw', 'recording.json')) ? JSON.parse(readFileSync(join(tmp, 'ext-raw', 'recording.json'), 'utf8')) : null;
    const diff = compareRaw(join(tmp, 'raw-unattended'), join(tmp, 'ext-raw'), recA, recB);
    console.log('raw compared: ' + JSON.stringify(diff));
    check('the same raw recording as the extension path: screens, steps, snapshots', diff.ok, JSON.stringify(diff));
  }
} catch (e) { check('ran to the end', false, e.stack); }
finally {
  for (const port of [RX, RX_EXT, RX_SIGN]) await fetch(`http://127.0.0.1:${port}/quit`, { method: 'POST' }).catch(() => {});
  for (const d of ['run', 'ext', 'signin']) if (existsSync(join(tmp, d))) await run(['capture', 'stop', '--demo', join(tmp, d)], { env: { REPLICA_RX_PORT: String(d === 'run' ? RX : d === 'signin' ? RX_SIGN : RX_EXT) } }).catch(() => {});
  if (ctx) await ctx.close().catch(() => {});
  await sleep(500);
  for (const p of procs) try { p.kill(); } catch (e) {}
  tasks.close(); fx.close();
  console.log('times (s): ' + JSON.stringify(times));
  if (keep) console.log('kept: ' + tmp); else rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
}
console.log(fails.length ? `${fails.length} FAILED: ${fails.join('; ')}` : 'capture run: all passed');
process.exit(fails.length ? 1 : 0);

// Two raw recordings of the same plan: the same screens (by signature), the same steps, the same snapshots (ids in
// addresses aside), the same pictures by name.
function compareRaw(dirA, dirB, a, b) {
  if (!a || !b) return { ok: false, why: `no recording.json in ${!a ? dirA : dirB}` };
  const sigs = r => Object.values(r.states || {}).map(s => s.sig).filter(Boolean).sort();
  const steps = r => (r.path || []).map(p => p.click ? 'click' : p.key ? `key ${p.key}` : p.type ? 'type' : Object.keys(p).filter(k => k !== 't' && k !== 'checkpoint').join('+')).join(' ');
  const files = d => existsSync(d) ? readdirSync(d).sort() : [];
  const snapsA = files(join(dirA, 'snaps')), snapsB = files(join(dirB, 'snaps'));
  const strip = t => t.replace(/\b1\d{5}\b/g, '{id}').replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '{at}').replace(/"(t|at|savedAt|ms|secs|time)":\s*[\d.]+/g, '"$1":0');
  // Keys in one order (the two paths put a snapshot's together in a different order).
  const canon = v => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
  const read = (d, f) => strip(JSON.stringify(canon(JSON.parse(readFileSync(join(d, 'snaps', f), 'utf8')))));
  const differ = snapsA.filter(f => snapsB.includes(f) && f.endsWith('.json') && read(dirA, f) !== read(dirB, f));
  const out = {
    states: [Object.keys(a.states).length, Object.keys(b.states).length], sameSigs: JSON.stringify(sigs(a)) === JSON.stringify(sigs(b)),
    steps: [steps(a), steps(b)], sameSteps: steps(a) === steps(b),
    snaps: [snapsA.length, snapsB.length], onlyA: snapsA.filter(f => !snapsB.includes(f)).slice(0, 8), onlyB: snapsB.filter(f => !snapsA.includes(f)).slice(0, 8), differ: differ.slice(0, 8),
    shots: [files(join(dirA, 'shots')).length, files(join(dirB, 'shots')).length],
  };
  out.ok = out.sameSigs && out.sameSteps && !out.onlyA.length && !out.onlyB.length && !differ.length;
  return out;
}
