// scenecast script: the presenter's script to focus points.
//   1. The script, as lines (parse.mjs).
//   2. Every screen of the run-through indexed in the replica (focus-target.js items(): text, roles, boxes).
//   3. The matcher (match.mjs; pluggable) puts each line on the screen it plays over and picks what backs it.
//   4. Each pick becomes a focus point, its target worked out and checked in the replica (the same code the editor's
//      dots use), and played once with the focus engine to see where it lands (zoom, mark).
//   5. focus.json (the script's points; dots and edited points are kept), the line-to-screen sheet (HTML and PDF), the
//      presenter cue sheet (Markdown and HTML) and script.json, in .out/script/.
// Progress: one `@script {json}` line per step on stdout (the scenecast binary and the desktop app read them).
import { at as __at } from '@stuntdouble/core/lib/at.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, basename, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { parseScript } from './parse.mjs';
import { loadMatcher } from './match.mjs';
import { writeSheet, cueSheet } from './sheet.mjs';
import { bundleFlow } from '@stuntdouble/core/lib/demo.mjs';
import { readFocusJson, writeJsonAtomic, FOCUS_JSON } from '@stuntdouble/core/lib/overrides.mjs';
import { stateSequence, beatPositions, beatAt, orderFocus } from '@stuntdouble/player/app/focus-order.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32).replace(/^-+|-+$/g, '') || 'point';
const freePort = () => new Promise(res => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

export async function startServer(dir) {
  const port = await freePort();
  const p = spawn(process.execPath, [__at('player', 'serve.mjs'), '--demo', dir, '--port', String(port)], { stdio: 'ignore', env: { ...process.env, REPLICA_NO_OPEN: '1' } });
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(url + '__replica/status')).ok) return { url, stop: () => p.kill() }; } catch (e) {} await sleep(100); }
  p.kill();
  throw new Error('the replica server did not start');
}

// In the replica page: go to a screen and wait for it to settle, with the pointer out of the way.
async function goTo(page, app, state) {
  await page.evaluate(([a, s]) => window.d1.go(a, s), [app, state]);
  await page.evaluate(() => window.d1.idle());
  await page.mouse.move(2, 2);
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
}

export async function runScript({ demo, file, url = null, matcher: matcherSpec, write = true, pdf = true, channel, out, on = () => {} }) {
  const t0 = Date.now();
  const emit = (event, data = {}) => on({ event, ...data });
  // The script's name as the demo keeps it: relative inside the demo folder, else just its name.
  const scriptName = (r => r.startsWith('..') || /^[a-z]:/i.test(r) ? basename(file) : r.split('\\').join('/'))(relative(demo.dir, file));
  const text = readFileSync(file, 'utf8');
  const script = parseScript(text, basename(file));
  if (!script.lines.length) throw new Error(`${file}: no lines found (plain text lines, or Markdown > quotes)`);
  emit('parsed', { lines: script.lines.length, beats: script.beats.length, title: script.title });
  const matcher = await loadMatcher(matcherSpec || (demo.cfg.script && demo.cfg.script.matcher) || 'text', demo.dir);
  out = out || join(demo.out, 'script');
  rmSync(join(out, 'shots'), { recursive: true, force: true });
  mkdirSync(join(out, 'shots'), { recursive: true });
  const server = url ? null : await startServer(demo.dir);
  url = url || server.url;
  let browser;
  try {
    const flow = await bundleFlow(url);
    const seq = stateSequence(flow), beatsAt = beatPositions(flow, seq);
    const vp = demo.cfg.viewport || { width: 1920, height: 1080 };
    browser = await chromium.launch({ channel: channel || process.env.REPLICA_CHROME_CHANNEL || 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(url + '?speed=4');
    await page.waitForFunction(() => window.d1 && window.d1.state.active, null, { timeout: 60000 });
    if (!(await page.evaluate(() => !!(window.d1.focus && window.d1.focus.locatePoint)))) throw new Error(`${url} has no focus engine: serve the demo for authoring (not --release, not an export)`);
    const W = vp.width, H = vp.height;

    // 2 · The screens.
    const screens = {};
    const states = [...new Set(seq.map(x => x.state))];
    for (const [i, st] of states.entries()) {
      const app = flow.states[st].app;
      await goTo(page, app, st);
      const items = await page.evaluate(async app => (await import('/app/focus-target.js')).items(window.d1.doc(app)).items, app);
      screens[st] = { state: st, app, title: flow.states[st].title || st, items };
      emit('indexed', { state: st, items: items.length, n: i + 1, of: states.length });
    }

    // 3 · Lines to screens.
    const results = await matcher.match({ lines: script.lines, screens, sequence: seq, flow });
    if (!Array.isArray(results) || results.length !== script.lines.length) throw new Error(`matcher ${matcher.name}: one result per line expected`);

    // 4 · Focus points, checked in the replica.
    const points = [], ids = new Set(readFocusJson(demo.dir).points.filter(p => p.source !== 'script').map(p => p.id));
    const lines = [];
    for (const [i, line] of script.lines.entries()) {
      const r = results[i], at = seq[r.pos], st = at.state, app = at.app;
      await goTo(page, app, st);
      const found = await page.evaluate(async ({ app, picks, W, H }) => {
        const m = await import('/app/focus-target.js');
        const root = window.d1.doc(app), { items, els } = m.items(root);
        const locate = t => window.d1.focus.locatePoint(t);
        const out = [];
        // The first pick in view (the focus engine scrolls the same way when it plays).
        const first = picks.length && els[picks[0].item];
        if (first) { const b = first.getBoundingClientRect(); if (b.top < 0 || b.bottom > innerHeight) { first.scrollIntoView({ block: 'center' }); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); } }
        for (const p of picks) {
          const el = els[p.item];
          const d = el && m.describe(el, { root, phrase: p.phrase || null, locate, W, H });
          out.push(d ? { ...d, item: items[p.item], pick: out.length } : { error: el ? 'no target the focus engine finds on it' : 'not on the screen', pick: out.length });
        }
        // Picks in the same list (chips, rows, tabs) are one point: the box around them.
        const listOf = k => { const el = els[picks[k].item]; return el && el.parentElement && el.parentElement.closest('ul,ol,[role=list],[role=grid],[role=listbox],[role=tablist],table'); };
        const merged = [], used = new Set();
        out.forEach((d, k) => {
          if (used.has(k)) return;
          used.add(k);
          const c = !d.error && listOf(k);
          const group = (c ? [k, ...out.map((x, j) => j).filter(j => !used.has(j) && !out[j].error && listOf(j) === c)] : [k]).sort((a, b) => picks[a].item - picks[b].item);
          if (group.length < 2) return merged.push(d);
          const t = { union: group.flatMap(j => out[j].target.find ? [out[j].target.find] : out[j].target.union) }, got = locate(t);
          if (!got) return merged.push(d);
          group.forEach(j => used.add(j));
          merged.push({ target: t, mark: 'rect', role: 'list', box: got.box, text: group.map(j => out[j].text).join(', '), item: d.item, pick: k });
        });
        return merged;
      }, { app, picks: r.picks, W, H });
      const pts = [];
      found.forEach(d => {
        if (d.error) return;
        let id = `l${line.id.replace(/\./g, '-')}-${slug(d.text)}`, n = 2;
        while (ids.has(id)) id = `l${line.id.replace(/\./g, '-')}-${slug(d.text)}-${n++}`;
        ids.add(id);
        pts.push({ id, beat: beatAt(r.pos, beatsAt), app, states: [st], ...(d.target.find ? { find: d.target.find } : { union: d.target.union }), mark: d.mark, ...(d.dir ? { dir: d.dir } : {}), line: line.id, label: d.text.slice(0, 80), source: 'script', score: r.picks[d.pick].score });
      });
      points.push(...pts);
      // The screen with what backs the line highlighted, numbered in focus order.
      await page.evaluate(({ boxes }) => {
        for (const [n, b] of boxes.entries()) {
          const e = document.createElement('div'); e.className = 'sc-hl';
          Object.assign(e.style, { position: 'fixed', left: b[0] - 4 + 'px', top: b[1] - 3 + 'px', width: b[2] - b[0] + 8 + 'px', height: b[3] - b[1] + 6 + 'px', background: 'rgba(255, 214, 0, .30)', outline: '3px solid #ff8a00', borderRadius: '4px', zIndex: 2147483647, pointerEvents: 'none' });
          const t = document.createElement('div'); t.className = 'sc-hl'; t.textContent = String(n + 1);
          Object.assign(t.style, { position: 'fixed', left: b[0] - 16 + 'px', top: b[1] - 16 + 'px', width: '24px', height: '24px', borderRadius: '50%', background: '#ff8a00', color: '#fff', font: '700 14px/24px sans-serif', textAlign: 'center', zIndex: 2147483647, pointerEvents: 'none' });
          document.body.append(e, t);
        }
      }, { boxes: found.filter(d => !d.error).map(d => d.box) });
      const shot = `shots/line-${line.id.replace(/\./g, '-')}.png`;
      writeFileSync(join(out, shot), await page.screenshot());
      await page.evaluate(() => document.querySelectorAll('.sc-hl').forEach(e => e.remove()));
      const status = !pts.length ? 'unbacked' : r.missing.length || found.some(d => d.error) ? 'partial' : 'backed';
      lines.push({ ...line, state: st, app, pos: r.pos, beatKey: beatAt(r.pos, beatsAt), status, score: r.score, missing: r.missing, problems: found.filter(d => d.error).map(d => d.error), points: pts.map(p => p.id), backing: found.filter(d => !d.error).map(d => d.text), shot });
      emit('matched', { line: line.id, state: st, status, points: pts.length, missing: r.missing });
    }

    // Where each point lands, played the way ⌥F plays it.
    const ordered = orderFocus(points, flow);
    await page.evaluate(list => window.d1.focus.setPoints(list), ordered);
    const landing = {};
    for (const p of ordered) {
      await goTo(page, p.app, p.states[0]);
      await page.evaluate(id => { window.d1.focus.at(id); return window.d1.focus.next(); }, p.id);
      await page.waitForFunction(() => !window.d1.focus.state().run, null, { timeout: 20000 }).catch(() => {});
      const s = await page.evaluate(() => window.d1.focus.state());
      const ok = s.id === p.id && s.z === 2 && s.last && s.last.id === p.id;
      landing[p.id] = ok ? { Z: s.last.Z, kind: s.last.kind, box: s.last.box, on: s.last.on, edge: s.last.edge, shot: `shots/focus-${p.id}.png` } : { error: 'did not land' };
      if (ok) writeFileSync(join(out, landing[p.id].shot), await page.screenshot());
      await page.evaluate(() => window.d1.focus.clear());
      emit('landed', { id: p.id, ok, Z: ok ? s.last.Z : null });
    }
    for (const l of lines) if (l.points.some(id => landing[id].error)) { l.status = 'partial'; l.problems.push('a focus point did not land'); }

    // 5 · Files.
    const kept = readFocusJson(demo.dir).points.filter(p => p.source !== 'script');
    const fresh = ordered.map(({ score, ...p }) => p);
    const all = orderFocus([...fresh, ...kept], flow);
    if (write) writeJsonAtomic(join(demo.dir, FOCUS_JSON), { version: 1, script: scriptName, points: all });
    const report = {
      at: new Date().toISOString(), script: scriptName, title: script.title, matcher: matcher.name,
      beats: script.beats, lines, points: fresh.map(p => ({ ...p, landing: landing[p.id] })), kept: kept.map(p => p.id),
      summary: { lines: lines.length, backed: lines.filter(l => l.status === 'backed').length, partial: lines.filter(l => l.status === 'partial').length, unbacked: lines.filter(l => l.status === 'unbacked').length, points: fresh.length },
      errors, secs: Math.round((Date.now() - t0) / 100) / 10,
    };
    writeFileSync(join(out, 'script.json'), JSON.stringify(report, null, 1) + '\n');
    const cues = cueSheet(report, flow, seq, beatsAt);
    writeFileSync(join(out, 'cues.md'), cues.md);
    writeFileSync(join(out, 'cues.html'), cues.html);
    const sheet = await writeSheet(report, { out, flow, browser, pdf, title: demo.cfg.title || demo.name });
    emit('done', { ...report.summary, sheet: join(out, 'sheet.html'), pdf: sheet.pdf, cues: join(out, 'cues.md'), focus: write ? join(demo.dir, FOCUS_JSON) : null, secs: report.secs });
    return { report, out, sheet: join(out, 'sheet.html'), pdf: sheet.pdf, cues: join(out, 'cues.md') };
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.stop();
  }
}
