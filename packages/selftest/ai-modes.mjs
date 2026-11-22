// The three AI modes end to end on the fixture app, with the deterministic stand-in model (SCENECAST_AI_MODEL=stub):
// no network, no account. Through the scenecast binary and the recorder extension in a headless browser, as a
// presenter's run would go, on macOS, Windows and Linux. Each mode goes from its input to a replica that passes its
// checks, with beats, a talk track, focus points and the presenter guide:
//   1. Record for me: a goal only → a plan → the browser driven through the extension while it records; the two
//      sends wait for the presenter (one "Do it", one "I'll click it myself": the test clicks it) → script.md.
//   2. I'll click, you script it: a person clicks through (Playwright), no plan → the talk track from the recording.
//   3. Coach me: a goal → the coach's live suggestions, which the "person" follows step by step → the talk track.
//   node packages/selftest/ai-modes.mjs [--keep] [--only 1,2,3]
// --real: Record for me on GitHub Copilot instead (SCENECAST_COPILOT_TOKEN, or the stored sign-in), goal only, every
// send answered "Do it": a local check that a real model makes a sensible demo (not run in CI).
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { chromium } from 'playwright-core';
import { startFixture } from '../../examples/fixture-app/server.mjs';
import { parsePlan, parseStep } from '../ai/plan.mjs';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = process.env.SCENECAST_BIN ? resolvePath(process.env.SCENECAST_BIN) : join(KIT, '..', 'target', 'debug', process.platform === 'win32' ? 'scenecast.exe' : 'scenecast');
if (!existsSync(BIN)) { console.log(`no scenecast binary at ${BIN}: cargo build -p scenecast-cli first (or set SCENECAST_BIN)`); process.exit(1); }
const keep = process.argv.includes('--keep');
const REAL = process.argv.includes('--real');
const only = (process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : REAL ? '1' : '1,2,3,4').split(',').map(Number);
const RX_PORT = 47695, REPLICA_PORT = 4695;
const tmp = mkdtempSync(join(tmpdir(), 'scenecast-ai-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fails = [];
const check = (name, ok, detail) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? `: ${String(detail).slice(0, 1500)}` : '')); if (!ok) fails.push(name); };
const GIT_ID = { GIT_AUTHOR_NAME: 'scenecast ai test', GIT_AUTHOR_EMAIL: 'ai-test@localhost', GIT_COMMITTER_NAME: 'scenecast ai test', GIT_COMMITTER_EMAIL: 'ai-test@localhost' };
const ENV = { ...process.env, ...GIT_ID, REPLICA_RX_PORT: String(RX_PORT), REPLICA_NO_OPEN: '1', SCENECAST_AI_MODEL: REAL ? 'copilot' : 'stub', ...(REAL ? {} : { SCENECAST_AI_HOME: join(tmp, 'ai-home') }) };
const run = (args, opts = {}) => new Promise(res => {
  const p = spawn(BIN, args, { cwd: opts.cwd || tmp, env: { ...ENV, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; p.stdout.on('data', d => { out += d; if (opts.echo) process.stdout.write(d); }); p.stderr.on('data', d => { out += d; process.stderr.write(d); });
  p.on('close', code => res({ code, out }));
});
const json = s => { const i = s.indexOf('{'); return JSON.parse(s.slice(i)); };
const aiLines = out => out.split('\n').filter(l => l.startsWith('@ai ')).map(l => JSON.parse(l.slice(4)));
// A long-running `scenecast ai …`: each @ai event to onEvent as it comes.
function aiProc(args, cwd, onEvent) {
  const p = spawn(BIN, ['ai', ...args], { cwd, env: ENV, stdio: ['pipe', 'pipe', 'pipe'] });
  const events = []; let buf = '', err = '';
  p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.startsWith('@ai ')) { const e = JSON.parse(l.slice(4)); events.push(e); Promise.resolve(onEvent && onEvent(e)).catch(x => console.log('handler: ' + x.stack)); } } });
  p.stderr.on('data', d => { err += d; });
  const done = new Promise(res => p.on('close', code => res({ code, events, err })));
  return { p, events, done };
}

for (const port of [RX_PORT, REPLICA_PORT, 47801, 47802]) {
  const busy = await new Promise(res => { const s = createServer().once('error', () => res(true)).once('listening', () => s.close(() => res(false))).listen(port, '127.0.0.1'); });
  if (busy) { console.log(`port ${port} is in use: stop whatever is on it and run again`); process.exit(1); }
}

async function launchWithExtension(ext, profile) {
  const args = ['--silent-debugger-extension-api', '--force-device-scale-factor=1', '--window-size=1700,1100', '--screen-info={0,0 2560x1600}', '--disable-features=DisableLoadExtensionCommandLineSwitch', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`];
  const ctx = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: null, colorScheme: 'light', ignoreDefaultArgs: ['--disable-extensions'], args });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
  return ctx;
}
async function sizeWindow(page, w, h) {
  const s = await page.context().newCDPSession(page);
  const { windowId } = await s.send('Browser.getWindowForTarget');
  for (let i = 0; i < 4; i++) {
    const [iw, ih, ow, oh] = await page.evaluate(() => [innerWidth, innerHeight, outerWidth, outerHeight]);
    if (iw === w && ih === h) break;
    await s.send('Browser.setWindowBounds', { windowId, bounds: { width: ow + w - iw, height: oh + h - ih } });
    await sleep(300);
  }
  await s.detach();
}

// The receiver asked to make way (on Windows the scenecast binary waits on its Node: killing it leaves Node on the port).
async function stopReceiver() {
  await fetch(`http://127.0.0.1:${RX_PORT}/quit`, { method: 'POST' }).catch(() => {});
  for (let i = 0; i < 50; i++) {
    const free = await new Promise(res => { const s = createServer().once('error', () => res(false)).once('listening', () => s.close(() => res(true))).listen(RX_PORT, '127.0.0.1'); });
    if (free) break;
    await sleep(200);
  }
  if (receiver) try { receiver.kill(); } catch (e) {}
}
const fx = startFixture();
const procs = [];
let ctx = null, receiver = null;
const times = {};
try {
  // The recorder extension in a fresh headless browser, as a presenter has it; the fixture's two apps as tabs.
  let r = await run(['extension', join(tmp, 'ext')]);
  check('extension builds', r.code === 0, r.out);
  ctx = await launchWithExtension(join(tmp, 'ext'), join(tmp, 'profile'));
  const chat = await ctx.newPage(); await chat.goto(fx.chat);
  for (const p of ctx.pages()) if (p !== chat) await p.close();
  await sizeWindow(chat, 1600, 900);
  const admin = await ctx.newPage(); await admin.goto(fx.admin);
  await chat.bringToFront();
  const page = { chat, admin };

  // A new demo for a mode: the fixture's apps, a quick recording (no side-state sweep: that's the selftest's), its
  // receiver, the tabs back on their start screens.
  async function newDemo(name, ai) {
    r = await run(['new', name, '--dir', tmp, '--title', `AI ${name}`, '--port', String(REPLICA_PORT), '--app', `chat=${fx.chat}`, '--app', `admin=${fx.admin}`]);
    const DEMO = join(tmp, name);
    const cfg = JSON.parse(readFileSync(join(DEMO, 'demo.json'), 'utf8'));
    Object.assign(cfg, { raw: join(tmp, name + '-raw'), receiverPort: RX_PORT, viewport: { width: 1600, height: 900, dpr: 1 }, zooms: [150] });
    Object.assign(cfg.record, { settleMs: 1200, typeIdleMs: 700, everyMs: 250, streamMinMs: 1200, auto: false });
    writeFileSync(join(DEMO, 'demo.json'), JSON.stringify(cfg, null, 2));
    if (ai) writeFileSync(join(DEMO, 'ai.json'), JSON.stringify(ai, null, 2));
    if (receiver) await stopReceiver();
    receiver = spawn(BIN, ['receiver', '--demo', DEMO], { cwd: DEMO, env: ENV, stdio: 'ignore' }); procs.push(receiver);
    await chat.goto(fx.chat); await admin.goto(fx.admin); await chat.bringToFront();
    let e = {};
    for (let i = 0; i < 60 && !e.version; i++) { await sleep(500); const x = await run(['cmd', 'extension'], { cwd: DEMO }); try { e = json(x.out); } catch (er) { e = {}; } }
    check(`${name}: the recorder connects`, !!e.version, JSON.stringify(e));
    const pf = json((await run(['preflight', '--json'], { cwd: DEMO })).out);
    check(`${name}: preflight ready`, pf.ready, JSON.stringify(pf));
    await chat.bringToFront();
    return DEMO;
  }
  // The replica from the recording, then the talk track's focus points and the presenter guide, then its checks.
  async function finish(name, DEMO) {
    const t0 = Date.now();
    let x = await run(['build', '--from-raw'], { cwd: DEMO });
    check(`${name}: build`, x.code === 0, x.out.slice(-1500));
    const script = readFileSync(join(DEMO, 'script.md'), 'utf8');
    x = await run(['script', 'script.md', '--no-pdf'], { cwd: DEMO });
    const m = /(\d+) lines: (\d+) backed, (\d+) partly, (\d+) not backed; (\d+) focus points/.exec(x.out) || [];
    check(`${name}: script to focus points`, x.code === 0 && +m[5] > 0 && +m[2] >= Math.ceil(+m[1] / 2), x.out.slice(-1200) + '\n' + script);
    x = await run(['notes'], { cwd: DEMO });
    check(`${name}: presenter guide notes`, x.code === 0 && existsSync(join(DEMO, 'presenter', 'notes.json')), x.out.slice(-800));
    x = await run(['guide-shots'], { cwd: DEMO });
    check(`${name}: presenter guide pictures`, x.code === 0, x.out.slice(-800));
    const notes = JSON.parse(readFileSync(join(DEMO, 'presenter', 'notes.json'), 'utf8'));
    const flow = JSON.parse(readFileSync(join(DEMO, 'flow.json'), 'utf8'));
    check(`${name}: beats, a talk track, focus points`, flow.beats.length >= 2 && notes.beats.reduce((k, b) => k + b.say.length, 0) >= 3 && (JSON.parse(readFileSync(join(DEMO, 'focus.json'), 'utf8')).points || []).length > 0, JSON.stringify({ beats: flow.beats.length, say: notes.beats.map(b => b.say.length) }));
    x = await run(['quick'], { cwd: DEMO });
    const q = existsSync(join(DEMO, '.out', 'quick.json')) ? JSON.parse(readFileSync(join(DEMO, '.out', 'quick.json'), 'utf8')) : {};
    check(`${name}: the replica passes its checks`, x.code === 0 && q.pass, (q.items || []).filter(i => i.status === 'fail').map(i => `${i.id}: ${i.detail}`).join('\n') || x.out.slice(-1500));
    times[name + 'Finish'] = Math.round((Date.now() - t0) / 1000);
  }
  // The "person": does a plan step in the browser, the way someone reading it would.
  async function doStep(text, app) {
    const parts = text.split(/, then /i);
    if (parts.length > 1) { for (const t of parts) app = await doStep(t[0].toUpperCase() + t.slice(1), app); return app; }
    const s = parseStep(text);
    const p = page[app];
    if (s.kind === 'app') { await page[s.app].bringToFront(); return s.app; }
    if (s.kind === 'click') await p.getByText(s.target, { exact: true }).or(p.getByLabel(s.target, { exact: true })).first().click();
    if (s.kind === 'type') { if (s.target) await p.getByLabel(s.target, { exact: true }).first().click(); await p.keyboard.type(s.value, { delay: 15 }); }
    if (s.kind === 'press') await p.keyboard.press(s.key);
    return app;
  }
  const settled = async DEMO => { await sleep(450); for (let i = 0, ok = 0; i < 1200; i++) { const s = json((await run(['record', 'status'], { cwd: DEMO })).out); if (!s.busy && !(s.typing || []).length) { if (++ok >= 2) return s; } else ok = 0; await sleep(250); } throw new Error('recorder never settled'); };

  // ---- 1 · Record for me ------------------------------------------------------------------------------------------
  if (only.includes(1)) {
    const t0 = Date.now();
    const goal = 'Ask "Summarize the supplier delay on PO-450101", then close the workspace, then open Plugins. In admin, search "alpha" and open alpha-6. Then go to chat, start a new chat and ask "What will it cost us?" with the send button.';
    const DEMO = await newDemo('record-for-me', { mode: 'record', goal: REAL && process.env.SCENECAST_AI_GOAL || goal });
    r = await run(['ai', 'plan', '--demo', DEMO]);
    const plan = existsSync(join(DEMO, 'plan.md')) ? parsePlan(readFileSync(join(DEMO, 'plan.md'), 'utf8')) : { beats: [] };
    const steps = plan.beats.flatMap(b => b.steps.map(s => s.text));
    check('record for me: a plan from the goal alone', r.code === 0 && (REAL ? plan.beats.length >= 2 : plan.beats.length >= 4 && ['Type "Summarize the supplier delay on PO-450101" in "Message"', 'Click "Close workspace"', 'Click "Plugins"', 'Go to admin', 'Type "alpha" in "Search tools by name"', 'Click "alpha-6"', 'Click "Send"'].every(s => steps.includes(s))), r.out.slice(-600) + JSON.stringify(steps));
    if (REAL) console.log(readFileSync(join(DEMO, 'plan.md'), 'utf8'));
    check('record for me: sends are marked "ask first" in the plan', REAL || /Press Enter — ask first/.test(readFileSync(join(DEMO, 'plan.md'), 'utf8')) && /Click "Send" — ask first/.test(readFileSync(join(DEMO, 'plan.md'), 'utf8')) && !/Search tools by name.*\n- Press Enter — ask first/.test(readFileSync(join(DEMO, 'plan.md'), 'utf8')), readFileSync(join(DEMO, 'plan.md'), 'utf8'));
    const sent = json((await run(['ai', 'sent', '--demo', DEMO])).out.split('\n').find(l => l.startsWith('@ai ')).slice(4)).result.sent;
    check('record for me: what was sent is kept, and shown', sent.length >= 1 && sent[0].task === 'plan' && /Search tools by name/.test(readFileSync(sent[0].file, 'utf8')), JSON.stringify(sent));
    // Run it. Each confirmation: nothing happens until it's answered (the recorder sees no action), then "Do it" for
    // Enter, "I'll click it myself" for Send (and the test clicks it).
    const confirms = [];
    let held = null;
    const pr = aiProc(['record', '--demo', DEMO], DEMO, async e => {
      if (e.event === 'step') console.log(`  step ${e.n}/${e.of}: ${e.text}`);
      if (e.event === 'question') { console.log('  question: ' + e.text); await run(['ai', 'answer', '--demo', DEMO, e.id, 'skip']); }
      if (e.event !== 'confirm') return;
      confirms.push(e);
      const a0 = json((await run(['record', 'status'], { cwd: DEMO })).out).actions;
      await sleep(1500);
      const a1 = json((await run(['record', 'status'], { cwd: DEMO })).out).actions;
      held = held === false ? false : a0 === a1;
      if (/Send/.test(e.step) && !REAL) {
        await run(['ai', 'answer', '--demo', DEMO, e.id, 'self']);
        await sleep(800);
        await chat.click('[aria-label="Send"]');
      } else await run(['ai', 'answer', '--demo', DEMO, e.id, 'do']);
    });
    const res = await pr.done;
    const done = pr.events.find(e => e.event === 'done');
    check('record for me: runs the plan to the end', res.code === 0 && done && !done.result.stopped && done.result.summary.states >= (REAL ? 4 : 8) && (REAL || done.result.summary.streams === 2), JSON.stringify(pr.events.filter(e => /error|note|done|question/.test(e.event))) + res.err.slice(-800));
    check('record for me: asked before each send, and waited', REAL ? confirms.length >= 1 && held === true : confirms.length === 2 && /Enter/.test(confirms[0].step) && /Send/.test(confirms[1].step) && held === true, JSON.stringify(confirms));
    check('record for me: "I\'ll click it myself" waited for the presenter', REAL || pr.events.some(e => e.event === 'step-done' && e.did === 'presenter'), JSON.stringify(pr.events.filter(e => e.event === 'step-done')));
    if (REAL && existsSync(join(DEMO, 'script.md'))) console.log(readFileSync(join(DEMO, 'script.md'), 'utf8'));
    check('record for me: the talk track written from what happened', existsSync(join(DEMO, 'script.md')) && /Kestrel|ship date|six days/i.test(readFileSync(join(DEMO, 'script.md'), 'utf8')) && done && done.result.script.lines >= 4, existsSync(join(DEMO, 'script.md')) ? readFileSync(join(DEMO, 'script.md'), 'utf8') : 'no script.md');
    await finish('record for me', DEMO);
    times.recordForMe = Math.round((Date.now() - t0) / 1000);
  }

  // ---- 2 · I'll click, you script it -------------------------------------------------------------------------------
  if (only.includes(2)) {
    const t0 = Date.now();
    const DEMO = await newDemo('click-script', { mode: 'script' });
    let s = json((await run(['record', 'start'], { cwd: DEMO })).out);
    check('click and script: recording', s.recording === true, JSON.stringify(s));
    await settled(DEMO);
    await chat.click('[aria-label="Message"]'); await chat.keyboard.type('Summarize the supplier delay on PO-450101', { delay: 15 }); await chat.keyboard.press('Enter'); await settled(DEMO);
    await chat.click('[aria-label="Plugins"]'); await settled(DEMO);
    await admin.bringToFront(); await sleep(300);
    await admin.click('[aria-label="Search tools by name"]'); await admin.keyboard.type('alpha', { delay: 30 }); await admin.keyboard.press('Enter'); await settled(DEMO);
    await admin.click('[role=gridcell]:text-is("alpha-6")'); await settled(DEMO);
    s = json((await run(['record', 'stop'], { cwd: DEMO })).out);
    check('click and script: recorded', s.states >= 5 && s.streams === 1, JSON.stringify(s).slice(0, 400));
    r = await run(['ai', 'script', '--demo', DEMO]);
    const ev = aiLines(r.out), done = ev.find(e => e.event === 'done');
    const md = existsSync(join(DEMO, 'script.md')) ? readFileSync(join(DEMO, 'script.md'), 'utf8') : '';
    check('click and script: beats and lines from the recording alone', r.code === 0 && done && done.result.beats >= 3 && /Kestrel moved the ship date/.test(md) && /alpha-6/i.test(md) && /\*\*Do:\*\* .*Click "Plugins"/.test(md), r.out.slice(-600) + md);
    await finish('click and script', DEMO);
    times.clickScript = Math.round((Date.now() - t0) / 1000);
  }

  // ---- 3 · Coach me ------------------------------------------------------------------------------------------------
  if (only.includes(3)) {
    const t0 = Date.now();
    const DEMO = await newDemo('coach', { mode: 'coach', goal: 'Ask "Summarize the supplier delay on PO-450101", then open Plugins. In admin, search "alpha" and open alpha-6.' });
    let latest = null;
    const shown = [];
    const co = aiProc(['coach', '--demo', DEMO], DEMO, e => { if (e.event === 'coach') { latest = e; shown.push(e.next); } });
    for (let i = 0; i < 60 && !latest; i++) await sleep(500);
    check('coach: a plan from the goal, and a first suggestion before recording', !!latest && latest.next && existsSync(join(DEMO, 'plan.md')), JSON.stringify(co.events.slice(-5)));
    const s = json((await run(['record', 'start'], { cwd: DEMO })).out);
    await settled(DEMO);
    // The person follows each suggestion; the coach moves on when the recorder sees it done.
    let app = 'chat', followed = 0;
    for (let i = 0; i < 20 && latest && !latest.finished; i++) {
      const before = latest.done;
      const text = latest.next;
      console.log(`  coach says: ${text}${latest.say ? ` (say: ${latest.say})` : ''}`);
      app = await doStep(text, app);
      await settled(DEMO);
      const want = before + text.split(/, then /i).length;
      for (let k = 0; k < 40 && latest.done < want && !latest.finished; k++) await sleep(250);
      followed++;
    }
    check('coach: followed to the end of the plan', s.recording === true && latest && latest.finished && followed >= 6, JSON.stringify({ latest, followed }));
    const win = await (await fetch(`http://127.0.0.1:${RX_PORT}/coach.json`)).json();
    const page2 = await ctx.newPage(); await page2.goto(`http://127.0.0.1:${RX_PORT}/coach`); await sleep(1200);
    const winText = await page2.evaluate(() => document.body.innerText); await page2.close(); await chat.bringToFront();
    check('coach: the coach window shows it', win.finished === true && /whole plan/.test(winText), JSON.stringify(win) + winText);
    await run(['record', 'stop'], { cwd: DEMO });
    const cres = await co.done;
    check('coach: ends with the recording', cres.code === 0, cres.err.slice(-500));
    r = await run(['ai', 'script', '--demo', DEMO]);
    check('coach: the talk track from the recording', r.code === 0 && /Kestrel moved the ship date/.test(readFileSync(join(DEMO, 'script.md'), 'utf8')), r.out.slice(-600));
    await finish('coach', DEMO);
    times.coach = Math.round((Date.now() - t0) / 1000);
  }
  // ---- 4 · The benchmark: a saved plan run unattended, every phase timed -----------------------------------------
  // "May I?" is answered from --yes only (Enter is allowed, Send isn't: skipped, never done).
  if (only.includes(4) && !REAL) {
    const DEMO = await newDemo('bench', { mode: 'record', goal: 'bench' });
    const plan = join(tmp, 'bench-plan.md');
    writeFileSync(plan, '# Bench\n\n## Beat 1 · Ask\n\n- Go to chat\n- Type "Summarize the supplier delay on PO-450101" in "Message"\n- Press Enter — ask first\n- Wait for the answer\n\n## Beat 2 · Admin\n\n- Go to admin\n- Click "Plugins"\n- Go to chat\n- Click "Send" — ask first\n');
    const pr = aiProc(['bench', '--demo', DEMO, '--plan', plan, '--yes', '^Press Enter', '--no-script'], DEMO);
    const res = await pr.done;
    const b = existsSync(join(DEMO, '.out', 'bench.json')) ? JSON.parse(readFileSync(join(DEMO, '.out', 'bench.json'), 'utf8')) : {};
    const ph = Object.fromEntries((b.phases || []).map(p => [p.name, p]));
    check('bench: check and record timed, unattended', res.code === 0 && ph.check?.ok && ph.record?.ok && b.secs > 0 && b.take && b.take.wallSecs > 0 && b.screens >= 3, JSON.stringify(b).slice(0, 800) + res.err.slice(-500));
    check('bench: only the allowed "May I?" is done', b.answered?.length === 1 && /Enter/.test(b.answered[0]) && b.skipped?.some(s => /Send/.test(s)), JSON.stringify({ answered: b.answered, skipped: b.skipped }));
  }
} catch (e) {
  check('ai modes ran to the end', false, String(e.stack || e));
} finally {
  await stopReceiver();
  for (const p of procs) { try { p.kill(); } catch (e) {} }
  if (ctx) await ctx.close().catch(() => {});
  fx.close();
  console.log('TIMES ' + JSON.stringify(times));
  if (keep) console.log(`kept: ${tmp}`); else rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
}
console.log(fails.length ? `\n${fails.length} failing: ${fails.join(', ')}` : '\nai modes: all pass');
process.exit(fails.length ? 1 : 0);
