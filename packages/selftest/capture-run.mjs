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
import { endTree } from './reap.mjs';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, readdirSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startTasks, startFixture } from '../../examples/fixture-app/server.mjs';
import { browserApp } from '@stuntdouble/capture/browser.mjs';
import { selftestGuard } from './guard.mjs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readScreen } from '@scenecast/script/html.mjs';
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
// Each CLI run has a time limit: one that runs over is ended (its whole tree) and reported as
// "FAIL timed out in <what>, after <its last line>", and the test goes on, so a hang shows where it stopped.
const lastLine = t => (String(t || '').split('\n').map(l => l.trim()).filter(Boolean).pop() || 'no output').slice(0, 300);
const limited = (p, what, limitS, last) => {
  const t = setTimeout(() => { const name = `timed out in ${what} (${limitS} s), after ${last()}`; console.log('FAIL ' + name); fails.push(name); endTree(p); }, limitS * 1000);
  p.on('close', () => clearTimeout(t));
};
const run = (args, opts = {}) => new Promise(res => {
  const p = spawn(BIN, args, { cwd: opts.cwd || tmp, env: { ...ENV, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
  limited(p, `scenecast ${args.slice(0, 2).join(' ')}`, opts.limitS || 300, () => lastLine(out));
  p.on('close', code => res({ code, out }));
});
const json = s => { const i = s.indexOf('{'); return JSON.parse(s.slice(i)); };
// A long-running `scenecast ai …`: each @ai event to onEvent as it comes.
function aiProc(args, cwd, env, onEvent = () => {}, limitS = 480) {
  const p = spawn(BIN, ['ai', ...args], { cwd, env: { ...ENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const events = []; let buf = '', err = '';
  limited(p, `scenecast ai ${args[0]}`, limitS, () => events.length ? JSON.stringify(events[events.length - 1]).slice(0, 300) : lastLine(err));
  p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.startsWith('@ai ')) { const e = { ...JSON.parse(l.slice(4)), t: Date.now() }; if (process.env.SCENECAST_AI_TRACE) console.log('  @ai ' + l.slice(4, 300)); events.push(e); onEvent(e); } } });
  p.stderr.on('data', d => { err += d; });
  return new Promise(res => p.on('close', code => res({ code, events, err, done: events.find(e => e.event === 'done'), error: events.find(e => e.event === 'error') })));
}


// The tasks app's pack (an external one, as a demo's own would be): its writes and what it sends while looked at. Its
// notes panel is a frame on a host of its own (hosts: a write opens it too).
const HOST = `127.0.0.1:${TASKS}`, NOTES_HOST = `127.0.0.1:${NOTES}`;
mkdirSync(join(tmp, 'packs', 'fixture-tasks'), { recursive: true });
// apiPath: new-task's API undo (as a private pack's), on the page's own session; null: none. notesApi: pin-note's, on
// the notes frame's session.
// filters: Leave out's two kinds, a response's list (Suggested, ordered by refs) and a list the page draws from its own
// store (Teams).
const writePack = ({ frameHost = true, apiPath = null, notesApi = false, stayHeld = null, taskCheck = false, filters = false } = {}) => writeFileSync(join(tmp, 'packs', 'fixture-tasks', 'pack.json'), JSON.stringify({
  kind: 'stuntdouble-app-pack', version: 1, id: 'fixture-tasks', title: 'Fixture Tasks', names: ['Tasks'], match: [HOST],
  writes: [
    { id: 'new-task', what: 'Adds a task', on: { kind: 'press', key: 'Enter', field: 'New task' }, makes: 'task', undo: { steps: ['Click "Delete {typed}"'], ...(apiPath ? { api: { use: 'tasks', method: 'DELETE', path: apiPath } } : {}) }, ...(taskCheck ? { check: { api: { use: 'tasks', method: 'GET', path: '/api/tasks', made: 200 } } } : {}) },
    { id: 'delete-task', what: 'Deletes a task', on: { kind: 'click', target: '/^Delete /' }, undo: null },
    { id: 'sync', what: 'Turns Sync on or off', on: { kind: 'switch', target: 'Sync' }, undo: { same: 'sync' } },
    { id: 'pin-note', what: 'Pins the note', on: { kind: 'click', target: 'Pin note' }, undo: { steps: ['Click "Unpin note"'], ...(notesApi ? { api: { use: 'notes', method: 'POST', path: '/api/unpin' } } : {}) }, check: { api: { use: 'notes', method: 'GET', path: '/api/note', made: { pinned: true } } } },
    { id: 'unpin-note', what: 'Unpins the note', on: { kind: 'click', target: 'Unpin note' }, undo: null },
  ],
  guard: { allow: [`${HOST}/api/telemetry`], ...(frameHost ? { hosts: [NOTES_HOST] } : {}), ...(stayHeld ? { stayHeld } : {}) },
  apis: { tasks: { open: `http://${HOST}/`, host: HOST }, notes: { open: `http://${HOST}/`, host: NOTES_HOST, from: NOTES_HOST } },
  services: [{ name: "Tasks' catalog service", match: `/^GET ${HOST.replace(/\./g, '\\.')}\\/api\\/catalog$/`, start: true, waitS: 20 }],
  ...(filters ? { filters: [
    { id: 'suggested', why: 'The Suggested list: GET /api/suggested, items by ref, drawn in order\'s order.', url: `*://${HOST}/api/suggested*`, match: `/^GET ${HOST.replace(/\./g, '\\.')}\\/api\\/suggested$/`, items: 'items', fields: ['name'], refs: [{ list: 'order', by: 'ref' }], shows: 'name' },
    { id: 'team-tree', kind: 'dom', why: 'The Teams tree, drawn from the page\'s own store.', list: '[role=tree] [role=treeitem][aria-level="2"]' },
  ] } : {}),
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
// A run's time by part, from its own events (each stamped as it came): the reset before, the start (apps, services,
// start sweeps), the steps (screen sweeps included), saving the recording, the reset after.
const partsOf = evs => {
  const at = f => (evs.find(f) || {}).t, rb = at(e => e.event === 'stage' && e.name === 'reset-before'), st = at(e => e.event === 'stage' && e.name === 'start');
  const b0 = at(e => e.event === 'beat'), sp = at(e => e.event === 'stage' && e.name === 'stop'), ra = at(e => e.event === 'stage' && e.name === 'reset-after'), end = at(e => e.event === 'done');
  const d = (a, b) => a && b ? +((b - a) / 1000).toFixed(1) : null;
  return { resetBefore: d(rb, st), start: d(st, b0), steps: d(b0, sp), stop: d(sp, ra), resetAfter: d(ra, end) };
};

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
  times.parts = partsOf(res.events);
  let rj = existsSync(join(DEMO, '.out', 'ai', 'run.json')) ? readRun(DEMO) : {};
  check('runs the approved plan to the end, unattended', res.code === 0 && res.done && !res.done.result.stopped && res.done.result.writes === 1, JSON.stringify({ code: res.code, err: res.err.slice(-1500), stopped: rj.stopped, done: res.done }));
  check('the start waited for the app\'s own call to its named service, and it answered', (rj.services || []).some(n => n.service === "Tasks' catalog service" && n.status === 200 && n.app === 'tasks'), JSON.stringify(rj.services));
  const L = rj.landings || [], wroteAt = L.findIndex(l => l.wrote);
  check('each landing proven on the live page, with its strength; the write only after strong ones', L.length >= 4 && L.every(l => ['strong', 'weak', 'none'].includes(l.strength) && l.got) && wroteAt === 2 && L.slice(0, wroteAt).every(l => l.strength === 'strong') && (rj.needsYou || []).length === 0, JSON.stringify(L.map(l => [l.step, l.strength, l.basis, l.got && l.got.text, l.why])));
  // One read per screen for all its lines, and Set first read before it sets: before, the check, Set first's page,
  // Sync's own read as it's set, the check again; after, Set first's page and the check (Sync is already off).
  times.reset = { before: [rj.reset.before && rj.reset.before.secs, rj.reset.before && rj.reset.before.reads], after: [rj.reset.after && rj.reset.after.secs, rj.reset.after && rj.reset.after.reads] };
  check('the reset reads each screen once for all its lines, and sets only what isn\'t so', rj.reset.before && rj.reset.before.reads === 4 && rj.reset.after && rj.reset.after.reads === 2, JSON.stringify(times.reset));
  // Reads per step: the read before is the last step's read after when nothing ran between; a second read after only
  // where the first didn't prove the landing strongly.
  times.reads = rj.reads;
  check('a step\'s read before reuses the last step\'s read after when nothing ran between, and a strong landing is read once', rj.reads && rj.reads.before.reused >= 2 && rj.reads.after.one >= 2 && rj.reads.after.one + rj.reads.after.two === (rj.landings || []).length, JSON.stringify({ reads: rj.reads, landings: (rj.landings || []).map(l => [l.step, l.strength]) }));
  check('the reset before: the leftover task deleted, Sync turned off, then checked', rj.reset && rj.reset.before && rj.reset.before.ok && rj.reset.before.did.join('|') === 'tasks: Click "Delete Call Kestrel"|tasks: Click "Sync"', JSON.stringify(rj.reset && rj.reset.before));
  const w = (rj.writes || [])[0] || {};
  check('the approved write ran, and run.json keeps what it made (for the undo)', w.write === 'new-task' && w.result && w.result.ids.length === 1 && /^\d{6}$/.test(w.result.ids[0]) && w.result.typed === 'Call Kestrel', JSON.stringify(w));
  const held = (rj.guard && rj.guard.held) || [];
  check('the guard held the read-only step\'s POST, and it never reached the server', held.some(h => h.method === 'POST' && h.path === '/api/refresh' && h.held) && !tasks.log.includes('POST /api/refresh') && tasks.state().refreshes === 0, JSON.stringify({ held, log: tasks.log }));
  const tele = (rj.guard.passed || []).find(p => p.path === '/api/telemetry');
  check('a passed non-read names the allow entry that let it through, and its app', tele && tele.by === 'allowed' && tele.entry === `${HOST}/api/telemetry` && tele.app === 'tasks' && tele.tab === HOST, JSON.stringify(tele));
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
  const pinLand = (rj.landings || []).find(l => l.step === 'Click "Pin note"');
  check('after a write, its pack\'s read-only check passing is a strong landing', pinLand && pinLand.wrote && pinLand.strength === 'strong' && pinLand.basis === 'pack check' && pinLand.check && pinLand.check.picked && pinLand.check.picked.pinned === true, JSON.stringify(pinLand));
  check('and the reset after unpins it, in the frame', count(tasks.log, 'POST notes/api/unpin') === 1 && rj.reset.after && rj.reset.after.ok && tasks.state().pinned === false, JSON.stringify({ after: rj.reset.after, state: tasks.state() }));
  // Without the frame's host in the pack, the write's POST to it is held: it never reaches the notes server.
  writePack({ frameHost: false });
  tasks.log.length = 0;
  res = await aiProc(['record', '--demo', DEMO, '--unattended', '--checked'], DEMO, E);
  rj = readRun(DEMO);
  const pinHeld = (rj.guard.held || []).find(h => h.host === NOTES_HOST && h.path === '/api/pin');
  check('a held request names the tab, the frame and the app it came from', pinHeld && pinHeld.tab === HOST && pinHeld.frame === NOTES_HOST && pinHeld.app === 'tasks', JSON.stringify(pinHeld));
  check('a frame\'s host the pack doesn\'t name stays held: the write never reaches it, and the run stops', rj.stopped && count(tasks.log, 'POST notes/api/pin') === 0 && tasks.state().pinned === false && (rj.guard.held || []).some(h => h.host === NOTES_HOST && h.path === '/api/pin'), JSON.stringify({ stopped: rj.stopped, held: (rj.guard.held || []).filter(h => h.host === NOTES_HOST), log: tasks.log.filter(l => !l.startsWith('GET')) }));
  writePack();
  writeFileSync(join(DEMO, 'reset.md'), RESET);

  // 1d · An API undo (a private pack's): "Undo with the app pack" runs the pack's call in the page's own signed-in
  // session (the server refuses a delete without it), with the demo's own value ({list}, demo.json apps[].values) and
  // the task id the run recorded. If it can't (here, a path the server doesn't know), the Note's steps run instead, as
  // approved.
  const setValues = values => { const f = join(DEMO, 'demo.json'), c = JSON.parse(readFileSync(f, 'utf8')); c.apps.find(a => a.id === 'tasks').values = values; writeFileSync(f, JSON.stringify(c, null, 2)); };
  setValues({ list: 'tasks' });
  const RESET_API = RESET.replace('- Click "Delete Call Kestrel"\n  Undoes: beat 1, Press Enter', '- Undo with the app pack: fixture-tasks:new-task\n  Undoes: beat 1, Press Enter\n  Note: an API call in the capture browser\'s own signed-in session, with {taskId} from the run; if it can\'t: Click "Delete {typed}"');
  writeFileSync(join(DEMO, 'plan.md'), PLAN('')); writeFileSync(join(DEMO, 'reset.md'), RESET_API);
  writePack({ apiPath: '/api/{list}/{taskId}' });
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
  setValues(undefined);
  // An API undo in a frame's own session (IQ's: its API answers the Power BI frame, not the portal): the notes frame's
  // session, the call from that frame (the notes host has no CORS: from the page around it, it can't). While the call
  // is open, the frame's own pings to that host stay held: the guard opens that one call, not the host.
  writePack({ apiPath: null, notesApi: true });
  writeFileSync(join(DEMO, 'plan.md'), PIN_PLAN);
  writeFileSync(join(DEMO, 'reset.md'), PIN_RESET.replace('- Click "Unpin note"\n  Undoes: beat 1, Click "Pin note"', '- Undo with the app pack: fixture-tasks:pin-note\n  Undoes: beat 1, Click "Pin note"\n  Note: an API call in the notes frame\'s own session; if it can\'t: Click "Unpin note"'));
  await run(['ai', 'approve', '--demo', DEMO], { env: E });
  tasks.notePing(true);
  tasks.log.length = 0;
  res = await aiProc(['record', '--demo', DEMO, '--unattended', '--checked'], DEMO, E);
  rj = readRun(DEMO);
  const nst = tasks.state();
  tasks.notePing(false);
  const pinDid = ((rj.reset.after || {}).did || []).join(' | ');
  check('an API undo in a frame\'s own session goes from that frame', !rj.stopped && rj.reset.after && rj.reset.after.ok && /Undo with the app pack: fixture-tasks:pin-note \(POST, 200\)/.test(pinDid) && count(tasks.log, 'POST notes/api/unpin') === 1 && !tasks.log.some(l => / 401$/.test(l)) && nst.pinned === false, JSON.stringify({ stopped: rj.stopped, after: rj.reset.after, log: tasks.log.filter(l => !l.startsWith('GET') && !/api\/seen/.test(l)) }));
  const [u0, u1] = nst.unpins[nst.unpins.length - 1] || [0, 0];
  const seenIn = nst.seen.filter(t => t >= u0 && t <= u1).length;
  const heldIn = (rj.guard.held || []).filter(h => h.host === NOTES_HOST && h.path === '/api/seen' && Date.parse(h.at) >= u0 && Date.parse(h.at) <= u1).length;
  check('and while that call is open, the app\'s other non-reads to the host stay held', u1 > u0 && seenIn === 0 && heldIn > 0, JSON.stringify({ unpin: [u0, u1], seenIn, heldIn, seen: nst.seen.length }));
  // A write opens its app's hosts for its step: the app's own background POST to one of them (the notes frame's pings)
  // stays held when the pack keeps it held (guard.stayHeld), and the write still lands.
  writePack({ stayHeld: [`/^POST ${NOTES_HOST.replace(/\./g, '\\.')}\\/api\\/seen$/`] });
  writeFileSync(join(DEMO, 'reset.md'), PIN_RESET);
  // And the demo's capture.keepBodies keeps those held requests' bodies, in a file of their own.
  const setKeep = keep => { const f = join(DEMO, 'demo.json'), c = JSON.parse(readFileSync(f, 'utf8')); if (keep) c.capture.keepBodies = keep; else delete c.capture.keepBodies; writeFileSync(f, JSON.stringify(c, null, 2)); };
  setKeep([`${NOTES_HOST}/api/seen`]);
  await run(['ai', 'approve', '--demo', DEMO], { env: E });
  tasks.notePing(true);
  tasks.log.length = 0;
  res = await aiProc(['record', '--demo', DEMO, '--unattended', '--checked'], DEMO, E);
  rj = readRun(DEMO);
  const sst2 = tasks.state();
  tasks.notePing(false);
  const duringWrite = (rj.guard.held || []).filter(h => h.host === NOTES_HOST && h.path === '/api/seen' && h.duringWrite).length;
  check('a background POST to a write\'s host stays held during the write (stayHeld), and the write lands', !rj.stopped && rj.writes.length === 1 && rj.writes[0].write === 'pin-note' && count(tasks.log, 'POST notes/api/pin') === 1 && sst2.seen.length === 0 && duringWrite > 0 && rj.reset.after && rj.reset.after.ok && sst2.pinned === false, JSON.stringify({ stopped: rj.stopped, writes: rj.writes, seen: sst2.seen.length, duringWrite, after: rj.reset.after && rj.reset.after.ok }));
  const kept = (() => { try { return JSON.parse(readFileSync(join(DEMO, '.out', 'ai', 'held-bodies.json'), 'utf8')); } catch (e) { return null; } })();
  check('and the held bodies the demo asked for are kept in their own file, not in run.json', kept && kept.length > 0 && kept.every(b => b.path === '/api/seen' && /^\{"seen":\d+\}$/.test(b.body)) && !readFileSync(join(DEMO, '.out', 'ai', 'run.json'), 'utf8').includes('\\"seen\\"'), JSON.stringify({ kept: kept && kept.slice(0, 2), n: kept && kept.length }));
  setKeep(null);
  writePack();
  writeFileSync(join(DEMO, 'plan.md'), PLAN(''));
  writeFileSync(join(DEMO, 'reset.md'), RESET);

  // 1f · A service the app needs: not answering as the app first opens (no status at all), the run stops before the
  // reset before: nothing captured, nothing written, what an earlier run left still there ("try again later"); failing
  // during a beat (the lookup as you type), the run stops before that beat's write, lists it for her, and the reset
  // after runs.
  writeFileSync(join(DEMO, 'plan.md'), PLAN('')); writeFileSync(join(DEMO, 'reset.md'), RESET);
  await run(['ai', 'approve', '--demo', DEMO], { env: E });
  tasks.catalog('drop');
  tasks.seed({ tasks: ['Call Kestrel'], sync: true });
  tasks.log.length = 0;
  res = await aiProc(['record', '--demo', DEMO, '--unattended', '--checked'], DEMO, E);
  rj = readRun(DEMO);
  const untouched = tasks.state().tasks.map(t => t.name).join('|') === 'Call Kestrel' && tasks.state().sync === true && !tasks.log.some(l => !l.startsWith('GET') && l !== 'POST /api/telemetry');
  check('a named service not answering as its app first opens: the run stops before the reset, nothing written, "try again later"', rj.stopped && rj.stopped.kind === 'service' && rj.stopped.stage === 'before-reset' && /^Tasks' catalog service didn't answer \(net::ERR_[A-Z_]+\)\. Try again later\.$/.test(rj.stopped.why) && rj.stopped.picture && existsSync(rj.stopped.picture) && !rj.summary && !rj.reset.before && !rj.reset.after && untouched, JSON.stringify({ stopped: rj.stopped, summary: rj.summary, reset: rj.reset, state: tasks.state(), log: tasks.log.filter(l => !l.startsWith('GET')) }));
  tasks.seed({});
  tasks.catalog('fail-on-type');
  tasks.log.length = 0;
  res = await aiProc(['record', '--demo', DEMO, '--unattended', '--checked'], DEMO, E);
  rj = readRun(DEMO);
  check('a named service failing during a beat: the run stops before its write, lists it for her, and the reset after runs', rj.stopped && rj.stopped.kind === 'service' && /^Press Enter/.test(rj.stopped.why) && /Tasks' catalog service answered 500 during this beat/.test(rj.stopped.why) && (rj.needsYou || []).some(n => n.text === 'Press Enter') && count(tasks.log, 'POST /api/tasks') === 0 && rj.reset.after && rj.reset.after.ok && tasks.state().tasks.length === 0, JSON.stringify({ stopped: rj.stopped, needsYou: rj.needsYou, log: tasks.log.filter(l => !l.startsWith('GET')) }));
  tasks.catalog('ok');

  // 1g · Set before: Sync, which the script has on by beat 2, set off camera just before Refresh, in a tab of its own
  // (the recorded tab never moves, and no screen of it is saved), approved with the writes; Refresh's screen then
  // shows it on, and Set first turns it off after. A pack without the write its line names fails closed.
  const SB = tag => RESET.replace('## Check', `## Set before beat 2, Click "Refresh"\n\n- tasks: "Sync" is on\n  Set: "Sync" · ${tag}\n  Opens: ${tasks.url}\n  Seen: beat 2, tasks\n\n## Check`);
  // The task write's pack check makes its landing strong: what's set off camera is a write, and the write gate applies.
  writePack({ taskCheck: true });
  // Only one run's screens in the raw folder (the receiver keeps its folders, its blobs and its address index).
  const freshRaw = () => { for (const d of ['snaps', 'shots', 'streams']) for (const f of existsSync(join(tmp, 'run-raw', d)) ? readdirSync(join(tmp, 'run-raw', d)) : []) rmSync(join(tmp, 'run-raw', d, f), { recursive: true, force: true }); rmSync(join(tmp, 'run-raw', 'recording.json'), { force: true }); };
  const keepRaw = name => { const d = join(tmp, name); rmSync(d, { recursive: true, force: true }); if (existsSync(join(tmp, 'run-raw'))) cpSync(join(tmp, 'run-raw'), d, { recursive: true }); return [d, existsSync(join(d, 'recording.json')) ? JSON.parse(readFileSync(join(d, 'recording.json'), 'utf8')) : null]; };
  // The same plan without it first, here, for the recording to be compared with.
  writeFileSync(join(DEMO, 'plan.md'), PLAN('')); writeFileSync(join(DEMO, 'reset.md'), RESET);
  await run(['ai', 'approve', '--demo', DEMO], { env: E });
  freshRaw();
  await aiProc(['record', '--demo', DEMO, '--unattended', '--checked'], DEMO, E);
  const [baseRaw, recBase] = keepRaw('sb-base-raw');
  writeFileSync(join(DEMO, 'reset.md'), SB('fixture-tasks:sync'));
  await run(['ai', 'approve', '--demo', DEMO], { env: E });
  freshRaw();
  const apSB = JSON.parse(readFileSync(join(DEMO, '.out', 'ai', 'approved.json'), 'utf8'));
  tasks.log.length = 0;
  res = await aiProc(['record', '--demo', DEMO, '--unattended', '--checked'], DEMO, E);
  rj = readRun(DEMO);
  const sbr = (rj.setBefore || [])[0] || {}, inSB = e => Date.parse(e.at) >= Date.parse(sbr.from) && Date.parse(e.at) <= Date.parse(sbr.to);
  const sbLoads = (rj.events || []).filter(e => e.kind === 'loaded' && inSB(e));
  check('Set before: approved with the writes, set off camera just before its step once the gate passed (the write before it strong by its pack check), and that step\'s screen shows it', rj.landings.some(l => l.wrote && l.strength === 'strong' && l.basis === 'pack check') && (apSB.reset || []).some(x => x.part === 'before' && x.text === 'tasks: "Sync" is on' && /off camera, before Click "Refresh"/.test(x.label)) && !rj.stopped && sbr.ok && sbr.items.length === 1 && sbr.items[0].ok && !sbr.items[0].already && sbr.seen.length === 1 && sbr.seen[0].ok && rj.writes.length === 1 && count(tasks.log, 'POST /api/sync') === 2 && tasks.state().sync === false && rj.reset.after && rj.reset.after.ok, JSON.stringify({ stopped: rj.stopped, wrote: rj.landings.filter(l => l.wrote), setBefore: rj.setBefore, writes: rj.writes.length, log: tasks.log.filter(l => !l.startsWith('GET')), after: rj.reset.after && rj.reset.after.why }));
  check('and it ran in a tab of its own: the recorded tab didn\'t load anything meanwhile', sbLoads.length > 0 && sbLoads.every(e => e.side === 'set-before:tasks'), JSON.stringify(sbLoads));
  // Nothing from the side tab in the recording: the same screens, steps and snapshots as this plan's run without it
  // (Sync's state aside, which Set before is there to change), nothing captured while it ran, and no side mark.
  const [sbRaw, recSB] = keepRaw('sb-raw');
  const syncAside = t => t.replace(/aria-checked=\\"(true|false)\\"/g, 'aria-checked=\\"?\\"').replace(/Sync is (on|off)/g, 'Sync is ?');
  // Screens by name (a screen's signature has Sync's state in it), steps, and each snapshot, Sync's state aside.
  const dSB = compareRaw(baseRaw, sbRaw, recBase, recSB, syncAside);
  const sameScreens = recBase && recSB && JSON.stringify(Object.keys(recBase.states).sort()) === JSON.stringify(Object.keys(recSB.states).sort());
  const t0SB = recSB ? Date.parse(recSB.recordedAt) : NaN, during = ((recSB && recSB.timeline) || []).filter(e => inSB({ at: new Date(t0SB + e.at).toISOString() }));
  const allRaw = d => readdirSync(d, { recursive: true }).filter(f => /\.json$/.test(String(f))).map(f => readFileSync(join(d, String(f)), 'utf8')).join('\n');
  check('and the recording has nothing from the side tab: the same screens, steps and snapshots as without it, nothing captured while it ran, no side mark', sameScreens && dSB.sameSteps && !dSB.onlyA.length && !dSB.onlyB.length && !dSB.differ.length && during.length === 0 && !allRaw(sbRaw).includes('set-before:'), JSON.stringify({ diff: dSB, during: during.slice(0, 5), window: [sbr.from, sbr.to] }));
  // Two tabs of one app at the same address: a lookup by the app's tab finds its own by its mark, never the other.
  const SPEC = (c => c.apps[0].match || c.apps[0].url)(JSON.parse(readFileSync(join(DEMO, 'demo.json'), 'utf8')));
  const MARK_JS = "return { mark: await page.evaluate(() => sessionStorage.getItem('d1tab')) }";
  const twoOpen = json((await run(['cmd', 'capTab', JSON.stringify({ open: tasks.url, mark: 'set-before:tasks' })], { env: E })).out);
  const byApp = json((await run(['cmd', 'js', JSON.stringify({ tab: SPEC, code: MARK_JS })], { env: E })).out), bySide = json((await run(['cmd', 'js', JSON.stringify({ tab: 'set-before:tasks', code: MARK_JS })], { env: E })).out);
  const closed = json((await run(['cmd', 'capTab', JSON.stringify({ close: 'set-before:tasks' })], { env: E })).out);
  check('two tabs of one app: a lookup by the app\'s tab finds its own by its mark', twoOpen.mark === 'set-before:tasks' && byApp.mark === SPEC && bySide.mark === 'set-before:tasks' && closed.closed === true, JSON.stringify({ twoOpen, byApp, bySide, closed }));
  writeFileSync(join(DEMO, 'reset.md'), SB('fixture-tasks:sync-all'));
  await run(['ai', 'approve', '--demo', DEMO], { env: E });
  tasks.log.length = 0;
  res = await aiProc(['record', '--demo', DEMO, '--unattended', '--checked'], DEMO, E);
  const sbErr = res.error ? (res.error.error || res.error.message || res.error.text || JSON.stringify(res.error)) : res.err;
  check('a Set before line whose pack lacks its write: the run refuses before anything runs', res.code !== 0 && /Set before beat 2, Click "Refresh": tasks: "Sync" is on: the fixture-tasks pack has no "sync-all" write/.test(sbErr) && !tasks.log.some(l => !l.startsWith('GET') && l !== 'POST /api/telemetry'), JSON.stringify({ code: res.code, error: sbErr, log: tasks.log.filter(l => !l.startsWith('GET')) }));
  writePack();
  writeFileSync(join(DEMO, 'reset.md'), RESET);

  // 1h · Leave out: a Suggested item (from a response, with an order list that names it by ref) and a team (drawn from
  // the page's own store) left out of the replica, in the capture browser only. The page draws itself without them
  // (no hole, one fewer), the raw recording has no trace of them, and the server sees the same requests as without the
  // rule. A line naming a filter no pack has refuses at start; one whose words are on a screen stops the take before
  // that screen is saved.
  {
    tasks.suggest(true);
    writePack({ filters: true });
    const LO = ({ from = 'fixture-tasks:suggested', shows = null } = {}) => RESET.replace('## Check', `## Leave out\n\n- tasks: suggestion "Fabrikam Payroll"\n  From: ${from}\n${shows ? `  Shows: "${shows}"\n` : ''}- tasks: team "Contoso Beta"\n  From: fixture-tasks:team-tree\n\n## Check`);
    const freshAll = () => { freshRaw(); rmSync(join(tmp, 'run-raw', 'hovers'), { recursive: true, force: true }); };
    const reqs = log => [...new Set(log)].sort().join('\n');
    writeFileSync(join(DEMO, 'plan.md'), PLAN('')); writeFileSync(join(DEMO, 'reset.md'), RESET);
    await run(['ai', 'approve', '--demo', DEMO], { env: E });
    freshAll(); tasks.log.length = 0;
    await aiProc(['record', '--demo', DEMO, '--unattended', '--checked'], DEMO, E);
    const baseLog = tasks.log.slice(), [loBase] = keepRaw('lo-base-raw');
    writeFileSync(join(DEMO, 'reset.md'), LO());
    r = await run(['ai', 'approve', '--demo', DEMO], { env: E });
    const apLO = JSON.parse(readFileSync(join(DEMO, '.out', 'ai', 'approved.json'), 'utf8'));
    freshAll(); tasks.log.length = 0;
    res = await aiProc(['record', '--demo', DEMO, '--unattended', '--checked'], DEMO, E);
    rj = readRun(DEMO);
    const loLog = tasks.log.slice(), [loRaw, recLO] = keepRaw('lo-raw');
    const lr = ((rj.leaveOut || {}).rules || []), sug = lr.find(x => x.id === 'fixture-tasks:suggested') || {};
    check('Leave out: the run goes to the end, the approval lists its lines apart from the writes, and run.json has what each rule took out and where', res.code === 0 && !rj.stopped && (apLO.leaveOut || []).map(x => x.label).join('|') === 'Left out of the replica: suggestion "Fabrikam Payroll"|Left out of the replica: team "Contoso Beta"' && !(apLO.reset || []).some(x => /Fabrikam|Contoso Beta/.test(x.text)) && sug.removed && sug.removed.length === 1 && sug.removed[0].value === 'Fabrikam Payroll' && sug.removed[0].field === 'name' && sug.requests.some(q => q.method === 'GET' && q.path === '/api/suggested' && q.removed === 1 && q.refs === 1 && q.kept === 2) && !sug.failures.length && rj.leaveOut.checks && rj.leaveOut.checks.n > 0 && rj.leaveOut.checks.clean === rj.leaveOut.checks.n && !rj.leaveOut.leak, JSON.stringify({ code: res.code, error: res.error, err: res.err.slice(-800), stopped: rj.stopped, leaveOut: rj.leaveOut, approved: apLO.leaveOut }));
    const snapOf = (dir, id) => { try { return JSON.parse(readFileSync(join(dir, 'snaps', `${id}.json`), 'utf8')).docs.map(d => d.html).join('\n'); } catch (e) { return ''; } };
    const startLO = snapOf(loRaw, 'tasks-start'), startBase = snapOf(loBase, 'tasks-start');
    const rowsOf = h => (/<ul id="sug"[^>]*>([\s\S]*?)<\/ul>/.exec(h) || [])[1] || '';
    check('and the page drew itself without them: one fewer row, in order, no hole (the order list\'s ref went too), the count right', /Fabrikam Payroll/.test(rowsOf(startBase)) && (rowsOf(startLO).match(/<li/g) || []).length === 2 && !/class="blank"/.test(rowsOf(startLO)) && /Contoso Notes[\s\S]*Northwind Ledger/.test(rowsOf(startLO)) && /2 suggested/.test(startLO), JSON.stringify({ lo: rowsOf(startLO).slice(0, 600), base: rowsOf(startBase).slice(0, 600) }));
    check('and the team drawn from its own store: hidden, never in a snapshot, the next team there', /Contoso Beta/.test(startBase) && !/Contoso Beta/.test(startLO) && /Contoso Alpha[\s\S]*Northwind Ops/.test(startLO), JSON.stringify({ lo: (/<div role="tree"[\s\S]{0,800}/.exec(startLO) || [''])[0] }));
    check('and the raw recording has no trace of either (screens, hovers, frames, the recording)', recLO && !/Fabrikam Payroll|Contoso Beta/.test(allRaw(loRaw)) && /Fabrikam Payroll/.test(allRaw(loBase)), JSON.stringify({ states: recLO && Object.keys(recLO.states) }));
    check('and the run asked the server for the same things as without it', reqs(loLog) === reqs(baseLog) && count(loLog, 'GET /api/suggested') > 0, JSON.stringify({ lo: reqs(loLog), base: reqs(baseLog) }));
    // On the live page, the tab loaded with the rules on and with them off: the same requests, each one (the browser's
    // own icon fetch aside: it's cached); the list one fewer with no hole; the team hidden and the next one moved up
    // into its place (no gap; the tree as a whole moves up by the list's row).
    const MEASURE = "return await page.evaluate(() => ({ teams: [...document.querySelectorAll('#teams [aria-level=\"2\"]')].map(e => ({ t: e.textContent, top: Math.round(e.getBoundingClientRect().top), shown: getComputedStyle(e).display !== 'none' })), rows: [...document.querySelectorAll('#sug li')].map(e => e.textContent), count: (document.getElementById('sugCount') || {}).textContent }))";
    const loadNow = async () => { tasks.log.length = 0; await run(['cmd', 'goto', JSON.stringify({ tab: SPEC, url: tasks.url })], { env: E }); await sleep(3000); return { log: tasks.log.filter(l => !/icon\.png|favicon/.test(l)).sort(), ...json((await run(['cmd', 'js', JSON.stringify({ tab: SPEC, code: MEASURE })], { env: E })).out) }; };
    const filterRules = [
      { id: 'fixture-tasks:suggested', app: 'tasks', kind: 'response', url: `*://${HOST}/api/suggested*`, match: `/^GET ${HOST.replace(/\./g, '\\.')}\\/api\\/suggested$/`, items: 'items', fields: ['name'], refs: [{ list: 'order', by: 'ref' }], shows: 'name', values: ['Fabrikam Payroll'] },
      { id: 'fixture-tasks:team-tree', app: 'tasks', kind: 'dom', hosts: [HOST], list: '[role=tree] [role=treeitem][aria-level="2"]', values: ['Contoso Beta'] },
    ];
    const off = await loadNow();
    const lon = json((await run(['cmd', 'capLeaveOut', JSON.stringify({ rules: filterRules, words: { tasks: ['Fabrikam Payroll', 'Contoso Beta'] }, check: '@scenecast/ai/leave-check.mjs' })], { env: E })).out);
    const on = await loadNow();
    const onLog = json((await run(['cmd', 'capLeaveLog', '{}'], { env: E })).out);
    await run(['cmd', 'capLeaveOut', JSON.stringify({ rules: [] })], { env: E });
    const at = (list, t) => (list || []).find(x => x.t === t) || {};
    check('and loaded with the rules on and off, the page asks the server for exactly the same things', lon.on === true && on.log.length > 3 && on.log.join('|') === off.log.join('|') && on.log.includes('GET /api/suggested'), JSON.stringify({ on: on.log, off: off.log }));
    check('and on the live page the list is one fewer with no hole, and the team is hidden with the next one moved up into its place', on.rows.join('|') === 'Contoso Notes|Northwind Ledger' && on.count === '2 suggested' && off.rows.length === 3 && at(on.teams, 'Contoso Beta').shown === false && at(off.teams, 'Contoso Beta').shown === true && at(on.teams, 'Northwind Ops').top - at(on.teams, 'Contoso Alpha').top === at(off.teams, 'Contoso Beta').top - at(off.teams, 'Contoso Alpha').top, JSON.stringify({ lon, off: { rows: off.rows, teams: off.teams }, on: { rows: on.rows, count: on.count, teams: on.teams }, log: onLog }));
    // A walk has it as a run does, and checks each screen it keeps.
    res = await aiProc(['walk', '--demo', DEMO, '--live'], DEMO, E);
    const wl = existsSync(join(DEMO, '.out', 'ai', 'walk.json')) ? JSON.parse(readFileSync(join(DEMO, '.out', 'ai', 'walk.json'), 'utf8')) : {};
    const wlo = wl.leaveOut || {};
    check('and a walk leaves them out too, and checks each screen it keeps', (wlo.screens || []).length >= 2 && wlo.screens.every(x => x.ok) && (wlo.rules || []).some(x => x.id === 'fixture-tasks:suggested' && x.removed.length === 1), JSON.stringify({ code: res.code, error: res.error, leaveOut: wlo, err: res.err.slice(-600) }));
    // A line whose filter no pack has: the run refuses at start, nothing run.
    writeFileSync(join(DEMO, 'reset.md'), LO({ from: 'fixture-tasks:suggestions' }));
    await run(['ai', 'approve', '--demo', DEMO], { env: E });
    tasks.log.length = 0;
    res = await aiProc(['record', '--demo', DEMO, '--unattended', '--checked'], DEMO, E);
    const loErr = res.error ? (res.error.error || res.error.message || res.error.text || JSON.stringify(res.error)) : res.err;
    check('a Leave out line naming a filter no pack has: the run refuses before anything runs', res.code !== 0 && /Leave out: "suggestion "Fabrikam Payroll"" is left out by fixture-tasks:suggestions, and no app pack of this demo has that filter/.test(loErr) && !tasks.log.some(l => !l.startsWith('GET') && l !== 'POST /api/telemetry'), JSON.stringify({ code: res.code, error: loErr, log: tasks.log.filter(l => !l.startsWith('GET')) }));
    // Words of hers on a screen no filter covers (here the start screen's own "Sync is off"): that screen isn't saved,
    // the run stops with a picture and where it was, lists it for her, and the reset after still runs.
    writeFileSync(join(DEMO, 'reset.md'), LO({ shows: 'Sync is off' }));
    await run(['ai', 'approve', '--demo', DEMO], { env: E });
    freshAll(); tasks.log.length = 0;
    res = await aiProc(['record', '--demo', DEMO, '--unattended', '--checked'], DEMO, E);
    rj = readRun(DEMO);
    const [leakRaw] = keepRaw('lo-leak-raw');
    const stp = rj.stopped || {};
    check('words she leaves out on a screen: not saved, the run stops with a picture and where, listed for her, the demo put back', stp.kind === 'leave-out' && /"Sync is off" is on the screen/.test(stp.why) && stp.picture && existsSync(stp.picture) && (stp.where || []).some(h => h.value === 'Sync is off' && h.text === 'Sync is off') && (rj.needsYou || []).length === 1 && !snapOf(leakRaw, 'tasks-start') && count(tasks.log, 'POST /api/tasks') === 0 && rj.reset.after && rj.reset.after.ok, JSON.stringify({ code: res.code, error: res.error, stopped: stp, needsYou: rj.needsYou, snaps: existsSync(join(leakRaw, 'snaps')) ? readdirSync(join(leakRaw, 'snaps')) : [], after: rj.reset.after && rj.reset.after.why }));
    const st0 = json((await run(['cmd', 'recordStatus', '{}'], { env: E })).out);
    check('and the recorder is free again for the next run', st0 && st0.recording === false, JSON.stringify(st0));
    tasks.suggest(false);
    writePack();
    writeFileSync(join(DEMO, 'reset.md'), RESET);
    await run(['ai', 'approve', '--demo', DEMO], { env: E });
  }

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
  // A step its plan proves, but only by a live region's words ("Up to date": a status line): the check passes, the
  // landing isn't strong. The write after it doesn't run on its own: the run stops before it, keeps a picture and
  // both reads, lists it for her, and the reset after puts the demo back.
  writeFileSync(join(DEMO, 'plan.md'), PLAN('- Click "Delete Call Kestrel"\n  Writes: deletes the task "Call Kestrel" · fixture-tasks:delete-task\n  Lands on: "No tasks yet"\n'));
  await run(['ai', 'approve', '--demo', DEMO], { env: E });
  tasks.log.length = 0;
  res = await aiProc(['record', '--demo', DEMO, '--unattended', '--checked'], DEMO, E);
  rj = readRun(DEMO);
  const gl = (rj.landings || []).find(l => l.step === 'Click "Refresh"');
  check('a write after a landing that isn\'t strong stops before it, with a picture and both reads, and is listed for her', rj.stopped && rj.stopped.kind === 'gate' && /Click "Refresh"/.test(rj.stopped.why) && rj.stopped.picture && existsSync(rj.stopped.picture) && rj.stopped.reads && JSON.parse(gunzipSync(readFileSync(rj.stopped.reads))).length === 2 && gl && gl.strength !== 'strong' && (rj.needsYou || []).some(n => /Delete Call Kestrel/.test(n.text)), JSON.stringify({ stopped: rj.stopped, refresh: gl, needsYou: rj.needsYou }));
  check('and the delete never reached the server; the reset after removed the run\'s task', count(tasks.log, 'DELETE /api/tasks/{id}') === 1 && rj.reset.after && rj.reset.after.ok && tasks.state().tasks.length === 0, JSON.stringify({ log: tasks.log.filter(l => !l.startsWith('GET')), after: rj.reset.after }));
  // The walk after this walks the unprovable plan again.
  writeFileSync(join(DEMO, 'plan.md'), UNPROVEN);
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
  // And each one in the reader's shape, read twice: the recorder's serialization, so a box's value is in its markup.
  const readsOf = name => { try { return JSON.parse(gunzipSync(readFileSync(join(DEMO, '.out', 'ai', 'walk-screens', `${name}.reads.json.gz`)))); } catch (e) { return null; } };
  const typedReads = readsOf('1-2'), startReads = readsOf('start-tasks');
  const startShot = (() => { try { return JSON.parse(readFileSync(join(DEMO, '.out', 'ai', 'walk-screens', 'start-tasks.json'), 'utf8')); } catch (e) { return null; } })();
  const rs = typedReads && typedReads.length === 2 ? readScreen(typedReads[1].docs) : null;
  const refreshKind = `POST ${HOST}/api/refresh`, driftShot = (() => { try { return JSON.parse(readFileSync(join(DEMO, '.out', 'ai', 'walk-screens', '2-1.json'), 'utf8')); } catch (e) { return null; } })();
  check('and what the guard held while a landing drifted: in its step; suspect steps by the re-ground\'s rule (none here: this plan\'s proofs name no recorded screen)', (wj.beats[1].steps[0].held || []).some(h => `${h.method} ${h.host}${h.path}` === refreshKind) && wj.suspect && Array.isArray(wj.suspect.steps) && wj.suspect.steps.length === 0 && driftShot && (driftShot.held || []).some(h => h.method === 'POST' && h.path === '/api/refresh') && wj.beats[1].steps[0].window, JSON.stringify({ suspect: wj.suspect, held: driftShot && driftShot.held, step: wj.beats[1] && wj.beats[1].steps[0] && { window: wj.beats[1].steps[0].window, held: wj.beats[1].steps[0].held } }));
  const loads = (wj.events || []).filter(e => e.kind === 'loaded' && e.app === 'tasks');
  check('and each tab\'s new documents, with their app and time (an in-page route change isn\'t one)', loads.length > 0 && loads.every(e => e.host === HOST && e.at), JSON.stringify((wj.events || []).slice(0, 8)));
  const refreshNet = (wj.beats[1] && wj.beats[1].steps[0] && wj.beats[1].steps[0].net) || [];
  check('and each step\'s failed requests and answers of 400 or more, with their app and frame', refreshNet.some(n => n.status === 404 && n.path === '/api/fresh-count' && n.app === 'tasks' && n.frame === HOST) && (wj.net || []).some(n => n.path === '/api/fresh-count'), JSON.stringify({ step: refreshNet, all: (wj.net || []).slice(0, 5) }));
  check('and in the reader\'s shape, read twice: the page and its frames, what a box holds, each start screen too, and the plan it walked', rs && typedReads.every(r => r.docs.some(d => d.key === 'main') && r.docs.some(d => d.key === NOTES_HOST)) && rs.controls.some(c => c.name === 'New task' && c.role === 'textbox' && c.value === 'Call Kestrel') && rs.controls.some(c => c.name === 'Pin note' && c.frame === NOTES_HOST) && startReads && startReads.length === 2 && readScreen(startReads[0].docs).text.includes('No tasks yet') && startShot && startShot.app === 'tasks' && String(startShot.url).startsWith(tasks.url) && startShot.title === 'Fixture Tasks' && typedScreen.app === 'tasks' && typedScreen.title === 'Fixture Tasks' && wj.plan && wj.plan.sha256 === createHash('sha256').update(readFileSync(join(DEMO, 'plan.md'))).digest('hex'), JSON.stringify({ plan: wj.plan, startShot: startShot && { app: startShot.app, url: startShot.url, title: startShot.title, status: startShot.status }, reads: typedReads && typedReads.map(r => r.docs.map(d => [d.key, d.html.length])), controls: rs && rs.controls.slice(0, 8), start: !!startReads }));
  const cl = (wj.beats[0] && wj.beats[0].steps[2] && wj.beats[0].steps[2].cleared) || {};
  check('the beat stopped at the write: what it typed for it is cleared, no draft left', cl.cleared === true && cl.in === 'New task', JSON.stringify(wj.beats[0] && wj.beats[0].steps[2]));
  // 5b · Twins (record.auto.twins): the same plan recorded with its side sweeps (hovers and zoom) in one window, then
  // shared with 2 twin windows of each app where they show the same screen. The same screens, steps, zoom levels and
  // hovers either way; the sweep times for the record.
  writeFileSync(join(DEMO, 'plan.md'), PLAN('')); writeFileSync(join(DEMO, 'reset.md'), RESET);
  await run(['ai', 'approve', '--demo', DEMO], { env: E });
  const cfgFile = join(DEMO, 'demo.json'), cfg0 = readFileSync(cfgFile, 'utf8');
  const withTwins = n => { const c = JSON.parse(cfg0); c.zooms = [90, 110, 125, 150]; c.record.auto = { ...c.record.auto, zoom: true, maxS: 120, zoomMinS: 5, twins: n }; writeFileSync(cfgFile, JSON.stringify(c, null, 2)); };
  const twinRun = async (n, name) => {
    withTwins(n); freshRaw();
    const t = Date.now();
    const r = await aiProc(['record', '--demo', DEMO, '--unattended', '--checked'], DEMO, E);
    const [dir, rec] = keepRaw(name);
    const hovers = existsSync(join(dir, 'hovers')) ? readdirSync(join(dir, 'hovers')).flatMap(pg => readdirSync(join(dir, 'hovers', pg)).filter(f => f.endsWith('.json')).map(f => { const h = JSON.parse(readFileSync(join(dir, 'hovers', pg, f), 'utf8')); return `${pg.replace(/~t\d+$/, '')} ${h.cand && h.cand.sel}|${h.cand && h.cand.text}`; })).sort() : [];
    const zooms = ((rec && rec.sides && rec.sides.zoom) || []).map(z => `${z.state} ${z.z} ${z.vw} ${z.pw}`).sort();
    const tm = (rec && rec.timing) || {};
    return { r, rec, dir, hovers, zooms, secs: Math.round((Date.now() - t) / 1000), sweeps: +((tm.startSweepSecs || 0) + (tm.screenSweepSecs || 0)).toFixed(1), log: (rec && rec.log || []).filter(l => /twins for/.test(l)) };
  };
  const one = await twinRun(0, 'twins-0'), two = await twinRun(2, 'twins-2');
  writeFileSync(cfgFile, cfg0);
  const dTw = compareRaw(one.dir, two.dir, one.rec, two.rec);
  times.twins = { off: { run: one.secs, sweeps: one.sweeps }, two: { run: two.secs, sweeps: two.sweeps } };
  console.log('twins: ' + JSON.stringify({ ...times.twins, used: two.log }));
  check('twins: the same screens, steps, zoom levels and hovers as one window, and twins were used where a screen showed alike', !one.r.done?.result?.stopped && !two.r.done?.result?.stopped && dTw.sameSteps && JSON.stringify(Object.keys(one.rec.states).sort()) === JSON.stringify(Object.keys(two.rec.states).sort()) && JSON.stringify(one.zooms) === JSON.stringify(two.zooms) && JSON.stringify(one.hovers) === JSON.stringify(two.hovers) && two.log.some(l => /twins for \S+: [12] of 2/.test(l)), JSON.stringify({ steps: dTw.steps, zooms: [one.zooms, two.zooms], hovers: [one.hovers.length, two.hovers.length, one.hovers.filter(h => !two.hovers.includes(h)).slice(0, 4), two.hovers.filter(h => !one.hovers.includes(h)).slice(0, 4)], log: two.log, stopped: [one.r.done?.result?.stopped, two.r.done?.result?.stopped] }));
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
// also: one more change to each snapshot's text before they're compared (what a run is meant to show differently).
function compareRaw(dirA, dirB, a, b, also = t => t) {
  if (!a || !b) return { ok: false, why: `no recording.json in ${!a ? dirA : dirB}` };
  const sigs = r => Object.values(r.states || {}).map(s => s.sig).filter(Boolean).sort();
  const steps = r => (r.path || []).map(p => p.click ? 'click' : p.key ? `key ${p.key}` : p.type ? 'type' : Object.keys(p).filter(k => k !== 't' && k !== 'checkpoint').join('+')).join(' ');
  const files = d => existsSync(d) ? readdirSync(d).sort() : [];
  const snapsA = files(join(dirA, 'snaps')), snapsB = files(join(dirB, 'snaps'));
  const strip = t => t.replace(/\b1\d{5}\b/g, '{id}').replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '{at}').replace(/"(t|at|savedAt|ms|secs|time)":\s*[\d.]+/g, '"$1":0');
  // Keys in one order (the two paths put a snapshot's together in a different order).
  const canon = v => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
  const read = (d, f) => also(strip(JSON.stringify(canon(JSON.parse(readFileSync(join(d, 'snaps', f), 'utf8'))))));
  const differ = snapsA.filter(f => snapsB.includes(f) && f.endsWith('.json') && read(dirA, f) !== read(dirB, f));
  const out = {
    states: [Object.keys(a.states).length, Object.keys(b.states).length], sameSigs: JSON.stringify(sigs(a)) === JSON.stringify(sigs(b)),
    steps: [steps(a), steps(b)], sameSteps: steps(a) === steps(b),
    snaps: [snapsA.length, snapsB.length], onlyA: snapsA.filter(f => !snapsB.includes(f)).slice(0, 8), onlyB: snapsB.filter(f => !snapsA.includes(f)).slice(0, 8), differ: differ.slice(0, 8),
    first: differ.length ? (() => { const x = read(dirA, differ[0]), y = read(dirB, differ[0]); let i = 0; while (i < x.length && x[i] === y[i]) i++; return [x.slice(Math.max(0, i - 80), i + 120), y.slice(Math.max(0, i - 80), i + 120)]; })() : undefined,
    shots: [files(join(dirA, 'shots')).length, files(join(dirB, 'shots')).length],
  };
  out.ok = out.sameSigs && out.sameSteps && !out.onlyA.length && !out.onlyB.length && !differ.length;
  return out;
}
