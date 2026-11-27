// Phase 4 end to end, on the fixture demo the selftest recorded (selftest.mjs runs this at its end; or on a kept demo:
//   node packages/selftest/script-focus.mjs --demo <dir>), through the scenecast binary, headless:
//   1. scenecast script examples/fixture-app/script.md: every line on its screen with the focus points agreed below
//      (EXPECTED), the unbacked lines flagged on the sheet (HTML and PDF), the cue sheet, focus.json; a second run gives
//      the same points landing the same way, and the checklist's focus check passes on them (each played twice).
//   2. The editor, in Chrome and Edge: hidden until its key; a scripted new user adds a dot and changes a date (and
//      sets a beat start, moves, deletes and reorders points, and undoes) in under 5 minutes of simulated steps; the
//      changes show at once, persist (focus.json, flow.editor.json, the served pages) and replay identically.
import './reap.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { chromium } from 'playwright-core';
import { selftestGuard } from './guard.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'examples', 'fixture-app', 'script.md');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The agreed result for examples/fixture-app/script.md on the fixture: for every line, the screen it plays over, whether
// the screen backs it, and its focus points in ⌥F order ([beat, target, mark, arrow dir]). Change it only on purpose.
const LI = t => ({ text: t, up: '[role=listitem]' });
export const EXPECTED = {
  '1.1': { state: 'chat-start', status: 'unbacked', points: [] },
  '1.2': { state: 'chat-01-message', status: 'backed', points: [[2, 'You said: Summarize the supplier delay on PO-450101', 'rect']] },
  '1.3': { state: 'chat-01-message', status: 'backed', points: [[2, 'Kestrel moved the ship date on PO-450101 by six days.', 'rect']] },
  '1.4': { state: 'chat-01-message', status: 'backed', points: [[2, 'Two builds and three customer orders are at risk; the earliest is due Friday.', 'rect']] },
  '1.5': { state: 'chat-01-message', status: 'backed', points: [[2, 'Workspace', 'rect'], [2, [LI('Work IQ'), LI('Fabric IQ')], 'rect']] },
  '2.1': { state: 'chat-03-plugins', status: 'backed', points: [[2, 'Supply chain disruption', 'rect']] },
  '3.1': { state: 'admin-start', status: 'backed', points: [[3, 'Fixture Admin', 'rect'], [3, [{ sel: 'input[aria-label="Search tools by name"]' }], 'arrow', 'se']] },
  '3.2': { state: 'admin-02-alpha-6', status: 'backed', points: [[3, [{ sel: 'h2' }], 'rect'], [3, 'Publisher: Fixture', 'rect']] },
  '4.1': { state: 'chat-05-send', status: 'backed', points: [[5, 'You said: What will it cost us?', 'rect']] },
  '4.2': { state: 'chat-05-send', status: 'backed', points: [[5, 'The cost of the delay is about $35,073.', 'rect'], [5, [{ text: 'Approved 1 action', up: 'button' }], 'arrow', 'se']] },
  '4.3': { state: 'chat-05-send', status: 'unbacked', points: [], missing: ['CFO'] },
};
const shape = p => [p.beat, p.find || p.union, p.mark, ...(p.dir ? [p.dir] : [])];

// A new user's steps, in the seconds a person takes for each (reading the panel included).
const SIM = { key: 2, click: 4, drag: 6, char: 0.4, read: 5 };
const freePort = () => new Promise(res => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

export async function scriptAndEditor({ DEMO, BIN, check, times = {} }) {
  const run = (args, opts = {}) => new Promise(res => {
    const p = spawn(BIN, args, { cwd: DEMO, env: { ...process.env, REPLICA_NO_OPEN: '1', ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
    p.on('close', code => res({ code, out }));
  });
  const read = f => JSON.parse(readFileSync(join(DEMO, f), 'utf8'));
  for (const f of ['focus.json', 'flow.editor.json']) rmSync(join(DEMO, f), { force: true });

  // ---- 1 · script to focus --------------------------------------------------------------------------------------
  let t1 = Date.now();
  let r = await run(['script', SCRIPT]);
  times.script = +((Date.now() - t1) / 1000).toFixed(1);
  check('script: runs', r.code === 0 && /11 lines: 9 backed, 0 partly, 2 not backed/.test(r.out), r.out.slice(-1500));
  const OUT = join(DEMO, '.out', 'script');
  const rep = JSON.parse(readFileSync(join(OUT, 'script.json'), 'utf8'));
  // The expected text is the fixture's as captured; the demo's own wording edits (scenecast text) apply to it too.
  const edits = (read('flow.json').edits || []).filter(e => e.replace && !e.in);
  const edited = v => typeof v === 'string' ? edits.reduce((t, e) => t.split(e.replace[0]).join(e.replace[1]), v) : Array.isArray(v) ? v.map(edited) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, edited(x)])) : v;
  for (const [id, want] of Object.entries(EXPECTED)) {
    const l = rep.lines.find(x => x.id === id) || {};
    const got = { state: l.state, status: l.status, points: rep.points.filter(p => p.line === id).map(shape) };
    const exp = { state: want.state, status: want.status, points: edited(want.points) };
    check(`script: line ${id} on ${want.state}, ${want.status}, ${want.points.length} focus point(s) as agreed`, isDeepStrictEqual(got, exp) && (!want.missing || isDeepStrictEqual(l.missing, want.missing)), JSON.stringify({ got, missing: l.missing }));
  }
  check('script: every line in the expected set', rep.lines.length === Object.keys(EXPECTED).length, rep.lines.map(l => l.id).join(' '));
  check('script: every focus point lands', rep.points.every(p => p.landing && !p.landing.error && p.landing.Z >= 1), JSON.stringify(rep.points.filter(p => !p.landing || p.landing.error).map(p => p.id)));
  const sheet = readFileSync(join(OUT, 'sheet.html'), 'utf8');
  const flagged = [...sheet.matchAll(/data-line="([^"]+)" data-status="(unbacked|partial)"/g)].map(m => m[1]);
  check('sheet: flags every unbacked line, and only those', isDeepStrictEqual(flagged, ['1.1', '4.3']) && (sheet.match(/Not backed: nothing on this screen supports this line/g) || []).length === 2 && /Not on this screen: CFO/.test(sheet), JSON.stringify(flagged));
  check('sheet: each line next to its screen, landings shown', (sheet.match(/<img class="main" src="shots\/line-/g) || []).length === 11 && rep.points.every(p => existsSync(join(OUT, p.landing.shot))) && rep.lines.every(l => existsSync(join(OUT, l.shot))));
  check('sheet: PDF', existsSync(join(OUT, 'sheet.pdf')) && readFileSync(join(OUT, 'sheet.pdf')).subarray(0, 5).toString() === '%PDF-');
  const cues = readFileSync(join(OUT, 'cues.md'), 'utf8');
  check('cue sheet: the steps to each screen and ⌥F per point', /Switch to Admin \(⌥A\)/.test(cues) && /Click “alpha-6”/.test(cues) && (cues.match(/^- ⌥F /gm) || []).length === rep.points.length && /⚠ nothing on screen backs this line/.test(cues), cues.slice(0, 600));
  const fj = read('focus.json');
  check('focus.json: the script\'s points, for the replica', fj.points.length === rep.points.length && fj.points.every(p => p.source === 'script') && fj.script === 'script.md', JSON.stringify(fj).slice(0, 300));
  // Twice: the same points, landing the same way.
  r = await run(['script', SCRIPT, '--no-pdf', '--ndjson']);
  const events = r.out.split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l).event);
  check('script: progress, one event per step (--ndjson)', ['parsed', 'indexed', 'matched', 'landed', 'done'].every(e => events.includes(e)), r.out.slice(0, 800));
  const rep2 = JSON.parse(readFileSync(join(OUT, 'script.json'), 'utf8'));
  const land = x => x.points.map(p => [p.id, p.find || p.union, p.mark, p.dir, p.landing.Z, p.landing.box, p.landing.on]);
  check('script: a second run, the same points landing the same way', r.code === 0 && isDeepStrictEqual(land(rep), land(rep2)), JSON.stringify([land(rep), land(rep2)]).slice(0, 2000));
  // The checklist plays every focus point (the script's and focus.mjs's) twice, with the beat keys, ↑/↓ and Esc.
  r = await run(['check', '--only', 'focus']);
  const fid = read('.out/fidelity.json'), fc = fid.items.find(i => i.id === 'focus') || {};
  check('checklist: the script\'s focus points land the same twice', r.code === 0 && fc.status === 'pass' && new RegExp(`^${rep.points.length + 4} points`).test(fc.detail), JSON.stringify(fc));
  const afterScript = readFileSync(join(DEMO, 'focus.json'));

  // ---- 2 · the editor, in Chrome and Edge ------------------------------------------------------------------------
  const channels = ['chrome', 'msedge'];
  for (const channel of channels) {
    let browser;
    try { browser = await chromium.launch({ channel, headless: true }); }
    catch (e) {
      // Every CI runner has both; a machine without Edge skips it (and says so).
      check(`editor (${channel}): browser available`, !process.env.CI, String(e.message).split('\n')[0]);
      continue;
    }
    writeFileSync(join(DEMO, 'focus.json'), afterScript);
    rmSync(join(DEMO, 'flow.editor.json'), { force: true });
    const port = await freePort();
    const srv = spawn(BIN, ['edit', '--no-open', '--port', String(port)], { cwd: DEMO, env: { ...process.env, REPLICA_NO_OPEN: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let srvOut = ''; srv.stdout.on('data', d => { srvOut += d; });
    try {
      for (let i = 0; i < 100 && !/"event":"ready"/.test(srvOut); i++) await sleep(100);
      const ready = JSON.parse((srvOut.split('\n').find(l => l.startsWith('@edit ') && /"ready"/.test(l)) || '@edit {}').slice(6));
      check(`edit (${channel}): scenecast edit serves the replica in edit mode`, /edit=1/.test(ready.url || ''), srvOut);
      const url = `http://127.0.0.1:${port}/`;
      await editorFlow({ browser, url, channel, check, times, DEMO, srv: () => srvOut });
    } catch (e) {
      check(`editor (${channel}) ran to the end`, false, String(e.stack || e));
    } finally {
      await browser.close().catch(() => {});
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(srv.pid), '/T', '/F'], { stdio: 'ignore' }); else srv.kill();
    }
  }
  return times;
}

async function editorFlow({ browser, url, channel, check, times, DEMO, srv }) {
  const C = `editor (${channel})`;
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  let sim = 0;
  const t0 = Date.now();
  const d1 = (fn, arg) => page.evaluate(fn, arg);
  const idle = async () => { await d1(() => window.d1.editor.idle()); await d1(() => window.d1.idle()); };
  const key = async k => { sim += SIM.key; await page.keyboard.press(k); await sleep(150); await idle(); };
  const word = (app, text) => d1(([app, text]) => {
    const d = window.d1.doc(app), w = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode());) { const i = n.data.indexOf(text); if (i < 0) continue; const r = d.createRange(); r.setStart(n, i); r.setEnd(n, i + text.length); const b = r.getBoundingClientRect(), f = d.defaultView.frameElement.getBoundingClientRect(); if (b.width) return { x0: f.x + b.left, x1: f.x + b.right, y: f.y + b.top + b.height / 2 }; }
    return null;
  }, [app, text]);
  const served = async (snap, re) => re.test(await (await fetch(url + 'snaps/' + snap + '.html')).text());

  await page.goto(url);
  await page.waitForFunction(() => window.d1 && window.d1.state.active && window.d1.editor);
  // Present mode: nothing of the editor in the page until its key.
  check(`${C}: nothing on screen in present mode`, !(await d1(() => !!document.querySelector('[data-scenecast-editor]'))) && !(await d1(() => window.d1.editor.on)));
  await key('Control+Alt+Shift+KeyE');
  check(`${C}: the hidden key opens it`, await d1(() => window.d1.editor.on && !!document.querySelector('[data-scenecast-editor="panel"]')), errs.join('\n'));
  sim += SIM.read;

  // ⌥2: the first answer. A new dot on the More options button (a control: an arrow), shown at once.
  await key('Control+Alt+Digit2');
  const more = await d1(() => window.d1.locate({ sel: 'button[aria-label="More options"]' }, 'chat'));
  sim += SIM.click; await page.mouse.click(more.x, more.y); await idle();
  let s = await d1(() => window.d1.editor.state());
  const dot = s.points.find(p => p.source === 'dot');
  check(`${C}: a click drops a dot, snapped to the control, with an arrow and its beat`, dot && dot.states[0] === 'chat-01-message' && dot.beat === 2 && dot.mark === 'arrow' && JSON.stringify(dot.union) === JSON.stringify([{ sel: 'button[aria-label="More options"]' }]) && s.dots.some(d => d.id === dot.id), JSON.stringify(s).slice(0, 1500));
  // Its place in the beat: reading order among this screen's points (it's above them all).
  const order = await d1(() => window.d1.focus.points.filter(p => p.beat === 2 && p.states[0] === 'chat-01-message').map(p => p.id));
  check(`${C}: its place in the beat, in reading order`, dot && order[0] === dot.id, JSON.stringify(order));
  sim += SIM.read;
  // It plays the way ⌥F plays: at once, no reload.
  const shown = await d1(async id => { window.d1.editor.toggle(false); await new Promise(r => setTimeout(r, 50)); window.d1.focus.at(id); await window.d1.focus.next(); return window.d1.focus.state(); }, dot && dot.id);
  check(`${C}: the dot plays at once (⌥F), no reload`, shown.id === (dot && dot.id) && shown.z === 2 && shown.last.kind === 'arrow', JSON.stringify(shown));
  await key('Escape'); await page.waitForFunction(() => !window.d1.focus.zoomed);
  await key('Control+Alt+Shift+KeyE');

  // A date: drag across "Friday" in the answer, type the new day, Enter. Shown at once on this screen.
  const fri = await word('chat', 'Friday');
  sim += SIM.drag;
  await page.mouse.move(fri.x0 + 2, fri.y); await page.mouse.down(); await page.mouse.move((fri.x0 + fri.x1) / 2, fri.y, { steps: 4 }); await page.mouse.move(fri.x1 - 2, fri.y, { steps: 4 }); await page.mouse.up();
  await page.waitForSelector('input[data-replace]');
  check(`${C}: a drag across text picks the word`, (await d1(() => window.d1.editor.state().replace)).text === 'Friday');
  await page.waitForFunction(() => /screen/.test(document.querySelector('[data-count]').textContent));
  const where = await d1(() => document.querySelector('[data-count]').textContent);
  check(`${C}: it says where else the text is`, +((/on (\d+) screens/.exec(where) || [])[1]) >= 2, where);
  sim += SIM.read + 6 * SIM.char + SIM.key;
  await page.keyboard.type('Monday', { delay: 20 }); await page.keyboard.press('Enter'); await idle();
  const now = await d1(() => window.d1.doc('chat').body.innerText);
  check(`${C}: the change shows at once`, /due Monday/.test(now) && !/due Friday/.test(now), now.slice(0, 400));
  // Everywhere the text appears: the second answer too, as it plays (⌥5), and as the server serves it.
  await key('Control+Alt+Digit5');
  check(`${C}: everywhere that text appears`, /due Monday/.test(await d1(() => window.d1.doc('chat').body.innerText)) && await served('chat-05-send', /due Monday/) && !(await served('chat-05-send', /due Friday/)));

  // A beat start: beat 2 starts on the screen with the workspace closed; ⌥2 goes there. Then undone.
  await d1(() => window.d1.go('chat', 'chat-02-close-workspace')); await idle();
  sim += SIM.click; await page.click('[data-scenecast-editor="panel"] button[data-act="beat"][data-n="2"]'); await idle();
  await key('Control+Alt+Digit2');
  check(`${C}: a beat start, at once`, (await d1(() => window.d1.state.states.chat)) === 'chat-02-close-workspace' && JSON.stringify(JSON.parse(readFileSync(join(DEMO, 'flow.editor.json'), 'utf8')).beats) === JSON.stringify({ 2: { active: 'chat', states: { chat: 'chat-02-close-workspace' } } }));
  await key(process.platform === 'darwin' ? 'Meta+KeyZ' : 'Control+KeyZ');
  await key('Control+Alt+Digit2');
  check(`${C}: undo puts the beat back`, (await d1(() => window.d1.state.states.chat)) === 'chat-01-message' && JSON.stringify(JSON.parse(readFileSync(join(DEMO, 'flow.editor.json'), 'utf8')).beats) === '{}');

  // Move the dot: drag it onto the answer's "3 steps" group button.
  s = await d1(() => window.d1.editor.state());
  const d = s.dots.find(x => x.id === dot.id), steps = await d1(() => { const b = window.d1.groupButtons('chat')[0]; return b; });
  sim += SIM.drag;
  await page.mouse.move(d.x, d.y); await page.mouse.down(); await page.mouse.move(d.x - 100, d.y + 50, { steps: 5 }); await page.mouse.move(steps.x, steps.y, { steps: 5 }); await page.mouse.up(); await idle();
  const moved = (await d1(() => window.d1.editor.state())).points.find(p => p.id === dot.id);
  check(`${C}: drag a dot to move it`, moved && JSON.stringify(moved.union) !== JSON.stringify(dot.union) && /3 steps/.test(JSON.stringify(moved.union) + moved.label), JSON.stringify(moved));
  // Delete a script point (select its dot, Delete), then undo brings it back.
  s = await d1(() => window.d1.editor.state());
  const victim = s.dots.find(x => x.id.startsWith('l1-3-'));
  sim += SIM.click + SIM.key;
  await page.mouse.click(victim.x, victim.y); await idle(); await key('Delete');
  const gone = !(await d1(() => window.d1.editor.state())).points.some(p => p.id === victim.id);
  await key(process.platform === 'darwin' ? 'Meta+KeyZ' : 'Control+KeyZ');
  check(`${C}: delete, and undo`, gone && (await d1(() => window.d1.editor.state())).points.some(p => p.id === victim.id));
  // Reorder: the Workspace point after the chips.
  s = await d1(() => window.d1.editor.state());
  const ws = s.dots.find(x => x.id.startsWith('l1-5-workspace'));
  sim += SIM.click + SIM.key;
  await page.mouse.click(ws.x, ws.y); await idle(); await key(']');
  const l15 = (await d1(() => window.d1.focus.points)).filter(p => p.line === '1.5').map(p => p.id);
  check(`${C}: reorder within the beat`, l15.length === 2 && l15[1] === ws.id, JSON.stringify(l15));
  sim += SIM.click;
  await page.click('[data-scenecast-editor="panel"] button[data-act="done"]');
  check(`${C}: Done hides it`, await d1(() => !window.d1.editor.on && [...document.querySelectorAll('[data-scenecast-editor]')].every(e => e.style.display === 'none')));
  check(`${C}: no errors in the page`, !errs.length && !(await d1(() => window.d1.errors.length)), errs.join('\n'));
  times[`editorSim_${channel}`] = Math.round(sim);
  times[`editorReal_${channel}`] = +((Date.now() - t0) / 1000).toFixed(1);
  check(`${C}: a new user's dot and date change in under 5 minutes of simulated steps (${Math.round(sim)} s)`, sim < 300);
  check(`${C}: every change saved, one line each from the server`, (srv().match(/^@edit \{"event":"saved"/gm) || []).length >= 8, srv().slice(-800));
  await page.close();

  // Persisted: the files, and a fresh replica (another browser) has them; the dot replays identically, twice.
  const fj = JSON.parse(readFileSync(join(DEMO, 'focus.json'), 'utf8')), ej = JSON.parse(readFileSync(join(DEMO, 'flow.editor.json'), 'utf8'));
  check(`${C}: saved to focus.json and flow.editor.json`, fj.points.some(p => p.id === dot.id && p.source === 'dot') && isDeepStrictEqual(ej.edits, [{ replace: ['Friday', 'Monday'] }]), JSON.stringify([fj.points.find(p => p.id === dot.id), ej]));
  const replay = async () => {
    const p = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
    await p.goto(url); await p.waitForFunction(() => window.d1 && window.d1.state.active && window.d1.focus);
    await p.evaluate(() => window.d1.jump(2)); await p.evaluate(() => window.d1.idle());
    const text = await p.evaluate(() => window.d1.doc('chat').body.innerText);
    await p.evaluate(id => { window.d1.focus.at(id); return window.d1.focus.next(); }, dot.id);
    await p.waitForFunction(() => !window.d1.focus.state().run && window.d1.focus.state().z === 2);
    await p.mouse.move(1, 1); await sleep(100);
    const st = await p.evaluate(() => window.d1.focus.state());
    const hash = createHash('sha256').update(await p.screenshot()).digest('hex');
    await p.close();
    return { text: /due Monday/.test(text) && !/due Friday/.test(text), last: st.last, marks: st.marks, hash };
  };
  const a = await replay(), b = await replay();
  check(`${C}: persists: a fresh replica has the dot and the date`, a.text && a.last && a.last.id === dot.id, JSON.stringify(a));
  check(`${C}: replays identically (two fresh runs)`, isDeepStrictEqual(a, b), JSON.stringify([a, b]).slice(0, 1500));
}

// Standalone, on a demo the selftest kept: node packages/selftest/script-focus.mjs --demo <dir>
if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
  const i = process.argv.indexOf('--demo');
  const DEMO = resolvePath(process.argv[i + 1]);
  await selftestGuard({ tmp: dirname(DEMO), kept: [dirname(DEMO)] });
  const BIN = process.env.SCENECAST_BIN ? resolvePath(process.env.SCENECAST_BIN) : join(ROOT, 'target', 'debug', process.platform === 'win32' ? 'scenecast.exe' : 'scenecast');
  const fails = [];
  const check = (name, ok, detail) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? `: ${String(detail).slice(0, 3000)}` : '')); if (!ok) fails.push(name); };
  const times = await scriptAndEditor({ DEMO, BIN, check });
  console.log('TIMES ' + JSON.stringify(times));
  console.log(fails.length ? `${fails.length} FAILED` : 'ALL PASS');
  process.exit(fails.length ? 1 : 0);
}
