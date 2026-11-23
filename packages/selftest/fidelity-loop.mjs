// The fidelity loop, end to end, on the seeded lab (examples/fixture-app/lab.mjs), through the scenecast binary, offline
// and headless, on macOS, Windows and Linux: the lab is recorded by the extension the way a demo is, built, and then
// `scenecast fidelity` compares every captured state with the real page, diagnoses each difference, writes the demo's
// own patches (flow.fixes.json) and checks again, until every state is within 0.5% of pixels. Nothing is fixed by hand.
//   node packages/selftest/fidelity-loop.mjs [--keep] [--record-only]
import './reap.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { chromium } from 'playwright-core';
import { startLab } from '../../examples/fixture-app/lab.mjs';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = process.env.SCENECAST_BIN ? resolvePath(process.env.SCENECAST_BIN) : join(KIT, '..', 'target', 'debug', process.platform === 'win32' ? 'scenecast.exe' : 'scenecast');
if (!existsSync(BIN)) { console.log(`no scenecast binary at ${BIN}: cargo build -p stuntdouble-cli first (or set SCENECAST_BIN)`); process.exit(1); }
const keep = process.argv.includes('--keep');
const RX_PORT = 47693, REPLICA_PORT = 4698, LAB_PORT = 47803;
const tmp = mkdtempSync(join(tmpdir(), 'scenecast-fidelity-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fails = [];
const check = (name, ok, detail) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? `: ${String(detail).slice(0, 3000)}` : '')); if (!ok) fails.push(name); };
const procs = [];
const run = (args, opts = {}) => new Promise(res => {
  const p = spawn(BIN, args, { cwd: opts.cwd || tmp, env: { ...process.env, REPLICA_RX_PORT: String(RX_PORT), REPLICA_NO_OPEN: '1', ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; p.stdout.on('data', d => { out += d; if (opts.echo) process.stdout.write(d); }); p.stderr.on('data', d => { out += d; process.stderr.write(d); });
  p.on('close', code => res({ code, out }));
});
const bg = args => { const p = spawn(BIN, args, { cwd: tmp, env: { ...process.env, REPLICA_RX_PORT: String(RX_PORT), REPLICA_NO_OPEN: '1' }, stdio: 'ignore' }); procs.push(p); return p; };
const json = s => JSON.parse(s.slice(s.indexOf('{')));

for (const port of [RX_PORT, REPLICA_PORT, LAB_PORT]) {
  const busy = await new Promise(res => { const s = createServer().once('error', () => res(true)).once('listening', () => s.close(() => res(false))).listen(port, '127.0.0.1'); });
  if (busy) { console.log(`port ${port} is in use: stop whatever is on it and run again`); process.exit(1); }
}

// The extension in a fresh profile (as selftest.mjs loads it).
async function launchWithExtension(ext, profile) {
  const channel = process.env.SCENECAST_EXT_CHANNEL || 'chromium';
  const args = ['--silent-debugger-extension-api', '--force-device-scale-factor=1', '--window-size=1700,1100', '--screen-info={0,0 2560x1600}', '--disable-features=DisableLoadExtensionCommandLineSwitch'];
  const branded = channel !== 'chromium';
  const ctx = await chromium.launchPersistentContext(profile, { channel, headless: true, viewport: null, colorScheme: 'light', ignoreDefaultArgs: ['--disable-extensions'],
    args: branded ? [...args, '--enable-unsafe-extension-debugging'] : [...args, `--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
  if (branded) { const b = await ctx.browser().newBrowserCDPSession(); await b.send('Extensions.loadUnpacked', { path: ext }); }
  if (!ctx.serviceWorkers().length) await ctx.waitForEvent('serviceworker', { timeout: 30000 });
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

const lab = startLab({ port: LAB_PORT });
let ctx = null;
try {
  // 1 · A demo of the lab.
  let r = await run(['new', 'lab-demo', '--dir', tmp, '--title', 'Lab', '--port', String(REPLICA_PORT), '--app', `lab=${lab.url}`]);
  check('scaffold', r.code === 0, r.out);
  const DEMO = join(tmp, 'lab-demo'), at = { cwd: DEMO };
  const cfg = JSON.parse(readFileSync(join(DEMO, 'demo.json'), 'utf8'));
  Object.assign(cfg, { raw: join(tmp, 'raw'), receiverPort: RX_PORT, viewport: { width: 1600, height: 900, dpr: 1 }, zooms: [67] });
  Object.assign(cfg.record, { settleMs: 1000, typeIdleMs: 700, everyMs: 250, streamMinMs: 1200, auto: { hovers: false, groups: false, chips: false, drags: false, clicks: true, lists: true, zoom: true } });
  writeFileSync(join(DEMO, 'demo.json'), JSON.stringify(cfg, null, 2));
  const overridesBefore = readFileSync(join(DEMO, 'flow.overrides.mjs'), 'utf8');

  // 2 · Record: the person opens Tasks, then the More actions menu, and closes it.
  const cmd = async (...a) => { const x = await run(a, at); try { return json(x.out); } catch (e) { return { raw: x.out }; } };
  bg(['receiver', '--demo', DEMO]);
  await sleep(600);
  r = await run(['extension', join(tmp, 'ext')], at);
  check('extension builds', r.code === 0, r.out);
  ctx = await launchWithExtension(join(tmp, 'ext'), join(tmp, 'profile'));
  const page = await ctx.newPage(); await page.goto(lab.url);
  for (const p of ctx.pages()) if (p !== page) await p.close();
  await sizeWindow(page, 1600, 900);
  await page.bringToFront(); await sleep(500);
  let e = {};
  for (let i = 0; i < 40 && !e.version; i++) { e = await cmd('cmd', 'extension'); if (!e.version) await sleep(500); }
  check('extension connects', !!e.version, JSON.stringify(e));
  const settled = async () => { await sleep(450); for (let i = 0, ok = 0; i < 1200; i++) { const s = await cmd('record', 'status'); if (!s.busy && !(s.typing || []).length) { if (++ok >= 2) return s; } else ok = 0; await sleep(250); } throw new Error('recorder never settled'); };
  let s = await cmd('record', 'start');
  check('record start', s.recording === true, JSON.stringify(s));
  await settled();
  await page.click('[aria-label="Tasks"]'); await settled();
  await page.click('[aria-label="More actions"]'); await settled();
  await page.keyboard.press('Escape'); await settled();
  s = await cmd('record', 'stop');
  check('record stop', s.states >= 3, JSON.stringify(s).slice(0, 800));
  console.log('side paths: ' + (s.autos || []).join(' | '));
  await ctx.close(); ctx = null;
  if (process.argv.includes('--record-only')) throw 'record-only';

  // 3 · Build.
  r = await run(['build', '--from-raw'], at);
  check('build', r.code === 0, r.out.slice(-1500));
  const flow = JSON.parse(readFileSync(join(DEMO, 'flow.json'), 'utf8'));
  console.log('states: ' + Object.keys(flow.states).join(' ') + ' · zoomRefs: ' + (flow.zoomRefs || []).map(z => z.snap).join(' ') + ' · clicks: ' + (flow.clickPages || []).map(c => c.page).join(' '));
  if (process.argv.includes('--build-only')) throw 'build-only';

  // 4 · Compare only: each seeded problem shows as a difference (or a font that isn't the real file).
  const fid = async (...a) => { const x = await run(['fidelity', '--json', ...a], at); let o = null; try { o = json(x.out); } catch (e) {} return { code: x.code, out: x.out, o }; };
  let t0 = Date.now();
  r = await fid('--no-fix');
  const before = r.o && r.o.report;
  const item = id => before && before.items.find(i => i.id === id) || {};
  check('compare only: fails, and fixes nothing', r.code === 1 && r.o && r.o.stop === 'compare-only' && !existsSync(join(DEMO, 'flow.fixes.json')), r.out.slice(-2000));
  check('found: the font the page loaded by script falls back', before && before.fonts.some(f => f.name === 'Lab Blocks' && f.status === 'substituted'), JSON.stringify(before && before.fonts));
  check('found: the blank image, the unstyled menu, the zoomed Tasks screen', !item('lab-start').pass && !item('lab-start+click:More actions').pass && !item('lab-01-tasks@67').pass, JSON.stringify(before && before.items));
  console.log('MEASURED before: ' + (before ? before.items.map(i => `${i.id} ${i.pct}%`).join(', ') : '?') + ` (${((Date.now() - t0) / 1000).toFixed(1)} s)`);

  // 5 · The loop: diagnose, patch, build, compare again, until every state is within 0.5%.
  t0 = Date.now();
  r = await fid();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const rep = r.o && r.o.report;
  check('fidelity: passes, within 0.5% everywhere, in at most 3 rounds', r.code === 0 && r.o.pass && r.o.stop === 'within' && r.o.rounds <= 3, r.out.slice(-3000));
  const diag = JSON.parse(readFileSync(join(DEMO, '.out', 'fidelity', 'round-1', 'diagnoses.json'), 'utf8'));
  const found = c => diag.diagnoses.find(d => d.cause === c && d.patchStatus && d.patchStatus.startsWith('added'));
  for (const [cause, kind, where] of [['font-substituted', 'font', 'lab-start'], ['missing-asset', 'asset', 'lab-start'], ['late-style', 'clickCss', 'lab-start+click:More actions'], ['script-pinned', 'pin', 'lab-01-tasks@67'], ['virtualized', 'rows', 'lab-01-tasks@67']]) {
    const d = found(cause);
    check(`loop finds and fixes: ${cause}`, d && d.patch.kind === kind && d.finding === where, JSON.stringify(diag.diagnoses.map(x => [x.finding, x.cause, x.patchStatus])));
  }
  const states = rep ? rep.items.filter(i => i.kind === 'state') : [];
  check('every state within 0.5% at 100%', states.length === 3 && states.every(i => i.pct !== null && i.pct <= 0.5), JSON.stringify(states));
  // The start screen at 67% has the markup it has at 100%: it isn't captured again (its CSS lays it out), so two.
  check('every zoom capture and click side state within 0.5%', rep && rep.items.filter(i => i.kind !== 'state').length === 2 && rep.items.some(i => i.id === 'lab-01-tasks@67') && rep.items.every(i => i.pct !== null && i.pct <= 0.5), JSON.stringify(rep && rep.items));
  const full = JSON.parse(readFileSync(join(DEMO, '.out', 'fidelity', 'report.json'), 'utf8'));
  check('fonts match by file (SHA-256)', full.fonts.length === 1 && full.fonts.every(f => f.status === 'match' && f.real.length && f.replica.includes(f.real[0].sha256)), JSON.stringify(full.fonts));
  const m = JSON.parse(readFileSync(join(DEMO, 'manifest.json'), 'utf8'));
  check('no fallback scene added: live pages only', r.o.fallbackBefore === 0 && r.o.fallbackAfter === 0 && m.graph.scenes.every(x => x.kind === 'live-page'), JSON.stringify(m.graph.scenes.map(x => x.kind)));
  const fixes = JSON.parse(readFileSync(join(DEMO, 'flow.fixes.json'), 'utf8'));
  check('the fixes are the demo\'s own (flow.fixes.json), no hand edits', fixes.patches.map(p => p.kind).sort().join() === 'asset,clickCss,font,pin,rows' && readFileSync(join(DEMO, 'flow.overrides.mjs'), 'utf8') === overridesBefore, JSON.stringify(fixes.patches.map(p => p.kind)));
  check('no raw URL with its query in the fixes', !/once=/.test(JSON.stringify(fixes)), JSON.stringify(fixes).slice(0, 400));
  check('report: HTML and JSON', existsSync(join(DEMO, '.out', 'fidelity', 'report.html')) && full.residual.every(x => x.pass), JSON.stringify(full.residual).slice(0, 800));
  console.log('MEASURED after: ' + (rep ? rep.items.map(i => `${i.id} ${i.pct}%`).join(', ') : '?') + ` · ${r.o && r.o.rounds} rounds, ${secs} s`);
  // Again: nothing left to do.
  r = await fid();
  check('fidelity again: passes at once, adds nothing', r.code === 0 && r.o.rounds === 1 && JSON.parse(readFileSync(join(DEMO, 'flow.fixes.json'), 'utf8')).patches.length === 5, r.out.slice(-1500));
  // The fixed replica still plays: every screen renders, two runs of the path the same.
  r = await run(['check', '--only', 'render,two-run'], at);
  check('checklist: render and two-run on the fixed replica', r.code === 0, r.out.slice(-1500));
} catch (e) {
  if (!['record-only', 'build-only'].includes(e)) check('ran to the end', false, String(e.stack || e));
} finally {
  if (ctx) await ctx.close().catch(() => {});
  for (const p of procs) { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); else p.kill(); }
  lab.close();
  if (keep || fails.length) console.log('demo folder: ' + tmp); else rmSync(tmp, { recursive: true, force: true });
}
console.log(fails.length ? `${fails.length} FAILED` : 'ALL PASS');
process.exit(fails.length ? 1 : 0);
