// The checker's real Chrome (packages/checks/real-chrome.mjs) draws a page the way the presenter's Chrome did, and
// still sees a difference that's really there.
//   1. One real Chrome plays the presenter's: the fixture chat at 110% page zoom, captured as the recorder does.
//   2. A second one, the checker's (its own profile, hidden), draws the same page: the same to within anti-aliasing.
//   3. Differences planted in the checker's page, one at a time: each one makes the screen differ (verdict, real mode),
//      at the 0.5% bar, and the spot or area it's found in is where it was planted.
// Needs Google Chrome (or Edge) installed: on a machine without either it says so and stops (CI's Linux runner).
//   node packages/selftest/real-chrome-checker.mjs
import './reap.mjs';
import { chromium } from 'playwright-core';
import { startFixture } from '../../examples/fixture-app/server.mjs';
import { launchRealChrome, browserApp } from '@stuntdouble/checks/real-chrome.mjs';
import { diffDetail, verdict, CLUSTER_PX } from '@stuntdouble/checks/compare.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selftestGuard } from './guard.mjs';

await selftestGuard({ tmp: mkdtempSync(join(tmpdir(), 'scenecast-real-chrome-')) });
const channel = browserApp('chrome') ? 'chrome' : browserApp('msedge') ? 'msedge' : null;
if (!channel) { console.log('SKIP real Chrome checker: no Chrome or Edge here'); process.exit(0); }

const fails = [];
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ': ' + detail}`); if (!ok) fails.push(name); };
const ZOOM = 1.1, METRICS = { width: 1512, height: 806, deviceScaleFactor: 2, mobile: false };
const fx = startFixture({ chatPort: 47861, adminPort: 47862 });
const shotOf = async (R, prep) => {
  const p = await R.newPage(); const s = await p.context().newCDPSession(p);
  await s.send('Emulation.setDeviceMetricsOverride', METRICS);
  await p.goto(fx.chat); await p.waitForTimeout(800);
  if (prep) { await p.evaluate(prep); await p.waitForTimeout(300); }
  await p.mouse.move(1, 1);
  return { png: Buffer.from((await s.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'), inner: await p.evaluate(() => [innerWidth, devicePixelRatio]) };
};
const cmpB = await chromium.launch({ headless: true });
const cmp = await (await cmpB.newContext()).newPage();
const diff = async (a, b) => (await diffDetail(cmp, [{ real: a.toString('base64'), replica: b.toString('base64') }]))[0];
try {
  const presenter = await launchRealChrome({ zoom: ZOOM, channel });
  if (!presenter) { console.log('SKIP real Chrome checker: the browser didn\'t start'); process.exit(0); }
  const real = await shotOf(presenter);
  await presenter.close();
  check('the presenter\'s Chrome at 110%: 1374 CSS px at 2.2', Math.abs(real.inner[0] - 1374) <= 1 && Math.abs(real.inner[1] - 2.2) < 0.01, JSON.stringify(real.inner));

  const checker = await launchRealChrome({ zoom: ZOOM, channel });
  const same = await shotOf(checker);
  const base = await diff(real.png, same.png);
  check('the checker\'s Chrome draws it the same (≤0.05%)', base.pct <= 0.05, `${base.pct}%`);

  // Each planted in the checker's page, and where it is (CSS px, for the region found).
  const plants = [
    ['a changed word', () => { const h = document.querySelector('h1'); h.textContent = h.textContent.replace('working on', 'working at'); }, 'h1'],
    ['a 1-px border', () => { document.querySelector('[aria-label="Workspace"]').style.outline = '1px solid #c8c8c8'; }, '[aria-label="Workspace"]'],
    ['a clearly wrong colour', () => { document.querySelector('[aria-label="Send"]').style.background = '#d13438'; }, '[aria-label="Send"]'],
    // A panel's background lost (its CSS variable falling back to white): #f6f7f9 → #fff, under the per-pixel tolerance.
    ['a panel\'s background lost', () => { document.querySelector('[aria-label="Sidebar"]').style.background = '#ffffff'; }, '[aria-label="Sidebar"]'],
    ['a missing icon', () => { document.querySelector('[aria-label="Send"]').style.visibility = 'hidden'; }, '[aria-label="Send"]'],
    ['a 2-px shift', () => { document.querySelector('h1').style.transform = 'translateX(2px)'; }, 'h1'],
  ];
  check('the same page passes (no spot, no area)', verdict(base, { real: true }).pass, JSON.stringify({ spot: base.regions[0], area: base.areas[0] }));
  const results = [];
  for (const [name, prep, sel] of plants) {
    const shot = await shotOf(checker, prep);
    const d = await diff(real.png, shot.png), v = verdict(d, { real: true });
    // Where it was planted, in device pixels (2.2 a CSS px).
    const box = await (async () => { const p = await checker.newPage(); const s = await p.context().newCDPSession(p); await s.send('Emulation.setDeviceMetricsOverride', METRICS); await p.goto(fx.chat); await p.waitForTimeout(500); const r = await p.evaluate(q => { const b = document.querySelector(q).getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; }, sel); await p.close(); return r.map(v => v * 2.2); })();
    const at = v.spot || v.area, near = at && at.x <= box[0] + box[2] + 40 && at.x + at.w >= box[0] - 40 && at.y <= box[1] + box[3] + 40 && at.y + at.h >= box[1] - 40;
    results.push(`${name}: ${d.pct}%, largest spot ${(d.regions[0] || {}).px || 0} px, area ${(d.areas[0] || {}).pct || 0}% → ${v.why}`);
    check(`planted ${name}: caught (${v.why || 'missed'}), where it was planted`, !v.pass && (v.why === 'share' || near), JSON.stringify({ v, box }));
  }
  console.log('PLANTS ' + results.join(' · '));
  await checker.close();
} finally { await cmpB.close(); fx.close(); }
console.log(fails.length ? `${fails.length} FAILED` : 'real Chrome checker: all pass');
process.exit(fails.length ? 1 : 0);
