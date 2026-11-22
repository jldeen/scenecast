// Capture receiver: a local HTTP endpoint the capture driver (running inside playwright-chrome) posts to.
// Raw captures hold real URLs (some with sign-in tokens), so they're written outside the repo (the demo's raw
// folder, ~/.scenecast/<demo>/raw by default). It also queues remote-control commands for the driver's command
// loop (GET /cmd, POST /cmd/result), and keeps the recorder's recording (recording.json).
//   node capture/receiver.mjs --demo <dir>        or        node capture/receiver.mjs <rawDir> [port]
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { loadDemo } from '@stuntdouble/core/lib/demo.mjs';

const argv = process.argv.slice(2);
const demo = argv.includes('--demo') || !argv[0] ? loadDemo(argv) : null;
let RAW = demo ? demo.raw : argv[0];
const PORT = +(demo ? (process.env.REPLICA_RX_PORT || demo.cfg.receiverPort) : (argv[1] || 47621));
for (const d of ['snaps', 'streams', 'shots', 'blobs']) mkdirSync(join(RAW, d), { recursive: true });
let URLS = join(RAW, 'urls.json');
let urlIndex = existsSync(URLS) ? JSON.parse(readFileSync(URLS, 'utf8')) : {};
const saveIndex = () => writeFileSync(URLS, JSON.stringify(urlIndex, null, 1));
// A receiver kept running (the desktop app's) follows demo.json: a raw folder changed there is where captures go.
let cfgAt = demo ? statSync(join(demo.dir, 'demo.json')).mtimeMs : 0;
function follow() {
  if (!demo) return;
  let at; try { at = statSync(join(demo.dir, 'demo.json')).mtimeMs; } catch (e) { return; }
  if (at === cfgAt) return;
  cfgAt = at;
  let raw; try { raw = loadDemo(demo.dir).raw; } catch (e) { return; }
  if (raw === RAW) return;
  RAW = raw;
  for (const d of ['snaps', 'streams', 'shots', 'blobs']) mkdirSync(join(RAW, d), { recursive: true });
  URLS = join(RAW, 'urls.json');
  urlIndex = existsSync(URLS) ? JSON.parse(readFileSync(URLS, 'utf8')) : {};
  log(`raw folder now ${RAW} (demo.json changed)`);
}
const log = s => { const l = `${new Date().toISOString()} ${s}`; console.log(l); appendFileSync(join(RAW, 'receiver.log'), l + '\n'); };

const EXT = { 'text/css': 'css', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/webp': 'webp', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'font/woff2': 'woff2', 'font/woff': 'woff', 'font/ttf': 'ttf', 'application/font-woff2': 'woff2', 'application/font-woff': 'woff', 'application/x-font-woff': 'woff', 'font/otf': 'otf', 'application/json': 'json', 'image/avif': 'avif' };
function storeBlob(buf, type, url) {
  const sha = createHash('sha256').update(buf).digest('hex').slice(0, 24);
  let ext = EXT[(type || '').split(';')[0].trim().toLowerCase()];
  if (!ext) { const m = (url || '').split(/[?#]/)[0].match(/\.(woff2?|ttf|otf|png|jpe?g|gif|svg|webp|ico|css|avif)$/i); ext = m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'bin'; }
  const file = `${sha}.${ext}`;
  const p = join(RAW, 'blobs', file);
  if (!existsSync(p)) writeFileSync(p, buf);
  return file;
}
const fromDataUrl = d => { const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(d || ''); if (!m) return null; return { type: m[1], buf: m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3])) }; };

const cmds = []; const waiters = []; const drop = w => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); }; let agentAt = 0; const results = {};
// One recorder per receiver. Every copy of the recorder that finds this receiver says who it is (a browser with the
// extension, another browser or profile with it too, a test's browser): the first one is this receiver's, and only it
// gets commands, so a check and the recording that follows always run in the same browser. The others wait (standby)
// and are listed by /ping, so the app can say there are two. One that's gone (no poll for 30 s, nothing in hand) gives
// its place to the next.
const agents = new Map(); let bound = null; const inHand = new Set();
const ALIVE_MS = 30000;
const alive = id => { const a = agents.get(id); return !!a && (Date.now() - a.at < ALIVE_MS || (id === bound && inHand.size > 0)); };
function agentOf(u) {
  const id = u.searchParams.get('agent') || 'unnamed';
  const a = agents.get(id) || { id, first: Date.now() };
  Object.assign(a, { at: Date.now(), browser: u.searchParams.get('browser') || a.browser || '', tabs: +(u.searchParams.get('tabs') || a.tabs || 0), version: u.searchParams.get('v') || a.version || '' });
  agents.set(id, a);
  if (!bound || (bound !== id && !alive(bound))) { if (bound !== id) log(`recorder ${id} (${a.browser}, ${a.tabs} tabs) is this receiver's${bound ? ` (${bound} is gone)` : ''}`); bound = id; inHand.clear(); }
  return a;
}
const others = () => [...agents.values()].filter(a => a.id !== bound && Date.now() - a.at < ALIVE_MS).map(a => ({ id: a.id, browser: a.browser, tabs: a.tabs, secsAgo: Math.round((Date.now() - a.at) / 1000) }));
const SINCE = Date.now(), OWNER = process.env.SCENECAST_RX_OWNER || 'cli', DEMO = demo ? demo.dir : null;
// Started by the desktop app: go when the app does (it stops this receiver when it quits; this covers a crash).
const PARENT = +process.env.SCENECAST_RX_PARENT || 0;
if (PARENT) setInterval(() => { try { process.kill(PARENT, 0); } catch (e) { if (e.code !== 'EPERM') process.exit(0); } }, 3000).unref();
function body(req) { return new Promise((res, rej) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c))); req.on('error', rej); }); }
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(obj)); };

const escHtml = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function setupPage(browser, dir) {
  const edge = browser === 'edge', page = edge ? 'edge://extensions' : 'chrome://extensions', mac = process.platform === 'darwin';
  return `<!doctype html><meta charset="utf-8"><title>Install the Scenecast recorder</title>
<style>body{font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:720px;margin:48px auto;padding:0 24px;color:#1b1b1f}
h1{font-size:24px}ol{padding-left:22px}li{margin:14px 0}code{background:#f2f2f4;padding:2px 6px;border-radius:5px;font-size:14px}
button{font:inherit;padding:6px 14px;border-radius:7px;border:1px solid #c9c9cf;background:#fff;cursor:pointer}button.primary{background:#0f6cbd;color:#fff;border-color:#0f6cbd}
.state{padding:12px 16px;border-radius:9px;background:#ebf3fc;margin:20px 0}.state.ok{background:#e7f4e6;color:#0e7a0d;font-weight:600}</style>
<h1>Install the Scenecast recorder</h1>
<div class="state" id="state">Waiting for the recorder… this page turns green when it connects.</div>
<ol>
<li><strong>Open ${page}</strong>: click the address bar (${mac ? '⌘L' : 'Ctrl+L'}), paste (${mac ? '⌘V' : 'Ctrl+V'}) and press Enter. Scenecast already copied it.
 <button class="primary" id="copy">Copy ${page} again</button></li>
<li><strong>Turn on Developer mode</strong> (${edge ? 'bottom of the left side of the page' : 'top right of the page'}).</li>
<li><strong>Drag the Recorder Extension folder onto that page</strong> from the ${mac ? 'Finder' : 'File Explorer'} window Scenecast opened, or click <strong>Load unpacked</strong> and pick it:<br><code>${escHtml(dir)}</code></li>
</ol>
<script>
document.getElementById('copy').onclick = () => navigator.clipboard.writeText(${JSON.stringify(page)}).then(() => { document.getElementById('copy').textContent = 'Copied'; });
setInterval(async () => {
  const p = await fetch('/ping').then(r => r.json()).catch(() => null);
  const on = p && p.agent && (p.agent.polling || p.agent.busy || (p.agent.secsAgo !== null && p.agent.secsAgo < 30));
  const el = document.getElementById('state');
  el.className = 'state' + (on ? ' ok' : '');
  el.textContent = on ? '✓ The recorder is connected. You can close this tab.' : 'Waiting for the recorder… this page turns green when it connects.';
}, 1500);
</script>`;
}

// Coach me's window (the AI's coach posts here): the next step and the line to say, big, for the laptop screen.
let coachNow = null;
const COACH_PAGE = `<!doctype html><meta charset="utf-8"><title>Scenecast coach</title>
<style>body{font:18px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:28px 32px;color:#1b1b1f;background:#fafafa}
.k{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#6b6b75;margin:18px 0 6px}.next{font-size:30px;font-weight:600}
.say{font-size:24px;color:#0f548c;border-left:4px solid #0f6cbd;padding-left:14px}.bar{height:6px;background:#e6e6ea;border-radius:3px;margin-top:22px}
.bar div{height:6px;background:#0f6cbd;border-radius:3px}.muted{color:#6b6b75;font-size:15px}.off{color:#8a5300}</style>
<div class="muted" id="beat">Waiting for the coach…</div>
<div class="k">Next</div><div class="next" id="next">—</div>
<div class="k">Say</div><div class="say" id="say">—</div>
<div class="bar"><div id="prog" style="width:0"></div></div><p class="muted" id="state"></p>
<script>
setInterval(async () => {
  const c = await fetch('/coach.json', { cache: 'no-store' }).then(r => r.json()).catch(() => null);
  if (!c || !c.at) return;
  document.getElementById('beat').textContent = c.finished ? 'That was the whole plan. Stop recording in Scenecast when you are done.' : 'Beat ' + (c.beat + 1) + ': ' + c.beatTitle + (c.offPlan ? ' (off the plan: a suggestion)' : '');
  document.getElementById('beat').className = c.offPlan ? 'muted off' : 'muted';
  document.getElementById('next').textContent = c.next || '—';
  document.getElementById('say').textContent = c.say || '—';
  document.getElementById('prog').style.width = (c.of ? Math.round(100 * c.done / c.of) : 0) + '%';
  document.getElementById('state').textContent = !c.recording ? 'Not recording yet: press Start recording in Scenecast.' : c.busy ? 'Hold on: capturing this screen…' : 'Ready for your next step.';
}, 700);
</script>`;

createServer(async (req, res) => {
  try {
    follow();
    const u = new URL(req.url, 'http://x');
    // Only the recorder (an extension, or a local tool with no Origin) talks to the receiver: never a web page.
    const origin = req.headers.origin;
    if (origin && !/^(chrome|moz)?-?extension:\/\//.test(origin) && origin !== `http://127.0.0.1:${PORT}`) { res.writeHead(403); return res.end(); }
    // Install recorder's page, opened in the presenter's browser and profile: the steps, and a tick when it connects.
    if (req.method === 'GET' && u.pathname === '/setup') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(setupPage(u.searchParams.get('browser'), u.searchParams.get('dir'))); }
    if (req.method === 'GET' && u.pathname === '/coach') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(COACH_PAGE); }
    if (req.method === 'GET' && u.pathname === '/coach.json') return json(res, 200, coachNow || {});
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-private-network': 'true' }); return res.end(); }
    // agent: whether the recorder (extension or agent) is polling now, and when it last asked for a command or answered.
    if (req.method === 'GET' && u.pathname === '/ping') { const b = agents.get(bound) || {}; return json(res, 200, { ok: true, scenecast: 'receiver', pid: process.pid, owner: OWNER, since: SINCE, port: PORT, demo: DEMO, raw: RAW, urls: Object.keys(urlIndex).length, agent: { polling: waiters.length > 0, busy: inHand.size > 0, secsAgo: agentAt ? Math.round((Date.now() - agentAt) / 1000) : null, id: bound, browser: b.browser, tabs: b.tabs, others: others() } }); }
    // The recorder's checkpoint, for record start --resume.
    if (req.method === 'GET' && u.pathname === '/recording-partial') { const f = join(RAW, 'recording-partial.json'); return existsSync(f) ? json(res, 200, JSON.parse(readFileSync(f, 'utf8'))) : json(res, 404, { error: 'no checkpoint' }); }
    // Remote control: the driver long-polls for its next command.
    if (req.method === 'GET' && u.pathname === '/cmd') {
      const a = agentOf(u);
      // Another recorder: no commands, and back in a few seconds (it's listed by /ping).
      if (a.id !== bound) { const t = setTimeout(() => json(res, 200, { op: 'idle', standby: true }), 5000); res.on('close', () => clearTimeout(t)); return; }
      agentAt = Date.now();
      if (cmds.length) { const c = cmds.shift(); inHand.add(c.id); return json(res, 200, c); }
      // Each waiting recorder in turn; a command goes to the one that asked last (two copies of the extension
      // loaded can't strand a command on a poll that's gone).
      const w = c => { clearTimeout(t); drop(w); if (c.id) inHand.add(c.id); json(res, 200, c); };
      const t = setTimeout(() => w({ op: 'idle' }), 20000);
      waiters.push(w);
      res.on('close', () => { if (!res.writableEnded) { clearTimeout(t); drop(w); } });
      return;
    }
    const buf = await body(req);
    const data = buf.length ? JSON.parse(buf.toString('utf8')) : {};
    switch (u.pathname) {
      // Another receiver wants this port (the desktop app, for the demo that's open): this one makes way.
      case '/quit': json(res, 200, { ok: true, pid: process.pid }); log('quit (asked to make way)'); setTimeout(() => process.exit(0), 100); return;
      case '/cmd': { // queue a command (from bash) → returns its id; read the result with GET /result?id=
        const c = { id: data.id || ('c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)), ...data };
        if (waiters.length) waiters[waiters.length - 1](c); else cmds.push(c);
        return json(res, 200, { id: c.id });
      }
      case '/cmd/result': agentAt = Date.now(); inHand.delete(data.id); results[data.id] = data; log(`result ${data.id} ${String(data.ok)} ${(data.error || '').slice(0, 200)}`); return json(res, 200, { ok: true });
      case '/result': { const id = u.searchParams.get('id') || data.id; return json(res, 200, results[id] || { pending: true }); }
      case '/have': return json(res, 200, { missing: (data.urls || []).filter(x => !urlIndex[x] || urlIndex[x].error) });
      case '/res': {
        for (const it of data.items || []) {
          if (it.error && urlIndex[it.url] && !urlIndex[it.url].error) continue;
          if (it.error) { urlIndex[it.url] = { error: it.error, via: it.via }; continue; }
          const d = it.dataUrl ? fromDataUrl(it.dataUrl) : it.text !== undefined ? { type: it.type || 'text/plain', buf: Buffer.from(it.text, 'utf8') } : { type: it.type, buf: Buffer.from(it.b64 || '', 'base64') };
          if (!d) { urlIndex[it.url] = { error: 'bad data' }; continue; }
          urlIndex[it.url] = { file: storeBlob(d.buf, it.type || d.type, it.url), type: it.type || d.type, via: it.via, bytes: d.buf.length };
        }
        saveIndex();
        return json(res, 200, { ok: true, n: (data.items || []).length });
      }
      case '/snap': {
        writeFileSync(join(RAW, 'snaps', data.id + '.json'), JSON.stringify(data));
        const sizes = (data.docs || []).map(d => `${d.key}:${Math.round(d.html.length / 1024)}KB/${d.urls.length}u`);
        log(`snap ${data.id} ${sizes.join(' ')}`);
        return json(res, 200, { ok: true });
      }
      case '/frame': {
        const dir = join(RAW, 'streams', data.stream); mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, String(data.n).padStart(4, '0') + '.json'), JSON.stringify(data));
        return json(res, 200, { ok: true });
      }
      case '/hover': { // one hover from the hover audit, and its picture
        const dir = join(RAW, 'hovers', data.page); mkdirSync(dir, { recursive: true });
        const name = String(data.n).padStart(4, '0');
        if (data.shot) writeFileSync(join(dir, name + '.png'), Buffer.from(data.shot, 'base64'));
        delete data.shot;
        writeFileSync(join(dir, name + '.json'), JSON.stringify(data));
        log(`hover ${data.page} ${name} ${(data.cand && data.cand.text || '').slice(0, 50)} ${data.res && data.res.portals ? 'portal' : ''}${data.res && data.res.ops ? ' inplace' : ''}`);
        return json(res, 200, { ok: true });
      }
      case '/shot': {
        writeFileSync(join(RAW, 'shots', data.id + '.png'), Buffer.from(data.b64, 'base64'));
        log(`shot ${data.id}`);
        return json(res, 200, { ok: true });
      }
      case '/recording-partial': writeFileSync(join(RAW, 'recording-partial.json'), JSON.stringify(data)); return json(res, 200, { ok: true });
      case '/recording': {
        writeFileSync(join(RAW, 'recording.json'), JSON.stringify(data, null, 1));
        // The window it was recorded in, on its own (small, read by every tool that loads the demo).
        if (data.viewport) writeFileSync(join(RAW, 'viewport.json'), JSON.stringify(data.viewport));
        rmSync(join(RAW, 'recording-partial.json'), { force: true });
        log(`recording: ${Object.keys(data.states || {}).length} states, ${Object.keys(data.streams || {}).length} streams, ${(data.path || []).length} steps`);
        return json(res, 200, { ok: true });
      }
      case '/coach': coachNow = data; return json(res, 200, { ok: true });
      case '/log': log('driver: ' + String(data.msg).slice(0, 2000)); return json(res, 200, { ok: true });
      default: return json(res, 404, { error: 'not found' });
    }
  } catch (e) { log('error ' + e.stack); json(res, 500, { error: String(e) }); }
}).on('error', e => { console.error(`receiver: ${e.code === 'EADDRINUSE' ? `port ${PORT} is in use (another receiver?)` : e.message}`); process.exit(1); })
  .listen(PORT, '127.0.0.1', () => log(`receiver on http://127.0.0.1:${PORT} → ${RAW}`));
