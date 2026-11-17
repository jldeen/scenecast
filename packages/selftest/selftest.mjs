// The kit's own end-to-end test, offline and headless: a fixture product (test/fixture/server.mjs) is recorded by
// the recorder exactly the way a demo is (a "person" clicks, types and presses Enter in two app tabs while the
// agent watches), side paths are captured (hovers, clicks with a menu whose styles load on open, a resize handle,
// step groups, a "+N" chip list, zoom, a virtualized grid), the replica is built, served, and the fidelity checklist
// runs on it, including two identical runs of the recorded path.
//   node test/selftest.mjs [--keep]        (--keep leaves the temp demo folder and prints where it is)
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { chromium } from 'playwright-core';
import { startFixture } from './fixture/server.mjs';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');
const RX_PORT = 47691, REPLICA_PORT = 4699;
const tmp = mkdtempSync(join(tmpdir(), 'replica-selftest-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fails = [];
const times = {};
const check = (name, ok, detail) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? `: ${detail}` : '')); if (!ok) fails.push(name); };
// A fresh clone has no git identity of its own: the test demo's commits get this one.
const GIT_ID = { GIT_AUTHOR_NAME: 'replica selftest', GIT_AUTHOR_EMAIL: 'selftest@localhost', GIT_COMMITTER_NAME: 'replica selftest', GIT_COMMITTER_EMAIL: 'selftest@localhost' };
const run = (args, opts = {}) => new Promise(res => {
  const p = spawn(process.execPath, [join(KIT, 'bin/replica.mjs'), ...args], { cwd: opts.cwd || tmp, env: { ...process.env, ...GIT_ID, REPLICA_RX_PORT: String(RX_PORT), REPLICA_NO_OPEN: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; p.stdout.on('data', d => { out += d; if (opts.echo) process.stdout.write(d); }); p.stderr.on('data', d => { out += d; process.stderr.write(d); });
  p.on('close', code => res({ code, out }));
});
const procs = [];
const bg = (args) => { const p = spawn(process.execPath, [join(KIT, 'bin/replica.mjs'), ...args], { cwd: tmp, env: { ...process.env, REPLICA_RX_PORT: String(RX_PORT), REPLICA_NO_OPEN: '1' }, stdio: 'ignore' }); procs.push(p); return p; };
const json = s => { const i = s.indexOf('{'); return JSON.parse(s.slice(i)); };

// Ports in use mean a server from another run is still up: its data would be read instead of this run's.
for (const port of [RX_PORT, REPLICA_PORT, 47801, 47802]) {
  const busy = await new Promise(res => { const s = createServer().once('error', () => res(true)).once('listening', () => s.close(() => res(false))).listen(port, '127.0.0.1'); });
  if (busy) { console.log(`port ${port} is in use: stop whatever is on it and run again`); process.exit(1); }
}
const fx = startFixture();
let browser;
try {
  // 1 · A new demo folder from the template, pointed at the fixture.
  let r = await run(['new', 'fixture-demo', '--dir', tmp, '--title', 'Fixture', '--port', String(REPLICA_PORT), '--app', `chat=${fx.chat}`, '--app', `admin=${fx.admin}`]);
  check('scaffold', r.code === 0 && existsSync(join(tmp, 'fixture-demo', 'demo.json')), r.out);
  const DEMO = join(tmp, 'fixture-demo');
  const cfg = JSON.parse(readFileSync(join(DEMO, 'demo.json'), 'utf8'));
  Object.assign(cfg, { raw: join(tmp, 'raw'), receiverPort: RX_PORT, viewport: { width: 1600, height: 900, dpr: 1 }, zooms: [67, 150, 200] });
  Object.assign(cfg.record, { settleMs: 1200, typeIdleMs: 700, everyMs: 250, streamMinMs: 1200 });
  writeFileSync(join(DEMO, 'demo.json'), JSON.stringify(cfg, null, 2));
  const at = { cwd: DEMO };
  check('scaffold: a focus file', /export default \[/.test(readFileSync(join(DEMO, 'focus.mjs'), 'utf8')));
  // Focus points (⌥F): text, a selector with an arrow, the block around a text, on screens of both apps. The beats
  // come from the recording, so the file is a function of the flow.
  writeFileSync(join(DEMO, 'focus.mjs'), `const F = (id, beat, app, states, target, extra = {}) => ({ id, beat, app, states: [].concat(states), ...(typeof target === 'string' ? { find: target } : Array.isArray(target) ? { union: target } : { union: [target] }), ...extra });
export default flow => {
  const admin = flow.beats.findIndex(b => b.active === 'admin'), chat = flow.beats.map(b => b.active).lastIndexOf('chat');
  return [
    F('answer-risk', 0, 'chat', 'chat-01-message', 'Two builds and three customer orders are at risk'),
    F('admin-search', admin, 'admin', 'admin-start', { sel: 'input[aria-label="Search tools by name"]' }, { mark: 'arrow', dir: 'se' }),
    F('admin-details', admin, 'admin', 'admin-02-alpha-6', [{ sel: '[role=dialog] h2' }, { text: 'Publisher: Fixture', up: 'p' }]),
    F('answer-cost', chat, 'chat', 'chat-05-send', 'The cost of the delay is about $35,073.', { mark: 'arrow', dir: 'sw' }),
  ];
};
`);

  // 2 · The agent, the receiver, and Chrome with the two app tabs (light mode).
  r = await run(['agent', join(tmp, 'agent')], at);
  check('agent builds', r.code === 0, r.out);
  bg(['receiver', '--demo', DEMO]);
  await sleep(600);
  browser = await chromium.launch({ channel: process.env.REPLICA_CHROME_CHANNEL || 'chrome', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light' });
  const chat = await ctx.newPage(); await chat.goto(fx.chat);
  const admin = await ctx.newPage(); await admin.goto(fx.admin);
  await chat.bringToFront(); await sleep(500);
  const agent = eval(readFileSync(join(tmp, 'agent', 'agent.js'), 'utf8'));
  check('agent starts', (await agent(chat)) === 'agent started');

  // 3 · Record: the person runs the demo once. Each new screen's side states (hovers, panes and menus, step groups,
  // "+N", resize handles, zoom, every row of a long list) are captured as it goes: one Chrome pass, nothing after.
  const cmd = async (...a) => { const x = await run(a, at); try { return json(x.out); } catch (e) { return { raw: x.out }; } };
  const settled = async () => { await sleep(450); for (let i = 0, ok = 0; i < 1200; i++) { const s = await cmd('record', 'status'); if (!s.busy && !(s.typing || []).length) { if (++ok >= 2) return s; } else ok = 0; await sleep(250); } throw new Error('recorder never settled'); };
  const tRec = Date.now();
  let s = await cmd('record', 'start');
  check('record start, automatic side paths on', s.recording === true && s.auto === true, JSON.stringify(s));
  await settled();
  // Chat: prompt 1 typed and sent with Enter at once (the recorder holds Enter, captures the typed screen first).
  await chat.click('[aria-label="Message"]'); await chat.keyboard.type('Summarize the supplier delay on PO-450101', { delay: 15 });
  await chat.keyboard.press('Enter'); await settled();
  await chat.click('[aria-label="Close workspace"]'); await settled();
  await chat.click('[aria-label="Show workspace"]'); await settled();
  await chat.click('[aria-label="Plugins"]'); await settled();
  // An interruption: the recording stops without being written (as if the agent died). record start --resume picks
  // it up from the receiver's checkpoint.
  s = await cmd('cmd', 'recordAbort');
  check('interrupted', s.aborted === true, JSON.stringify(s));
  s = await cmd('record', 'start', '--resume');
  check('resumed from the checkpoint', s.resumed === true && s.states >= 6 && s.steps >= 5 && !(s.notOnTheirScreen || []).length, JSON.stringify(s));
  // Admin: a search, a row's details, Escape.
  await admin.bringToFront(); await sleep(300);
  await admin.click('[aria-label="Search tools by name"]'); await admin.keyboard.type('alpha', { delay: 30 });
  await admin.keyboard.press('Enter'); await settled();
  await admin.click('[role=gridcell]:text-is("alpha-6")'); await settled();
  await admin.keyboard.press('Escape'); await settled();
  // Chat again: New, prompt 2 typed, a pause, then the send arrow.
  await chat.bringToFront(); await sleep(300);
  await chat.click('[aria-label="New"]'); await settled();
  await chat.click('[aria-label="Message"]'); await chat.keyboard.type('What will it cost us?', { delay: 15 });
  await settled();
  await chat.click('[aria-label="Send"]'); await settled();
  s = await cmd('record', 'stop');
  times.recording = Math.round((Date.now() - tRec) / 1000);
  check('record stop', s.states >= 10 && s.streams === 2, JSON.stringify(s).slice(0, 600));
  check('side states captured on the way', (s.autos || []).length >= 8, JSON.stringify(s.autos));
  console.log(`TIME recording, one Chrome pass with every side state: ${times.recording} s (side paths ${s.autoSecs} s)\n  ` + (s.autos || []).join('\n  '));
  await browser.close(); browser = null;

  // 4 · Build: flow.json from the recording, raw captures → data/, secret scan.
  let t1 = Date.now();
  r = await run(['build', '--from-raw'], at);
  times.build = +((Date.now() - t1) / 1000).toFixed(1);
  check('build', r.code === 0, r.out.slice(-1500));
  const flow = JSON.parse(readFileSync(join(DEMO, 'flow.json'), 'utf8'));
  const S = flow.states;
  const ids = Object.keys(S);
  const byApp = a => ids.filter(i => S[i].app === a);
  const answer = Object.values(flow.streams)[0] && Object.values(flow.streams)[0].to;
  check('flow: typed screen before Enter', !!S['chat-start-typed'] && S['chat-start'].on.some(t => t.type && t.to === 'chat-start-typed'), ids.join(' '));
  check('flow: Enter streams the answer', (S['chat-start-typed'].on || []).some(t => t.enter && t.stream), JSON.stringify(S['chat-start-typed']));
  check('flow: stream keeps its prompt and real timing', Object.values(flow.streams).every(x => x.timing === 'real' && x.frames[1] >= 3) && Object.values(flow.streams)[0].prompt === 'Summarize the supplier delay on PO-450101', JSON.stringify(flow.streams));
  const closed = (S[answer].on || []).find(t => t.click && /Close workspace/.test(JSON.stringify(t.click)));
  check('flow: pane closes', !!closed, JSON.stringify(S[answer]));
  check('flow: pane reopens to the same state', closed && (S[closed.to].on || []).some(t => t.to === answer), closed && JSON.stringify(S[closed.to]));
  check('flow: matchers are roles, labels and text', ids.every(i => (S[i].on || []).every(t => { const m = t.click || t.enter || t.type; return !m || !/\.[a-z][\w-]*-\d|class/i.test(m.sel || ''); })));
  check('flow: send arrow carries the typed text', ids.some(i => (S[i].on || []).some(t => t.click && t.typedFrom && t.stream)), '');
  check('flow: Escape closes the details', byApp('admin').some(i => S[i].esc), byApp('admin').map(i => JSON.stringify(S[i])).join('\n'));
  // Side states: once per kind of screen (zoom, chips, drags), once per control (hovers, clicks), once per group.
  check('flow: zoom bands, once per kind of screen', (flow.apps.find(a => a.id === 'chat').layout.responsive || [])[0].bands.length === 2 && flow.zoomRefs.length === 12 && new Set(flow.zoomRefs.map(z => z.state)).size === 4, JSON.stringify(flow.zoomRefs.map(z => z.snap)));
  check('flow: hover pages and the list', flow.hoverPages.length >= 1 && flow.lists.length >= 1 && flow.lists[0].state === 'admin-start' && flow.lists[0].seen === 300, JSON.stringify([flow.hoverPages, flow.lists]));
  check('flow: one click page (no control clicked twice), sections sticky, menus not', flow.clickPages.length === 1 && flow.clickPages[0].sticky.includes('Projects') && !flow.clickPages[0].sticky.includes('More options'), JSON.stringify(flow.clickPages));
  const G = (flow.groups || [])[0] || {};
  check('flow: step groups', flow.groups.length === 1 && G.template.label === '3 steps' && G.open.length === 2 && JSON.stringify(G.grid) === JSON.stringify({ closed: ['row-closed'], open: ['row-open'] }) && G.streams.length === 2, JSON.stringify(flow.groups));
  const CH = (flow.apps.find(a => a.id === 'chat').layout.chips || [])[0];
  check('flow: chips rule', CH && CH.rows === 2 && CH.gap === 6 && CH.plus.less === 'Show less' && flow.variants.includes(CH.plus.from), JSON.stringify(CH));
  check('flow: drag rule', flow.drags.length === 1 && flow.drags[0].target === 'aside[aria-label="Workspace"]' && flow.drags[0].mode === 'live', JSON.stringify(flow.drags));
  check('flow: focus points, and the kit\'s focus module', (flow.focus || []).length === 4 && flow.focus[1].beat > 0 && (flow.modules || [])[0] === '/app/focus-module.js', JSON.stringify([flow.focus, flow.modules]));
  check('flow: beats', flow.beats.length >= 4 && flow.beats[0].states.admin === 'admin-start', JSON.stringify(flow.beats));
  check('data: no secrets, no scripts', /secret scan: clean/.test(r.out));
  {
    const H = JSON.parse(readFileSync(join(DEMO, 'data', 'snaps', 'hovers-chat.json'), 'utf8'));
    const texts = H.defs.flatMap(d => (d.portals || []).map(q => q.text));
    check('hovers: a chip\'s card and the Projects section', texts.some(t => /Your work: mail/.test(t)) && H.defs.some(d => (d.ops || []).some(o => /New project/.test(o.html || ''))), JSON.stringify(texts).slice(0, 300));
    check('clicks: the menu with its lazy stylesheet', (H.clicks || []).some(c => c.name === 'More options' && c.restore === 'escape') && /fx-menu/.test(Object.values(H.css).join('')), JSON.stringify((H.clicks || []).map(c => [c.name, c.restore])));
  }

  // 5 · Serve the replica (tweaks show on reload), and look at the parts that only show when clicked.
  bg(['serve', '--demo', DEMO]);
  await sleep(800);
  // The menu's styles only existed on the real page while it was open: the replica's menu has them.
  {
    const b2 = await chromium.launch({ channel: process.env.REPLICA_CHROME_CHANNEL || 'chrome', headless: true });
    const p2 = await b2.newPage({ viewport: { width: 1600, height: 900 } });
    await p2.goto(`http://127.0.0.1:${REPLICA_PORT}/`); await p2.waitForFunction(() => window.d1 && window.d1.state.active);
    await p2.evaluate(() => window.d1.go('chat', 'chat-01-message'));
    const at = await p2.evaluate(() => window.d1.locate({ sel: 'button[aria-label="More options"]' }));
    await p2.mouse.click(at.x, at.y); await sleep(300);
    const bg2 = await p2.evaluate(() => { const m = window.d1.doc('chat').querySelector('[role=menu]'); return m && getComputedStyle(m).backgroundColor; });
    check('replica: lazy menu styles', bg2 === 'rgb(250, 240, 255)', String(bg2));
    await p2.keyboard.press('Escape');
    // Resting on Projects first (its hover puts a button in the section), then clicking: the section still collapses.
    const pr = await p2.evaluate(() => window.d1.locate({ sel: 'button[aria-label="Projects"]' }));
    await p2.mouse.move(pr.x, pr.y, { steps: 3 }); await sleep(800);
    const hovering = (await p2.evaluate(() => window.d1.hovers('chat'))).length;
    await p2.mouse.click(pr.x, pr.y); await sleep(300);
    const collapsed = (await p2.evaluate(() => window.d1.clicks('chat'))).some(c => c.name === 'Projects');
    check('replica: a click after its hover', hovering > 0 && collapsed, JSON.stringify({ hovering, collapsed }));
    // Each answer's step group shows its own steps (both are "3 steps").
    await p2.evaluate(() => window.d1.go('chat', 'chat-05-send'));
    const own = async () => {
      const g = (await p2.evaluate(() => window.d1.groupButtons('chat'))).find(x => x.key === '3 steps');
      await p2.mouse.click(g.x, g.y); await sleep(400); await p2.evaluate(() => window.d1.idle());
      return (await p2.evaluate(() => window.d1.groupButtons('chat'))).find(x => x.id === g.id);
    };
    const g2 = await own();
    check('replica: a step group shows its own answer\'s steps', g2 && g2.expanded && /Pricing the delay/.test(g2.text) && !/supplier alert/.test(g2.text), JSON.stringify(g2));
    await b2.close();
  }
  // 6 · Release: the full checklist (two identical runs included), a secret scan, a commit.
  t1 = Date.now();
  r = await run(['release'], { ...at, echo: true });
  times.release = Math.round((Date.now() - t1) / 1000);
  let fid = JSON.parse(readFileSync(join(DEMO, '.out', 'fidelity.json'), 'utf8'));
  for (const item of fid.items) check(`fidelity: ${item.id}`, item.status !== 'fail', item.detail);
  check('release passes and commits', r.code === 0 && /saved [0-9a-f]+ release/.test(r.out), r.out.slice(-600));
  const two = fid.items.find(i => i.id === 'two-run');
  check('two runs identical', two && two.status === 'pass', two && two.detail);
  const it = id => fid.items.find(i => i.id === id) || {};
  check('focus points: each lands on screen with its mark, the same twice; beat keys, ↑/↓, Esc and ⌥0', it('focus').status === 'pass' && /4 points/.test(it('focus').detail), JSON.stringify(it('focus')));
  check('cold start: three fresh clones, each first run identical to the warm runs', it('cold-start').status === 'pass' && /^3 clones/.test(it('cold-start').detail), JSON.stringify(it('cold-start')));
  times.focus = it('focus').secs; times.coldStart = it('cold-start').secs;
  // 7 · A tweak: one line, shown on reload with no build; the quick check covers only the screens it touched.
  t1 = Date.now();
  r = await run(['text', 'by six days', 'by a week'], at);
  const page = await (await fetch(`http://127.0.0.1:${REPLICA_PORT}/snaps/chat-01-message.html`)).text();
  times.tweakVisible = +((Date.now() - t1) / 1000).toFixed(1);
  check('tweak: shows on reload, without a build', /by a week/.test(page) && !/by six days/.test(page), page.slice(0, 200));
  t1 = Date.now();
  r = await run(['quick'], at);
  times.quick = Math.round((Date.now() - t1) / 1000);
  const q = JSON.parse(readFileSync(join(DEMO, '.out', 'quick.json'), 'utf8'));
  check('quick: only the screens the tweak touched, and they pass', q.pass && q.scope.includes('chat-01-message') && !q.scope.some(x => x.startsWith('admin')) && q.scope.length < Object.keys(flow.states).length, JSON.stringify([q.scope, q.items.filter(i => i.status === 'fail')]));
  // 8 · Release again: the tweak baked in, the full checklist, a commit; then nothing pending.
  t1 = Date.now();
  r = await run(['release'], at);
  times.release2 = Math.round((Date.now() - t1) / 1000);
  fid = JSON.parse(readFileSync(join(DEMO, '.out', 'fidelity.json'), 'utf8'));
  const built = readFileSync(join(DEMO, 'data', 'snaps', 'chat-01-message.html'), 'utf8');
  check('release: the tweak baked in, checklist passes', r.code === 0 && fid.pass && /by a week/.test(built), r.out.slice(-600));
  // A file only on this machine (kept out of git): the warm runs still pass, a fresh clone doesn't.
  {
    const img = (readFileSync(join(DEMO, 'data', 'snaps', 'chat-start.html'), 'utf8').match(/<img[^>]*src="\/assets\/([^"]+)"/) || [])[1];
    const gi = readFileSync(join(DEMO, '.gitignore'), 'utf8');
    const git = (...a) => spawnSync('git', ['-C', DEMO, ...a], { encoding: 'utf8' });
    git('rm', '--cached', '-q', `data/assets/${img}`); writeFileSync(join(DEMO, '.gitignore'), gi + `data/assets/${img}\n`);
    r = await run(['fidelity', '--only', 'two-run,cold-start'], at);
    const f2 = JSON.parse(readFileSync(join(DEMO, '.out', 'fidelity.json'), 'utf8')), c2 = f2.items.find(i => i.id === 'cold-start') || {};
    check('cold start: catches a file that isn\'t in the repository', !!img && c2.status === 'fail' && /clone 1: .*(404|failed|differ)/.test(c2.detail) && (f2.items.find(i => i.id === 'two-run') || {}).status === 'pass', JSON.stringify([img, c2]));
    writeFileSync(join(DEMO, '.gitignore'), gi); git('reset', '-q');
  }
  r = await run(['status'], at);
  check('status: nothing pending', /build +up to date/.test(r.out) && /all committed/.test(r.out), r.out);
  console.log('TIMES ' + JSON.stringify(times));
  writeFileSync(join(tmp, 'times.json'), JSON.stringify(times));
} catch (e) {
  check('selftest ran to the end', false, String(e.stack || e));
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const p of procs) p.kill();
  fx.close();
  if (keep || fails.length) console.log('demo folder: ' + tmp); else rmSync(tmp, { recursive: true, force: true });
}
console.log(fails.length ? `${fails.length} FAILED` : 'ALL PASS');
process.exit(fails.length ? 1 : 0);
