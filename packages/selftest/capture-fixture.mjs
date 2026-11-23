// Offline check of the capture pipeline: a fixture page with the tricky parts of the real apps (insertRule CSS,
// adopted sheets, shadow DOM, a cross-origin iframe, a blob image, a canvas, form state, scroll), captured with the
// same agent code that runs in playwright-chrome, through a real receiver. Headless system Chrome, temp profile.
//   node test/capture-fixture.mjs
import './reap.mjs';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const raw = mkdtempSync(join(tmpdir(), 'd1raw-'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
// A JWT-shaped value made from pieces (the repo's own secret scan would rightly flag a literal one).
const FAKE_JWT = ['eyJ' + 'hbGciOiJub25lIn0', 'eyJ' + 'zdWIiOiJ0ZXN0In0', 'c2lnbmF0dXJlLXRlc3Q'].join('.');
const page1 = `<!doctype html><html class="light"><head><meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline' 'unsafe-eval' data: blob:">
<title>Fixture</title><link rel="icon" href="/fav.png"><link rel="stylesheet" href="http://127.0.0.1:47702/x.css">
<style id="g" data-make-styles-bucket="d"></style><script>window.x=1</script></head>
<body><div id="scroller" style="height:80px;overflow:auto"><div style="height:400px">tall</div></div>
<button class="fui" onclick="alert(1)">Show more</button><input id="i" value=""><input type="checkbox" role="switch" id="sw">
<img id="b"><canvas id="c" width="10" height="10"></canvas><x-card></x-card><x-closed></x-closed>
<svg width="10" height="10"><linearGradient id="lg"></linearGradient><use href="#lg"></use></svg>
<div id="embed" data-testid="embed" powerbi-access-token="${FAKE_JWT}" data-note="see ${FAKE_JWT} here"></div>
<iframe id="f" src="http://127.0.0.1:47702/frame.html" width="300" height="100"></iframe>
<iframe id="x" src="http://localhost:47703/cross.html" width="300" height="100"></iframe>
<script>
document.getElementById('g').sheet.insertRule('.fui{color:rgb(1,2,3);background:url(/bg.png)}');
const s = new CSSStyleSheet(); s.replaceSync('body{margin:3px}'); document.adoptedStyleSheets=[s];
customElements.define('x-closed', class extends HTMLElement { constructor(){ super(); const r=this.attachShadow({mode:'closed'}); r.innerHTML='<style>b{color:blue}</style><b>closed shadow text</b>'; } });
customElements.define('x-card', class extends HTMLElement { constructor(){ super(); const r=this.attachShadow({mode:'open'}); r.innerHTML='<style>p{color:red}</style><p>shadow text</p>'; } });
document.getElementById('i').value='typed by user';
document.getElementById('sw').checked=true;
document.getElementById('scroller').scrollTop=120;
const c=document.getElementById('c').getContext('2d'); c.fillStyle='red'; c.fillRect(0,0,10,10);
fetch('/img.png').then(r=>r.blob()).then(b=>{ document.getElementById('b').src=URL.createObjectURL(b); });
</script></body></html>`;
const frame = `<!doctype html><html><head><style>h1{font-family:Fx}@font-face{font-family:Fx;src:url(font.woff2)}</style></head><body><h1>inside frame</h1></body></html>`;
const srv = (port, routes) => createServer((q, s) => { const r = routes[q.url.split('?')[0]]; if (!r) { s.writeHead(404); return s.end(); } s.writeHead(200, { 'content-type': r[0], 'access-control-allow-origin': '*' }); s.end(r[1]); }).listen(port, '127.0.0.1');
const a = srv(47701, { '/': ['text/html', page1], '/fav.png': ['image/png', PNG], '/bg.png': ['image/png', PNG], '/img.png': ['image/png', PNG] });
// Another site (localhost, not 127.0.0.1): with site isolation it runs in its own process (an OOPIF).
const x = srv(47703, { '/cross.html': ['text/html', '<!doctype html><html><body><p>cross-site frame</p></body></html>'] });
const b = srv(47702, { '/x.css': ['text/css', '.ext{background:url("sub/ext.png")}'], '/sub/ext.png': ['image/png', PNG], '/frame.html': ['text/html', frame], '/font.woff2': ['font/woff2', Buffer.from('wOF2fake')] });

// Its own receiver port: never a receiver another session is using.
const RXP = '47692';
if (await fetch(`http://127.0.0.1:${RXP}/ping`).then(() => true, () => false)) { console.log(`port ${RXP} is in use: stop whatever is on it and run again`); process.exit(1); }
spawnSync(process.execPath, [join(here, '../capture/build.mjs'), join(raw, 'agent'), '--port', RXP], { stdio: 'ignore' });
const rx = spawn(process.execPath, [join(here, '../capture/receiver.mjs'), raw, RXP], { stdio: 'inherit' });
await new Promise(r => setTimeout(r, 500));
// The recorder: the extension (default), or the Playwright agent (--agent).
const MODE = process.argv.includes('--agent') ? 'agent' : 'extension';
let browser, ctx, page;
if (MODE === 'extension') {
  spawnSync(process.execPath, [join(here, '../capture/build.mjs'), '--extension', join(raw, 'ext'), '--port', RXP], { stdio: 'ignore' });
  ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'scx-')), { channel: 'chromium', headless: true, viewport: null, args: ['--silent-debugger-extension-api', '--window-size=800,687', `--disable-extensions-except=${join(raw, 'ext')}`, `--load-extension=${join(raw, 'ext')}`] });
  if (!ctx.serviceWorkers().length) await ctx.waitForEvent('serviceworker', { timeout: 30000 });
  page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('http://127.0.0.1:47701/');
  await page.waitForTimeout(500);
  for (let i = 0; i < 60; i++) { if ((await fetch(`http://127.0.0.1:${RXP}/ping`).then(r => r.json())).agent.secsAgo !== null) break; await new Promise(r => setTimeout(r, 500)); }
} else {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
  page = await ctx.newPage();
  await page.goto('http://127.0.0.1:47701/');
  await page.waitForTimeout(500);
  const agent = eval(readFileSync(join(raw, 'agent', 'agent.js'), 'utf8'));
  console.log(await agent(page));
}
const cli = (op, args) => new Promise(res => { const p = spawn(process.execPath, [join(here, '../capture/cli.mjs'), op, JSON.stringify(args)], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, REPLICA_RX_PORT: RXP } }); let o = ''; p.stdout.on('data', d => o += d); p.on('close', code => res({ code, o })); });
const r = await cli('snap', { tab: '127.0.0.1:47701', id: 'fixture' });
console.log('snap result', r.o.slice(0, 800));
await cli('quit', {});
const snapFile = join(raw, 'snaps', 'fixture.json');
const fails = [];
const check = (name, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) fails.push(name); };
check('snapshot written', existsSync(snapFile));
const s = JSON.parse(readFileSync(snapFile, 'utf8'));
const main = s.docs.find(d => d.key === 'main'), fr = s.docs.find(d => d.key === 'f0');
check('insertRule CSS kept', /\.fui \{ color: rgb\(1, 2, 3\)/.test(main.html));
check('adopted sheet kept', /data-d1-adopted[^>]*>body \{ margin: 3px; \}/.test(main.html));
check('shadow root as DSD', main.html.includes('<template shadowrootmode="open" shadowrootclonable=""><style>p { color: red; }') && main.html.includes('shadow text'));
check('scripts and handlers gone', !/<script/i.test(main.html) && !/onclick/.test(main.html));
check('CSP meta gone', !/Content-Security-Policy/.test(main.html));
check('input value', main.html.includes('value="typed by user"'));
check('switch checked', /id="sw"[^>]* checked=""/.test(main.html));
check('scroll offset', main.html.includes('data-d1-scroll="120,0"'));
check('canvas inlined', Object.keys(main.inline).some(k => k.startsWith('canvas')));
check('blob image inlined', main.urls.some(u => u.startsWith('blob:')) && Object.keys(main.inline).some(k => k.startsWith('blob:') && main.inline[k]));
check('cross-origin sheet', main.html.includes('.ext {') || main.html.includes('data-d1-fetch'));
check('custom element listed', main.meta.customElements.includes('x-card'));
check('internal svg use kept', main.html.includes('href="#lg"'));
check('sign-in tokens in the markup never reach the capture (Power BI\'s powerbi-access-token)', /id="embed"[^>]*powerbi-access-token=""/.test(main.html) && !main.html.includes(FAKE_JWT.slice(0, 20)), (main.html.match(/<div id="embed"[^>]*>/) || [''])[0].slice(0, 300));
check('iframe tokenised', main.html.includes('src="d1frame://f0"'));
check('frame captured', fr && fr.html.includes('inside frame') && fr.parent === 'main');
if (MODE === 'extension') {
  // What only the extension can reach: a closed shadow root, and a cross-site frame in its own process.
  check('closed shadow root as DSD', /<x-closed><template shadowrootmode="open"[^>]*data-sc-closed=""><style>b \{ color: blue; \}\s*<\/style><b>closed shadow text<\/b>/.test(main.html), (main.html.match(/<x-closed>.{0,200}/) || [''])[0]);
  const xf = s.docs.find(d => d.html.includes('cross-site frame'));
  check('cross-site frame (OOPIF) captured', !!xf && xf.parent === 'main' && main.html.includes(`src="d1frame://${xf.key}"`), JSON.stringify(s.docs.map(d => [d.key, d.frameUrl])));
  check('screenshot is a real PNG of the page', readFileSync(join(raw, 'shots', 'fixture.png')).subarray(1, 4).toString() === 'PNG');
}
const idx = JSON.parse(readFileSync(join(raw, 'urls.json'), 'utf8'));
check('bg.png fetched', idx['http://127.0.0.1:47701/bg.png'] && idx['http://127.0.0.1:47701/bg.png'].file);
check('frame font fetched', idx['http://127.0.0.1:47702/font.woff2'] && idx['http://127.0.0.1:47702/font.woff2'].file);
check('favicon fetched', idx['http://127.0.0.1:47701/fav.png'] && idx['http://127.0.0.1:47701/fav.png'].file);
check('shot written', existsSync(join(raw, 'shots', 'fixture.png')));
await (browser || ctx).close(); rx.kill(); a.close(); b.close(); x.close();
console.log(fails.length ? `${fails.length} FAILED` : 'ALL PASS', raw);
process.exit(fails.length ? 1 : 0);
