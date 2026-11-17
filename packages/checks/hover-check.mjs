// Hover check: every hover captured from the real pages (data/snaps/hovers-<app>.json) is hovered in the replica,
// on the screen it was captured from, and pictured next to the real one. Also counts, for every screen of the app,
// which hovers find their element there.
//   node checks/hover-check.mjs --demo <dir> [--url http://127.0.0.1:<port>/] [--only page] [--no-sheet]
// Writes .out/hovers/report.json and hover-sheet-NN.png (real vs replica).
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { comparePngs } from './compare.mjs';
import { loadDemo, readFlow, arg as argOf } from '../kit/lib/demo.mjs';

const demo = loadDemo(process.argv.slice(2));
const arg = (k, d) => argOf(process.argv.slice(2), k, d);
const URL0 = arg('--url', demo.url);
const ROOT = demo.dir + '/';
const OUTH = demo.out + '/hovers/';
const RAWH = demo.raw + '/hovers/';
const SHEET = OUTH + 'hover-sheet.png';
const ROWS = OUTH + 'rows/';
rmSync(ROWS, { recursive: true, force: true }); mkdirSync(ROWS, { recursive: true });
const ONLY = arg('--only', null);
const APPS = (arg('--apps', '') || '').split(',').filter(Boolean);
// --speed: the replica's clock runs faster (hover delays too), so each hover is waited for that much less.
const SPEED = +arg('--speed', 1);
const flow = readFlow(demo);
const stateOf = snap => (Object.entries(flow.states).find(([, s]) => s.snap === snap) || [snap])[0];
const VPW = demo.cfg.viewport.width, VPH = demo.cfg.viewport.height;

const b = await chromium.launch({ channel: process.env.REPLICA_CHROME_CHANNEL || 'chrome', headless: true });
const ctx = await b.newContext({ viewport: { width: VPW, height: VPH }, deviceScaleFactor: demo.cfg.viewport.dpr });
const p = await ctx.newPage();
const msgs = []; p.on('console', m => msgs.push(m.text())); p.on('pageerror', e => msgs.push('ERR ' + e.message));
await p.goto(SPEED > 1 ? URL0 + (URL0.includes('?') ? '&' : '?') + 'speed=' + SPEED : URL0); await p.waitForFunction(() => window.d1 && window.d1.state.active);
const cmp = await ctx.newPage();
const rows = []; const report = { pages: {}, failed: [] };

for (const hp of flow.hoverPages) {
  if (APPS.length && !APPS.includes(hp.app)) continue;
  if (ONLY && hp.page !== ONLY) continue;
  const hf = `${ROOT}data/snaps/hovers-${hp.app}.json`;
  if (!existsSync(hf)) { report.failed.push({ id: hp.page, text: 'no hover data: run scenecast build' }); continue; }
  const data = JSON.parse(readFileSync(hf, 'utf8'));
  const defs = data.defs.filter(d => d.page === hp.page);
  if (!defs.length) continue;
  const st = stateOf(hp.base);
  const r = report.pages[hp.page] = { defs: defs.length, shown: 0, missing: [] };
  for (const [k, d] of defs.entries()) {
    if (k % 20 === 0) { await p.evaluate(([a, s]) => window.d1.go(a, s), [hp.app, st]); await p.waitForTimeout(500); }
    // The anchor's place in the replica, scrolled into view the way she would.
    const loc = await p.evaluate(([d, app]) => {
      const doc = window.d1.doc(app);
      const docs = [doc, ...[...doc.querySelectorAll('iframe')].map(f => { try { return f.contentDocument; } catch (e) { return null; } }).filter(Boolean)];
      const fdoc = d.frame ? docs.find(x => x.defaultView.frameElement && x.defaultView.frameElement.getAttribute('data-d1-frame') === d.frame) : doc;
      if (!fdoc) return null;
      const norm = s => (s || '').replace(/\s+/g, ' ').trim();
      // Anchors found by size: go to the named target (bySize) or to where the element was on the real page (loose).
      const named = d.bySize ? d.bySize.target : null;
      const spots = named ? [named] : d.loose ? [{ at: d.anchorRect }] : d.anchors;
      for (const a of spots) {
        if (a.at) {
          const e0 = fdoc.elementFromPoint(a.at.x + a.at.w / 2, a.at.y + a.at.h / 2);
          if (!e0) continue;
          const rr = e0.getBoundingClientRect(); let x = rr.x, y = rr.y; let w = fdoc.defaultView;
          while (w.frameElement) { const fr = w.frameElement.getBoundingClientRect(); x += fr.x; y += fr.y; w = w.parent; }
          return { x: x + (a.at.x - rr.x), y: y + (a.at.y - rr.y), w: a.at.w, h: a.at.h, ax: d.anchorRect.x, ay: d.anchorRect.y };
        }
        let el = [...fdoc.querySelectorAll(a.sel)].find(e => (!a.in || e.closest(a.in)) && (a.text === undefined || norm(e.innerText) === a.text) && (a.textStarts === undefined || norm(e.innerText).startsWith(a.textStarts)) && e.getBoundingClientRect().width > 0);
        if (!el) continue;
        let tgt = el;
        if (d.scope && d.scope.length && !named) { const ek = e => [...e.children].filter(c => !/^(script|noscript|template|base)$/.test(c.localName)); tgt = d.scope.reduce((e, i) => e && ek(e)[i], el); if (!tgt) continue; }
        // A portal's trigger inside the anchor is what the pointer goes to.
        const trig = (d.portals || [])[0] && d.portals[0].trigger;
        if (trig && !(trig.sel && tgt.matches(trig.sel))) { const t2 = [...tgt.querySelectorAll(trig.sel || '*')].find(e => (trig.text === undefined || norm(e.innerText) === trig.text)); if (t2) tgt = t2; }
        el = tgt;
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const rr = el.getBoundingClientRect();
        let x = rr.x, y = rr.y; let w = fdoc.defaultView;
        while (w.frameElement) { const fr = w.frameElement.getBoundingClientRect(); x += fr.x; y += fr.y; w = w.parent; }
        return { x, y, w: rr.width, h: rr.height, ax: d.anchorRect ? d.anchorRect.x : null, ay: d.anchorRect ? d.anchorRect.y : null };
      }
      return null;
    }, [d, hp.app]);
    if (!loc) { r.missing.push(d.id + ' ' + JSON.stringify(d.anchors[0]).slice(0, 120)); continue; }
    const cx = loc.x + Math.min(loc.w / 2, 40), cy = loc.y + loc.h / 2;
    // On the fast clock a hover delay is a few ms: a path over a neighbour opens its card on the way, so go straight there.
    if (SPEED > 1) { await p.mouse.move(cx, cy); await p.mouse.move(cx + 1, cy); } else { await p.mouse.move(cx - 30, cy - 30); await p.mouse.move(cx, cy, { steps: 3 }); }
    await p.waitForTimeout((d.delay || 0) / SPEED + (SPEED > 1 ? 200 : 450));
    const on = await p.evaluate(app => window.d1.hovers(app), hp.app);
    const shown = on.some(h => h.id === d.id);
    if (shown) r.shown++; else { const why = await p.evaluate(([x, y, app]) => window.d1.hoverAt(x, y, app), [cx, cy, hp.app]); report.failed.push({ id: d.id, text: ((d.portals || [])[0] || {}).text || JSON.stringify(d.anchors[0]).slice(0, 90), at: why }); }
    // Same picture area as the real one, moved by however far the element sits from where it was.
    const real = `${RAWH}${d.shot}`;
    if (d.shot && existsSync(real)) {
      const meta = JSON.parse(readFileSync(real.replace(/\.png$/, '.json'), 'utf8'));
      const c = meta.res.shotClip;
      const off = meta.frameOff || { x: 0, y: 0 };
      const dx = loc.ax !== null ? loc.x - (loc.ax + off.x) : 0, dy = loc.ay !== null ? loc.y - (loc.ay + off.y) : 0;
      const clip = { x: Math.max(0, c.x + off.x + dx), y: Math.max(0, c.y + off.y + dy), width: Math.min(c.w, VPW), height: Math.min(c.h, VPH) };
      clip.x = Math.min(clip.x, VPW - 20); clip.y = Math.min(clip.y, VPH - 20);
      clip.width = Math.max(8, Math.min(clip.width, VPW - clip.x)); clip.height = Math.max(8, Math.min(clip.height, VPH - clip.y));
      const png = await p.screenshot({ clip });
      let pct = null;
      try { const [res] = await comparePngs(cmp, [[readFileSync(real).toString('base64'), png.toString('base64')]]); pct = res.pct; } catch (e) {}
      writeFileSync(ROWS + d.id + '-rep.png', png);
      rows.push({ page: hp.page, id: d.id, text: (d.portals || []).map(q => q.text).join(' / ').slice(0, 90) || (d.ops || []).map(o => o.kind + (o.set ? ':' + Object.keys(o.set).join(',') : '')).join(' ').slice(0, 90), real, rep: ROWS + d.id + '-rep.png', shown, pct });
    }
    await p.mouse.move(VPW - 1, VPH / 2, { steps: 2 }); await p.waitForTimeout(250);
  }
}

// Coverage: on each screen of the app, how many hovers find their element.
report.coverage = {};
for (const [st, s] of Object.entries(flow.states)) {
  const app = s.app; if (!app) continue;
  if (!existsSync(`${ROOT}data/snaps/hovers-${app}.json`)) continue;
  const data = JSON.parse(readFileSync(`${ROOT}data/snaps/hovers-${app}.json`, 'utf8'));
  if (!data.defs.length) continue;
  await p.evaluate(([a, s]) => window.d1.go(a, s), [app, st]); await p.waitForTimeout(300);
  report.coverage[st] = await p.evaluate(([defs, app]) => {
    const doc = window.d1.doc(app);
    const docs = [doc, ...[...doc.querySelectorAll('iframe')].map(f => { try { return f.contentDocument; } catch (e) { return null; } }).filter(Boolean)];
    const norm = s => (s || '').replace(/\s+/g, ' ').trim();
    let n = 0;
    for (const d of defs) {
      const fdoc = d.frame ? docs.find(x => x.defaultView.frameElement && x.defaultView.frameElement.getAttribute('data-d1-frame') === d.frame) : doc;
      if (fdoc && d.anchors.some(a => [...fdoc.querySelectorAll(a.sel)].some(e => (!a.in || e.closest(a.in)) && (a.text === undefined || norm(e.innerText) === a.text) && (a.textStarts === undefined || norm(e.innerText).startsWith(a.textStarts))))) n++;
    }
    return n;
  }, [data.defs, app]);
}
report.errors = await p.evaluate(() => window.d1.errors);
report.console = msgs;

// The sheet: real (left) and replica (right) for each hover, 24 per page, pictures at most 760 px wide.
if (rows.length && !process.argv.includes('--no-sheet')) {
  const cell = (f, label) => `<div style="flex:1;min-width:0"><div style="font:12px -apple-system;color:#555;margin:2px 0">${label}</div><img src="file://${f}" style="max-width:100%;max-height:300px;border:1px solid #ddd;display:block"></div>`;
  report.sheets = [];
  const sp = await (await b.newContext({ viewport: { width: 1640, height: 1000 }, deviceScaleFactor: 1 })).newPage();
  for (let i = 0; i < rows.length; i += 24) {
    const part = rows.slice(i, i + 24);
    const html = `<html><body style="margin:0;padding:16px;width:1600px;font-family:-apple-system,sans-serif;background:#fff"><div style="font:700 24px -apple-system">${demo.cfg.title || demo.name} replica · hovers ${i + 1}–${i + part.length} of ${rows.length}: real (left) vs replica (right)</div>` +
      part.map(r => `<div style="border-top:1px solid #ccc;margin-top:8px;padding-top:4px"><div style="font:600 13px -apple-system">${r.page} · ${r.id} · ${r.text.replace(/</g, '&lt;')} ${r.shown ? '' : '<span style="color:#c00">NOT SHOWN</span>'} ${r.pct !== null ? `· ${r.pct}% px` : ''}</div><div style="display:flex;gap:16px">${cell(r.real, 'real')}${cell(r.rep, 'replica')}</div></div>`).join('') + '</body></html>';
    const f = ROWS + `sheet-${i / 24 + 1}.html`; writeFileSync(f, html);
    await sp.goto('file://' + f); await sp.waitForTimeout(400);
    const out = SHEET.replace(/\.png$/, `-${String(i / 24 + 1).padStart(2, '0')}.png`);
    writeFileSync(out, await sp.screenshot({ fullPage: true }));
    report.sheets.push(out);
  }
}
report.rows = rows.map(r => ({ id: r.id, shown: r.shown, pct: r.pct, text: r.text }));
report.total = Object.values(report.pages).reduce((n, p) => n + p.defs, 0);
report.shown = Object.values(report.pages).reduce((n, p) => n + p.shown, 0);
writeFileSync(OUTH + 'report.json', JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
await b.close();
