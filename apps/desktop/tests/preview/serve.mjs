// The window's preview: the real apps/desktop/ui, served with a stand-in for the app's Rust side (mock.js), so each
// screen can be looked at and screenshotted in any browser without running the app. Scenarios pick the state:
//   node apps/desktop/tests/preview/serve.mjs [port]      then open http://127.0.0.1:<port>/?s=record&os=macos
// Scenarios (s=): empty, library, record, recording, recorded, review, present, copilot. os=macos|windows.
// For looking only: nothing here records, builds or presents. With PREVIEW_SHOTS=<folder>, a page can POST a PNG data
// URL to /__shots/<name>.png and it's saved there (screenshots of each screen, as evidence).
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const UI = resolve(HERE, '..', '..', 'ui');
const PORT = +(process.argv[2] || process.env.PREVIEW_PORT || 47980);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };

const inside = (root, p) => { const f = normalize(join(root, p)); return f.startsWith(root) ? f : null; };
export const startPreview = (port = PORT) => new Promise(done => { const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname.startsWith('/__shots/') && process.env.PREVIEW_SHOTS) {
    const name = url.pathname.slice(9).replace(/[^a-z0-9._-]/gi, '');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const data = Buffer.concat(chunks).toString();
    await mkdir(process.env.PREVIEW_SHOTS, { recursive: true });
    await writeFile(join(process.env.PREVIEW_SHOTS, name), Buffer.from(data.slice(data.indexOf(',') + 1), 'base64'));
    res.writeHead(200); res.end('saved'); return;
  }
  let file = null, body = null;
  if (url.pathname === '/' || url.pathname === '/index.html') {
    body = (await readFile(join(UI, 'index.html'), 'utf8')).replace('<script type="module" src="app.js"></script>', '<script src="/__preview/mock.js"></script>\n  <script type="module" src="app.js"></script>');
  } else if (url.pathname === '/__preview/mock.js') file = join(HERE, 'mock.js');
  else if (url.pathname.startsWith('/__lib/') && process.env.PREVIEW_LIB) file = inside(resolve(process.env.PREVIEW_LIB), url.pathname.slice(7));
  else file = inside(UI, decodeURIComponent(url.pathname));
  try {
    if (body === null) body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file || 'index.html')] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}); server.listen(port, '127.0.0.1', () => done(server)); });

if (process.argv[1] === fileURLToPath(import.meta.url)) startPreview().then(() => console.log(`preview: http://127.0.0.1:${PORT}/?s=record`));
