// scenecast's end-to-end test, offline and headless, through the scenecast binary (SCENECAST_BIN, else
// target/debug/scenecast from cargo build -p scenecast-cli), on macOS, Windows and Linux: a fixture product (test/fixture/server.mjs) is recorded by
// the recorder exactly the way a demo is (a "person" clicks, types and presses Enter in two app tabs while the
// agent watches), side paths are captured (hovers, clicks with a menu whose styles load on open, a resize handle,
// step groups, a "+N" chip list, zoom, a virtualized grid), the replica is built, served, and the fidelity checklist
// runs on it, including two identical runs of the recorded path.
//   node test/selftest.mjs [--keep]        (--keep leaves the temp demo folder and prints where it is)
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync, statSync, unlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { chromium } from 'playwright-core';
import { startFixture } from '../../examples/fixture-app/server.mjs';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = process.env.SCENECAST_BIN ? resolvePath(process.env.SCENECAST_BIN) : join(KIT, '..', 'target', 'debug', process.platform === 'win32' ? 'scenecast.exe' : 'scenecast');
if (!existsSync(BIN)) { console.log(`no scenecast binary at ${BIN}: cargo build -p scenecast-cli first (or set SCENECAST_BIN)`); process.exit(1); }
const keep = process.argv.includes('--keep');
// The recorder: the extension (MV3, chrome.debugger) by default; --agent for the Playwright-driven agent.
const MODE = process.argv.includes('--agent') || process.env.SCENECAST_RECORDER === 'agent' ? 'agent' : 'extension';
const RX_PORT = 47691, REPLICA_PORT = 4699;
const tmp = mkdtempSync(join(tmpdir(), 'replica-selftest-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fails = [];
const times = {};
const check = (name, ok, detail) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? `: ${detail}` : '')); if (!ok) fails.push(name); };
// A fresh clone has no git identity of its own: the test demo's commits get this one.
const GIT_ID = { GIT_AUTHOR_NAME: 'replica selftest', GIT_AUTHOR_EMAIL: 'selftest@localhost', GIT_COMMITTER_NAME: 'replica selftest', GIT_COMMITTER_EMAIL: 'selftest@localhost' };
const run = (args, opts = {}) => new Promise(res => {
  const p = spawn(BIN, args, { cwd: opts.cwd || tmp, env: { ...process.env, ...GIT_ID, REPLICA_RX_PORT: String(RX_PORT), REPLICA_NO_OPEN: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; p.stdout.on('data', d => { out += d; if (opts.echo) process.stdout.write(d); }); p.stderr.on('data', d => { out += d; process.stderr.write(d); });
  p.on('close', code => res({ code, out }));
});
const procs = [];
const bg = (args) => { const p = spawn(BIN, args, { cwd: tmp, env: { ...process.env, REPLICA_RX_PORT: String(RX_PORT), REPLICA_NO_OPEN: '1' }, stdio: 'ignore' }); procs.push(p); return p; };
const json = s => { const i = s.indexOf('{'); return JSON.parse(s.slice(i)); };

// Ports in use mean a server from another run is still up: its data would be read instead of this run's.
for (const port of [RX_PORT, REPLICA_PORT, 47801, 47802]) {
  const busy = await new Promise(res => { const s = createServer().once('error', () => res(true)).once('listening', () => s.close(() => res(false))).listen(port, '127.0.0.1'); });
  if (busy) { console.log(`port ${port} is in use: stop whatever is on it and run again`); process.exit(1); }
}
// The extension, loaded unpacked into a fresh profile: Playwright's Chromium takes --load-extension; branded Chrome
// and Edge (which dropped that flag) get it through the DevTools protocol's Extensions.loadUnpacked instead.
async function launchWithExtension(ext, profile) {
  const channel = process.env.SCENECAST_EXT_CHANNEL || 'chromium';
  const args = ['--silent-debugger-extension-api', '--force-device-scale-factor=1', '--window-size=1700,1100', '--screen-info={0,0 2560x1600}', '--disable-features=DisableLoadExtensionCommandLineSwitch'];
  const branded = channel !== 'chromium';
  const ctx = await chromium.launchPersistentContext(profile, { channel, headless: true, viewport: null, colorScheme: 'light', ignoreDefaultArgs: ['--disable-extensions'],
    args: branded ? [...args, '--enable-unsafe-extension-debugging'] : [...args, `--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
  if (branded) {
    const b = await ctx.browser().newBrowserCDPSession();
    await b.send('Extensions.loadUnpacked', { path: ext });
  }
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
  return { ctx, sw };
}
// The window sized so the page is exactly w×h (whatever the browser's own bars take).
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
// Stops the extension's service worker, as the browser does to an idle one.
async function stopWorker(ctx, sw) {
  const b = await ctx.browser().newBrowserCDPSession();
  const { targetInfos } = await b.send('Target.getTargets');
  const t = targetInfos.find(x => x.type === 'service_worker' && x.url === sw.url());
  if (!t) throw new Error('no service worker target');
  await b.send('Target.closeTarget', { targetId: t.targetId });
  await b.detach();
  await sleep(1500);
}
const RECORD_ONLY = new Error('record only');
const fx = startFixture();
let browser, ctx;
try {
  // 1 · A new demo folder from the template, pointed at the fixture.
  let r = await run(['new', 'fixture-demo', '--dir', tmp, '--title', 'Fixture', '--port', String(REPLICA_PORT), '--app', `chat=${fx.chat}`, '--app', `admin=${fx.admin}`]);
  check('scaffold', r.code === 0 && existsSync(join(tmp, 'fixture-demo', 'demo.json')), r.out);
  const DEMO = join(tmp, 'fixture-demo');
  const manifestOf = () => JSON.parse(readFileSync(join(DEMO, 'manifest.json'), 'utf8'));
  {
    const m = manifestOf();
    check('scaffold: bundle v2, live-page scenes only', m.schema_version === 'scenecast.bundle.v2' && m.graph.scenes.length === 2 && m.graph.scenes.every(sc => sc.kind === 'live-page') && m.apps.map(a => a.id).join() === 'chat,admin', JSON.stringify(m.graph.scenes));
  }
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

  // 2 · The recorder, the receiver, and a browser with the two app tabs (light mode).
  const cmd = async (...a) => { const x = await run(a, at); try { return json(x.out); } catch (e) { return { raw: x.out }; } };
  bg(['receiver', '--demo', DEMO]);
  await sleep(600);
  let chat, admin, sw = null;
  if (MODE === 'extension') {
    // The extension as a presenter has it: loaded unpacked into the browser, talking to the receiver on its own.
    r = await run(['extension', join(tmp, 'ext')], at);
    check('extension builds', r.code === 0 && existsSync(join(tmp, 'ext', 'manifest.json')), r.out);
    ({ ctx, sw } = await launchWithExtension(join(tmp, 'ext'), join(tmp, 'profile')));
    chat = await ctx.newPage(); await chat.goto(fx.chat);
    for (const p of ctx.pages()) if (p !== chat) await p.close();
    await sizeWindow(chat, 1600, 900);
    await chat.bringToFront(); await sleep(500);
    let e = {};
    for (let i = 0; i < 40 && !e.version; i++) { e = await cmd('cmd', 'extension'); if (!e.version) await sleep(500); }
    check('extension connects to the receiver', !!e.version, JSON.stringify(e));
    // Preflight: the admin tab is missing, so it opens it (and touches nothing else); then again, all set, fast.
    let t1 = Date.now();
    let pf = await cmd('preflight', '--json');
    times.preflightFix = +((Date.now() - t1) / 1000).toFixed(1);
    const st = id => ((pf.items || []).find(i => i.id === id) || {}).status;
    check('preflight: opens the missing tab, leaves the rest', pf.ready && st('app admin') === 'fixed' && st('app chat') === 'ok' && st('browser') === 'ok' && st('receiver') === 'ok', JSON.stringify(pf));
    admin = ctx.pages().find(p => p.url().startsWith(fx.admin));
    check('preflight: the admin tab is open', !!admin, ctx.pages().map(p => p.url()).join(' '));
    await chat.bringToFront(); await sleep(300);
    t1 = Date.now();
    pf = await cmd('preflight', '--json');
    times.preflight = +((Date.now() - t1) / 1000).toFixed(1);
    check('preflight: all set, nothing done, under a minute', pf.ready && pf.items.every(i => i.status === 'ok') && times.preflight < 60, JSON.stringify(pf));
    const vp = await chat.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]);
    check('window is 1600×900 at 1×', vp.join() === '1600,900,1', vp.join());
  } else {
    r = await run(['agent', join(tmp, 'agent')], at);
    check('agent builds', r.code === 0, r.out);
    browser = await chromium.launch({ channel: process.env.REPLICA_CHROME_CHANNEL || 'chrome', headless: true });
    ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light' });
    chat = await ctx.newPage(); await chat.goto(fx.chat);
    admin = await ctx.newPage(); await admin.goto(fx.admin);
    await chat.bringToFront(); await sleep(500);
    const agent = eval(readFileSync(join(tmp, 'agent', 'agent.js'), 'utf8'));
    check('agent starts', (await agent(chat)) === 'agent started');
  }

  // 3 · Record: the person runs the demo once. Each new screen's side states (hovers, panes and menus, step groups,
  // "+N", resize handles, zoom, every row of a long list) are captured as it goes: one Chrome pass, nothing after.
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
  if (MODE === 'extension') {
    // An interruption: the browser stops the extension's service worker mid-recording (MV3 may, any time). The next
    // tab event starts it again and it resumes from the receiver's checkpoint on its own.
    await stopWorker(ctx, sw);
    check('service worker stopped', true);
    await admin.bringToFront(); await sleep(300);
    for (let i = 0; i < 120; i++) { s = await cmd('record', 'status'); if (s.recording && s.resumed) break; await sleep(500); }
    check('resumed from the checkpoint on its own', s.recording === true && s.resumed && s.resumed.states >= 6 && s.resumed.steps >= 5 && !(s.resumed.notOnTheirScreen || []).length, JSON.stringify(s));
    await settled();
  } else {
    // An interruption: the recording stops without being written (as if the agent died). record start --resume
    // picks it up from the receiver's checkpoint.
    s = await cmd('cmd', 'recordAbort');
    check('interrupted', s.aborted === true, JSON.stringify(s));
    s = await cmd('record', 'start', '--resume');
    check('resumed from the checkpoint', s.resumed === true && s.states >= 6 && s.steps >= 5 && !(s.notOnTheirScreen || []).length, JSON.stringify(s));
  }
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
  {
    // The recorder's own time, apart from the product's, and what it comes to at Demo 1's shape (4 apps, 38 screens)
    // at this fixture's density: each app's first screen (its full sweep), every later screen, and each screen's
    // capture and confirm time.
    const T = s.timing || {};
    const autos = (s.autos || []).map(x => ({ state: x.split(' ')[0], secs: +x.split(' ')[1] }));
    const starts = autos.filter(a => /-start$/.test(a.state)), later = autos.filter(a => !/-start$/.test(a.state));
    const avg = xs => xs.reduce((n, x) => n + x.secs, 0) / Math.max(1, xs.length);
    const perState = (T.captureSecs + T.confirmSecs) / Math.max(1, s.states);
    const demo1 = (4 * avg(starts) + 34 * avg(later) + 38 * perState) / 60;
    Object.assign(times, { recorderSecs: T.recorderSecs, productSecs: T.productSecs, sweepSecs: T.sweepSecs, startScreenSecs: +avg(starts).toFixed(1), laterScreenSecs: +avg(later).toFixed(1), perStateSecs: +perState.toFixed(1), demo1RecorderMin: +demo1.toFixed(1) });
    console.log(`TIME recorder ${T.recorderSecs} s (side states ${T.sweepSecs} s, captures ${T.captureSecs} s, confirming ${T.confirmSecs} s); product ${T.productSecs} s`);
    console.log(`TIME per screen: an app's first ${times.startScreenSecs} s, later ${times.laterScreenSecs} s, capture+confirm ${times.perStateSecs} s → Demo 1's shape (4 apps, 38 screens) at this density: ${times.demo1RecorderMin} min (budget 15)`);
    check('recorder time measured apart from the product\'s', T.recorderSecs > 0 && T.productSecs > 0, JSON.stringify(T));
  }
  if (MODE === 'extension') { await ctx.close(); ctx = null; } else { await browser.close(); browser = null; }
  // --record-only: stop here (for timing the recorder while working on it).
  if (process.argv.includes('--record-only')) throw RECORD_ONLY;

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
    // The bundle manifest, from the build: every recorded state a live-page scene, nothing else.
    const m = manifestOf(), sc = m.graph.scenes;
    check('manifest: live-page scenes only, one per state', sc.length === ids.length && sc.every(x => x.kind === 'live-page' && x.live && x.live.snapshot === `data/snaps/${S[x.id].snap}.html` && /^[0-9a-f]{64}$/.test(x.live.sha256)) && /0 fallback|manifest.json: \d+ live-page scene\(s\)/.test(r.out) && !/FALLBACK/.test(r.out), JSON.stringify(sc.map(x => [x.id, x.kind])) + r.out.slice(-400));
    check('manifest: streams, beats, focus points, transitions', m.streams.length === 2 && m.beats.length === flow.beats.length && m.focus_points.length === 4 && sc.some(x => (x.transitions || []).some(t => t.stream)), JSON.stringify([m.streams, m.focus_points.map(f => f.id)]));
    const v = await run(['validate', DEMO]);
    check('manifest: validates', v.code === 0 && !/fallback/.test(v.out), v.out);
  }
  {
    const H = JSON.parse(readFileSync(join(DEMO, 'data', 'snaps', 'hovers-chat.json'), 'utf8'));
    const texts = H.defs.flatMap(d => (d.portals || []).map(q => q.text));
    check('hovers: a chip\'s card and the Projects section', texts.some(t => /Your work: mail/.test(t)) && H.defs.some(d => (d.ops || []).some(o => /New project/.test(o.html || ''))), JSON.stringify(texts).slice(0, 300));
    check('clicks: the menu with its lazy stylesheet', (H.clicks || []).some(c => c.name === 'More options' && c.restore === 'escape') && /fx-menu/.test(Object.values(H.css).join('')), JSON.stringify((H.clicks || []).map(c => [c.name, c.restore])));
  }

  {
    const marker = join(tmp, 'raw', 'fingerprint-probe.json');
    try {
      writeFileSync(marker, '{"value":"alpha"}');
      const first = await run(['build', '--from-raw'], at);
      const stable = await run(['build', '--from-raw'], at);
      const before = statSync(marker);
      writeFileSync(marker, '{"value":"omega"}');
      utimesSync(marker, before.atime, before.mtime);
      const after = statSync(marker);
      const changed = await run(['build', '--from-raw'], at);
      check('build: content changes with the same size and timestamp force a rebuild',
        first.code === 0 && stable.code === 0 && /"upToDate":true/.test(stable.out)
          && before.size === after.size && Math.round(before.mtimeMs) === Math.round(after.mtimeMs)
          && changed.code === 0 && !/"upToDate":true/.test(changed.out),
        changed.out.slice(-500));
    } finally { if (existsSync(marker)) unlinkSync(marker); }
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
  check('release: the tweak baked in, checklist passes', r.code === 0 && fid.pass && /by a week/.test(built), fid.items.filter(i => i.status === 'fail').map(i => `${i.id}: ${i.detail}`).join('\n') || r.out.slice(-600));
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
  if (e !== RECORD_ONLY) check('selftest ran to the end', false, String(e.stack || e));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (ctx && MODE === 'extension') await ctx.close().catch(() => {});
  // On Windows the scenecast binary waits on Node rather than becoming it: stop the whole tree.
  for (const p of procs) { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); else p.kill(); }
  fx.close();
  if (keep || fails.length) console.log('demo folder: ' + tmp); else rmSync(tmp, { recursive: true, force: true });
}
console.log(fails.length ? `${fails.length} FAILED` : 'ALL PASS');
process.exit(fails.length ? 1 : 0);
