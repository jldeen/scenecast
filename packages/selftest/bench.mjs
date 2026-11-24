// Build benchmark at the size of a real demo. It scales a recorded fixture demo (test/selftest.mjs --keep) up to about
// Demo 1's size (≈300 page captures of ≈0.4–1 MB, ≈120 stream frames, ≈1,300 assets): each capture is copied K times
// with a large stylesheet and its own images, each stream K times. Then it times the build: from nothing (cold), again
// with nothing changed (warm), after a one-word text tweak, and after one capture changed.
//   node test/bench.mjs --from <fixture demo dir> [--k 6] [--keep]
import { readFileSync, writeFileSync, mkdirSync, readdirSync, cpSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { selftestGuard } from './guard.mjs';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const FROM = arg('--from');
const K = +arg('--k', 6);
if (!FROM || !existsSync(join(FROM, 'demo.json'))) { console.log('node test/bench.mjs --from <fixture demo dir (selftest --keep)>'); process.exit(1); }
const srcCfg = JSON.parse(readFileSync(join(FROM, 'demo.json'), 'utf8'));
const SRC_RAW = srcCfg.raw;
const root = join(tmpdir(), 'replica-bench-' + process.pid);
const RAW = join(root, 'raw'), DEMO = join(root, 'demo');
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
await selftestGuard({ tmp: root, kept: [FROM, SRC_RAW] });

// ---- the scaled demo -------------------------------------------------------------------------------------------
cpSync(SRC_RAW, RAW, { recursive: true });
mkdirSync(DEMO, { recursive: true });
for (const f of ['demo.json', 'recording.json', 'flow.overrides.mjs']) cpSync(join(FROM, f), join(DEMO, f));
const cfg = JSON.parse(readFileSync(join(DEMO, 'demo.json'), 'utf8'));
cfg.raw = RAW; writeFileSync(join(DEMO, 'demo.json'), JSON.stringify(cfg, null, 2));
const flow0 = JSON.parse(readFileSync(join(FROM, 'flow.json'), 'utf8'));
const urls = JSON.parse(readFileSync(join(RAW, 'urls.json'), 'utf8'));
const rnd = n => { let s = ''; for (let i = 0; i < n; i++) s += 'abcdefghijklmnopqrstuvwxyz'[(i * 7919 + n) % 26]; return s; };
// ≈0.9 MB of atomic-CSS-like rules, the same for every copy of a page (like an app's shared stylesheet).
const bigCss = tag => Array.from({ length: 9000 }, (_, i) => `.f${tag}${i.toString(36)}{color:rgb(${i % 255},${(i * 3) % 255},${(i * 7) % 255});margin:${i % 13}px ${i % 7}px;padding:${i % 5}px}`).join('\n');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const want = new Set([...Object.values(flow0.states).map(s => s.snap), ...(flow0.variants || [])]);
const copies = [];
let blobs = 0;
for (const f of readdirSync(join(RAW, 'snaps'))) {
  const id = f.replace(/\.json$/, '');
  if (!want.has(id)) continue;
  const snap = JSON.parse(readFileSync(join(RAW, 'snaps', f), 'utf8'));
  for (let k = 1; k <= K; k++) {
    const c = JSON.parse(JSON.stringify(snap));
    c.id = `${id}-b${k}`;
    const main = c.docs.find(d => d.key === 'main');
    // Its own images (as a page's avatars, icons and thumbnails), each a distinct blob.
    let imgs = '';
    for (let n = 0; n < 6; n++) {
      const u = `http://127.0.0.1:47801/bench/${id}-${k}-${n}.png`;
      const buf = Buffer.concat([PNG, Buffer.from(`${id}-${k}-${n}`)]);
      const file = createHash('sha256').update(buf).digest('hex').slice(0, 24) + '.png';
      writeFileSync(join(RAW, 'blobs', file), buf); blobs++;
      urls[u] = { file, type: 'image/png', via: 'bench', bytes: buf.length };
      imgs += `<img src="d1res://${main.urls.length}" alt="">`; main.urls.push(u);
    }
    main.html = main.html.replace('</head>', `<style data-bench="">${bigCss(id.replace(/\W/g, '').slice(0, 6))}</style></head>`).replace('</body>', `<div hidden="">${imgs}${rnd(2000 + k)}</div></body>`);
    writeFileSync(join(RAW, 'snaps', c.id + '.json'), JSON.stringify(c));
    copies.push({ id: c.id, app: (Object.values(flow0.states).find(st => st.snap === id) || {}).app });
  }
}
writeFileSync(join(RAW, 'urls.json'), JSON.stringify(urls));
// Streams: each one K times, its frames made heavier.
const streamCopies = {};
for (const [name, s] of Object.entries(flow0.streams || {})) {
  const dir = join(RAW, 'streams', s.raw || name);
  for (let k = 1; k <= K; k++) {
    const to = join(RAW, 'streams', `${s.raw || name}-b${k}`);
    mkdirSync(to, { recursive: true });
    for (const fr of readdirSync(dir)) {
      const j = JSON.parse(readFileSync(join(dir, fr), 'utf8'));
      j.html = j.html.replace('</body>', `<div hidden="">${rnd(150000 + k)}</div></body>`);
      writeFileSync(join(to, fr), JSON.stringify(j));
    }
    streamCopies[`${name}-b${k}`] = { ...s, raw: `${s.raw || name}-b${k}` };
  }
}
writeFileSync(join(DEMO, 'bench.json'), JSON.stringify({ variants: copies, streams: streamCopies }));
const over = readFileSync(join(DEMO, 'flow.overrides.mjs'), 'utf8').replace(/export default function overrides\(flow, \{ recording, demo \}\) \{/, `import { readFileSync as __r } from 'node:fs';
export default function overrides(flow, { recording, demo }) {
  const B = JSON.parse(__r(new URL('./bench.json', import.meta.url), 'utf8'));
  // Copies of a state's page are states of the same app (so every per-screen pass runs on big pages, as in Demo 1).
  for (const c of B.variants) if (c.app) flow.states[c.id] = { app: c.app, snap: c.id }; else flow.variants.push(c.id);
  Object.assign(flow.streams, B.streams);`);
writeFileSync(join(DEMO, 'flow.overrides.mjs'), over);

// ---- timings -------------------------------------------------------------------------------------------------
const build = () => { const t = Date.now(); const r = spawnSync(process.execPath, [join(KIT, 'core/bin/engine.mjs'), 'build', '--demo', DEMO], { encoding: 'utf8' }); if (r.status) { console.log(r.stdout.slice(-2000), r.stderr.slice(-2000)); throw new Error('build failed'); } return +((Date.now() - t) / 1000).toFixed(1); };
const size = () => { const r = spawnSync('du', ['-sk', join(DEMO, 'data')], { encoding: 'utf8' }); return Math.round(+r.stdout.split('\t')[0] / 1024) + ' MB'; };
const count = d => existsSync(d) ? readdirSync(d, { recursive: true }).length : 0;
const out = { k: K, raw: { snaps: readdirSync(join(RAW, 'snaps')).length, blobs } };
out.cold = build();
out.data = { size: size(), snaps: count(join(DEMO, 'data', 'snaps')), streamFiles: count(join(DEMO, 'data', 'streams')), assets: count(join(DEMO, 'data', 'assets')) };
out.warm = build();
// A one-word tweak, baked in.
writeFileSync(join(DEMO, 'flow.overrides.mjs'), readFileSync(join(DEMO, 'flow.overrides.mjs'), 'utf8').replace('flow.pace = 5;', "flow.pace = 5;\n  flow.edits = (flow.edits || []).concat({ replace: ['by six days', 'by seven days'] });"));
out.tweak = build();
// One capture recaptured (its raw file changed).
const one = join(RAW, 'snaps', copies[0].id + '.json');
const j = JSON.parse(readFileSync(one, 'utf8')); j.docs[0].html = j.docs[0].html.replace('</body>', '<p>recaptured</p></body>'); writeFileSync(one, JSON.stringify(j));
out.recapture = build();
console.log(JSON.stringify(out, null, 1));
if (args.includes('--keep')) console.log('bench demo: ' + DEMO); else rmSync(root, { recursive: true, force: true });
