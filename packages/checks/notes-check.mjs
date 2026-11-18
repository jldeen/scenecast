// The notes check: the script, the presenter window and the replica agree. Run by `scenecast notes --check` and as the
// `notes` item of the fidelity checklist (when the demo has presenter/notes.json).
//   script ↔ notes   presenter/notes.json is what `scenecast notes` makes from the script now (same words, same beats,
//                    the same focus points and stage); every focus point is on a script beat; every beat is somewhere
//                    on the stage.
//   notes ↔ window   in headless Chrome, the window shows each beat's title, its talk track word for word, its clicks,
//                    focus points and watch-outs, and its pictures load.
//   window ↔ replica the pictures still look like the screens they are of; ⌥G on the stage opens the window, which
//                    follows the stage through every beat key; Back/Next and the circles browse without moving the
//                    stage, Esc comes back; "Go to this beat on stage" moves the stage to each beat's start; → steps
//                    the window over a beat with no screen of its own while the screen stays; the timer starts at the
//                    first beat, runs, resets to the beat's script time, and stops at End.
//   node checks/notes-check.mjs --demo <dir> [--url http://127.0.0.1:N/] [--as-windows] [--json]
// --as-windows: the browser presents as Edge on Windows (keys are Ctrl+Alt, and the window says so).
// Writes .out/notes-check.json; exits 1 on any failure.
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { loadDemo, arg } from '../kit/lib/demo.mjs';
import { buildNotes } from '../kit/lib/notes.mjs';
import { replicaServer } from '../kit/lib/server.mjs';
import { compileFlow } from '../kit/compile/flow.mjs';
import { comparePngs } from './compare.mjs';
import { keyLabel } from '../player/app/presenter-key.js';

const args = process.argv.slice(2);
const demo = loadDemo(args);
const AS_WIN = args.includes('--as-windows');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const items = [];
const add = (id, ok, detail) => { items.push({ id, status: ok === null ? 'warn' : ok ? 'pass' : 'fail', detail: String(detail || '') }); console.log(`${(ok === null ? 'WARN' : ok ? 'PASS' : 'FAIL').padEnd(5)} ${id}: ${String(detail || '').split('\n')[0].slice(0, 200)}`); };
const nf = join(demo.dir, 'presenter', 'notes.json');
if (!existsSync(nf)) { console.log('no presenter/notes.json: run `scenecast notes`'); process.exit(1); }
const notes = JSON.parse(readFileSync(nf, 'utf8'));
const B = notes.beats, LAST = B.length - 1, SB = notes.stage.beats;
const landKey = n => SB[n] && SB[n].lands ? `${SB[n].lands.app}:${SB[n].lands.state}` : null;
const EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0';
// Text as the window shows it: Markdown marks gone, keys as this platform reads them, whitespace collapsed.
const plain = (s, win) => keyLabel(String(s), win ? 'Win32' : 'MacIntel').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1$2').replace(/\s+/g, ' ').trim();

const srv = await replicaServer(demo, arg(args, '--url'));
const browser = await chromium.launch({ channel: process.env.REPLICA_CHROME_CHANNEL || 'chrome', headless: true });
try {
  const flow = (await compileFlow(demo)).flow;
  // ---- script ↔ notes ------------------------------------------------------------------------------------------------
  const sp = resolve(demo.dir, notes.script || 'presenter/script.md');
  if (!existsSync(sp)) add('script', false, `${notes.script}: the script notes.json was made from isn't there`);
  else {
    const fresh = buildNotes(demo, flow, readFileSync(sp, 'utf8'), basename(sp)); fresh.script = notes.script;
    const diff = [];
    if (JSON.stringify(fresh) !== JSON.stringify(notes)) {
      if (fresh.beats.length !== notes.beats.length) diff.push(`the script has ${fresh.beats.length - 2} beats, notes.json ${notes.beats.length - 2}`);
      else fresh.beats.forEach((b, i) => { for (const k of Object.keys(b)) if (JSON.stringify(b[k]) !== JSON.stringify(notes.beats[i][k])) diff.push(`${fresh.names[b.n]}: ${k}`); });
      for (const k of ['title', 'parts', 'keys', 'stage', 'shots']) if (JSON.stringify(fresh[k]) !== JSON.stringify(notes[k])) diff.push(k);
    }
    add('script', !diff.length, diff.length ? `notes.json is out of date with ${notes.script} (run \`scenecast notes\`): ${[...new Set(diff)].join('; ')}` : `${notes.script}: ${B.length - 2} beats, ${B.reduce((n, b) => n + b.say.length, 0)} lines, word for word`);
  }
  const lost = (flow.focus || []).filter(p => !((p.beat || 0) >= 0 && (p.beat || 0) < LAST));
  add('focus-beats', !lost.length, lost.length ? `focus points on no script beat: ${lost.map(p => `${p.id} (beat ${p.beat})`).join(', ')}` : `${(flow.focus || []).length} focus points, each on a script beat`);
  const nowhere = SB.filter(b => !b.lands).map(b => notes.names[b.n]);
  add('stage', !nowhere.length, nowhere.length ? `not on the stage: ${nowhere.join(', ')} (demo.json presenter.beats)` : `${SB.filter(b => b.own).length} beats with a screen of their own, ${SB.filter(b => !b.own).length} sharing the one before`);

  // ---- the pictures ---------------------------------------------------------------------------------------------------
  const ctx0 = await browser.newContext({ viewport: { width: demo.cfg.viewport.width, height: demo.cfg.viewport.height }, deviceScaleFactor: 0.5 });
  const p0 = await ctx0.newPage();
  await p0.goto(srv.url); await p0.waitForFunction(() => window.d1 && window.d1.state && window.d1.state.active);
  const wait = (demo.cfg.presenter || {}).shotWait || {};
  const shotBad = [], shotWarn = [];
  for (const s of notes.shots) {
    const f = join(demo.dir, 'presenter', 'shots', s.name + '.png');
    if (!existsSync(f)) { shotBad.push(`${s.name}: missing (run \`scenecast guide-shots\`)`); continue; }
    await p0.evaluate(async ([a, st]) => { await window.d1.go(a, st); window.d1.activate(a); await window.d1.idle(); }, [s.app, s.state]);
    await p0.mouse.move(demo.cfg.viewport.width - 2, 2); await sleep(400 + (wait[s.app] || 0));
    const now = (await p0.screenshot()).toString('base64');
    const [c] = await comparePngs(p0, [[readFileSync(f).toString('base64'), now]]);
    if (c.pct > 15) shotBad.push(`${s.name}: ${c.pct}% differs from ${s.app} ${s.state} (run \`scenecast guide-shots\`)`);
    else if (c.pct > 2) shotWarn.push(`${s.name}: ${c.pct}% differs`);
  }
  await ctx0.close();
  add('pictures', shotBad.length ? false : shotWarn.length ? null : true, shotBad.length ? shotBad.join('\n') : shotWarn.length ? shotWarn.join('\n') + ' (run `scenecast guide-shots`)' : `${notes.shots.length} pictures, each its beat's screen`);

  // ---- the window and the stage ---------------------------------------------------------------------------------------
  const ctx = await browser.newContext({ viewport: { width: demo.cfg.viewport.width, height: demo.cfg.viewport.height }, deviceScaleFactor: 1, ...(AS_WIN ? { userAgent: EDGE } : {}) });
  // As Edge on Windows: its user agent and platform in every page, the popup window included, from the start.
  if (AS_WIN) await ctx.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'Win32' }); Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => ({ platform: 'Windows', mobile: false, brands: [{ brand: 'Microsoft Edge', version: '142' }] }) }); });
  const errs = [];
  const stage = await ctx.newPage();
  stage.on('pageerror', e => errs.push('stage: ' + e.message));
  await stage.goto(srv.url); await stage.waitForFunction(() => window.d1 && window.d1.state && window.d1.state.active && window.d1.presenter);
  const MOD = await stage.evaluate(() => /^win/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform) ? 'Control+Alt+' : 'Alt+');
  if (AS_WIN && MOD !== 'Control+Alt+') add('windows', false, 'the browser doesn\'t present as Windows');
  // Keys read the way the browser presents: Windows labels under --as-windows, and on a real Windows machine.
  const WIN = MOD === 'Control+Alt+';
  const idle = () => stage.evaluate(() => window.d1.idle());
  const where = () => stage.evaluate(() => { const s = window.d1.state; return `${s.active}:${s.states[s.active]}`; });
  await stage.keyboard.press(MOD + 'Digit0'); await idle();
  // ⌥G opens the window.
  const pop = ctx.waitForEvent('page', { timeout: 5000 }).catch(() => null);
  await stage.keyboard.press(MOD + 'KeyG');
  const win = await pop;
  if (!win) { add('window-opens', false, `${keyLabel('⌥G', WIN ? 'Win32' : 'MacIntel')} opened no window`); throw new Error('no window'); }
  win.on('pageerror', e => errs.push('window: ' + e.message));
  await win.waitForLoadState();
  const synced = n => win.waitForFunction(n => window.presenter && window.presenter.connected && window.presenter.live === n && !window.d1, n, { timeout: 10000 }).then(() => true, () => false);
  const ok0 = await synced(0);
  add('window-opens', ok0 && /\/presenter\.html$/.test(win.url()), ok0 ? `${keyLabel('⌥G', WIN ? 'Win32' : 'MacIntel')} opens the window, In sync on Start` : 'the window opened but never heard the stage');
  if (!ok0) throw new Error('not in sync');
  // Every beat's content, word for word.
  const content = [];
  for (const b of B) {
    await win.click(`[data-goto="${b.n}"]`);
    const got = await win.evaluate(() => {
      const q = s => document.querySelector(`[data-pn="${s}"]`);
      const imgs = [q('shot'), q('next-shot')].map(i => !i.getAttribute('src') || (i.complete && i.naturalWidth > 0));
      return { title: q('title').textContent, say: [...q('say').querySelectorAll(':scope > p, :scope > .pn-alt > p')].map(p => p.innerText), clicks: q('clicks').querySelectorAll(':scope > ul > li').length, focus: q('clicks').querySelectorAll('.pn-focus li').length, watch: q('watch').querySelectorAll('li').length, imgs, index: window.presenter.index };
    });
    for (let i = 0; i < 20 && got.imgs.includes(false); i++) { await sleep(100); got.imgs = await win.evaluate(() => ['shot', 'next-shot'].map(s => document.querySelector(`[data-pn="${s}"]`)).map(i => !i.getAttribute('src') || (i.complete && i.naturalWidth > 0))); }
    const name = notes.names[b.n];
    if (got.index !== b.n) content.push(`${name}: its circle shows ${got.index}`);
    if (got.title !== b.title) content.push(`${name}: title "${got.title}"`);
    if (b.n > 0 && b.n < LAST && b.say.length) { const want = b.say.map(p => plain(p.text, WIN)); const have = got.say.map(t => t.replace(/\s+/g, ' ').trim()); if (JSON.stringify(want) !== JSON.stringify(have)) content.push(`${name}: talk track differs: ${JSON.stringify(have).slice(0, 160)} vs ${JSON.stringify(want).slice(0, 160)}`); }
    if (got.clicks !== b.do.filter(d => !d.level).length) content.push(`${name}: ${got.clicks} clicks, the script has ${b.do.filter(d => !d.level).length}`);
    if (got.focus !== (b.focus || []).length) content.push(`${name}: ${got.focus} focus points, ${(b.focus || []).length} in notes`);
    if (got.watch !== b.watch.length) content.push(`${name}: ${got.watch} watch-outs, ${b.watch.length} in notes`);
    if (got.imgs.includes(false)) content.push(`${name}: a picture doesn't load`);
  }
  if (WIN) { const k = await win.evaluate(() => document.querySelector('[data-pn="keys"]').textContent); if (/⌥/.test(k) || !/Ctrl\+Alt\+G/.test(k)) content.push('the Keys list doesn\'t read as Windows keys'); }
  add('window-content', !content.length, content.length ? content.join('\n') : `${B.length} steps: titles, talk track word for word, clicks, focus points, watch-outs, pictures`);
  await win.keyboard.press('Escape');
  // The stage's beat keys: the window follows.
  const follow = [];
  const keys = Math.min(9, (flow.beats || []).length - 1);
  for (let k = 1; k <= keys; k++) {
    await stage.bringToFront(); await stage.keyboard.press(MOD + 'Digit' + k); await idle();
    const want = Math.min(k, LAST);
    if (!(await synced(want))) follow.push(`⌥${k}: the window is on ${await win.evaluate(() => window.presenter.live)}`);
    else if ((await win.evaluate(() => window.presenter.index)) !== want) follow.push(`⌥${k}: the window shows ${await win.evaluate(() => window.presenter.index)}`);
  }
  await stage.keyboard.press(MOD + 'Digit0'); await idle();
  if (!(await synced(0))) follow.push('⌥0: the window didn\'t come back to Start');
  // As before a talk after trying the keys: Reset on Start stops the timer at 0:00.
  await win.click('[data-pn="reset-timer"]');
  add('window-follows', !follow.length, follow.length ? follow.join('\n') : `follows ⌥0–⌥${keys} on the stage`);
  // Browsing moves only the window.
  const browse = [];
  {
    const before = await where();
    await win.bringToFront();
    await win.click('[data-pn="next"]'); await win.click('[data-pn="next"]'); await sleep(400);
    const st = await win.evaluate(() => ({ index: window.presenter.index, live: window.presenter.live, banner: !document.querySelector('[data-pn="preview"]').hidden, text: document.querySelector('[data-pn="preview-text"]').textContent }));
    if (st.index !== Math.min(2, LAST) || st.live !== 0) browse.push(`Next twice: the window shows ${st.index}, live ${st.live}`);
    if (!st.banner || !/Previewing/.test(st.text)) browse.push('no "Previewing" banner');
    await win.click('[data-pn="prev"]'); await win.keyboard.press('ArrowRight'); await win.keyboard.press('PageDown');
    await win.keyboard.press(MOD + 'Digit1'); await win.click(`[data-goto="${LAST}"]`); await sleep(300);
    if ((await win.evaluate(() => window.presenter.index)) !== LAST) browse.push('a circle doesn\'t show its beat');
    if ((await where()) !== before || (await stage.evaluate(() => window.d1.presenter.beat)) !== 0) browse.push('browsing moved the stage');
    await win.keyboard.press('Escape'); await sleep(200);
    if ((await win.evaluate(() => window.presenter.index)) !== 0) browse.push('Esc didn\'t come back to the stage\'s beat');
  }
  add('window-browses', !browse.length, browse.length ? browse.join('\n') : 'Back, Next, →, Page Down, the circles and ⌥1 browse; the stage stays; Esc comes back');
  // "Go to this beat on stage", every beat; the timer.
  const go = [], timer = [];
  if ((await win.evaluate(() => [window.presenter.running, Math.floor(window.presenter.elapsed)])).join() !== 'false,0') timer.push('not stopped at 0:00 on Start');
  for (let n = 1; n <= LAST; n++) {
    await win.click(`[data-goto="${n}"]`); await win.click('[data-pn="go-stage"]');
    const ok = await stage.waitForFunction(n => window.d1.presenter.beat === n && !window.d1.presenter.pending, n, { timeout: 15000 }).then(() => true, () => false);
    await idle();
    const at = await where();
    if (!ok) go.push(`${notes.names[n]}: the stage is on beat ${await stage.evaluate(() => window.d1.presenter.beat)}`);
    else if (landKey(n) && at !== landKey(n)) go.push(`${notes.names[n]}: the stage is on ${at}, the beat starts on ${landKey(n)}`);
    if (!(await synced(n))) go.push(`${notes.names[n]}: the window didn't follow`);
    else if ((await win.evaluate(() => window.presenter.index)) !== n) go.push(`${notes.names[n]}: the window shows another beat`);
    if (n === 1) {
      const t = await win.evaluate(() => [window.presenter.running, window.presenter.elapsed]);
      const want = B[1].start || 0;
      if (!t[0] || Math.abs(t[1] - want) > 3) timer.push(`at beat 1: running ${t[0]}, ${t[1].toFixed(1)} s (want ${want})`);
      await sleep(1200);
      const t2 = await win.evaluate(() => window.presenter.elapsed);
      if (!(t2 > t[1] + 0.8)) timer.push('doesn\'t run');
      await win.click('[data-pn="reset-timer"]');
      if (Math.abs((await win.evaluate(() => window.presenter.elapsed)) - want) > 0.5) timer.push('Reset doesn\'t go back to the beat\'s start');
    }
  }
  const tEnd = await win.evaluate(() => [window.presenter.running, window.presenter.elapsed]);
  if (tEnd[0]) timer.push('still running at End');
  add('window-goes', !go.length, go.length ? go.join('\n') : `"Go to this beat on stage" lands each of ${LAST} beats where it starts`);
  add('timer', !timer.length, timer.length ? timer.join('\n') : 'stopped on Start, runs from beat 1\'s script time, Reset, stops at End');
  // → on the stage over a beat that starts on the screen the stage is on.
  const steps = [];
  let tried = 0;
  for (let n = 0; n < LAST; n++) {
    if (!landKey(n) || landKey(n + 1) !== landKey(n)) continue;
    tried++;
    await win.click(`[data-goto="${n}"]`); await win.click('[data-pn="go-stage"]');
    await stage.waitForFunction(n => window.d1.presenter.beat === n && !window.d1.presenter.pending, n, { timeout: 15000 }).catch(() => {});
    await idle(); await synced(n);
    const before = await where();
    await stage.bringToFront(); await stage.keyboard.press('ArrowRight'); await idle();
    if (!(await synced(n + 1))) steps.push(`→ on ${notes.names[n]} didn't step the window to ${notes.names[n + 1]}`);
    if ((await where()) !== before) steps.push(`→ on ${notes.names[n]} moved the stage`);
    await stage.keyboard.press('ArrowLeft'); await idle();
    if (!(await synced(n))) steps.push(`← on ${notes.names[n + 1]} didn't step back`);
    await win.bringToFront();
  }
  add('steps', !steps.length, steps.length ? steps.join('\n') : tried ? `→ and ← step the window over ${tried} beat${tried > 1 ? 's' : ''} that start on the same screen` : 'no beats share a screen');
  add('errors', !errs.length, errs.length ? errs.slice(0, 10).join('\n') : 'no errors in the stage or the window');
} catch (e) {
  if (!items.some(i => i.status === 'fail')) add('notes-check', false, 'the check itself failed: ' + String(e && e.stack || e).slice(0, 600));
} finally {
  await browser.close(); srv.stop();
}
const fails = items.filter(i => i.status === 'fail');
mkdirSync(demo.out, { recursive: true });
writeFileSync(join(demo.out, 'notes-check.json'), JSON.stringify({ demo: demo.name, at: new Date().toISOString(), windows: AS_WIN, pass: !fails.length, items }, null, 1));
console.log(fails.length ? `notes check: ${fails.length} failing` : 'notes check: script, window and replica agree');
process.exit(fails.length ? 1 : 0);
