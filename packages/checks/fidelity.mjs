// The fidelity checklist (docs/checklist.md), run on a built replica in headless Chrome. Every item passes, fails,
// warns, or is left to a person (manual). Writes .out/fidelity.json and .out/fidelity.md; exits 1 on any failure.
//   node checks/fidelity.mjs --demo <dir> [--quick] [--states id,id] [--url …] [--skip id,id] [--only id,id]
//                            [--speed 10] [--jobs N]
// Items: secrets, render, two-run, light, transitions, composer, keys, lists, zoom, clicks, drags, groups, chips,
// reset, hovers, contact-sheet, then the manual ones. The replica server is started for the run if it isn't up.
// Fast: the items run at the same time (--jobs pages at once), on a clock --speed times faster (the replica's
// ?speed=; every screen comes out the same as at speed 1).
// --quick checks only what changed since the last passing check (.out/check-base.json): the screens whose served
// page, frames or definition changed (tweaks included, as the server applies them), with their controls, groups,
// panes and chips; the presenter keys if the beats changed; hovers if an app's hover data changed. No two-run, zoom,
// drags, reset or contact sheet: those are for a release (replica fidelity, no --quick).
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, rmSync, statSync, copyFileSync, mkdtempSync, constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { cpus, tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadDemo, readFlow, arg } from '../lib/demo.mjs';
import { scan } from './secrets.mjs';
import { comparePngs, luminance } from './compare.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const KIT = join(here, '..');
const args = process.argv.slice(2);
const demo = loadDemo(args);
const URL = arg(args, '--url', demo.url);
const QUICK = args.includes('--quick');
const SPEED = +arg(args, '--speed', 10);
const JOBS = +arg(args, '--jobs', Math.max(2, Math.min(6, cpus().length - 2)));
const T_START = Date.now();
const skip = new Set((arg(args, '--skip', '') || '').split(',').filter(Boolean));
const only = new Set((arg(args, '--only', '') || '').split(',').filter(Boolean));
const want = id => !skip.has(id) && (!only.size || only.has(id));
const VP = demo.cfg.viewport;
const items = [];
const add = (id, title, status, detail = '') => { items.push({ id, title, status, detail: String(detail).slice(0, 4000), secs: taskSecs(id) }); console.log(`${status.toUpperCase().padEnd(6)} ${id}: ${String(detail).split('\n')[0].slice(0, 160)}`); };
const started = {};
const taskSecs = id => started[id] ? Math.round((Date.now() - started[id]) / 100) / 10 : undefined;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const node = (script, a) => new Promise(res => { const p = spawn(process.execPath, [join(KIT, script), ...a], { stdio: ['ignore', 'pipe', 'pipe'] }); let o = ''; p.stdout.on('data', d => o += d); p.stderr.on('data', d => o += d); p.on('close', code => res({ code, out: o })); });
mkdirSync(demo.out, { recursive: true });

// The replica server: started here if it isn't running.
let server = null;
const up = async () => { try { return (await fetch(URL + 'flow.json')).ok; } catch (e) { return false; } };
if (!(await up())) {
  server = spawn(process.execPath, [join(KIT, 'engine/serve.mjs'), '--demo', demo.dir, '--port', String(new globalThis.URL(URL).port)], { stdio: 'ignore', env: { ...process.env, REPLICA_NO_OPEN: '1' } });
  for (let i = 0; i < 50 && !(await up()); i++) await sleep(100);
}
// The flow as the server has it now (tweaks in flow.overrides.mjs included).
const flow = await (await fetch(URL + 'flow.json')).json().catch(() => readFlow(demo));
const S = flow.states;
const browser = await chromium.launch({ channel: process.env.REPLICA_CHROME_CHANNEL || 'chrome', headless: true });
// Pages open at most JOBS at a time; a page's slot frees when its context closes.
let slots = JOBS; const waiting = [];
const acquire = () => slots > 0 ? (slots--, Promise.resolve()) : new Promise(r => waiting.push(r));
const release = () => { const w = waiting.shift(); if (w) w(); else slots++; };
// Rests before a click (a hover showing, as when a presenter clicks) and after it, scaled with the clock.
const REST = SPEED > 1 ? 250 : 900, AFTER = SPEED > 1 ? 180 : 400;
// demo.json checks.known: differences from the real product the demo has accepted (text each one starts with); they
// show as warnings, not failures.
const known = msg => ((demo.cfg.checks || {}).known || []).some(k => msg.startsWith(k));
const withSpeed = (u, sp) => { const x = new globalThis.URL(u); if (sp > 1) x.searchParams.set('speed', String(sp)); return x.href; };
// A fresh replica page at a zoom (1 = the demo's viewport), with errors and off-site requests collected.
async function open(z = 1, speed = SPEED) {
  await acquire();
  const ctx = await browser.newContext({ viewport: { width: Math.round(VP.width / z), height: Math.round(VP.height / z) }, deviceScaleFactor: VP.dpr * z });
  const close = ctx.close.bind(ctx); let closed = false;
  ctx.close = async () => { if (closed) return; closed = true; try { await close(); } finally { release(); } };
  const page = await ctx.newPage();
  page.noise = [];
  page.on('pageerror', e => page.noise.push('pageerror: ' + e.message.slice(0, 160)));
  page.on('console', m => page.noise.push(m.type() + ': ' + m.text().slice(0, 160)));
  page.on('request', r => { if (!/^(http:\/\/127\.0\.0\.1|data:|blob:|about:)/.test(r.url())) page.noise.push('offsite: ' + r.url().slice(0, 100)); });
  await page.goto(withSpeed(URL, speed));
  await page.waitForFunction(() => window.d1 && window.d1.state.active);
  return page;
}
// Splits a list into n parts (for checking a long list on several pages at once).
// The demo's files as a fresh clone has them: what git keeps (committed or not yet), or without a repository yet,
// everything .gitignore doesn't keep out.
function cloneFiles(dir) {
  const g = spawnSync('git', ['-C', dir, 'ls-files', '-z', '-co', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const isFile = f => { try { return statSync(join(dir, f)).isFile(); } catch (e) { return false; } };
  if (!g.status && spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).status === 0) return g.stdout.split('\0').filter(f => f && isFile(f));
  const ign = (existsSync(join(dir, '.gitignore')) ? readFileSync(join(dir, '.gitignore'), 'utf8').split('\n') : ['node_modules/', '.out/']).map(l => l.trim().replace(/^\/|\/$/g, '')).filter(l => l && !l.startsWith('#'));
  const out = [];
  const walk = rel => { for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) { const f = rel ? rel + '/' + e.name : e.name; if (e.name === '.git' || ign.some(p => p === f || p === e.name)) continue; if (e.isDirectory()) walk(f); else if (e.isFile()) out.push(f); } };
  walk('');
  return out;
}
const freePort = () => new Promise(res => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const shards = (list, n) => { const k = Math.max(1, Math.min(n, list.length)); return Array.from({ length: k }, (_, i) => list.filter((_, j) => j % k === i)); };
const idle = page => page.evaluate(() => window.d1.idle());
const go = async (page, st) => { await page.evaluate(([a, s]) => window.d1.go(a, s), [S[st].app, st]); await idle(page); await sleep(150); };
const stateOf = async (page, app) => (await page.evaluate(() => window.d1.state)).states[app];
const locate = (page, m, app) => page.evaluate(([m, app]) => window.d1.locate(m, app), [m, app]);
async function clickOn(page, m, app) {
  let r = await locate(page, m, app);
  for (let i = 0; r && i < 10 && (r.y < 10 || r.y > page.viewportSize().height - 10); i++) { await page.mouse.move(page.viewportSize().width / 2, page.viewportSize().height / 2); await page.mouse.wheel(0, r.y - page.viewportSize().height / 2); await sleep(300); r = await locate(page, m, app); }
  if (!r || !r.w) return false;
  await page.mouse.move(r.x, r.y, { steps: 3 }); await sleep(80); await page.mouse.click(r.x, r.y); return true;
}
const focusIn = async (page, m, app) => { if (!(await page.evaluate(([m, a]) => window.d1.focused(m, a), [m, app]))) return clickOn(page, m, app); return true; };
const streamTo = t => t.stream ? (flow.streams[t.stream] || {}).to : t.to;
// The page's markup in short (an app, or one of its frames), to see it's back as it was.
const bodySig = (page, app, frame) => page.evaluate(([a, f]) => { const d = window.d1.doc(a); const doc = f ? [...d.querySelectorAll('iframe')].map(x => { try { return x.contentDocument; } catch (e) { return null; } }).find(x => x && x.defaultView.frameElement.getAttribute('data-d1-frame') === f) : d; return doc.body.innerHTML.replace(/\sstyle="[^"]*anchor-name[^"]*"/g, '').length + ':' + doc.body.querySelectorAll('*').length + ':' + doc.body.innerText.length; }, [app, frame]);
const hoversOf = app => { const f = join(demo.data, 'snaps', `hovers-${app}.json`); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {}; };
const grpApps = flow.apps.map(a => a.id).filter(a => hoversOf(a).groups);
// What changed since the last passing check: each state's fingerprint is its definition, its page and frames as
// served (tweaks applied), and the answers that end on it; an app's, its layout; hovers, the app's hover data.
const sha = t => createHash('sha256').update(t).digest('hex').slice(0, 16);
const served = async p => { try { const r = await fetch(URL + p.replace(/^\//, '')); return r.ok ? await r.text() : ''; } catch (e) { return ''; } };
async function fingerprints() {
  const fp = { states: {}, apps: {}, hovers: {}, beats: sha(JSON.stringify([flow.beats, flow.apps.map(a => a.key)])), focus: sha(JSON.stringify([flow.focus || [], flow.focusOptions || {}])) };
  const snapFp = {};
  const snapOf = async snap => {
    if (snapFp[snap]) return snapFp[snap];
    const meta = await served(`/snaps/${snap}.json`);
    let frames = []; try { frames = JSON.parse(meta).frames || []; } catch (e) {}
    const parts = [await served(`/snaps/${snap}.html`), ...await Promise.all(frames.map(f => served(`/snaps/${snap}.${f.key}.html`)))];
    return (snapFp[snap] = sha(parts.join('\u0000')));
  };
  const streamFp = {};
  const streamOf = async name => {
    if (streamFp[name]) return streamFp[name];
    const ix = await served(`/streams/${name}.json`);
    let frames = []; try { frames = JSON.parse(ix).frames || []; } catch (e) {}
    const parts = [ix, ...await Promise.all(frames.map(f => served(`/streams/${name}/${f.file}`)))];
    return (streamFp[name] = sha(parts.join('\u0000')));
  };
  for (const a of flow.apps) { fp.apps[a.id] = sha(JSON.stringify([a.layout, a.on])); fp.hovers[a.id] = sha(await served(`/snaps/hovers-${a.id}.json`)); }
  await Promise.all(Object.entries(S).map(async ([id, st]) => {
    const streams = Object.entries(flow.streams || {}).filter(([, x]) => x.to === id);
    fp.states[id] = sha(JSON.stringify(st) + (await snapOf(st.snap)) + (await Promise.all(streams.map(async ([n, x]) => JSON.stringify(x) + await streamOf(n)))).join(''));
  }));
  return fp;
}
const BASE = join(demo.out, 'check-base.json');
const FP = await fingerprints();
const base = existsSync(BASE) ? JSON.parse(readFileSync(BASE, 'utf8')) : null;
const statesArg = (arg(args, '--states', '') || '').split(',').filter(Boolean);
let SCOPE = statesArg.length ? new Set(statesArg) : null;
const changedApps = new Set(), changedHovers = new Set();
let beatsChanged = true, focusChanged = true;
if (QUICK && !SCOPE) {
  SCOPE = new Set();
  for (const a of flow.apps) { if (!base || base.apps[a.id] !== FP.apps[a.id]) changedApps.add(a.id); if (!base || base.hovers[a.id] !== FP.hovers[a.id]) changedHovers.add(a.id); }
  for (const [id, st] of Object.entries(S)) if (!base || base.states[id] !== FP.states[id] || changedApps.has(st.app)) SCOPE.add(id);
  beatsChanged = !base || base.beats !== FP.beats;
  focusChanged = !base || base.focus !== FP.focus;
}
const inScope = id => !SCOPE || SCOPE.has(id);
const pathStates = [...new Set((flow.path || []).map(s => s.checkpoint).filter(Boolean))].filter(s => S[s]);
// A step group's button, by its region's id: brought on screen, rested on, clicked. Returns the group afterwards.
async function pressGroup(page, app, id, wait = true) {
  // Scrolled into view only when it's off screen: while an answer plays, each frame puts the chat back at its
  // captured scroll, so a scroll here would move the button away again before the click.
  const moved = await page.evaluate(([a, id]) => { const b = window.d1.doc(a).querySelector(`[aria-controls="${CSS.escape(id)}"]`); if (!b) return false; const r = b.getBoundingClientRect(); if (r.top >= 0 && r.bottom <= b.ownerDocument.defaultView.innerHeight) return false; b.scrollIntoView({ block: 'center' }); return true; }, [app, id]); if (moved) await sleep(150);
  const b = (await page.evaluate(a => window.d1.groupButtons(a), app)).find(x => x.id === id);
  if (!b) return null;
  const vp = page.viewportSize();
  await page.mouse.move(b.x, b.y, { steps: 3 }); await sleep(wait ? Math.min(500, REST) : 60); await page.mouse.click(b.x, b.y); await page.mouse.move(vp.width - 1, vp.height / 2, { steps: 2 });
  if (wait) { await sleep(Math.max(220, AFTER)); await idle(page); }
  return (await page.evaluate(a => window.d1.groupButtons(a), app)).find(x => x.id === id);
}
// Narrows the window until a chips rule shows its "+N" (it only shows when the chips don't fit). Returns the width.
async function narrowToPlus(page, app, ri) {
  const vp0 = page.viewportSize();
  for (const w of [vp0.width, 1366, 1280, 1180, 1100, 1024, 960, 900, 800, 700, 600].filter((w, i) => i === 0 || w < vp0.width)) {
    if (w !== page.viewportSize().width) { await page.setViewportSize({ width: w, height: vp0.height }); await sleep(350); await idle(page); }
    if (await page.evaluate(([a, ri]) => !!window.d1.doc(a).querySelector(`[data-d1-plus="${ri}"]`), [app, ri])) return w;
  }
  return null;
}
const plusInfo = (page, app, ri, list) => page.evaluate(([a, ri, list]) => {
  const d = window.d1.doc(a), pl = d.querySelector(`[data-d1-plus="${ri}"]`), ul = pl ? pl.parentElement : d.querySelector(list);
  const b = pl && (pl.querySelector('button,[role=button]') || pl), r = b && b.getBoundingClientRect();
  const items = ul ? [...ul.children].filter(e => e !== pl && !e.hasAttribute('data-d1-plusmark') && !/^\+\d+$/.test((e.textContent || '').trim())) : [];
  return { text: b ? b.textContent.replace(/\s+/g, ' ').trim() : null, label: b && b.getAttribute('aria-label'), x: r && r.x + r.width / 2, y: r && r.y + r.height / 2, total: items.length, shown: items.filter(e => getComputedStyle(e).display !== 'none').length };
}, [app, ri, list]);
async function pressPlus(page, app, ri, list) {
  const i = await plusInfo(page, app, ri, list); if (!i.text) return null;
  await page.mouse.move(i.x, i.y, { steps: 3 }); await sleep(Math.min(500, REST)); await page.mouse.click(i.x, i.y); await page.mouse.move(2, page.viewportSize().height / 2, { steps: 2 }); await sleep(AFTER); await idle(page);
  return plusInfo(page, app, ri, list);
}

const tasks = [];
let check = null;
try {
  tasks.push({ id: 'secrets', deps: [], run: async () => {
    // ---- secrets: nothing in the demo folder that looks like a token, key, signed URL, or a script in a capture.
    if (want('secrets')) { const f = scan([demo.dir]); add('secrets', 'Secret scan', f.length ? 'fail' : 'pass', f.length ? f.slice(0, 30).map(x => `${x.file}:${x.line} ${x.rule}`).join('\n') : 'clean'); }
  } });

  tasks.push({ id: 'two-run', deps: [], run: async () => {
    // ---- two-run: the recorded path twice, identical, each step on the recorded state, no errors or network.
    if (!QUICK && (want('two-run') || want('light') || want('contact-sheet'))) {
      const r = await node('checks/check.mjs', ['--demo', demo.dir, '--runs', '2', '--url', URL, '--speed', String(SPEED)]);
      try { check = JSON.parse(readFileSync(join(demo.out, 'check', 'report.json'), 'utf8')); } catch (e) {}
      if (want('two-run')) {
        if (!check) add('two-run', 'Two runs, identical', 'fail', r.out.slice(-1500));
        else {
          const bad = [...check.runs.flatMap(x => [...x.errors, ...x.noise, ...x.mismatches].map(e => `run ${x.run}: ${e}`)), ...check.differ.map(d => 'differs: ' + d)];
          add('two-run', 'Two runs, identical', check.pass ? 'pass' : 'fail', check.pass ? `${check.steps} screens, same DOM ${check.sameDom}, ${check.runs.map(x => x.secs + ' s').join(' / ')}` : bad.join('\n') || r.out.slice(-800));
        }
      }
    }
  } });

  tasks.push({ id: 'cold-start', deps: ['two-run'], run: async () => {
    // ---- cold-start: three fresh copies of the demo as a clone gets it (the files git keeps), each with a server of
    // its own and a browser that has never seen it: each one's first run is identical to the warm runs (same DOM,
    // pixels within 0.01%), with no errors or failed requests. Catches what only a first start does: fonts not in
    // memory yet, styles that depended on the pointer's timing, a file that's only on this machine.
    if (QUICK || !want('cold-start')) return;
    if (!check || !check.shots || !check.shots[0]) return add('cold-start', 'Cold start, three fresh clones', 'fail', 'no two-run result to compare with');
    const N = +arg(args, '--cold', 3), files = cloneFiles(demo.dir);
    const root = mkdtempSync(join(tmpdir(), 'replica-cold-'));
    const bad = [], secs = [];
    try {
      const reps = await Promise.all(Array.from({ length: N }, async (_, i) => {
        const dir = join(root, `clone${i + 1}`), out = join(demo.out, 'cold', `clone${i + 1}`);
        for (const f of files) { mkdirSync(dirname(join(dir, f)), { recursive: true }); copyFileSync(join(demo.dir, f), join(dir, f), constants.COPYFILE_FICLONE); }
        const port = await freePort();
        const srv = spawn(process.execPath, [join(KIT, 'engine/serve.mjs'), '--demo', dir, '--port', String(port)], { stdio: 'ignore', env: { ...process.env, REPLICA_NO_OPEN: '1' } });
        try {
          for (let k = 0; k < 150; k++) { try { if ((await fetch(`http://127.0.0.1:${port}/__replica/status`)).ok) break; } catch (e) {} await sleep(100); }
          rmSync(out, { recursive: true, force: true });
          const r = await node('checks/check.mjs', ['--demo', dir, '--runs', '1', '--url', `http://127.0.0.1:${port}/`, '--speed', String(SPEED), '--out', out]);
          try { return JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')); } catch (e) { bad.push(`clone ${i + 1}: ${r.out.slice(-400)}`); return null; }
        } finally { srv.kill(); }
      }));
      const cp = await browser.newPage();
      for (const [i, rep] of reps.entries()) {
        if (!rep) continue;
        const run = rep.runs[0], shots = rep.shots[0], ref = check.shots[0];
        secs.push(run.secs);
        for (const e of [...run.errors, ...run.noise, ...run.mismatches]) bad.push(`clone ${i + 1}: ${e}`);
        for (const [nm, a] of Object.entries(ref)) {
          const b = shots[nm];
          if (!b) { bad.push(`clone ${i + 1}: ${nm}: not reached`); continue; }
          if (a.dom !== b.dom) { bad.push(`clone ${i + 1}: ${nm}: the DOM differs from a warm run`); continue; }
          if (a.sha === b.sha) continue;
          const [d] = await comparePngs(cp, [[readFileSync(join(demo.out, 'check', 'run1', a.file)).toString('base64'), readFileSync(join(demo.out, 'cold', `clone${i + 1}`, 'run1', b.file)).toString('base64')]]);
          if (d.pct >= 0.01) bad.push(`clone ${i + 1}: ${nm}: ${d.pct}% of pixels differ from a warm run`);
        }
      }
      await cp.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
    add('cold-start', 'Cold start, three fresh clones', bad.length ? 'fail' : 'pass', bad.length ? [...new Set(bad)].slice(0, 30).join('\n') : `${N} clones (${files.length} files each), first runs identical to the warm runs, ${secs.map(x => x + ' s').join(' / ')}`);
  } });

  tasks.push({ id: 'light', deps: ['two-run'], run: async () => {
    // ---- light: every capture recorded in light mode, and every replica screen reads light.
    if (want('light') && !QUICK) {
      const dark = [];
      for (const f of readdirSync(join(demo.data, 'snaps')).filter(f => f.endsWith('.json') && !f.startsWith('hovers-'))) {
        const m = JSON.parse(readFileSync(join(demo.data, 'snaps', f), 'utf8'));
        // demo.json checks.light "rendered": the apps were set to Light while the OS was dark, so only the screens count.
        if (m.colorScheme && m.colorScheme !== 'light' && ((demo.cfg.checks || {}).light !== 'rendered')) dark.push(`${m.id}: captured with prefers-color-scheme ${m.colorScheme}`);
      }
      if (check && check.shots && check.shots[0]) {
        const page = await browser.newPage();
        const run1 = join(demo.out, 'check', 'run1');
        const shots = Object.entries(check.shots[0]);
        const lum = await luminance(page, shots.map(([, s]) => readFileSync(join(run1, s.file)).toString('base64')));
        shots.forEach(([n], i) => { if (lum[i] < 0.55) dark.push(`${n}: replica screen is dark (luminance ${lum[i]})`); });
        await page.close();
      }
      add('light', 'Light mode', dark.length ? 'fail' : 'pass', dark.length ? dark.join('\n') : 'every capture light, every screen reads light');
    }
  } });

  tasks.push({ id: 'render', deps: [], run: async () => {
    // ---- render: every screen (in --quick, each one that changed) loads with no error, console message or request
    // off the machine, and reads light. Pictures: .out/render/<state>.png, to look at.
    if (!want('render')) return;
    const list = Object.keys(S).filter(inScope);
    if (!list.length) return add('render', 'Every screen renders', 'skip', 'no screen changed');
    const dir = join(demo.out, 'render'); if (!QUICK) rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
    const bad = [], shots = [];
    await Promise.all(shards(list, JOBS).map(async part => {
      const page = await open();
      try {
        for (const id of part) {
          const n0 = page.noise.length;
          await go(page, id); await page.evaluate(a => window.d1.activate(a), S[id].app); await page.mouse.move(VP.width - 1, 2); await sleep(60);
          const errs = [...(await page.evaluate(() => window.d1.errors.splice(0))), ...page.noise.slice(n0)];
          if (errs.length) bad.push(`${id}: ${errs.slice(0, 3).join(' | ')}`);
          const png = await page.screenshot({ animations: 'disabled', caret: 'hide' });
          writeFileSync(join(dir, id + '.png'), png); shots.push([id, png.toString('base64')]);
        }
      } finally { await page.context().close(); }
    }));
    const cp = await browser.newPage();
    const lum = await luminance(cp, shots.map(x => x[1])); await cp.close();
    shots.forEach(([id], i) => { if (lum[i] < 0.55) bad.push(`${id}: reads dark (luminance ${lum[i]}); recapture in light mode`); });
    add('render', 'Every screen renders', bad.length ? 'fail' : 'pass', bad.length ? bad.join('\n') : `${list.length} screens${QUICK ? ' (changed)' : ''}, no errors, light (render/*.png)`);
  } });

  tasks.push({ id: 'transitions', deps: [], run: async () => {
    // ---- transitions: every click, Enter, typing and Escape a state has, from that state, lands where the
    // recording did. Panes closing and opening, the composer and send arrow, menus: all of them are transitions.
    if (want('transitions')) {
      const bad = [], errs = []; let n = 0;
      await Promise.all(shards(Object.entries(S).filter(([id]) => inScope(id)), JOBS).map(async part => {
      const page = await open();
      for (const [id, st] of part) {
        const ts = [...(st.on || []), ...((flow.apps.find(a => a.id === st.app) || {}).on || []).filter(t => !t.when || t.when.includes(id))];
        for (const t of ts) {
          if (t.hover || t.query) continue;
          await go(page, id);
          const app = st.app;
          let expect = streamTo(t), what = '';
          try {
            if (t.click) {
              what = 'click ' + JSON.stringify(t.click);
              if (!(await clickOn(page, t.click, app))) {
                // A section's second control (Show less) shows only once its first (Show more) has been clicked.
                const first = t.scope && ts.find(o => o !== t && o.click && o.scope);
                const ok = first && await clickOn(page, first.click, app) && (await sleep(300), await clickOn(page, t.click, app));
                if (!ok) { bad.push(`${id}: ${what}: not on screen`); continue; }
              }
              if (t.scope) expect = null;
            } else if (t.enter) {
              what = 'Enter in ' + JSON.stringify(t.enter);
              if (!(await focusIn(page, t.enter, app))) { bad.push(`${id}: ${what}: field not on screen`); continue; }
              await page.keyboard.press('End'); await page.keyboard.press('Enter');
            } else if (t.type && t.to) {
              what = 'typing in ' + JSON.stringify(t.type);
              if (!(await focusIn(page, t.type, app))) { bad.push(`${id}: ${what}: field not on screen`); continue; }
              await page.keyboard.type('x', { delay: 20 });
            } else if (t.type && t.empty) {
              what = 'emptying ' + JSON.stringify(t.type); expect = t.empty;
              if (!(await focusIn(page, t.type, app))) { bad.push(`${id}: ${what}: field not on screen`); continue; }
              await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('Backspace');
            } else continue;
            await sleep(200); await idle(page); await sleep(150);
            n++;
            if (expect) { const now = await stateOf(page, app); if (now !== expect) bad.push(`${id}: ${what} → ${now}, recorded ${expect}`); }
            if (t.app) { const a = (await page.evaluate(() => window.d1.state)).active; if (a !== t.app) bad.push(`${id}: ${what} should switch to ${t.app}`); }
          } catch (e) { bad.push(`${id}: ${what}: ${String(e.message || e).slice(0, 120)}`); }
        }
        if (st.esc) {
          await go(page, id); await page.keyboard.press('Escape'); await sleep(200); await idle(page); n++;
          const now = await stateOf(page, st.app); if (now !== st.esc) bad.push(`${id}: Escape → ${now}, recorded ${st.esc}`);
        }
      }
      errs.push(...(await page.evaluate(() => window.d1.errors)), ...page.noise);
      await page.context().close();
      }));
      add('transitions', 'Every recorded control works (panes, menus, composer, send)', bad.length || errs.length ? 'fail' : n ? 'pass' : 'skip', bad.length || errs.length ? [...bad, ...errs].join('\n') : n ? `${n} transitions` : 'none on the changed screens');
    }
  } });

  tasks.push({ id: 'composer', deps: [], run: async () => {
    // ---- composer: the cursor is where the real app puts it, ⌥P types the scripted text, the send arrow does
    // nothing with an empty box.
    if (want('composer')) {
      const page = await open();
      const bad = []; let n = 0;
      for (const [id, st] of Object.entries(S).filter(([id]) => inScope(id))) {
        if (st.focus) {
          await go(page, id); await page.evaluate(a => window.d1.activate(a), st.app); await sleep(100); n++;
          if (!(await page.evaluate(([m, a]) => window.d1.focused(m, a), [st.focus, st.app]))) bad.push(`${id}: the cursor isn't in ${JSON.stringify(st.focus)} (the real page put it there)`);
        }
        if (st.fill && st.fill.length && (st.on || []).some(t => t.type && t.to)) {
          await go(page, id); await page.evaluate(a => window.d1.activate(a), st.app);
          await focusIn(page, st.fill[0], st.app);
          await page.keyboard.press('Alt+KeyP'); await sleep(200);
          await page.waitForFunction(() => !window.d1.filling, null, { timeout: 120000 }); await idle(page); n++;
          const typedTo = (st.on.find(t => t.type && t.to) || {}).to;
          const now = await stateOf(page, st.app);
          if (now !== typedTo) bad.push(`${id}: ⌥P typed, but the replica is on ${now}, not ${typedTo}`);
        }
        for (const t of st.on || []) {
          if (!(t.click && t.typedFrom) || !st.typedOf && !Object.values(S).some(x => (x.on || []).some(y => y.type && y.to === id))) continue;
          const base = (st.on.find(y => y.type && y.empty) || {}).empty;
          if (!base) continue;
          await go(page, base); n++;
          if (await clickOn(page, t.click, st.app)) { await sleep(300); await idle(page); const now = await stateOf(page, st.app); if (now !== base) bad.push(`${base}: the send arrow sent an empty box (→ ${now})`); }
        }
      }
      add('composer', 'Composer: cursor, ⌥P, send', bad.length ? 'fail' : n ? 'pass' : 'skip', bad.length ? bad.join('\n') : n ? `${n} checks` : QUICK ? 'none on the changed screens' : 'no fields in this flow');
      await page.context().close();
    }
  } });

  tasks.push({ id: 'keys', deps: [], run: async () => {
    // ---- keys: ⌥0 and ⌥1 … ⌥9 land on their beats; each app's ⌥ key switches to it.
    if (want('keys') && (!QUICK || beatsChanged)) {
      const page = await open();
      const bad = [];
      for (let i = 0; i < Math.min(10, (flow.beats || []).length); i++) {
        await page.keyboard.press('Alt+Digit' + i); await sleep(200); await idle(page);
        const st = await page.evaluate(() => window.d1.state);
        const b = flow.beats[i];
        if (st.active !== b.active) bad.push(`⌥${i}: active ${st.active}, beat says ${b.active}`);
        for (const [a, s] of Object.entries(b.states)) if (st.states[a] !== s) bad.push(`⌥${i}: ${a} on ${st.states[a]}, beat says ${s}`);
      }
      for (const a of flow.apps.filter(x => x.key)) {
        await page.keyboard.press('Alt+Key' + a.key.toUpperCase()); await sleep(150);
        if ((await page.evaluate(() => window.d1.state)).active !== a.id) bad.push(`⌥${a.key} doesn't switch to ${a.id}`);
      }
      add('keys', 'Presenter keys (⌥0–9, app keys)', bad.length ? 'fail' : 'pass', bad.length ? bad.join('\n') : `${Math.min(10, flow.beats.length)} beats, ${flow.apps.filter(x => x.key).length} app keys`);
      await page.context().close();
    }
  } });

  tasks.push({ id: 'focus', deps: [], run: async () => {
    // ---- focus: every focus point (focus.mjs) reached with ⌥F on its screen: zoomed and marked with the margin on every
    // side (or, where the page puts it against the screen's edge, at least on screen), never past the zoom factor, the
    // same on a second run; Esc zooms out. Then ⌥ beat keys start the beat's points, ↑/↓ nudge the zoom, ⌥0 clears it.
    if (!want('focus')) return;
    const all = flow.focus || [];
    if (!all.length) { if (!QUICK) add('focus', 'Focus points (⌥F)', 'skip', 'no focus points (focus.mjs)'); return; }
    const pts = all.filter(p => !QUICK || focusChanged || beatsChanged || p.states.some(inScope));
    if (!pts.length) return;
    const top = (flow.focusOptions || {}).zoom || 2, MARG = 0.08, bad = [], edge = [];
    const quiet = page => page.waitForFunction(() => !window.d1.focus.state().run, null, { timeout: 20000 });
    const state = page => page.evaluate(() => window.d1.focus.state());
    // As on stage: the page has settled (its target hasn't moved for a moment) before ⌥F.
    const settle = (page, id) => page.waitForFunction(id => { const b = String(window.d1.focus.locate(id)), w = window.__fs || (window.__fs = {}), t = performance.now(); if (w.id !== id || w.b !== b) { Object.assign(w, { id, b, t }); return false; } return t - w.t > 300; }, id, { timeout: 8000, polling: 50 }).catch(() => {});
    const land = async (page, p) => {
      await page.evaluate(([a, s]) => window.d1.go(a, s), [p.app, p.states[0]]); await idle(page);
      const vp = page.viewportSize(); await page.mouse.move(vp.width - 1, vp.height - 1);
      await settle(page, p.id);
      await page.evaluate(id => window.d1.focus.at(id), p.id);
      await page.keyboard.press('Alt+KeyF'); await sleep(50); await quiet(page);
      const st = await state(page);
      if (st.id !== p.id || st.z !== 2 || !st.draw || !st.marks.length) { bad.push(`${p.id}: not shown on ${p.states[0]} (${p.find ? JSON.stringify(p.find) : 'union'} not found?)`); return null; }
      const L = st.last, on = L.on, m = Math.min(on[0] / L.W, on[1] / L.H, (L.W - on[2]) / L.W, (L.H - on[3]) / L.H);
      if (L.Z < 1 || L.Z > top + 1e-6 || Math.abs(st.s - L.Z) > 1e-6) bad.push(`${p.id}: zoom ${L.Z} (view ${st.s})`);
      if (L.edge) { if (m < -0.001) bad.push(`${p.id}: the mark is off screen`); else edge.push(p.id); }
      else if (m < MARG - 0.001) bad.push(`${p.id}: ${Math.round(m * 1000) / 10}% margin at ${L.Z}×`);
      await page.keyboard.press('Escape'); await quiet(page);
      const out = await state(page);
      if (out.z !== 0 || out.s !== 1 || out.marks.length) bad.push(`${p.id}: Esc left it zoomed`);
      return { last: L, marks: st.marks, s: st.s, A: st.A };
    };
    const pass = async () => {
      const rec = {};
      await Promise.all(shards(pts, Math.min(3, JOBS)).map(async list => { const page = await open(); for (const p of list) rec[p.id] = await land(page, p); await page.context().close(); }));
      return rec;
    };
    const [r1, r2] = await Promise.all([pass(), pass()]);
    for (const p of pts) if (r1[p.id] && r2[p.id] && JSON.stringify(r1[p.id]) !== JSON.stringify(r2[p.id])) bad.push(`${p.id}: lands differently on a second run`);
    if (!QUICK || focusChanged || beatsChanged) {
      const page = await open();
      const b = Math.max(1, Math.min(...all.map(p => p.beat)));
      if ((flow.beats || [])[b]) {
        await page.keyboard.press('Alt+Digit' + b); await sleep(200); await idle(page);
        const ready = await page.evaluate(() => window.d1.focus.ready());
        const first = all.slice(Math.max(0, all.findIndex(p => p.beat >= b))).find(p => ready.includes(p.id));
        if (first) await settle(page, first.id);
        await page.keyboard.press('Alt+KeyF'); await sleep(50); await quiet(page);
        const a = await state(page);
        if (first && (a.id !== first.id || a.z !== 2)) bad.push(`⌥${b} then ⌥F: ${a.id || 'nothing'}, expected ${first.id}`);
        if (a.z === 2) {
          await page.keyboard.press('ArrowUp'); const up = (await state(page)).s;
          for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowDown');
          const down = (await state(page)).s;
          if (!(up > a.s || Math.abs(a.s - a.limit) < 1e-3) || down !== 1) bad.push(`↑/↓: ${a.s} → ${up} → ${down}`);
          await page.keyboard.press('Alt+KeyF'); await sleep(50); await quiet(page);
          await page.keyboard.press('Alt+Digit0'); await sleep(100); await idle(page);
          const z = await state(page);
          if (z.z !== 0 || z.s !== 1 || z.marks.length) bad.push('⌥0 left it zoomed');
        }
      }
      await page.context().close();
    }
    add('focus', 'Focus points (⌥F)', bad.length ? 'fail' : 'pass', bad.length ? bad.join('\n') : `${pts.length} points, the same twice${edge.length ? `; against the screen's edge: ${[...new Set(edge)].join(', ')}` : ''}`);
  } });

  tasks.push({ id: 'lists', deps: [], run: async () => {
    // ---- lists: a virtualized list captured in full has every row in the replica, and scrolls to the last.
    if (want('lists')) {
      if (QUICK && !(flow.lists || []).some(l => inScope(l.state))) return;
      if (!(flow.lists || []).length) add('lists', 'Virtualized lists in full', 'skip', 'no list captures (replica record side list)');
      else {
        const page = await open();
        const bad = [];
        for (const l of flow.lists.filter(l => inScope(l.state))) {
          await go(page, l.state);
          const r = await page.evaluate(([app, l]) => {
            const d = window.d1.doc(app);
            const docs = [d, ...[...d.querySelectorAll('iframe')].map(f => { try { return f.contentDocument; } catch (e) { return null; } }).filter(Boolean)];
            for (const doc of docs) {
              const g = doc.querySelector(l.list) || doc.querySelector('[role=grid],[role=list],[role=listbox],[role=table],[role=treegrid],[role=feed],[role=tree]');
              if (!g) continue;
              const rows = g.querySelectorAll('[aria-rowindex],[aria-posinset],[data-index],[data-item-index],[data-row-index]').length;
              let sc = g; while (sc && !(sc.scrollHeight > sc.clientHeight + 20)) sc = sc.parentElement;
              let lastVisible = null;
              if (sc) { sc.scrollTop = sc.scrollHeight; const last = [...g.querySelectorAll('[aria-rowindex],[aria-posinset],[data-index]')].pop(); const rr = last && last.getBoundingClientRect(), sr = sc.getBoundingClientRect(); lastVisible = !!rr && rr.bottom <= sr.bottom + 2 && rr.top >= sr.top - 2; sc.scrollTop = 0; }
              return { rows, lastVisible };
            }
            return null;
          }, [S[l.state].app, l]);
          if (!r) bad.push(`${l.state}: list ${l.list} not found`);
          else if (r.rows < l.seen) bad.push(`${l.state}: ${r.rows} rows in the replica, ${l.seen} captured`);
          else if (r.lastVisible === false) bad.push(`${l.state}: the last row doesn't scroll into view`);
        }
        add('lists', 'Virtualized lists in full', bad.length ? 'fail' : 'pass', bad.length ? bad.join('\n') : flow.lists.map(l => `${l.state}: ${l.seen} rows`).join(', '));
        await page.context().close();
      }
    }
  } });

  tasks.push({ id: 'zoom', deps: [], run: async () => {
    // ---- zoom: every screen at each zoom (50–200%): no errors, the cursor's field on screen, the same layout as the
    // real page where a zoom capture exists. Writes .out/zoom-sheet.png to look over.
    if (want('zoom') && !QUICK) {
      const zooms = [100, ...(demo.cfg.zooms || [])].filter((z, i, a) => a.indexOf(z) === i).sort((a, b) => a - b);
      const states = [...new Set((flow.path || []).map(s => s.checkpoint).filter(Boolean))].filter(s => S[s]);
      const bad = [], warn = [], cells = [];
      const cmp = await browser.newPage();
      await Promise.all(zooms.map(async z => {
        const page = await open(z / 100);
        for (const st of states) {
          await go(page, st);
          const app = S[st].app;
          const field = S[st].focus || (S[st].fill && S[st].fill[0]);
          if (field) { const r = await locate(page, field, app); const vp = page.viewportSize(); if (!r || r.y < 0 || r.y > vp.height || r.x < 0 || r.x > vp.width) { const msg = `${st} at ${z}%: the field ${JSON.stringify(field).slice(0, 80)} is off screen`; (known(msg) ? warn : bad).push(msg + (known(msg) ? ' (known: demo.json checks.known)' : '')); } }
          const over = await page.evaluate(app => { const d = window.d1.doc(app); const e = d.scrollingElement || d.documentElement; return e.scrollWidth - d.defaultView.innerWidth; }, app);
          if (over > 2) warn.push(`${st} at ${z}%: page scrolls sideways by ${over} px`);
          const png = await page.screenshot();
          const ref = (flow.zoomRefs || []).find(r => r.state === st && r.z === z);
          let pct = null;
          if (ref && existsSync(join(demo.raw, 'shots', ref.snap + '.png'))) {
            [{ pct }] = await comparePngs(cmp, [[readFileSync(join(demo.raw, 'shots', ref.snap + '.png')).toString('base64'), png.toString('base64')]]);
            if (pct > 3) warn.push(`${st} at ${z}%: ${pct}% of pixels differ from the real page at that zoom`);
          }
          // The sheet's pictures are files: inlined, every screen at every zoom is too much for one page.
          const cellFile = join(demo.out, 'zoom', `${st}-z${z}.png`); mkdirSync(join(demo.out, 'zoom'), { recursive: true }); writeFileSync(cellFile, png);
          cells.push({ z, st, file: cellFile, pct });
        }
        const errs = [...(await page.evaluate(() => window.d1.errors)), ...page.noise];
        if (errs.length) bad.push(`${z}%: ${errs.slice(0, 5).join(' | ')}`);
        await page.context().close();
      }));
      // The sheet: a row per screen, a column per zoom.
      const sheet = await (await browser.newContext({ viewport: { width: 320 * zooms.length + 40, height: 800 }, deviceScaleFactor: 1 })).newPage();
      const sheetFile = join(demo.out, 'zoom-sheet.html');
      writeFileSync(sheetFile, `<html><body style="margin:0;padding:16px;font:13px -apple-system,sans-serif;background:#fff"><div style="font:700 20px -apple-system;margin-bottom:8px">${demo.cfg.title || demo.name} replica · every screen at each zoom</div>` +
        states.map(st => `<div style="font-weight:600;margin:10px 0 4px">${st}</div><div style="display:flex;gap:8px">` + zooms.map(z => { const c = cells.find(x => x.z === z && x.st === st); return `<div><div>${z}%${c && c.pct !== null ? ` · ${c.pct}% vs real` : ''}</div>${c ? `<img src="${pathToFileURL(c.file).href}" style="width:312px;height:176px;object-fit:contain;border:1px solid #ddd">` : ''}</div>`; }).join('') + '</div>').join('') + '</body></html>');
      await sheet.goto(pathToFileURL(sheetFile).href); await sheet.waitForTimeout(300);
      writeFileSync(join(demo.out, 'zoom-sheet.png'), await sheet.screenshot({ fullPage: true }));
      await sheet.context().close();
      add('zoom', `Zoom ${zooms[0]}–${zooms[zooms.length - 1]}%`, bad.length ? 'fail' : warn.length ? 'warn' : 'pass', [...bad, ...warn].join('\n') || `${states.length} screens × ${zooms.length} zooms (zoom-sheet.png)`);
    }
  } });

  tasks.push({ id: 'clicks', deps: [], run: async () => {
    // ---- clicks: every control the click audit recorded (panes, sections, menus) opens in the replica on its screen
    // and closes back the real page's way, leaving the page exactly as before; sticky ones stay through a morph.
    // Writes .out/clicks/click-sheet-NN.png (real right after the click, left; replica, right).
    if (want('clicks')) {
      const defsOf = app => { const f = join(demo.data, 'snaps', `hovers-${app}.json`); return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')).clicks || []) : []; };
      const pages = flow.clickPages || [];
      if (QUICK && !pages.some(cp => inScope((Object.entries(S).find(([, x]) => x.snap === cp.base) || [cp.base])[0]))) return;
      if (!pages.length) add('clicks', 'Panes, sections and menus', 'warn', 'no click captures: run replica record side clicks on screens with panes that close, sections that collapse, or menus');
      else {
        const page = await open();
        const vp = page.viewportSize();
        const stateOfSnap = snap => (Object.entries(S).find(([, s]) => s.snap === snap) || [snap])[0];
        const sig = (app, frame) => bodySig(page, app, frame);
        const isOpen = async (app, d) => (await page.evaluate(a => window.d1.clicks(a), app)).some(c => c.id === d.id || c.name === d.name);
        const bad = [], rows = []; let ok = 0;
        const outDir = join(demo.out, 'clicks'); mkdirSync(join(outDir, 'rows'), { recursive: true });
        for (const cp of pages) for (const d of defsOf(cp.app).filter(x => x.page === cp.page)) {
          const st = stateOfSnap(cp.base);
          if (!inScope(st)) continue;
          if (!S[st]) { bad.push(`${d.name}: no state for ${cp.base}`); continue; }
          await go(page, st); await page.mouse.move(vp.width - 1, vp.height / 2);
          const m = { ...d.ctl, frame: d.frame || undefined };
          await page.evaluate(([m, a]) => window.d1.reveal(m, a), [m, cp.app]); await sleep(200);
          const ctl = await locate(page, m, cp.app);
          if (!ctl || !ctl.w) { bad.push(`${d.name}: control not on ${st}`); continue; }
          const before = await sig(cp.app, d.frame);
          // Rest on the control first (its hover shows, as when a presenter clicks), then click.
          await page.mouse.move(ctl.x, ctl.y, { steps: 3 }); await sleep(REST); await page.mouse.click(ctl.x, ctl.y);
          // One that undoes itself (a Copy button's check mark) is looked for at once: on the fast clock it's gone soon.
          const openedNow = d.restore === 'auto' && await isOpen(cp.app, d);
          await page.mouse.move(vp.width - 1, vp.height / 2, { steps: 2 }); await sleep(AFTER);
          const opened = openedNow || await isOpen(cp.app, d);
          const png = await page.screenshot();
          let stays = true;
          if (d.sticky && opened) { await page.evaluate(([a, s]) => window.d1.morph(a, s), [cp.app, st]); await sleep(300); stays = await isOpen(cp.app, d); }
          if (d.restore === 'escape') await page.keyboard.press('Escape');
          else if (d.restore === 'auto') await sleep((d.revertMs || 2000) + 300);
          else if (d.restore === 'reopen') { const r = await locate(page, d.reopen, cp.app); if (r) await page.mouse.click(r.x, r.y); }
          else { const at = (await page.evaluate(([n, a]) => window.d1.openAt(n, a), [d.name, cp.app])) || ctl; await page.mouse.move(at.x, at.y, { steps: 2 }); await page.mouse.click(at.x, at.y); }
          await page.mouse.move(vp.width - 1, vp.height / 2, { steps: 2 }); await sleep(400);
          const closed = !(await isOpen(cp.app, d));
          const same = (await sig(cp.app, d.frame)) === before;
          if (opened && closed && same && stays) ok++; else bad.push(`${d.name} (${cp.page}): ${[!opened && "didn't open", !stays && "didn't stay through a morph", !closed && `didn't close by ${d.restore}`, opened && closed && !same && 'the page differs after closing'].filter(Boolean).join(', ')}`);
          const file = join(outDir, 'rows', d.id + '.png'); writeFileSync(file, png);
          const real = join(demo.raw, 'hovers', d.shot || '');
          rows.push({ d, cp, file, real: d.shot && existsSync(real) ? real : null, ok: opened && closed && same && stays });
        }
        const errs = [...(await page.evaluate(() => window.d1.errors)), ...page.noise];
        await page.context().close();
        if (rows.length) {
          const sp = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })).newPage();
          for (let i = 0; i < rows.length; i += 8) {
            const part = rows.slice(i, i + 8);
            const html = `<html><body style="margin:0;padding:16px;width:1568px;font-family:-apple-system,sans-serif;background:#fff"><div style="font:700 22px -apple-system,Helvetica,Arial,sans-serif">${demo.cfg.title || demo.name} replica · clicks ${i + 1}–${i + part.length} of ${rows.length}: the real page (left) and the replica (right) right after the click</div>` +
              part.map(r => `<div style="border-top:1px solid #ccc;margin-top:8px;padding-top:4px"><div style="font:600 13px -apple-system">${r.cp.page} · ${r.d.name.replace(/</g, '&lt;')} · closes by ${r.d.restore}${r.d.sticky ? ' · sticky' : ''} ${r.ok ? '' : '<span style="color:#c00">CHECK FAILED</span>'}</div><div style="display:flex;gap:16px">${r.real ? `<img src="file://${r.real}" style="width:760px;border:1px solid #ddd">` : '<div style="width:760px"></div>'}<img src="file://${r.file}" style="width:760px;border:1px solid #ddd"></div></div>`).join('') + '</body></html>';
            const f = join(outDir, 'rows', `sheet-${i / 8 + 1}.html`); writeFileSync(f, html);
            await sp.goto('file://' + f); await sp.waitForTimeout(300);
            writeFileSync(join(outDir, `click-sheet-${String(i / 8 + 1).padStart(2, '0')}.png`), await sp.screenshot({ fullPage: true }));
          }
          await sp.context().close();
        }
        add('clicks', 'Panes, sections and menus', bad.length || errs.length ? 'fail' : rows.length ? 'pass' : 'warn', bad.length || errs.length ? [...bad, ...errs].join('\n') : rows.length ? `${ok}/${rows.length} open and close back to the same page (clicks/click-sheet-*.png)` : 'click pages, but no clicks recorded');
      }
    }
  } });

  tasks.push({ id: 'drags', deps: [], run: async () => {
    // ---- drags: every resize handle follows the pointer (live) or applies on release like the real one, stops at the
    // real limits, and keeps its size through a morph.
    if (want('drags') && !QUICK) {
      if (!(flow.drags || []).length) add('drags', 'Resizing panes', 'skip', 'no resize handles recorded (replica record side drags on screens with them)');
      else {
        const page = await open();
        const vp = page.viewportSize();
        const bad = [], done = [];
        const states = [...new Set((flow.path || []).map(s => s.checkpoint).filter(Boolean))];
        const sizes = app => page.evaluate(a => Object.values(window.d1.sizes(a)), app);
        for (const [i, r] of flow.drags.entries()) {
          const hm = { sel: r.handle, frame: r.frame };
          let st = null, h = null;
          for (const s of states.filter(s => S[s] && S[s].app === r.app)) { await go(page, s); h = await locate(page, hm, r.app); if (h && h.w) { st = s; break; } }
          if (!st) { bad.push(`${r.handle}: not on any screen of the path`); continue; }
          const drag = async (toX, peek) => { const at = await locate(page, hm, r.app); await page.mouse.move(at.x, at.y); await page.mouse.down(); await page.mouse.move(toX, at.y, { steps: 8 }); await sleep(120); const during = await sizes(r.app); await page.mouse.up(); await sleep(250); return { during, after: await sizes(r.app) }; };
          const a = await drag(h.x + (r.dir === -1 ? -40 : 40));
          if (!a.after.length) { bad.push(`${r.handle}: dragging it changed nothing`); continue; }
          if (r.mode === 'live' && !a.during.length) bad.push(`${r.handle}: should follow the pointer while dragging`);
          if (r.mode === 'release' && a.during.length) bad.push(`${r.handle}: should change only when let go`);
          if (r.min !== undefined) {
            const lo = (await drag(r.dir === -1 ? vp.width - 2 : 2)).after[0], hi = (await drag(r.dir === -1 ? 2 : vp.width - 2)).after[0];
            if (Math.abs(lo - r.min) > 1 || Math.abs(hi - r.max) > 1) bad.push(`${r.handle}: stops at ${lo}–${hi}, real ${r.min}–${r.max}`);
          }
          const kept = (await sizes(r.app))[0];
          await page.evaluate(([app, s]) => window.d1.morph(app, s), [r.app, st]); await sleep(300);
          if ((await sizes(r.app))[0] !== kept) bad.push(`${r.handle}: size lost after a morph`);
          done.push(`${r.handle} (${r.mode}${r.min !== undefined ? `, ${r.min}–${r.max}` : ''})`);
        }
        const errs = [...(await page.evaluate(() => window.d1.errors)), ...page.noise];
        add('drags', 'Resizing panes', bad.length || errs.length ? 'fail' : 'pass', bad.length || errs.length ? [...bad, ...errs].join('\n') : done.join(', '));
        await page.context().close();
      }
    }
  } });

  tasks.push({ id: 'groups', deps: [], run: async () => {
    // ---- groups: every collapsed step group on the path's screens opens (its list shows) and closes back to the same
    // page, resting on it first; and one opened while an answer is still coming in stays open to the end. Each screen
    // and each answer on its own page, all at once.
    if (!want('groups')) return;
    if (!grpApps.length) return add('groups', 'Step groups', 'skip', 'no step groups (replica record side groups on a screen with them)');
    const bad = [], errs = []; let n = 0, mid = 0;
    const screens = pathStates.filter(s => grpApps.includes(S[s].app) && inScope(s));
    const screenJob = async st => {
      const page = await open(), app = S[st].app;
      try {
        await go(page, st); await page.evaluate(a => window.d1.activate(a), app);
        for (const g of (await page.evaluate(a => window.d1.groupButtons(a), app)).filter(x => x.canOpen)) {
          const before = await bodySig(page, app);
          const o = await pressGroup(page, app, g.id), c = await pressGroup(page, app, g.id);
          const same = (await bodySig(page, app)) === before;
          n++;
          if (!(o && o.expanded && o.height > 0 && o.text && o.visible)) bad.push(`${st} · ${g.key}: didn't open with its list (${JSON.stringify(o && { expanded: o.expanded, height: o.height, text: (o.text || '').slice(0, 40) })})`);
          else if (!(c && !c.expanded && same)) bad.push(`${st} · ${g.key}: ${c && c.expanded ? "didn't close" : 'the page differs after closing'}`);
        }
        errs.push(...(await page.evaluate(() => window.d1.errors)), ...page.noise);
      } finally { await page.context().close(); }
    };
    // Mid-answer: start the answer, and open the first group that shows while it plays, at a clock that still leaves
    // the answer about 2 s to click in.
    const streamJob = async ([name, sdef]) => {
      const app = S[sdef.to].app;
      const from = Object.entries(S).find(([, x]) => (x.on || []).some(t => t.stream === name && (t.enter || t.click)));
      if (!from) return;
      const t = from[1].on.find(t => t.stream === name);
      const page = await open(1, Math.max(1, Math.floor((sdef.ms || 5000) * (flow.pace || 5) / 5 / 2000)));
      try {
        await go(page, from[0]); await page.evaluate(a => window.d1.activate(a), app);
        if (t.enter) { if (!(await focusIn(page, t.enter, app))) return; await page.keyboard.press('End'); await page.keyboard.press('Enter'); }
        else if (!(await clickOn(page, t.click, app))) return;
        let opened = null;
        for (let i = 0; i < 300 && !opened; i++) {
          const busyNow = (await page.evaluate(() => window.d1.state)).busy;
          if (!busyNow && i > 4) break;
          const g = (await page.evaluate(a => window.d1.groupButtons(a), app)).find(x => x.canOpen && x.y > 0 && x.y < page.viewportSize().height);
          if (g && busyNow) {
            // While frames arrive the layout moves under the pointer (the answer starting, the chat following it), so
            // it's clicked where it is at that moment, and again if it moved before the click landed.
            let now = null;
            for (let k = 0; k < 4 && !(now && now.expanded); k++) {
              const at = (await page.evaluate(a => window.d1.groupButtons(a), app)).find(x => x.id === g.id);
              if (!at) break;
              await page.mouse.click(at.x, at.y); await sleep(80);
              now = (await page.evaluate(a => window.d1.groupButtons(a), app)).find(x => x.id === g.id);
            }
            await page.mouse.move(page.viewportSize().width - 1, page.viewportSize().height / 2);
            opened = { g, now, busy: busyNow };
          }
          else await sleep(40);
        }
        if (!opened) return bad.push(`${name}: no step group showed while it played`);
        mid++;
        await idle(page); await sleep(150);
        const end = (await page.evaluate(a => window.d1.groupButtons(a), app)).find(x => x.id === opened.g.id);
        const st = await stateOf(page, app);
        if (!opened.busy) bad.push(`${name}: the answer had finished before the group opened (too short to test)`);
        if (!(opened.now && opened.now.expanded)) bad.push(`${name}: "${opened.g.key}" didn't open while the answer played`);
        else if (!(end && end.expanded && end.height > 0 && end.text)) bad.push(`${name}: "${opened.g.key}" opened mid-answer but wasn't open (with its list) when the answer ended on ${st}`);
        else { const c = await pressGroup(page, app, opened.g.id); if (!c || c.expanded) bad.push(`${name}: "${opened.g.key}" didn't close after the answer`); }
        errs.push(...(await page.evaluate(() => window.d1.errors)), ...page.noise);
      } finally { await page.context().close(); }
    };
    const streams = Object.entries(flow.streams || {}).filter(([, x]) => S[x.to] && grpApps.includes(S[x.to].app) && inScope(x.to));
    await Promise.all([...screens.map(screenJob), ...streams.map(streamJob)]);
    if (QUICK && !n && !mid) return;
    add('groups', 'Step groups', bad.length || errs.length ? 'fail' : n ? 'pass' : 'warn', bad.length || errs.length ? [...bad, ...errs].join('\n') : n ? `${n} groups open and close back to the same page; ${mid} opened mid-answer and stayed open` : 'groups captured, but none on the path\'s screens');
  } });

  tasks.push({ id: 'chips', deps: [], run: async () => {
    // ---- chips: "+N" shows every chip and becomes "Show less" (and stays so through a morph); that puts it back.
    if (want('chips')) {
      const rules = flow.apps.flatMap(a => ((a.layout || {}).chips || []).map((r, ri) => ({ app: a.id, r, ri }))).filter(x => !QUICK || inScope(x.r.state && S[x.r.state] ? x.r.state : pathStates.find(st => S[st].app === x.app)));
      if (QUICK && !rules.length) return;
      if (!rules.length) add('chips', '"+N" chips', 'skip', 'no chip lists (replica record side chips on a screen with "+N")');
      else {
        const bad = [], done = [];
        for (const { app, r, ri } of rules) {
          const page = await open();
          const st = r.state && S[r.state] ? r.state : pathStates.find(s => S[s].app === app);
          await go(page, st); await page.evaluate(a => window.d1.activate(a), app);
          const w = await narrowToPlus(page, app, ri);
          if (!w) { bad.push(`${r.list}: no "+N" at any width on ${st}`); await page.context().close(); continue; }
          const before = await bodySig(page, app), b0 = await plusInfo(page, app, ri, r.list);
          const o = await pressPlus(page, app, ri, r.list);
          const less = r.plus.less || 'Show less';
          if (!o || o.text !== less || o.shown !== o.total) bad.push(`${r.list} at ${w} px: "${b0.text}" showed ${o && o.shown}/${o && o.total} chips and says "${o && o.text}"`);
          if (r.plus.labelLess && o && o.label !== r.plus.labelLess) bad.push(`${r.list}: open, its label is "${o.label}", real "${r.plus.labelLess}"`);
          await page.evaluate(([a, s]) => window.d1.morph(a, s), [app, st]); await sleep(200);
          const kept = await plusInfo(page, app, ri, r.list);
          if (kept.text !== less) bad.push(`${r.list}: after a morph it says "${kept.text}"`);
          const c = await pressPlus(page, app, ri, r.list);
          if (!c || c.text !== b0.text || c.shown !== b0.shown || (await bodySig(page, app)) !== before) bad.push(`${r.list}: "${less}" didn't put it back (${c && c.text}, ${c && c.shown} shown)`);
          if (r.plus.labelMore && c && c.label !== r.plus.labelMore.split('{n}').join(c.text.slice(1))) bad.push(`${r.list}: its label is "${c.label}"`);
          const errs = [...(await page.evaluate(() => window.d1.errors)), ...page.noise];
          if (errs.length) bad.push(...errs);
          done.push(`${r.list} at ${w} px: ${b0.text} → ${less}`);
          await page.context().close();
        }
        add('chips', '"+N" chips', bad.length ? 'fail' : 'pass', bad.length ? bad.join('\n') : done.join(', '));
      }
    }
  } });

  tasks.push({ id: 'reset', deps: [], run: async () => {
    // ---- reset: ⌥0 and a beat jump put every pane, section, menu and size back as captured.
    if (want('reset') && !QUICK) {
      const defsOf = app => { const f = join(demo.data, 'snaps', `hovers-${app}.json`); return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')).clicks || []) : []; };
      const sticky = flow.apps.flatMap(a => defsOf(a.id).filter(d => d.sticky || d.popup).map(d => ({ app: a.id, d })));
      const chipRules = flow.apps.flatMap(a => ((a.layout || {}).chips || []).map((r, ri) => ({ app: a.id, r, ri })));
      if (!sticky.length && !(flow.drags || []).length && !grpApps.length && !chipRules.length) add('reset', '⌥0 and jumps reset panes and sizes', 'skip', 'no clicks, drags, groups or chips to reset');
      else {
        const fresh = await open();
        await fresh.keyboard.press('Alt+Digit0'); await idle(fresh); await fresh.mouse.move(fresh.viewportSize().width - 1, 5); await sleep(300);
        const FP = readFileSync(join(here, 'fingerprint.js'), 'utf8').replace(/^\/\/.*\n/gm, '');
        const want0 = await fresh.evaluate(`(${FP})()`);
        await fresh.context().close();
        const page = await open();
        const vp = page.viewportSize();
        const stateOfSnap = snap => (Object.entries(S).find(([, s]) => s.snap === snap) || [snap])[0];
        const bad = [];
        const mess = async () => {
          let n = 0; const what = [];
          for (const { app, d } of sticky) {
            const st = stateOfSnap((flow.clickPages.find(c => c.page === d.page) || {}).base);
            if (!S[st]) continue;
            await page.evaluate(([a, s]) => window.d1.morph(a, s), [app, st]); await page.evaluate(a => window.d1.activate(a), app);
            const c = await locate(page, { ...d.ctl, frame: d.frame || undefined }, app);
            if (c && c.w) { await page.mouse.click(c.x, c.y); await sleep(250); n++; what.push(d.name); }
          }
          // "+N", open (at a width where it shows), then the window as it was. Before the drags: a pane she resized keeps
          // its width, so a narrower window wouldn't show "+N" any more.
          for (const { app, r, ri } of chipRules) {
            const st = r.state && S[r.state] ? r.state : pathStates.find(s => S[s].app === app);
            await page.evaluate(([a, s]) => window.d1.morph(a, s), [app, st]); await page.evaluate(a => window.d1.activate(a), app);
            if (await narrowToPlus(page, app, ri)) { await pressPlus(page, app, ri, r.list); n++; what.push('"+N"'); }
            await page.setViewportSize(vp); await sleep(300); await idle(page);
          }
          for (const r of flow.drags || []) {
            const st = [...new Set((flow.path || []).map(s => s.checkpoint))].find(s => S[s] && S[s].app === r.app);
            if (!st) continue;
            await page.evaluate(([a, s]) => window.d1.morph(a, s), [r.app, st]); await page.evaluate(a => window.d1.activate(a), r.app);
            const h = await locate(page, { sel: r.handle, frame: r.frame }, r.app);
            if (h && h.w) { await page.mouse.move(h.x, h.y); await page.mouse.down(); await page.mouse.move(h.x - 60, h.y, { steps: 5 }); await page.mouse.up(); await sleep(200); n++; what.push('drag ' + r.handle); }
          }
          // A step group, open.
          for (const st of pathStates.filter(s => grpApps.includes(S[s].app))) {
            const app = S[st].app;
            await page.evaluate(([a, s]) => window.d1.morph(a, s), [app, st]); await page.evaluate(a => window.d1.activate(a), app);
            const g = (await page.evaluate(a => window.d1.groupButtons(a), app)).find(x => x.canOpen);
            if (g) { await pressGroup(page, app, g.id); n++; what.push('group ' + g.key); break; }
          }
          mess.what = what;
          return n;
        };
        const left = () => page.evaluate(ids => ids.flatMap(a => [...window.d1.clicks(a).map(c => `${a}: ${c.name} open`), ...Object.keys(window.d1.sizes(a)).map(k => `${a}: size ${k}`), ...Object.keys(window.d1.flags(a)).filter(k => window.d1.flags(a)[k]).map(k => `${a}: flag ${k}`), ...window.d1.groups(a).open.map(k => `${a}: group ${k} open`)]), flow.apps.map(a => a.id));
        const n = await mess();
        if (!(await left()).length) bad.push('nothing stayed open or resized to reset');
        await page.keyboard.press('Alt+Digit0'); await idle(page); await page.mouse.move(vp.width - 1, 5); await sleep(300);
        const after0 = await left();
        if (after0.length) bad.push('after ⌥0: ' + after0.join(', '));
        if ((await page.evaluate(`(${FP})()`)) !== want0) bad.push('after ⌥0 the page differs from a fresh start');
        if ((flow.beats || []).length > 1) {
          await mess();
          await page.keyboard.press('Alt+Digit1'); await idle(page);
          const after1 = await left();
          if (after1.length) bad.push('after ⌥1: ' + after1.join(', '));
        }
        add('reset', '⌥0 and jumps reset panes and sizes', bad.length ? 'fail' : 'pass', bad.length ? bad.join('\n') : `${n} changed (${mess.what.join(', ')}), then all back after ⌥0 and ⌥1`);
        await page.context().close();
      }
    }
  } });

  tasks.push({ id: 'hovers', deps: [], run: async () => {
    // ---- hovers: every hover captured from the real pages shows in the replica.
    if (want('hovers')) {
      if (!(flow.hoverPages || []).length) add('hovers', 'Hover states', 'warn', 'no hover captures: run replica record side hovers on each screen with hover cards or tooltips');
      else {
        if (QUICK && !changedHovers.size) return;
        const r = await node('checks/hover-check.mjs', ['--demo', demo.dir, '--url', URL, '--speed', String(SPEED), '--no-sheet', ...(QUICK ? ['--apps', [...changedHovers].join(',')] : [])]);
        let rep = null; try { rep = JSON.parse(readFileSync(join(demo.out, 'hovers', 'report.json'), 'utf8')); } catch (e) {}
        if (!rep) add('hovers', 'Hover states', 'fail', r.out.slice(-800));
        else {
          // Hovers whose control isn't on any of the replica's screens (captured on a live page that differs) can't
          // show; they're listed, and the share is of the ones whose control is there.
          const absent = Object.values(rep.pages || {}).flatMap(p => p.missing || []);
          const share = rep.total - absent.length ? rep.shown / (rep.total - absent.length) : 1;
          add('hovers', 'Hover states', share >= 0.9 && !rep.errors.length ? (rep.failed.length || absent.length ? 'warn' : 'pass') : 'fail', `${rep.shown}/${rep.total - absent.length} shown` + (rep.failed.length ? '\n' + rep.failed.slice(0, 20).map(f => `${f.id}: ${f.text}`).join('\n') : '') + (absent.length ? `\n${absent.length} captured hovers have no control on the replica's screens:\n` + absent.slice(0, 30).join('\n') : ''));
        }
      }
    }
  } });

  tasks.push({ id: 'contact-sheet', deps: ['two-run'], run: async () => {
    // ---- contact sheet: real vs replica, every screen of the recorded path.
    if (want('contact-sheet') && !QUICK) {
      const r = await node('checks/contact-sheet.mjs', ['--demo', demo.dir]);
      let rows = null; try { rows = JSON.parse(readFileSync(join(demo.out, 'contact-sheet', 'summary.json'), 'utf8')); } catch (e) {}
      if (!rows || !rows.length) add('contact-sheet', 'Real vs replica contact sheet', 'fail', r.out.slice(-800));
      else {
        const worst = [...rows].sort((a, b) => b.pct - a.pct);
        const far = worst.filter(x => x.pct > 5);
        add('contact-sheet', 'Real vs replica contact sheet', far.length ? 'warn' : 'pass', `${rows.length} pairs, worst ${worst[0].name} ${worst[0].pct}% (contact-sheet/contact-sheet.png)` + (far.length ? '\nlook at: ' + far.map(x => `${x.name} ${x.pct}%`).join(', ') : ''));
      }
    }
  } });

  // ---- run them: each task once its deps are done, as many at once as the pages allow.
  const done = {};
  const runTask = t => done[t.id] || (done[t.id] = (async () => {
    for (const d of t.deps) { const dt = tasks.find(x => x.id === d); if (dt) await runTask(dt); }
    started[t.id] = Date.now();
    try { await t.run(); } catch (e) { add(t.id, t.id, 'fail', 'the check itself failed: ' + String(e && e.stack || e).slice(0, 600)); }
  })());
  await Promise.all(tasks.map(runTask));

  // ---- for a person: what no script can judge.
  for (const [id, t] of [
    ['manual-theme', "Each app's theme was set to Light (not System) before recording; dark mode anywhere means recapture"],
    ['manual-look', 'The contact sheet and zoom sheet looked over: nothing missing, cut off, or out of place'],
    ['manual-pace', 'Pace feels right on stage (flow.pace; ?pace= to try)'],
    ['manual-differences', "The demo's README lists every difference from the live product, every edit and every composed part"],
    ['manual-rehearse', 'Rehearsed on the venue display in full screen (⌃⌘F), with the presenter keys'],
  ]) if (want(id) && !only.size && !QUICK) add(id, t, 'manual', '');
} finally {
  await browser.close();
  if (server) server.kill();
}
const fails = items.filter(i => i.status === 'fail');
const ORDER = ['secrets', 'render', 'two-run', 'cold-start', 'light', 'transitions', 'composer', 'keys', 'focus', 'lists', 'zoom', 'clicks', 'drags', 'groups', 'chips', 'reset', 'hovers', 'contact-sheet'];
items.sort((a, b) => ((ORDER.indexOf(a.id) + 1) || 99) - ((ORDER.indexOf(b.id) + 1) || 99));
const secs = Math.round((Date.now() - T_START) / 1000);
const report = { demo: demo.name, at: new Date().toISOString(), quick: QUICK, scope: SCOPE ? [...SCOPE] : null, secs, pass: !fails.length, items };
// What passed becomes the base the next --quick compares with.
if (!fails.length && !only.size && !skip.size) {
  const next = QUICK && base ? base : { states: {}, apps: {}, hovers: {}, beats: null };
  if (!QUICK) Object.assign(next, FP);
  else {
    for (const id of SCOPE) if (FP.states[id]) next.states[id] = FP.states[id];
    for (const a of changedApps) next.apps[a] = FP.apps[a];
    for (const a of changedHovers) next.hovers[a] = FP.hovers[a];
    if (beatsChanged) next.beats = FP.beats;
    for (const id of Object.keys(next.states)) if (!S[id]) delete next.states[id];
  }
  writeFileSync(BASE, JSON.stringify(next, null, 1));
}
writeFileSync(join(demo.out, QUICK ? 'quick.json' : 'fidelity.json'), JSON.stringify(report, null, 1));
const icon = { pass: '✅', fail: '❌', warn: '⚠️', skip: '➖', manual: '👤' };
writeFileSync(join(demo.out, QUICK ? 'quick.md' : 'fidelity.md'), `# ${demo.cfg.title || demo.name} replica · ${QUICK ? 'quick check' : 'fidelity'}\n\n${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${secs} s · ${fails.length ? `${fails.length} failing` : 'all automatic checks pass'}${QUICK ? ` · ${SCOPE.size} changed screens: ${[...SCOPE].join(', ') || 'none'}` : ''}\n\n| | Check | Result | s |\n|---|---|---|---|\n` +
  items.map(i => `| ${icon[i.status]} | ${i.title} | ${(i.detail || '').split('\n')[0].replace(/\|/g, '\\|')} | ${i.secs ?? ''} |`).join('\n') + '\n\n' +
  items.filter(i => (i.detail || '').includes('\n')).map(i => `## ${i.title}\n\n\`\`\`\n${i.detail}\n\`\`\`\n`).join('\n'));
console.log(`\n${QUICK ? `quick check (${SCOPE.size} of ${Object.keys(S).length} screens changed)` : 'fidelity'}: ${fails.length ? `${fails.length} FAILING: ${fails.map(f => f.id).join(', ')}` : 'all automatic checks pass'} in ${secs} s → ${join(demo.out, QUICK ? 'quick.md' : 'fidelity.md')}`);
process.exit(fails.length ? 1 : 0);
