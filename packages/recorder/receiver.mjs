// Capture receiver: a local HTTP endpoint the capture driver (running inside playwright-chrome) posts to.
// Raw captures hold real URLs (some with sign-in tokens), so they're written outside the repo (the demo's raw
// folder, ~/.scenecast/<demo>/raw by default). It also queues remote-control commands for the driver's command
// loop (GET /cmd, POST /cmd/result), and keeps the recorder's recording (recording.json).
//   node capture/receiver.mjs --demo <dir>        or        node capture/receiver.mjs <rawDir> [port]
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { loadDemo } from '../kit/lib/demo.mjs';

const argv = process.argv.slice(2);
const demo = argv.includes('--demo') || !argv[0] ? loadDemo(argv) : null;
const RAW = demo ? demo.raw : argv[0];
const PORT = +(demo ? (process.env.REPLICA_RX_PORT || demo.cfg.receiverPort) : (argv[1] || 47621));
for (const d of ['snaps', 'streams', 'shots', 'blobs']) mkdirSync(join(RAW, d), { recursive: true });
const URLS = join(RAW, 'urls.json');
const urlIndex = existsSync(URLS) ? JSON.parse(readFileSync(URLS, 'utf8')) : {};
const saveIndex = () => writeFileSync(URLS, JSON.stringify(urlIndex, null, 1));
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

const cmds = []; let waiter = null; let agentAt = 0; const results = {};
function body(req) { return new Promise((res, rej) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c))); req.on('error', rej); }); }
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(obj)); };

createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-private-network': 'true' }); return res.end(); }
    // agent: whether the recorder (extension or agent) is polling now, and when it last asked for a command or answered.
    if (req.method === 'GET' && u.pathname === '/ping') return json(res, 200, { ok: true, raw: RAW, urls: Object.keys(urlIndex).length, agent: { polling: !!waiter, secsAgo: agentAt ? Math.round((Date.now() - agentAt) / 1000) : null } });
    // The recorder's checkpoint, for record start --resume.
    if (req.method === 'GET' && u.pathname === '/recording-partial') { const f = join(RAW, 'recording-partial.json'); return existsSync(f) ? json(res, 200, JSON.parse(readFileSync(f, 'utf8'))) : json(res, 404, { error: 'no checkpoint' }); }
    // Remote control: the driver long-polls for its next command.
    if (req.method === 'GET' && u.pathname === '/cmd') {
      agentAt = Date.now();
      if (cmds.length) return json(res, 200, cmds.shift());
      const t = setTimeout(() => { waiter = null; json(res, 200, { op: 'idle' }); }, 20000);
      waiter = c => { clearTimeout(t); waiter = null; json(res, 200, c); };
      return;
    }
    const buf = await body(req);
    const data = buf.length ? JSON.parse(buf.toString('utf8')) : {};
    switch (u.pathname) {
      case '/cmd': { // queue a command (from bash) → returns its id; read the result with GET /result?id=
        const c = { id: data.id || ('c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)), ...data };
        if (waiter) waiter(c); else cmds.push(c);
        return json(res, 200, { id: c.id });
      }
      case '/cmd/result': agentAt = Date.now(); results[data.id] = data; log(`result ${data.id} ${String(data.ok)} ${(data.error || '').slice(0, 200)}`); return json(res, 200, { ok: true });
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
        rmSync(join(RAW, 'recording-partial.json'), { force: true });
        log(`recording: ${Object.keys(data.states || {}).length} states, ${Object.keys(data.streams || {}).length} streams, ${(data.path || []).length} steps`);
        return json(res, 200, { ok: true });
      }
      case '/log': log('driver: ' + String(data.msg).slice(0, 2000)); return json(res, 200, { ok: true });
      default: return json(res, 404, { error: 'not found' });
    }
  } catch (e) { log('error ' + e.stack); json(res, 500, { error: String(e) }); }
}).on('error', e => { console.error(`receiver: ${e.code === 'EADDRINUSE' ? `port ${PORT} is in use (another receiver?)` : e.message}`); process.exit(1); })
  .listen(PORT, '127.0.0.1', () => log(`receiver on http://127.0.0.1:${PORT} → ${RAW}`));
