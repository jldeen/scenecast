// The recorder extension in the browsers presenters use: branded Chrome and Edge (which ignore --load-extension, so
// it's loaded through the DevTools protocol, as "Load unpacked" would). For each one installed: the extension
// loads, connects to a receiver, and captures a page (DOM and a real screenshot). Headless, temporary profiles.
//   node packages/selftest/extension-browsers.mjs [chrome] [msedge]
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const want = process.argv.slice(2).length ? process.argv.slice(2) : ['chrome', 'msedge'];
const RXP = '47693';
const page = '<!doctype html><title>Ext</title><style>@font-face{font-family:F;src:url(/f.woff2)}h1{font-family:F}</style><h1>extension capture</h1>';
const site = createServer((q, s) => { if (q.url === '/f.woff2') { s.writeHead(200, { 'content-type': 'font/woff2' }); return s.end('wOF2fake'); } s.writeHead(200, { 'content-type': 'text/html' }); s.end(page); }).listen(47704, '127.0.0.1');
const fails = [], ran = [];
const check = (name, ok, d) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || !d ? '' : ': ' + d)); if (!ok) fails.push(name); };
for (const channel of want) {
  const raw = mkdtempSync(join(tmpdir(), 'scext-'));
  spawnSync(process.execPath, [join(here, '../recorder/build.mjs'), '--extension', join(raw, 'ext'), '--port', RXP], { stdio: 'ignore' });
  let ctx;
  try { ctx = await chromium.launchPersistentContext(join(raw, 'profile'), { channel, headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging', '--silent-debugger-extension-api'] }); }
  catch (e) { console.log(`skip ${channel}: not installed (${String(e.message).split('\n')[0].slice(0, 100)})`); continue; }
  ran.push(channel);
  const rx = spawn(process.execPath, [join(here, '../recorder/receiver.mjs'), raw, RXP], { stdio: 'ignore' });
  try {
    const cdp = await ctx.browser().newBrowserCDPSession();
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: join(raw, 'ext') });
    check(`${channel}: extension loads unpacked`, !!id);
    const p = await ctx.newPage(); await p.goto('http://127.0.0.1:47704/');
    let ping = null;
    for (let i = 0; i < 60; i++) { ping = await fetch(`http://127.0.0.1:${RXP}/ping`).then(r => r.json()).catch(() => null); if (ping && ping.agent && ping.agent.secsAgo !== null) break; await sleep(500); }
    check(`${channel}: extension connects to the receiver`, ping && ping.agent && ping.agent.secsAgo !== null, JSON.stringify(ping));
    const r = spawnSync(process.execPath, [join(here, '../recorder/cli.mjs'), 'snap', JSON.stringify({ tab: '127.0.0.1:47704', id: 'x' }), '60'], { encoding: 'utf8', env: { ...process.env, REPLICA_RX_PORT: RXP } });
    const snap = existsSync(join(raw, 'snaps', 'x.json')) && JSON.parse(readFileSync(join(raw, 'snaps', 'x.json'), 'utf8'));
    check(`${channel}: captures the page`, snap && snap.docs[0].html.includes('extension capture'), r.stdout.slice(0, 300) + r.stderr.slice(0, 300));
    const urls = JSON.parse(readFileSync(join(raw, 'urls.json'), 'utf8'));
    check(`${channel}: fetches its font`, !!(urls['http://127.0.0.1:47704/f.woff2'] || {}).file, JSON.stringify(urls));
    check(`${channel}: real screenshot`, existsSync(join(raw, 'shots', 'x.png')) && readFileSync(join(raw, 'shots', 'x.png')).subarray(1, 4).toString() === 'PNG');
  } catch (e) { check(`${channel}: ran`, false, String(e.stack || e).slice(0, 400)); }
  finally { await ctx.close().catch(() => {}); rx.kill(); }
}
site.close();
if (!ran.length) console.log('no branded Chrome or Edge here: nothing checked');
console.log(fails.length ? `${fails.length} FAILED` : `ALL PASS (${ran.join(', ') || 'none'})`);
process.exit(fails.length ? 1 : 0);
