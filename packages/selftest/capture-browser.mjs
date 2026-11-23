// The capture browser (@stuntdouble/capture/browser.mjs, opt-in): the installed Chrome with its own throwaway
// profile, every window off the screen, on the fixture apps. Nothing shows on the screen and nothing of the
// presenter's is touched. Needs Chrome (or Edge: CAPTURE_CHANNEL=msedge) installed.
//   node packages/selftest/capture-browser.mjs
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openCaptureBrowser, launchRealChrome, browserApp, platformWindow } from '@stuntdouble/capture/browser.mjs';
import { startFixture } from '../../examples/fixture-app/server.mjs';

const channel = process.env.CAPTURE_CHANNEL || 'chrome';
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ': ' + String(detail).slice(0, 400) : ''}`); if (!ok) failed++; };
if (!browserApp(channel)) { console.log(`SKIP no ${channel} installed`); process.exit(0); }

const fx = startFixture({ chatPort: 47811, adminPort: 47812 });
// A page that sends (POST) and reads (GET), and one with a closed shadow root.
const seen = [];
const side = createServer((q, s) => {
  seen.push(`${q.method} ${q.url}`);
  s.setHeader('content-type', 'text/html');
  if (q.url === '/') return s.end(`<button id="send" onclick="fetch('/send',{method:'POST',body:'x'}).then(r=>document.title='sent '+r.status,e=>document.title='held')">Send</button>
<x-closed></x-closed><script>customElements.define('x-closed', class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'closed' }).innerHTML = '<b>inside</b>'; } });</script>`);
  s.end('ok');
}).listen(47813, '127.0.0.1');
const SIDE = 'http://127.0.0.1:47813/';
const log = [];
const t0 = Date.now();
const cb = await openCaptureBrowser({ channel, viewport: { width: 1600, height: 900, dpr: 1 }, log: s => log.push(s) });
check('the capture browser starts', !!cb, log.join('\n'));
if (!cb) { fx.close(); side.close(); process.exit(1); }
try {
  const info0 = await cb.info();
  console.log(`capture browser: ${JSON.stringify({ mode: info0.mode, fellBack: info0.fellBack, startMs: info0.startMs, ms: Date.now() - t0 })}`);
  check(`auto picks a mode that draws here (${platformWindow()} first)`, ['minimized', 'offscreen'].includes(info0.mode), JSON.stringify(info0.fellBack));
  check('nothing on the screen', info0.wins.every(w => w.state === 'minimized' || w.left <= -10000), JSON.stringify(info0.wins));

  // An app at the demo's viewport, light, drawing, focused, never raised.
  const chat = await cb.open(fx.chat);
  await chat.waitForLoadState('load');
  const p = await cb.probe(chat);
  check('a page draws off the screen (rAF, timers)', p.raf >= 30 && p.timer250 < 400, JSON.stringify(p));
  check('at the demo\'s viewport', p.size[0] === 1600 && p.size[1] === 900 && p.dpr === 1, JSON.stringify(p));
  check('light, visible, focused', !p.dark && !p.hidden && p.focus, JSON.stringify(p));
  // A shot at the demo's viewport and pixel ratio, whatever the display's; the page keeps its ratio after it.
  const shot = await chat.screenshot();
  const dims = [shot.readUInt32BE(16), shot.readUInt32BE(20)].join('x');
  check('a shot is the demo\'s viewport at its pixel ratio (1600x900)', dims === '1600x900', dims);
  const after = await chat.evaluate(() => devicePixelRatio);
  check('and the page keeps the demo\'s pixel ratio after it', after === 1, String(after));
  // A demo at pixel ratio 2 (as the app makes them: 1920 × 1080 @2) gets its shots at 2, on any display.
  const two = await cb.open(fx.chat, { viewport: { width: 800, height: 450, dpr: 2 } });
  const s2 = await two.screenshot();
  check('a shot at pixel ratio 2 is twice the viewport (1600x900)', [s2.readUInt32BE(16), s2.readUInt32BE(20)].join('x') === '1600x900' && await two.evaluate(() => devicePixelRatio) === 2, `${s2.readUInt32BE(16)}x${s2.readUInt32BE(20)}`);
  await two.close();
  await chat.bringToFront();
  const info1 = await cb.info();
  check('bringToFront leaves it off the screen', info1.wins.every(w => w.state === 'minimized' || w.left <= -10000), JSON.stringify(info1.wins));
  // A menu through CDP input: no pointer of the presenter's, no focus taken.
  await chat.mouse.click(5, 5);
  check('CDP input reaches the page', await chat.evaluate(() => document.readyState === 'complete'));

  // The recorder's zoom sweep ends by clearing the device metrics: the demo's viewport comes back.
  const s = await chat.context().newCDPSession(chat);
  await s.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 450, deviceScaleFactor: 2, mobile: false });
  await s.send('Emulation.clearDeviceMetricsOverride'); await s.detach();
  const back = await chat.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]);
  check('a cleared zoom goes back to the demo\'s viewport', back.join() === '1600,900,1', back.join());
  // Mid-zoom, a session that never touched the viewport (a snapshot's, for closed shadow roots) comes and goes: the
  // zoom stays for the capture.
  const z = await chat.context().newCDPSession(chat);
  await z.send('Emulation.setDeviceMetricsOverride', { width: 1067, height: 600, deviceScaleFactor: 1.5, mobile: false });
  const other = await chat.context().newCDPSession(chat); await other.send('DOM.enable'); await other.detach();
  const mid = await chat.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]);
  check('another session coming and going leaves a zoom as it is', mid.join() === '1067,600,1.5', mid.join());
  // A shot mid-zoom is the zoomed page, and the zoom stays for what comes after it.
  const zs = await chat.screenshot();
  const zmid = await chat.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]);
  check('a shot mid-zoom is the zoomed page (1067 × 600 at 1.5), and leaves the zoom', Math.abs(zs.readUInt32BE(16) - 1600) <= 1 && zs.readUInt32BE(20) === 900 && zmid.join() === '1067,600,1.5', `${zs.readUInt32BE(16)}x${zs.readUInt32BE(20)} ${zmid.join()}`);
  await z.send('Emulation.clearDeviceMetricsOverride'); await z.detach();
  const restored = await chat.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]);
  check('and the zoom\'s own session going puts the viewport back', restored.join() === '1600,900,1', restored.join());

  // Twins: three windows of one app at once, every one drawing.
  const tw = await cb.twins(fx.admin, 3);
  const tp = await Promise.all(tw.map(x => cb.probe(x)));
  check('3 twins, every one drawing', tp.every(x => x.raf >= 30), JSON.stringify(tp.map(x => x.raf)));
  for (const x of tw) await x.close();

  // The context's newPage (the recorder's side pages) gets a window of its own too.
  const extra = await chat.context().newPage();
  check('the context\'s new pages get a window of their own', (await cb.probe(extra)).raf >= 30);
  await extra.close();

  // Signed in? Both fixture apps land on themselves.
  const si = await cb.signedIn([{ id: 'chat', url: fx.chat }, { id: 'admin', url: fx.admin }], { settleMs: 300 });
  check('signedIn: every app on itself', si.ok && si.apps.every(a => a.at === 'app'), JSON.stringify(si.apps));

  // The read-only guard: the page's POST is held before it leaves; pass() lets a planned one through.
  const g = await cb.guard({ local: true });
  const sp = await cb.open(SIDE);
  await sp.waitForLoadState('load');
  await sp.click('#send'); await sp.waitForFunction(() => document.title !== '', null, { timeout: 10000 }).catch(() => {});
  check('the guard holds a POST', await sp.title() === 'held' && !seen.includes('POST /send'), `${await sp.title()} ${seen.join(',')}`);
  await g.pass(async () => { await sp.evaluate(() => { document.title = ''; }); await sp.click('#send'); await sp.waitForFunction(() => document.title !== '', null, { timeout: 10000 }).catch(() => {}); });
  check('pass() lets a planned one through', (await sp.title()).startsWith('sent') && seen.includes('POST /send'), `${await sp.title()} ${seen.join(',')}`);
  check('the guard counts what it held and passed', Object.keys(g.counts()).some(k => k.startsWith('held POST')) && g.held().length === 1, JSON.stringify(g.counts()));
  await g.stop();

  // Closed shadow roots, through the DevTools protocol (the extension's way), for the serializer.
  const EXPOSE = new Function(readFileSync(fileURLToPath(import.meta.resolve('@stuntdouble/capture/cdp-shadow.js')), 'utf8') + '\nreturn EXPOSE_SHADOW;')();
  const n = await EXPOSE(sp);
  check('a closed shadow root handed to the page', n === 1 && await sp.evaluate(() => { const h = document.querySelector('x-closed'); return !!(window.__scShadow && window.__scShadow.get(h)); }), `found ${n}`);
  await sp.close();
} catch (e) { check('ran to the end', false, e.stack); }
finally { await cb.close(); }

// The checker's shape (Phase 6's launchRealChrome), from the same launcher.
const rc = await launchRealChrome({ channel });
check('launchRealChrome', !!rc);
if (rc) { const pg = await rc.newPage(); await pg.goto(fx.chat); check('the checker\'s page loads', (await pg.title()) !== null); await rc.close(); }
fx.close(); side.close();
// Every Chrome it started is gone.
await new Promise(r => setTimeout(r, 1000));
const left = process.platform === 'win32' ? '' : (spawnSync('pgrep', ['-f', 'stuntdouble-capture-'], { encoding: 'utf8' }).stdout || '').trim();
check('no capture browser left running', !left, left);
console.log(failed ? `${failed} FAILED` : 'capture browser: all passed');
process.exit(failed ? 1 : 0);
