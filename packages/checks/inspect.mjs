// Dev helper: loads processed snapshots in headless system Chrome and lists elements that match a text or selector,
// with their role, label, test id, tag path and box, to write matchers in flow.overrides.mjs.
//   node checks/inspect.mjs --demo <dir> '<json: [[snapId, {text|sel|re, frame?}], ...]>'   (scenecast serve running)
import { chromium } from 'playwright-core';
import { loadDemo } from '@stuntdouble/core/lib/demo.mjs';

const demo = loadDemo(process.argv.slice(2));
const queries = JSON.parse(process.argv.slice(2).find(a => a.trim().startsWith('[')));
const browser = await chromium.launch({ channel: process.env.REPLICA_CHROME_CHANNEL || 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })).newPage();
let cur = null;
for (const [snap, q] of queries) {
  if (cur !== snap) { await page.goto(`${demo.url}snaps/${snap}.html`, { waitUntil: 'load' }); cur = snap; }
  const res = await page.evaluate(q => {
    const docs = [document, ...[...document.querySelectorAll('iframe')].map(f => { try { return f.contentDocument; } catch (e) { return null; } }).filter(Boolean)];
    const out = [];
    for (const d of docs) {
      const key = d === document ? 'main' : d.defaultView.frameElement.getAttribute('data-d1-frame');
      if (q.frame && q.frame !== key) continue;
      let els = [...d.querySelectorAll(q.sel || '*')];
      if (q.text) els = els.filter(e => (e.innerText || '').replace(/\s+/g, ' ').trim() === q.text);
      if (q.re) els = els.filter(e => new RegExp(q.re).test((e.innerText || '').replace(/\s+/g, ' ').trim()));
      for (const e of els.slice(0, q.n || 6)) {
        const r = e.getBoundingClientRect();
        const path = []; let x = e; for (let i = 0; x && i < 4; i++) { path.unshift(x.localName + (x.getAttribute('role') ? `[role=${x.getAttribute('role')}]` : '')); x = x.parentElement; }
        out.push({ frame: key, tag: e.localName, role: e.getAttribute('role'), label: e.getAttribute('aria-label'), testid: e.getAttribute('data-testid'), ce: e.getAttribute('contenteditable'), cls: (e.getAttribute('class') || '').slice(0, 50), text: (e.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60), box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], path: path.join(' > ') });
      }
    }
    return out;
  }, q);
  console.log(`## ${snap} ${JSON.stringify(q)}`);
  for (const r of res) console.log('  ' + JSON.stringify(r));
}
await browser.close();
