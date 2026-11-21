// Record start on tabs like a presenter's real ones (Jessica's Mac, Nov 19):
//   1. A frame that never answers (Microsoft apps keep about:blank frames like this) made Record sit on "Starting…"
//      for minutes and the app gave up ("timeout waiting for …"). Start now leaves the frame out after a few seconds.
//   2. Frames with no script context (Copilot had 18 of its 24, all about:blank, never touched): each call into one
//      waited 3 s for a context, on every check, so Start and each screen's side states took minutes.
//   3. Two tabs for one app, the second marked (a tab opened for the recording next to the presenter's own): the marked
//      one is recorded even when the recorder hasn't attached to it yet (as after the recorder reloads).
//   node packages/selftest/real-tabs.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { buildExtension } from '../recorder/build.mjs';
import { send } from '../recorder/cli.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RX = 47698, WEB = 47896;
const tmp = mkdtempSync(join(tmpdir(), 'scenecast-real-tabs-'));
const raw = join(tmp, 'raw');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fails = [];
const check = (name, ok, detail) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? `: ${String(detail).slice(0, 1200)}` : '')); if (!ok) fails.push(name); };
const ping = () => fetch(`http://127.0.0.1:${RX}/ping`).then(r => r.json()).catch(() => null);
// The app on 127.0.0.1; its frame on localhost (another site, so its own process) loads, then never answers again.
const web = createServer((q, s) => {
  s.setHeader('content-type', 'text/html');
  if (q.url.startsWith('/stuck')) return s.end('<p>frame</p><script>setTimeout(() => { for (;;) {} }, 6000)</script>');
  const who = new URL(q.url, 'http://x').searchParams.get('who') || 'app';
  const blanks = q.url.startsWith('/blanks') ? '<iframe></iframe>'.repeat(16) : '';
  s.end(`<title>${who}</title><h1>${who}</h1><button onclick="document.querySelector('h1').textContent = '${who} opened'">Open</button>${q.url.startsWith('/busy') ? `<iframe src="http://localhost:${WEB}/stuck"></iframe>` : ''}${blanks}`);
}).listen(WEB, '127.0.0.1');
const rx = spawn(process.execPath, [join(HERE, '..', 'recorder', 'receiver.mjs'), raw, String(RX)], { stdio: 'ignore', env: { ...process.env, SCENECAST_RX_OWNER: 'cli' } });
let ctx;
try {
  buildExtension(join(tmp, 'ext'), RX);
  for (let i = 0; i < 50 && !(await ping()); i++) await sleep(100);
  ctx = await chromium.launchPersistentContext(join(tmp, 'profile'), { channel: 'chromium', headless: true, viewport: { width: 1200, height: 800 }, ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--site-per-process', '--silent-debugger-extension-api', '--disable-features=DisableLoadExtensionCommandLineSwitch', `--disable-extensions-except=${join(tmp, 'ext')}`, `--load-extension=${join(tmp, 'ext')}`] });
  const match = `127.0.0.1:${WEB}/app`;
  await (await ctx.newPage()).goto(`http://127.0.0.1:${WEB}/app?who=hers`);
  const mine = await ctx.newPage(); await mine.goto(`http://127.0.0.1:${WEB}/app?who=mine`);
  // Marked before the recorder has attached to anything: what a tab marked earlier looks like after the recorder reloads.
  await mine.evaluate(k => sessionStorage.setItem('d1tab', k), match);
  const busy = `127.0.0.1:${WEB}/busy`, blanks = `127.0.0.1:${WEB}/blanks`;
  await (await ctx.newPage()).goto(`http://${blanks}?who=blanks`);
  await (await ctx.newPage()).goto(`http://${busy}?who=busy`);
  for (let i = 0; i < 80; i++) { const p = await ping(); if (p && p.agent && p.agent.id) break; await sleep(250); }
  // The recorder knows the busy tab's frame (it's attached) before the frame stops answering.
  const seen = await send({ op: 'eval', tab: busy, expr: 'document.title' }, 30, RX);
  check('the busy tab is there', seen.ok && seen.value === 'busy', JSON.stringify(seen));
  await sleep(7000);
  const t0 = Date.now();
  const r = await send({ op: 'recordStart', apps: [{ id: 'app', match }, { id: 'busy', match: busy }, { id: 'blanks', match: blanks }], record: { auto: false } }, 120, RX);
  const secs = (Date.now() - t0) / 1000;
  check('record starts though a frame never answers and another tab has 16 empty frames', r.ok && r.value && r.value.recording, JSON.stringify(r));
  check('and waits on neither (under 30 s)', secs < 30, `${secs.toFixed(1)} s`);
  // The busy tab's frame never answers now: a click in another app is still recorded (the loop that reads each frame's
  // events waited on it for ever before).
  await sleep(1500);
  await send({ op: 'front', tab: busy }, 30, RX);
  const box = await send({ op: 'find', tab: busy, text: 'Open' }, 30, RX);
  await send({ op: 'click', tab: busy, x: box.value.x, y: box.value.y }, 30, RX);
  let stepped = false;
  for (let i = 0; i < 40 && !stepped; i++) { await sleep(500); const st = await send({ op: 'recordStatus' }, 30, RX); stepped = st.ok && (st.value.log || []).some(l => /click "Open"/.test(l)); }
  check('a click is recorded though a frame never answers', stepped, JSON.stringify((await send({ op: 'recordStatus' }, 30, RX)).value?.log?.slice(-4)));
  const title = await send({ op: 'eval', tab: match, expr: 'document.title' }, 30, RX);
  check('a marked tab the recorder hasn\'t attached to yet is the one recorded', title.ok && title.value === 'mine', JSON.stringify(title));
  const log = readFileSync(join(raw, 'receiver.log'), 'utf8');
  check('the log names the frame that didn\'t answer', /a frame \(http:\/\/localhost:\d+\/stuck\) didn't answer/.test(log), log.split('\n').filter(l => /rec:/.test(l)).slice(-6).join('\n'));
  await send({ op: 'recordAbort' }, 60, RX);
  // Between takes: a click with no recording on is kept by the page (its queue outlives Stop). The next take must not
  // replay it (Nov 20: the second take began with a click made while tidying the tabs).
  await send({ op: 'front', tab: busy }, 30, RX);
  const box2 = await send({ op: 'find', tab: busy, text: 'Open' }, 30, RX);
  await send({ op: 'click', tab: busy, x: box2.value.x, y: box2.value.y }, 30, RX);
  await sleep(500);
  const r2 = await send({ op: 'recordStart', apps: [{ id: 'app', match }, { id: 'busy', match: busy }], record: { auto: false } }, 120, RX);
  await sleep(4000);
  const st2 = (await send({ op: 'recordStatus' }, 30, RX)).value || {};
  check('a new take doesn\'t replay a click made between takes', r2.ok && st2.recording && !st2.actions && !(st2.log || []).some(l => /click "Open"/.test(l)), JSON.stringify({ actions: st2.actions, log: (st2.log || []).slice(-4) }));
  await send({ op: 'recordAbort' }, 60, RX);
} catch (e) {
  check('ran', false, e.stack || e);
} finally {
  if (process.env.SHOWLOG) try { console.log(readFileSync(join(raw, 'receiver.log'), 'utf8').slice(-3000)); } catch (e) {}
  await ctx?.close().catch(() => {});
  rx.kill(); web.close();
  try { rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
}
console.log(fails.length ? `real tabs: ${fails.length} failed` : 'real tabs: all pass');
process.exit(fails.length ? 1 : 0);
