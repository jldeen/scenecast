// Replica server. No dependencies, no network: it serves the player, bundle, captured pages and assets on localhost.
//   node packages/player/serve.mjs --demo <dir> [--port 4620] [--open [--fullscreen] [--position x,y --size w,h]]
//     [--pace N] [--release] [--rehearse]
// --open opens it as an app window (no tabs or address bar; launch.mjs): Chrome on the Mac (⌃⌘F for full screen),
// Edge on Windows (F11), or demo.json chrome.browser, on chrome.profile; --position and --size put it on a given
// screen (the projector). REPLICA_NO_OPEN=1 serves without opening a window (checks while her window is in use).
// --rehearse: the stage reports each beat it reaches (POST /__replica/rehearsal), kept in .out/rehearsal.json.
//
// Tweaks show on reload, without a build: when recording.json, flow.overrides.mjs or demo.json changes, the flow is
// compiled again (and flow.json written, for the next build); text edits the last build hasn't baked in (data/build.json) are applied to
// each page, frame and hover as it's served. What only a build can do is listed at /__replica/status and in the log.
// --release serves the bundle and data exactly as built.
import { at as __at, has } from '@stuntdouble/core/lib/at.mjs';
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, readFileSync, readdirSync, realpathSync, mkdirSync } from 'node:fs';
import { join, normalize, extname, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApp } from './launch.mjs';
import { diffFlow, flowFromBundle, applyFlowOverrides, withEngineModule } from './app/bundle-flow.js';
import { readFocusJson, readEditorOverrides, checkFocusJson, checkEditorOverrides, writeJsonAtomic, FOCUS_JSON, EDITOR_JSON } from '@stuntdouble/core/lib/overrides.mjs';
import { textRe } from '@stuntdouble/core/lib/edits.mjs';
import { loadDemo, arg } from '@stuntdouble/core/lib/demo.mjs';
import { compileFlow } from '@stuntdouble/core/compile/flow.mjs';
import { buildInputs, buildDiff } from '@stuntdouble/core/lib/buildkey.mjs';
import { compileEdits, applyEdits, applyEditsJson } from '@stuntdouble/core/lib/edits.mjs';

// Started for a check or a test (REPLICA_EXIT_WITH_PARENT=1): it goes when what started it goes, crashed or killed
// too. A check that crashed before stopping it left it serving, orphaned, for hours (Nov 2026).
if (process.env.REPLICA_EXIT_WITH_PARENT === '1') {
  const parent = process.ppid;
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  setInterval(() => { if (process.ppid !== parent || !alive(parent)) process.exit(0); }, 1000).unref();
}
const APP = join(dirname(fileURLToPath(import.meta.url)), 'app');
const PRESENTER = join(dirname(fileURLToPath(import.meta.url)), 'presenter');
const args = process.argv.slice(2);
const demo = loadDemo(args);
const PORT = +arg(args, '--port', 0) || demo.port;
// --pace N opens the replica at N seconds per streamed answer (the bundle's pace otherwise).
const PACE = +arg(args, '--pace', 0);
const pair = name => { const v = String(arg(args, name, '')).split(',').map(Number); return v.length === 2 && v.every(Number.isFinite) ? v : undefined; };
const REHEARSE = args.includes('--rehearse');
const rehearsal = { at: Date.now(), events: [], end: null, live: true };
const REHEARSAL_FILE = join(demo.dir, '.out', 'rehearsal.json');
const TYPES = { '.zip': 'application/zip', '.webmanifest': 'application/manifest+json', '.mjs': 'text/javascript; charset=utf-8', '.map': 'application/json', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.bin': 'application/octet-stream' };
const EDITOR = __at('editor', 'app');
const MAP = [['/app/', APP], ['/editor/', EDITOR], ['/snaps/', join(demo.data, 'snaps')], ['/streams/', join(demo.data, 'streams')], ['/assets/', join(demo.data, 'assets')]];
// demo.json engine: { dir, modules }: the demo's own engine modules (flow.modules), served from its dir as /demo/.
const ENGINE = demo.cfg.engine || null;
if (ENGINE) MAP.push(['/demo/', join(demo.dir, ENGINE.dir || 'app')]);
// demo.json static: { "/prefix/": "folder" }, a folder of the demo's own served as is (a bundled web app such as the
// Playwright trace viewer): any file type, byte ranges, and its service worker allowed at the prefix.
const STATIC = Object.entries(demo.cfg.static || {}).map(([pre, dir]) => [pre, join(demo.dir, dir)]);
for (const m of STATIC) MAP.push(m);

// ---- the live flow and the edits not built in yet --------------------------------------------------------------
const RELEASE = args.includes('--release');
// The editor (packages/editor): loaded in the replica whenever it's served for authoring (not --release, not an
// export), hidden until its key (⌥⇧E, Ctrl+Alt+Shift+E on Windows) or ?edit=1. --no-editor leaves it out.
// (Scenecast's: served only where it's installed.)
const EDITING = !RELEASE && !args.includes('--no-editor') && has('editor');
const live = { key: null, flow: null, error: null, needsBuild: [], pending: [], at: null };
const watched = () => {
  const parts = [];
  for (const f of readdirSync(demo.dir)) if (/\.(mjs|json)$/.test(f) && f !== 'flow.json') { try { parts.push(f + ':' + statSync(join(demo.dir, f)).mtimeMs); } catch (e) {} }
  for (const f of [join(demo.data, 'build.json'), join(demo.raw, 'recording.json')]) { try { parts.push(f + ':' + statSync(f).mtimeMs); } catch (e) {} }
  return parts.join('|');
};
let lastNote = '';
let warnedMissingBase = false;
let refreshing = Promise.resolve();
async function refresh() {
  const pending = refreshing.then(() => refreshNow());
  refreshing = pending.catch(() => {});
  return pending;
}
async function refreshNow() {
  if (RELEASE) return;
  const key = watched();
  if (key === live.key) return;
  live.key = key;
  try {
    const { flow, problems } = await compileFlow(demo);
    live.flow = flow; live.error = problems.length ? problems.join('; ') : null; live.at = new Date().toISOString();
    let manifest = null; try { manifest = JSON.parse(readFileSync(join(demo.data, 'build.json'), 'utf8')); } catch (e) {}
    const d = buildDiff(manifest, buildInputs(demo, flow));
    live.needsBuild = d.needsBuild;
    live.pending = compileEdits(d.serveEdits);
  } catch (e) {
    live.error = String(e.message || e);
  }
  const note = [live.error && `flow: ${live.error}`, live.pending.length && `${live.pending.length} text edit(s) applied as served (not built in yet)`, live.needsBuild.length && `needs scenecast build: ${live.needsBuild.join(', ')}`].filter(Boolean).join(' · ');
  if (note !== lastNote) { lastNote = note; console.log(`${new Date().toISOString().slice(11, 19)} ${note || 'flow and data up to date'}`); }
}
// Pending edits on a text response: pages (and in-capture edits on their main document), stream frames, hover data.
function edited(path, f) {
  if (RELEASE || !live.pending.length) return null;
  const ext = extname(f);
  if (path.startsWith('/snaps/hovers-') && ext === '.json') {
    const v = applyEditsJson(JSON.parse(readFileSync(f, 'utf8')), live.pending.filter(e => !e.in));
    return JSON.stringify(v);
  }
  if (ext !== '.html' || !(path.startsWith('/snaps/') || path.startsWith('/streams/'))) return null;
  const m = /^\/snaps\/([^/.]+)\.html$/.exec(path);
  return applyEdits(readFileSync(f, 'utf8'), live.pending, m ? decodeURIComponent(m[1]) : null);
}

// ---- the editor's files ------------------------------------------------------------------------------------------
// GET  /__replica/editor            focus.json and flow.editor.json as they are
// POST /__replica/editor            { focus?, overrides?, what }: both checked, then written (and the flow compiled again)
// GET  /__replica/editor/count?text= how many captured screens and answer frames have that text (a wording change
//                                   applies to all of them)
// Only from the replica's own page: the Host must be this server and the request must carry x-scenecast-editor (which
// a page from anywhere else can't send without a CORS preflight this server never answers).
const json = (res, code, v) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' }); res.end(JSON.stringify(v)); };
function countText(text) {
  const re = new RegExp(textRe(text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')), 'g');
  let screens = 0, matches = 0;
  const scan = dir => { if (!existsSync(dir)) return; for (const f of readdirSync(dir)) { const p = join(dir, f); let st; try { st = statSync(p); } catch (e) { continue; } if (st.isDirectory()) scan(p); else if (f.endsWith('.html')) { const n = (applyEdits(readFileSync(p, 'utf8'), live.pending).match(re) || []).length; if (n) { screens++; matches += n; } } } };
  scan(join(demo.data, 'snaps')); scan(join(demo.data, 'streams'));
  return { screens, matches };
}
async function editorApi(req, res, path) {
  if (!EDITING) return json(res, 404, { error: 'the editor is off (--release or --no-editor)' });
  const host = String(req.headers.host || '');
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) || req.headers['x-scenecast-editor'] !== '1') return json(res, 403, { error: 'forbidden' });
  try {
    if (req.method === 'GET' && path === '/__replica/editor') return json(res, 200, { focus: readFocusJson(demo.dir), overrides: readEditorOverrides(demo.dir) });
    if (req.method === 'GET' && path === '/__replica/editor/count') { await refresh(); const t = new URL(req.url, 'http://x').searchParams.get('text') || ''; return json(res, 200, t ? countText(t) : { screens: 0, matches: 0 }); }
    if (req.method === 'POST' && path === '/__replica/editor') {
      let body = '';
      for await (const c of req) { body += c; if (body.length > 4e6) return json(res, 413, { error: 'too large' }); }
      const v = JSON.parse(body || '{}');
      const bad = [...(v.focus ? checkFocusJson(v.focus) : []), ...(v.overrides ? checkEditorOverrides(v.overrides) : [])];
      if (bad.length) return json(res, 400, { error: bad.join('; ') });
      const written = [];
      if (v.focus) { writeJsonAtomic(join(demo.dir, FOCUS_JSON), { version: 1, ...v.focus }); written.push(FOCUS_JSON); }
      if (v.overrides) { writeJsonAtomic(join(demo.dir, EDITOR_JSON), { version: 1, edits: v.overrides.edits || [], beats: v.overrides.beats || {} }); written.push(EDITOR_JSON); }
      live.key = null; await refresh();
      // One machine-readable line per change, for whoever runs the server (scenecast edit, the desktop app).
      console.log('@edit ' + JSON.stringify({ event: 'saved', what: String(v.what || '').slice(0, 200), files: written, error: live.error, pendingEdits: live.pending.length, needsBuild: live.needsBuild }));
      return json(res, 200, { ok: !live.error, error: live.error, pendingEdits: live.pending.map(e => e.what), needsBuild: live.needsBuild });
    }
  } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
  return json(res, 404, { error: 'no such editor call' });
}

function resolve(path) {
  if (path === '/' || path === '/index.html') return join(APP, 'index.html');
  if (path === '/favicon.ico') return null;
  // The presenter guide (⌥G): the demo's own presenter/ files first (notes.json, shots/, any override), then the kit's.
  if (path === '/presenter.html') path = '/presenter/index.html';
  if (path.startsWith('/presenter/')) {
    let rel;
    try { rel = decodeURIComponent(path.slice('/presenter/'.length)); } catch { return null; }
    for (const dir of [join(demo.dir, 'presenter'), PRESENTER]) { const f = normalize(join(dir, rel)); if (f.startsWith(dir + sep) && existsSync(f) && statSync(f).isFile()) return f; }
    return null;
  }
  if (path.startsWith('/bundle/')) {
    let rel;
    try { rel = decodeURIComponent(path.slice('/bundle/'.length)); } catch { return null; }
    if (!rel || rel.includes('\\') || rel.split('/').some(part => !part || part.startsWith('.'))) return null;
    const manifest = JSON.parse(readFileSync(join(demo.dir, 'manifest.json'), 'utf8'));
    const scenes = manifest.graph?.scenes || [];
    const snapshots = scenes.map(s => s.live?.snapshot).filter(Boolean);
    const captures = scenes.flatMap(s => [
      s.assets?.screenshot, s.assets?.video,
      ...(s.hotspots || []).flatMap(h => (h.transition?.frames || []).map(f => f.path)),
    ]).filter(Boolean);
    const allowed = captures.includes(rel) || snapshots.some(snapshot => {
      if (rel === snapshot) return true;
      const base = snapshot.replace(/\.html$/i, '');
      if (rel === base + '.json') return true;
      if (!rel.startsWith(base + '.') || !rel.endsWith('.html')) return false;
      return /^[a-z0-9_-]+$/i.test(rel.slice(base.length + 1, -5));
    });
    if (!allowed) return null;
    const f = normalize(join(demo.dir, rel));
    try {
      const actual = realpathSync(f), root = realpathSync(demo.dir);
      return actual.startsWith(root + sep) ? actual : null;
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }
  for (const [pre, dir] of MAP) if (path.startsWith(pre)) {
    const f = normalize(join(dir, decodeURIComponent(path.slice(pre.length))));
    if (!f.startsWith(dir + sep)) return null;
    if (pre === '/demo/' && !/\.(m?js|css|json)$/.test(f)) return null;
    if (pre === '/editor/' && !EDITING) return null;
    return f;
  }
  return null;
}

createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  // Every font file the replica has, so the shell can load them before the first screen.
  if (path === '/__replica/fonts') {
    const dir = join(demo.data, 'assets');
    const list = existsSync(dir) ? readdirSync(dir).filter(f => /\.(woff2?|ttf|otf)$/.test(f) && statSync(join(dir, f)).size > 0).sort().map(f => '/assets/' + f) : [];
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' }); return res.end(JSON.stringify(list));
  }
  if (path === '/manifest.json') {
    await refresh();
    const file = join(demo.dir, 'manifest.json');
    try {
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      if (!RELEASE && live.flow) {
        const basePath = join(demo.dir, '.out', 'live-base.json');
        if (existsSync(basePath)) {
          const base = JSON.parse(readFileSync(basePath, 'utf8'));
          manifest.development_overrides = diffFlow(base, live.flow);
        } else if (!warnedMissingBase) {
          warnedMissingBase = true;
          console.warn('live overrides need a build or sync; serving the bundle as built');
        }
      }
      if (EDITING) {
        // The focus engine (for dots and previews, even before a demo has focus points) and the editor.
        const mods = [...((live.flow && live.flow.modules) || manifest.playback?.options?.modules || [])].filter(m => m !== '/app/focus-module.js' && m !== '/editor/editor.js');
        (manifest.development_overrides ||= []).push({ path: ['modules'], value: [...withEngineModule(mods, 'focus-module.js'), '/editor/editor.js'] });
      }
      // The presenter guide's stage side (⌥G; packages/player/presenter/), on every replica this server serves (not in
      // an export: the guide needs this server). It reads presenter/notes.json (scenecast notes) when there is one.
      const mods = applyFlowOverrides(flowFromBundle(manifest), manifest.development_overrides).modules || [];
      const withGuide = withEngineModule(mods, 'presenter-module.js', { first: false });
      if (withGuide !== mods) (manifest.development_overrides ||= []).push({ path: ['modules'], value: withGuide });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(JSON.stringify(manifest));
    } catch (e) {
      console.error(`manifest: ${e.message}`);
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Could not load bundle manifest');
    }
  }
  if (path === '/__replica/status') {
    await refresh();
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
    return res.end(JSON.stringify({ release: RELEASE, error: live.error, needsBuild: live.needsBuild, pendingEdits: live.pending.map(e => e.what), compiledAt: live.at }));
  }
  if (path.startsWith('/__replica/editor')) return editorApi(req, res, path);
  // While rehearsing: the stage's beat as it changes ({ beat, t }), and when it closes ({ end }).
  if (path === '/__replica/rehearsal' && req.method === 'POST' && REHEARSE) {
    let body = '';
    for await (const c of req) { body += c; if (body.length > 4096) break; }
    try {
      const m = JSON.parse(body);
      if (Number.isInteger(m.beat) && Number.isFinite(m.t)) rehearsal.events.push({ beat: m.beat, t: Math.round(m.t) });
      if (Number.isFinite(m.end)) { rehearsal.end = Math.round(m.end); rehearsal.live = false; }
      writeJsonAtomic(REHEARSAL_FILE, rehearsal);
    } catch (e) { /* not a rehearsal message */ }
    res.writeHead(204); return res.end();
  }
  const f = resolve(path);
  if (path.startsWith('/snaps/') || path.startsWith('/streams/')) await refresh();
  if (!f || !existsSync(f) || !statSync(f).isFile()) {
    // Unknown assets answer with an empty 204 rather than a 404, so nothing shows in the console.
    res.writeHead(path.startsWith('/assets/') || path === '/favicon.ico' || path === '/presenter/notes.json' ? 204 : 404); return res.end();
  }
  const st = STATIC.find(([pre]) => path.startsWith(pre));
  if (st) {
    const size = statSync(f).size, type = TYPES[extname(f)] || 'application/octet-stream';
    const h = { 'content-type': type, 'cache-control': 'no-cache', 'accept-ranges': 'bytes', 'service-worker-allowed': st[0] };
    const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (r && (r[1] || r[2])) {
      const start = r[1] ? +r[1] : Math.max(0, size - +r[2]), end = r[1] && r[2] ? Math.min(+r[2], size - 1) : size - 1;
      if (start > end || start >= size) { res.writeHead(416, { 'content-range': `bytes */${size}` }); return res.end(); }
      res.writeHead(206, { ...h, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
      return req.method === 'HEAD' ? res.end() : createReadStream(f, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...h, 'content-length': size });
    return req.method === 'HEAD' ? res.end() : createReadStream(f).pipe(res);
  }
  const immutable = path.startsWith('/assets/');
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream', 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache', 'access-control-allow-origin': '*' });
  const body = edited(path, f);
  if (body !== null) return res.end(body);
  createReadStream(f).pipe(res);
}).on('error', e => { console.error(`replica: ${e.code === 'EADDRINUSE' ? `port ${PORT} is in use` : e.message}`); process.exit(1); }).listen(PORT, '127.0.0.1', () => {
  const query = [PACE > 0 ? `pace=${PACE}` : '', REHEARSE ? 'rehearse=1' : ''].filter(Boolean).join('&');
  const url = `http://127.0.0.1:${PORT}/${query ? `?${query}` : ''}`;
  if (REHEARSE) { mkdirSync(dirname(REHEARSAL_FILE), { recursive: true }); writeJsonAtomic(REHEARSAL_FILE, rehearsal); }
  console.log(`${demo.cfg.title || demo.name} replica: ${url}${RELEASE ? ' (release: as built)' : ''}`);
  refresh();
  if (EDITING && args.includes('--edit')) console.log('@edit ' + JSON.stringify({ event: 'ready', url: url + (url.includes('?') ? '&' : '?') + 'edit=1' }));
  if (args.includes('--open') && !process.env.REPLICA_NO_OPEN) openApp(args.includes('--edit') ? url + (url.includes('?') ? '&' : '?') + 'edit=1' : url, { ...demo.cfg.chrome, fullscreen: args.includes('--fullscreen'), position: pair('--position'), size: pair('--size') });
});
