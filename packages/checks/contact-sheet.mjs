// Contact sheet: every replica screen (run 1 of checks/check.mjs) next to the real capture of the same state, at the
// demo's full pixel size. Writes pairs/NN-name.png, index.html, summary.json and an overview contact-sheet.png.
//   node checks/contact-sheet.mjs --demo <dir> [--run <check run dir>] [--out <dir>]
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { comparePngs } from './compare.mjs';
import { loadDemo, readFlow, arg } from '@stuntdouble/core/lib/demo.mjs';

const args = process.argv.slice(2);
const demo = loadDemo(args);
const flow = readFlow(demo);
const RUN = arg(args, '--run', join(demo.out, 'check', 'run1'));
const OUT = arg(args, '--out', join(demo.out, 'contact-sheet'));
const SHOTS = join(demo.raw, 'shots');
if (!existsSync(RUN)) { console.log(`no replica screens in ${RUN}: run "scenecast check" first`); process.exit(1); }
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'pairs'), { recursive: true });
const rec = existsSync(join(demo.dir, 'recording.json')) ? JSON.parse(readFileSync(join(demo.dir, 'recording.json'), 'utf8')) : {};
const when = rec.recordedAt ? new Date(rec.recordedAt).toISOString().slice(0, 10) : 'recorded';
const shots = readdirSync(RUN).filter(f => f.endsWith('.png')).sort();
const b64 = f => readFileSync(f).toString('base64');
const W = demo.cfg.viewport.width * demo.cfg.viewport.dpr, Hh = demo.cfg.viewport.height * demo.cfg.viewport.dpr;
const browser = await chromium.launch({ channel: process.env.REPLICA_CHROME_CHANNEL || 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: W * 2 + 8, height: Hh + 140 }, deviceScaleFactor: 1 })).newPage();
const rows = [];
for (const f of shots) {
  const name = f.replace(/^\d+-/, '').replace(/\.png$/, '');
  const state = name.split('@')[0];
  const real = (flow.states[state] && flow.states[state].snap) || state;
  const realFile = join(SHOTS, real + '.png');
  if (!existsSync(realFile)) { console.log('no real capture for', name); continue; }
  const realB64 = b64(realFile), repB64 = b64(join(RUN, f));
  const [d] = await comparePngs(page, [[realB64, repB64]]);
  const fs = Math.round(Hh / 50);
  await page.setContent(`<html><body style="margin:0;background:#fff;font:600 ${fs}px -apple-system,Segoe UI,sans-serif;color:#1b1b1b">
    <div style="display:flex;height:140px;align-items:center"><div style="width:${W}px;padding-left:40px;box-sizing:border-box">Real · ${when} · ${real}</div><div style="width:${W}px;padding-left:40px;box-sizing:border-box;border-left:8px solid #fff">Replica · ${f.slice(0, 2)} · ${name} · ${d.pct}% of pixels differ</div></div>
    <div style="display:flex"><img src="data:image/png;base64,${realB64}" style="width:${W}px;height:${Hh}px;display:block"><img src="data:image/png;base64,${repB64}" style="width:${W}px;height:${Hh}px;display:block;border-left:8px solid #fff"></div></body></html>`);
  await page.waitForTimeout(150);
  const out = `pairs/${f}`;
  writeFileSync(join(OUT, out), await page.screenshot({ clip: { x: 0, y: 0, width: W * 2 + 8, height: Hh + 140 } }));
  rows.push({ n: f.slice(0, 2), name, real, pct: d.pct, box: d.box, file: out });
  console.log(`${f.slice(0, 2)} ${name.padEnd(36)} ${d.pct}%`);
}
// Overview: three pairs per row.
const cells = rows.map(r => `<div style="width:1272px;padding:6px"><div style="font:600 18px -apple-system,sans-serif;margin:4px 2px 6px">${r.n} · ${r.name} <span style="font-weight:400;color:#666">· real (left) vs replica (right) · ${r.pct}% differ</span></div><img src="${pathToFileURL(join(OUT, r.file)).href}" style="width:1272px;display:block;border:1px solid #ddd"></div>`).join('');
writeFileSync(join(OUT, 'overview.html'), `<html><body style="margin:0;background:#fff;width:3840px"><div style="font:700 34px -apple-system,sans-serif;padding:24px 12px 8px">${demo.cfg.title || demo.name} replica · real capture vs replica, every screen</div><div style="display:flex;flex-wrap:wrap;padding:0 3px">${cells}</div></body></html>`);
const ov = await (await browser.newContext({ viewport: { width: 3840, height: 1000 }, deviceScaleFactor: 1 })).newPage();
await ov.goto(pathToFileURL(join(OUT, 'overview.html')).href);
await ov.waitForTimeout(500);
writeFileSync(join(OUT, 'contact-sheet.png'), await ov.screenshot({ fullPage: true }));
writeFileSync(join(OUT, 'index.html'), `<!doctype html><meta charset="utf-8"><title>${demo.name} · contact sheet</title><body style="font:16px -apple-system,sans-serif;margin:24px;background:#fff"><h1>${demo.cfg.title || demo.name} · real vs replica</h1><p>Left: the real page as recorded. Right: the replica at the same step of the recorded path.</p>${rows.map(r => `<h3>${r.n} · ${r.name} <small style="font-weight:400">(${r.pct}% of pixels differ)</small></h3><a href="${r.file}"><img src="${r.file}" style="width:100%;max-width:1600px;border:1px solid #ccc"></a>`).join('')}</body>`);
writeFileSync(join(OUT, 'summary.json'), JSON.stringify(rows, null, 1));
await browser.close();
console.log(`${rows.length} pairs → ${join(OUT, 'contact-sheet.png')}`);
