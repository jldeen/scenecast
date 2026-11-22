// One round of the fidelity fixer: reads the real-vs-replica comparison (checks/real-vs-replica.mjs), asks each
// diagnoser (index.mjs) why every difference over the threshold is there, and writes the patches they propose to the
// demo's flow.fixes.json (new ones only; a patch already there that didn't fix its difference is reported, not
// written again). Writes <out>/diagnoses.json and prints one "@fidelity {json}" line per diagnosis.
//   node fixer/fix.mjs --demo <dir> [--url <replica>] [--compare <compare.json>] [--out <dir>] [--round N] [--dry-run]
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadDemo, arg } from '@stuntdouble/core/lib/demo.mjs';
import { openReplica, appOffset } from '../replica-render.mjs';
import { loadDiagnosers, PATCH_KINDS, readFixes, writeFixes, patchKey } from './index.mjs';
import { refOf } from './patches.mjs';

const args = process.argv.slice(2);
const demo = loadDemo(args);
const URL0 = arg(args, '--url', demo.url);
const OUT = arg(args, '--out', join(demo.out, 'fidelity'));
const COMPARE = arg(args, '--compare', join(OUT, 'compare', 'compare.json'));
const ROUND = +arg(args, '--round', 1);
const DRY = args.includes('--dry-run');
const emit = (event, data) => console.log('@fidelity ' + JSON.stringify({ event, ...data }));
const compare = JSON.parse(readFileSync(COMPARE, 'utf8'));
const VP = demo.cfg.viewport;

// What's over the threshold, or has a font that isn't the real file.
const fontOff = f => (f.fonts || []).some(x => x.status === 'substituted' || x.status === 'different-file');
const findings = compare.items.filter(it => it.pct !== null && (!it.pass || fontOff(it)));
const fixes = readFixes(demo.dir);
const known = new Map(fixes.patches.map(p => [patchKey(p), p]));
if (!findings.length) { emit('fix-done', { round: ROUND, findings: 0, added: 0 }); writeFileSync(join(OUT, 'diagnoses.json'), JSON.stringify({ round: ROUND, diagnoses: [] }, null, 1)); process.exit(0); }

// The raw captures, read as needed.
const sha256 = b => createHash('sha256').update(b).digest('hex');
const urls = existsSync(join(demo.raw, 'urls.json')) ? JSON.parse(readFileSync(join(demo.raw, 'urls.json'), 'utf8')) : {};
const cache = new Map();
const memo = (k, f) => { if (!cache.has(k)) cache.set(k, f()); return cache.get(k); };
const raw = {
  urls,
  snaps: () => memo('snaps', () => readdirSync(join(demo.raw, 'snaps')).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort()),
  snap: id => memo('snap:' + id, () => { const f = join(demo.raw, 'snaps', id + '.json'); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { docs: [] }; }),
  main: id => raw.snap(id).docs.find(d => d.key === 'main') || { html: '', urls: [], meta: {} },
  styles: id => memo('css:' + id, () => [...(raw.main(id).html || '').matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n')),
  blob: u => memo('blob:' + u, () => {
    const e = urls[u]; if (!e || !e.file) return null;
    const file = join(demo.raw, 'blobs', e.file); if (!existsSync(file)) return null;
    const buf = readFileSync(file);
    return { file, type: (e.type || '').split(';')[0], html: !e.file.endsWith('.css') && /<(!doctype html|html[\s>])/i.test(buf.subarray(0, 600).toString('latin1')), sha256: sha256(buf) };
  }),
  clickRecords: page => memo('click:' + page, () => { const dir = join(demo.raw, 'hovers', 'click-' + page); return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => JSON.parse(readFileSync(join(dir, f), 'utf8'))) : []; }),
};

const R = await openReplica(demo, URL0);
const flow = R.flow;
let shown = null;
const ctx = {
  demo, flow, compare, fixes, raw, refOf,
  // The finding as it was compared (cached while the diagnosers look at the same one).
  async show(f) {
    const key = f.id;
    if (shown && shown.key === key) return shown.r;
    const it = { app: f.app, state: f.state, z: f.z, click: f.click ? clickOf(f) : undefined };
    const r = await R.show(it);
    shown = { key, r };
    return r;
  },
  // Regions in the app's CSS pixels (screenshot pixels ÷ the device scale, less the app's offset on the page), a
  // little wider so an element on a region's edge counts.
  async regionsCss(f, page) {
    const s = VP.dpr * f.z / 100, off = await appOffset(page, f.app);
    return (f.regions || []).map(g => ({ x: g.x / s - off.x - 2, y: g.y / s - off.y - 2, w: g.w / s + 4, h: g.h / s + 4 }));
  },
};
function clickOf(f) {
  const cp = (flow.clickPages || []).find(c => c.app === f.app && c.base === f.snap);
  const file = join(demo.data, 'snaps', `hovers-${f.app}.json`);
  const defs = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')).clicks || []) : [];
  const d = defs.find(x => cp && x.page === cp.page && x.name === f.click) || {};
  return { name: f.click, ctl: d.ctl, frame: d.frame || undefined };
}

const diagnosers = await loadDiagnosers(demo);
const all = [], added = [];
emit('fix-start', { round: ROUND, findings: findings.length, diagnosers: diagnosers.map(d => d.name) });
for (const f of findings) {
  const got = [];
  for (const d of diagnosers) {
    try { for (const x of (await d.diagnose(f, ctx)) || []) got.push({ ...x, by: d.name }); }
    catch (e) { got.push({ cause: 'error', by: d.name, summary: `${d.name} failed: ${String(e.message || e).slice(0, 200)}`, confidence: 0 }); }
  }
  if (!got.some(x => x.cause !== 'error')) got.push({ cause: 'unexplained', by: 'fixer', confidence: 0, summary: `${f.pct}% of pixels differ${f.regions && f.regions[0] ? ` (most at ${f.regions[0].x},${f.regions[0].y}, ${f.regions[0].w}×${f.regions[0].h})` : ''}; no diagnoser found why` });
  for (const x of got) {
    const row = { finding: f.id, kind: f.kind, z: f.z, pct: f.pct, cause: x.cause, by: x.by, confidence: x.confidence, summary: x.summary, evidence: x.evidence };
    if (x.patch) {
      if (!PATCH_KINDS.includes(x.patch.kind)) row.patchStatus = `refused: ${x.patch.kind} isn't a patch the loop writes`;
      else {
        const key = patchKey(x.patch);
        if (known.has(key) && known.get(key).round === ROUND && !fixes.patches.includes(known.get(key))) row.patchStatus = 'added (also found on ' + known.get(key).finding + ')';
        else if (known.has(key)) row.patchStatus = JSON.stringify((({ round, finding, cause, why, ...p }) => p)(known.get(key))) === JSON.stringify(x.patch) ? 'already applied' : 'kept (an earlier patch for the same thing)';
        else { const p = { ...x.patch, round: ROUND, finding: f.id, cause: x.cause, why: x.summary }; known.set(key, p); added.push(p); row.patchStatus = 'added'; }
        row.patch = x.patch;
      }
    }
    all.push(row);
    emit('diagnosed', { round: ROUND, finding: f.id, cause: row.cause, by: row.by, patch: row.patch ? row.patch.kind : null, patchStatus: row.patchStatus || null, summary: row.summary });
  }
}
await R.close();
if (added.length && !DRY) writeFixes(demo.dir, { patches: [...known.values()] });
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'diagnoses.json'), JSON.stringify({ round: ROUND, at: new Date().toISOString(), diagnoses: all, added }, null, 1));
emit('fix-done', { round: ROUND, findings: findings.length, added: added.length, kinds: added.map(p => p.kind), dryRun: DRY || undefined });
process.exit(0);
