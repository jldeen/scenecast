// Runs the recorded path (flow.path) through the replica in headless Chrome at the demo's viewport, screenshots
// every settled screen, and checks that two runs in a row are identical, that each step lands on the state the
// recording did, and that nothing errors, logs to the console or asks the network for anything.
//   node checks/check.mjs --demo <dir> [--runs 2] [--zoom 150] [--speed 10] [--url http://127.0.0.1:<port>/] [--out dir]
// The runs go at the same time, each in its own browser context, on a clock --speed times faster (the replica's
// ?speed=; every screen is the same as at speed 1). --speed 1 runs at the real pace. The replica server must be running.
import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { comparePngs } from './compare.mjs';
import { loadDemo, bundleFlow, arg } from '../kit/lib/demo.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const demo = loadDemo(args);
const RUNS = +arg(args, '--runs', 2);
const ZOOM = +arg(args, '--zoom', 100) / 100;
const OUT = arg(args, '--out', join(demo.out, ZOOM === 1 ? 'check' : `check-z${Math.round(ZOOM * 100)}`));
const SPEED = +arg(args, '--speed', 10);
const URL0 = arg(args, '--url', demo.url);
const fileBase = new globalThis.URL(URL0).protocol === 'file:' ? new globalThis.URL('.', URL0).href : null;
const URL = (u => { u.searchParams.set('speed', String(SPEED)); return u.href; })(new globalThis.URL(URL0));
const VP = demo.cfg.viewport;
const flow = await bundleFlow(URL0);
const runPath = new Function(readFileSync(join(here, 'path.js'), 'utf8') + '\nreturn runPath;')();
const FINGERPRINT = readFileSync(join(here, 'fingerprint.js'), 'utf8').replace(/^\/\/.*\n/gm, '');
const browser = await chromium.launch({ channel: process.env.REPLICA_CHROME_CHANNEL || 'chrome', headless: true });
async function oneRun(n) {
  const dir = join(OUT, `run${n}`); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  // --zoom 150 runs at the CSS viewport Chrome gives at that zoom on the same display.
  const ctx = await browser.newContext({ viewport: { width: Math.round(VP.width / ZOOM), height: Math.round(VP.height / ZOOM) }, deviceScaleFactor: VP.dpr * ZOOM });
  const page = await ctx.newPage();
  const noise = [];
  page.on('console', m => noise.push(m.type() + ': ' + m.text().slice(0, 200)));
  page.on('pageerror', e => noise.push('pageerror: ' + e.message.slice(0, 200)));
  page.on('requestfailed', r => noise.push('failed: ' + r.url().slice(0, 120)));
  page.on('response', r => { if (r.status() >= 400) noise.push(r.status() + ' ' + r.url().slice(0, 120)); });
  page.on('request', r => { if (!/^(http:\/\/127\.0\.0\.1|data:|blob:|about:)/.test(r.url()) && !(fileBase && r.url().startsWith(fileBase))) noise.push('offsite request: ' + r.url().slice(0, 120)); });
  const shots = {}; const timings = {};
  let k = 0; const t0 = Date.now(); let last = t0;
  await page.goto(URL);
  let res = { mismatches: [] };
  try {
    res = await runPath(page, flow, {
      speed: SPEED,
      checkpoint: async name => {
        const dom = await page.evaluate(`(${FINGERPRINT})()`);
        const png = await page.screenshot({ animations: 'disabled', caret: 'hide' });
        const file = `${String(++k).padStart(2, '0')}-${name.replace(/[^\w@.-]+/g, '_')}.png`;
        writeFileSync(join(dir, file), png);
        shots[name] = { file, dom, sha: createHash('sha256').update(png).digest('hex').slice(0, 16) };
        timings[name] = Date.now() - last; last = Date.now();
      },
    });
  } catch (e) { res.mismatches.push('path stopped: ' + String(e.message || e).slice(0, 300)); }
  const errors = await page.evaluate(() => window.d1 ? window.d1.errors : ['no replica on the page']).catch(e => [String(e)]);
  await ctx.close();
  return { run: n, ms: Date.now() - t0, shots, timings, errors, noise: [...new Set(noise)], mismatches: res.mismatches };
}
const T0 = Date.now();
const runs = await Promise.all(Array.from({ length: RUNS }, (_, i) => oneRun(i + 1)));
// Identical means the same DOM in every app and frame, and screenshots within 0.01% of each other's pixels
// (GPU anti-aliasing and overlay scrollbars can move a few pixels between runs of the same page).
const names = Object.keys(runs[0].shots);
const differ = [], pixel = {};
if (RUNS > 1) {
  const cp = await browser.newPage();
  for (const nm of names) for (const r of runs.slice(1)) {
    const a = runs[0].shots[nm], b = r.shots[nm];
    if (!b || a.dom !== b.dom) { differ.push(nm + ' (DOM)'); continue; }
    if (a.sha === b.sha) continue;
    const [d] = await comparePngs(cp, [[readFileSync(join(OUT, 'run1', a.file)).toString('base64'), readFileSync(join(OUT, `run${r.run}`, b.file)).toString('base64')]]);
    pixel[nm] = d;
    if (d.pct >= 0.01) differ.push(nm + ` (${d.pct}% pixels)`);
  }
}
await browser.close();
const streamed = Object.values(flow.streams || {}).map(s => s.to);
const report = {
  demo: demo.name, url: URL, zoom: Math.round(ZOOM * 100), speed: SPEED, secs: Math.round((Date.now() - T0) / 1000),
  runs: runs.map(r => ({ run: r.run, secs: Math.round(r.ms / 1000), screens: Object.keys(r.shots).length, errors: r.errors, noise: r.noise, mismatches: r.mismatches })),
  steps: (flow.path || []).filter(s => s.checkpoint).length,
  identical: RUNS > 1 ? differ.length === 0 : null, differ, pixelNoise: pixel,
  sameDom: RUNS > 1 ? names.filter(nm => runs.every(r => r.shots[nm] && r.shots[nm].dom === runs[0].shots[nm].dom)).length + '/' + names.length : null,
  streamTimes: Object.fromEntries(names.filter(n => streamed.includes(n.split('@')[0])).map(n => [n, runs.map(r => r.timings[n])])),
};
report.pass = report.runs.every(r => !r.errors.length && !r.noise.length && !r.mismatches.length && r.screens === report.steps) && (RUNS < 2 || report.identical);
writeFileSync(join(OUT, "report.json"), JSON.stringify({ ...report, shots: runs.map(r => r.shots), timings: runs.map(r => r.timings) }, null, 1));
console.log(JSON.stringify(report, null, 1));
process.exit(report.pass ? 0 : 1);
