// Spike (stage C): does a page draw the same in every window mode? The fixture's screens, a menu opened and a hover
// card shown through CDP input (no OS pointer, no focus), in each mode, screenshot by the browser, compared with the
// visible window's (the screen's own drawing). Also each page's probe (rAF, timers, visibility, focus, light).
//   node spikes/capture-browser/parity.mjs [--modes visible,minimized,offscreen,headless] [--out dir]
// On a machine with a screen of its own (CI); minimized/offscreen/headless only on the presenter's Mac.
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchCaptureBrowser, probe } from './browser.mjs';
import { startFixture } from '../../examples/fixture-app/server.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const MODES = arg('--modes', 'visible,minimized,offscreen,headless').split(',');
const OUT = arg('--out', join(process.env.DIAG_DIR || '.', 'parity'));
mkdirSync(OUT, { recursive: true });
const fx = startFixture({ chatPort: 47821, adminPort: 47822 });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The viewport: what fits a window on this display (CI's Windows screen is 1024 × 768), the same in every mode.
async function fit() {
  const b = await chromium.launch({ channel: 'chrome', headless: true }); await b.close();
  return { width: +arg('--width', 960), height: +arg('--height', 600) };
}
const VP = await fit();

// Each scenario: [name, url, steps on the page (CDP input only)].
const SCENES = [
  ['chat', fx.chat, async p => {}],
  ['chat-menu', fx.chat, async p => { const b = await p.locator('[aria-label="More options"]').boundingBox(); await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2); await p.waitForSelector('[role=menu]'); }],
  ['chat-hover', fx.chat, async p => { const b = await p.locator('[data-chip]').first().boundingBox(); await p.mouse.move(b.x + 5, b.y + 5, { steps: 3 }); await p.waitForSelector('.card-tip', { timeout: 5000 }); }],
  ['admin', fx.admin, async p => {}],
  ['admin-details', fx.admin, async p => { const c = p.locator('[role=gridcell]').first(); const b = await c.boundingBox(); await p.mouse.click(b.x + 10, b.y + 5); await sleep(400); }],
];
const settle = async p => { await p.evaluate(() => document.fonts.ready); await p.mouse.move(VP.width - 2, VP.height - 2); await sleep(150); };

const results = {};
for (const mode of MODES) {
  const t0 = Date.now();
  const cb = await launchCaptureBrowser({ mode, width: VP.width, height: VP.height });
  if (!cb) { results[mode] = { error: 'no browser' }; continue; }
  const r = results[mode] = { startMs: Date.now() - t0, scenes: {} };
  try {
    for (const [name, url, steps] of SCENES) {
      for (const vp of ['window', 'emulated']) {
        if (mode === 'headless' && vp === 'emulated') continue;
        const p = await cb.newPage({ url, width: VP.width, height: VP.height, viewport: vp });
        await p.waitForLoadState('load'); await sleep(500);
        if (!/hover/.test(name)) await settle(p);
        await steps(p);
        if (/hover/.test(name)) await sleep(200);
        const png = await p.screenshot();
        const key = name + (vp === 'emulated' ? '@emulated' : '');
        writeFileSync(join(OUT, `${mode}-${key}.png`), png);
        r.scenes[key] = await probe(p);
        await p.close();
      }
    }
    r.info = await cb.info?.();
  } catch (e) { r.error = String(e.stack || e).slice(0, 600); }
  finally { await cb.close(); }
}

// Each mode's pictures against the visible window's (and each emulated one against its own window), in headless Chrome.
const { comparePngs } = await import('../../packages/checks/compare.mjs');
const cmpB = await chromium.launch({ channel: 'chrome', headless: true });
const cp = await cmpB.newPage();
const b64 = f => { try { return readFileSync(join(OUT, f)).toString('base64'); } catch (e) { return null; } };
const table = [];
for (const [name] of SCENES) for (const mode of MODES) for (const key of [name, name + '@emulated']) {
  const ref = MODES.includes('visible') ? `visible-${name}.png` : `${MODES[0]}-${name}.png`;
  const mine = `${mode}-${key}.png`;
  if (!b64(mine) || mine === ref) continue;
  const [c] = await comparePngs(cp, [[b64(ref), b64(mine)]]);
  table.push({ scene: key, mode, vs: ref.replace('.png', ''), pct: c && c.pct, box: c && c.box });
}
await cmpB.close();
fx.close();
const report = { platform: process.platform, viewport: VP, results, table };
writeFileSync(join(OUT, 'parity.json'), JSON.stringify(report, null, 1));
for (const t of table) console.log(`${t.scene.padEnd(24)} ${t.mode.padEnd(10)} vs ${t.vs.padEnd(18)} ${t.pct}%`);
for (const [mode, r] of Object.entries(results)) {
  if (r.error) { console.log(`${mode}: ERROR ${r.error}`); continue; }
  const s = Object.entries(r.scenes).map(([k, v]) => `${k}: raf ${v.raf} t250 ${v.timer250} ${v.vis}${v.focus ? '' : ' unfocused'}${v.dark ? ' DARK' : ''} ${v.size.join('x')}@${v.dpr}`);
  console.log(`${mode} (start ${r.startMs} ms; windows ${JSON.stringify((r.info && r.info.wins || []).map(w => w.state + '@' + w.left + ',' + w.top))})\n  ` + s.join('\n  '));
}
process.exit(0);
