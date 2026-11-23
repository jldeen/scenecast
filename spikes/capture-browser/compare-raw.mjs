// Spike (stage C): two recordings of the fixture, compared as the build reads them: the screens and side states
// recorded, the path, the streams, each capture's markup (byte for byte, then how far apart), hover parts, and the
// screenshots (pixels). A third raw folder of the same recorder gives the run-to-run noise to judge against.
//   node spikes/capture-browser/compare-raw.mjs <rawA> <rawB> [--out file.json]
import { readFileSync, readdirSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { comparePngs } from '../../packages/checks/compare.mjs';

const [A, B] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const outI = process.argv.indexOf('--out');
const J = (d, f) => JSON.parse(readFileSync(join(d, f), 'utf8'));
const ls = (d, sub) => existsSync(join(d, sub)) ? readdirSync(join(d, sub)).sort() : [];
const recA = J(A, 'recording.json'), recB = J(B, 'recording.json');
const r = {};
// The recording: its states, path, beats, streams, side states.
const keysOf = o => Object.keys(o || {}).sort();
r.states = { a: keysOf(recA.states).length, b: keysOf(recB.states).length, same: JSON.stringify(keysOf(recA.states)) === JSON.stringify(keysOf(recB.states)) };
const pathOf = rec => (rec.path || []).map(s => [s.app, s.checkpoint, s.kind || s.action || ''].join(':'));
r.path = { a: recA.path.length, b: recB.path.length, same: JSON.stringify(pathOf(recA)) === JSON.stringify(pathOf(recB)) };
r.beats = { same: JSON.stringify(recA.beats) === JSON.stringify(recB.beats) };
r.streams = Object.fromEntries(keysOf(recA.streams).map(k => [k, { framesA: (recA.streams[k].frames || []).length, framesB: ((recB.streams || {})[k] || { frames: [] }).frames.length }]));
r.autos = { a: (recA.autos || []).map(x => String(x).split(' ')[0]), b: (recB.autos || []).map(x => String(x).split(' ')[0]) };
r.autos.same = JSON.stringify(r.autos.a) === JSON.stringify(r.autos.b);
r.viewport = { a: recA.viewport, b: recB.viewport };
// Each capture's markup.
const norm = h => String(h || "").replace(/\s+/g, " ").replace(process.argv.includes("--loose") ? / style=""/g : /$^/, "");
const snaps = [...new Set([...ls(A, 'snaps'), ...ls(B, 'snaps')])];
r.snaps = { total: snaps.length, onlyA: snaps.filter(f => !existsSync(join(B, 'snaps', f))), onlyB: snaps.filter(f => !existsSync(join(A, 'snaps', f))), identical: 0, differ: [] };
for (const f of snaps) {
  if (!existsSync(join(A, 'snaps', f)) || !existsSync(join(B, 'snaps', f))) continue;
  const a = J(join(A, 'snaps'), f), b = J(join(B, 'snaps'), f);
  const da = Object.fromEntries(a.docs.map(d => [d.key, norm(d.html)])), db = Object.fromEntries(b.docs.map(d => [d.key, norm(d.html)]));
  const keys = [...new Set([...Object.keys(da), ...Object.keys(db)])];
  const bad = keys.filter(k => da[k] !== db[k]);
  if (!bad.length) { r.snaps.identical++; continue; }
  const k = bad[0], x = da[k] || '', y = db[k] || '';
  let i = 0; while (i < x.length && x[i] === y[i]) i++;
  r.snaps.differ.push({ snap: f, docs: bad.length + '/' + keys.length, lenA: x.length, lenB: y.length, at: i, a: x.slice(Math.max(0, i - 60), i + 80), b: y.slice(Math.max(0, i - 60), i + 80) });
}
// Hover and click parts, per screen.
r.hovers = Object.fromEntries([...new Set([...ls(A, 'hovers'), ...ls(B, 'hovers')])].map(h => [h, { a: ls(A, join('hovers', h)).filter(f => f.endsWith('.json')).length, b: ls(B, join('hovers', h)).filter(f => f.endsWith('.json')).length }]));
// Screenshots, pixel by pixel.
const shots = ls(A, 'shots').filter(f => f.endsWith('.png') && existsSync(join(B, 'shots', f)));
const br = await chromium.launch({ channel: 'chrome', headless: true }); const pg = await br.newPage();
const pairs = shots.map(f => [readFileSync(join(A, 'shots', f)).toString('base64'), readFileSync(join(B, 'shots', f)).toString('base64')]);
const cmp = pairs.length ? await comparePngs(pg, pairs) : [];
await br.close();
r.shots = { compared: shots.length, onlyA: ls(A, 'shots').filter(f => !existsSync(join(B, 'shots', f))).length, onlyB: ls(B, 'shots').filter(f => !existsSync(join(A, 'shots', f))).length,
  identical: cmp.filter(c => c.pct === 0).length, worst: shots.map((f, i) => ({ f, pct: cmp[i].pct })).sort((x, y) => y.pct - x.pct).slice(0, 5) };
// Resources the captures pointed at.
r.urls = { a: Object.keys(J(A, 'urls.json')).length, b: Object.keys(J(B, 'urls.json')).length };
if (outI > 0) writeFileSync(process.argv[outI + 1], JSON.stringify(r, null, 1));
console.log(JSON.stringify({ states: r.states, path: r.path, beats: r.beats, streams: r.streams, autosSame: r.autos.same, viewport: r.viewport, snaps: { total: r.snaps.total, identical: r.snaps.identical, differ: r.snaps.differ.length, onlyA: r.snaps.onlyA, onlyB: r.snaps.onlyB }, hovers: r.hovers, shots: { compared: r.shots.compared, identical: r.shots.identical, worst: r.shots.worst.slice(0, 3) }, urls: r.urls }, null, 1));
for (const d of r.snaps.differ.slice(0, 8)) console.log(`\n${d.snap} (${d.docs} docs, ${d.lenA} vs ${d.lenB} chars, from ${d.at})\n  A: ${d.a}\n  B: ${d.b}`);
