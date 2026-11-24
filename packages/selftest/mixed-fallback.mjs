import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { selftestGuard } from './guard.mjs';

const temp = mkdtempSync(join(tmpdir(), 'scenecast-mixed-'));
await selftestGuard({ tmp: temp });
const bundle = join(temp, 'bundle'), output = join(temp, 'export');
const binary = process.env.SCENECAST_BIN ? resolve(process.env.SCENECAST_BIN) : resolve('target/debug', process.platform === 'win32' ? 'scenecast.exe' : 'scenecast');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const bounds = { x: 0, y: 0, width: 1, height: 1 };
let server, browser;
try {
  mkdirSync(join(bundle, 'data', 'snaps'), { recursive: true });
  mkdirSync(join(bundle, 'data', 'assets'), { recursive: true });
  mkdirSync(join(bundle, 'captures'), { recursive: true });
  writeFileSync(join(bundle, 'data', 'snaps', 'live.html'), '<!doctype html><html><body><button>Open fallback</button><img src="../assets/fixture.png"></body></html>');
  writeFileSync(join(bundle, 'data', 'assets', 'fixture.png'), png);
  for (const name of ['still.png', 'frame.png', 'video-frame.png']) writeFileSync(join(bundle, 'captures', name), png);
  const manifest = {
    schema_version: 'scenecast.bundle.v2', title: 'Mixed fixture',
    apps: [{ id: 'a', title: 'A', key: 'A' }],
    graph: { start_scene: 'live', scenes: [
      { id: 'live', title: 'Live', live: { app: 'a', snapshot: 'data/snaps/live.html' },
        transitions: [{ trigger: 'click', target: 'still', matcher: { sel: 'button' } }] },
      { id: 'still', title: 'Still', kind: 'screenshot', assets: { screenshot: 'captures/still.png' },
        hotspots: [{ id: 'next', label: 'Next', target: 'frame', bounds, trigger: 'scroll', scroll_direction: 'down',
          transition: { frames: [{ path: 'captures/frame.png', duration_ms: 600 }] } }] },
      { id: 'frame', title: 'Video frame', kind: 'video-frame', assets: { screenshot: 'captures/video-frame.png' },
        hotspots: [{ id: 'back', label: 'Back', target: 'live', bounds }] },
    ] },
    beats: [
      { label: 'Reset', active: 'a', scenes: { a: 'live' } },
      { label: 'Still', active: 'a', scenes: { a: 'still' } },
    ],
  };
  writeFileSync(join(bundle, 'manifest.json'), JSON.stringify(manifest));
  const exported = spawnSync(binary, ['export-html', bundle, output], { encoding: 'utf8' });
  assert.equal(exported.status, 0, exported.stderr);
  server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (!path.startsWith('/nested/')) { res.writeHead(404).end(); return; }
    try {
      const file = join(output, decodeURIComponent(path.slice('/nested/'.length)) || 'index.html');
      const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.json') ? 'application/json' : file.endsWith('.png') ? 'image/png' : 'application/octet-stream';
      const contents = readFileSync(file);
      res.writeHead(200, { 'content-type': type }).end(contents);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const url of [`http://127.0.0.1:${server.address().port}/nested/`, pathToFileURL(join(output, 'index.html')).href]) {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(url);
    const state = id => page.waitForFunction(id => window.d1?.state.states.a === id && !window.d1.state.busy, id);
    await state('live');
    await page.frameLocator('iframe').getByRole('button', { name: 'Open fallback' }).click();
    await state('still');
    await page.waitForFunction(() => window.d1.doc().querySelector('img')?.naturalWidth === 1);
    await page.mouse.move(400, 300);
    await page.mouse.wheel(0, -100);
    assert.equal(await page.evaluate(() => window.d1.state.states.a), 'still');
    await page.mouse.wheel(0, 100);
    await page.waitForFunction(() => window.d1.state.busy > 0);
    await state('frame');
    await page.waitForFunction(() => window.d1.doc().querySelector('img')?.naturalWidth === 1);
    await page.mouse.click(400, 300);
    await state('live');
    try { await page.waitForFunction(() => window.d1.doc().querySelector('img')?.naturalWidth === 1, null, { timeout: 5000 }); }
    catch (e) {
      console.error(url, await page.evaluate(() => ({ url: window.d1.doc().URL, html: window.d1.doc().documentElement.outerHTML, errors: window.d1.errors })));
      throw e;
    }
    assert.deepEqual(await page.evaluate(() => window.d1.errors), []);
    assert.deepEqual(errors, []);
    await page.evaluate(() => window.d1.jump(1));
    await state('still');
    await page.evaluate(() => window.d1.jump(0));
    await state('live');
    await page.close();
  }
  console.log('Mixed live-page, screenshot and video-frame playback passed over HTTP and file://');
} finally {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  rmSync(temp, { recursive: true, force: true });
}
