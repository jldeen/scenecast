// Finds a demo folder and its settings (demo.json). Every kit command takes the demo folder as --demo <dir>, or
// runs from inside it.
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { flowFromBundle, applyFlowOverrides } from '../../player/app/bundle-flow.js';

export const KIT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const KIT_VERSION = JSON.parse(readFileSync(join(KIT, 'kit', 'package.json'), 'utf8')).version;
export const FLOW_VERSION = 1;

const home = p => p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;

export const DEFAULTS = {
  port: 4620,
  viewport: { width: 1920, height: 1080, dpr: 2 },
  // No profile: the one the presenter has open (preflight finds it), never a guess at "Default".
  chrome: {},
  receiverPort: 47621,
  record: { everyMs: 400, settleMs: 2500, typeIdleMs: 1200, streamMinMs: 1500, streamMinFrames: 4, maxS: 240, busy: [], ignore: [], groups: { button: 'button[aria-expanded][aria-controls]' } },
  zooms: [50, 67, 75, 90, 110, 125, 150, 175, 200],
};

// The demo's record options for the recorder. Demos made before 0.4.3 carry the template's old side-path budget
// (auto.maxS 240 a screen, which real apps ran far past): 240 with only the template's keys means the defaults.
export function recordOpts(cfg) {
  const rec = { ...(cfg.record || {}) };
  if (rec.auto && rec.auto.maxS === 240 && Object.keys(rec.auto).sort().join() === 'clickMax,hoverMax,maxS') { const { maxS, ...auto } = rec.auto; rec.auto = auto; }
  return rec;
}
export function arg(args, k, d) { const i = args.indexOf(k); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; }

export function findDemoDir(args = process.argv.slice(2)) {
  const given = arg(args, '--demo');
  let dir = resolve(given || process.cwd());
  if (!given) for (let d = dir; d !== dirname(d); d = dirname(d)) if (existsSync(join(d, 'demo.json'))) { dir = d; break; }
  if (!existsSync(join(dir, 'demo.json'))) throw new Error(`no demo.json in ${dir} (pass --demo <dir>, or run "scenecast new <name>" first)`);
  return dir;
}

// The window a take was recorded in (raw/viewport.json, else recording.json's), or null.
export function recordedViewport(raw) {
  for (const [f, pick] of [['viewport.json', v => v], ['recording.json', r => r.viewport]]) {
    try { const v = pick(JSON.parse(readFileSync(join(raw, f), 'utf8'))); if (v && v.width > 0 && v.height > 0) return { width: v.width, height: v.height, dpr: v.dpr || 1 }; } catch (e) {}
  }
  return null;
}

export function loadDemo(dirOrArgs) {
  const dir = typeof dirOrArgs === 'string' ? resolve(dirOrArgs) : findDemoDir(dirOrArgs);
  const cfg = JSON.parse(readFileSync(join(dir, 'demo.json'), 'utf8'));
  const c = { ...DEFAULTS, ...cfg, viewport: { ...DEFAULTS.viewport, ...(cfg.viewport || {}) }, chrome: { ...DEFAULTS.chrome, ...(cfg.chrome || {}) }, record: { ...DEFAULTS.record, ...(cfg.record || {}) } };
  // Raw captures hold real URLs (some with sign-in tokens): they live outside the demo folder by default.
  const raw = home(process.env.REPLICA_RAW || c.raw || `~/.scenecast/${c.name}/raw`);
  const out = home(process.env.REPLICA_OUT || c.out || '.out');
  // No viewport in demo.json: the window it was recorded in (a real Chrome window is rarely 1920×1080 @2; Nov 2026,
  // a take at 1374 @2.2 was compared, and its zoom bands placed, at 1920).
  if (!cfg.viewport) { const v = recordedViewport(isAbsolute(raw) ? raw : join(dir, raw)); if (v) c.viewport = { ...c.viewport, ...v }; }
  const d = {
    dir, cfg: c, name: c.name,
    raw: isAbsolute(raw) ? raw : join(dir, raw),
    out: isAbsolute(out) ? out : join(dir, out),
    flowPath: join(dir, 'flow.json'),
    data: join(dir, 'data'),
    port: +(process.env.REPLICA_PORT || c.port),
    get url() { return `http://127.0.0.1:${this.port}/`; },
  };
  return d;
}

export function ensureDir(p) { mkdirSync(p, { recursive: true }); return p; }
export function readFlow(demo) { return JSON.parse(readFileSync(demo.flowPath, 'utf8')); }
// The flow a replica at url plays: its bundle (manifest.json, with the server's live overrides), read the way the player
// reads it, so a check runs on what is served or exported rather than on the demo's authoring files.
export async function bundleFlow(url) {
  const at = new URL('manifest.json', new URL('.', url));
  let manifest;
  if (at.protocol === 'file:') manifest = JSON.parse(readFileSync(fileURLToPath(at), 'utf8'));
  else {
    const res = await fetch(at, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${at.href}: ${res.status}`);
    manifest = await res.json();
  }
  return applyFlowOverrides(flowFromBundle(manifest), manifest.development_overrides);
}
