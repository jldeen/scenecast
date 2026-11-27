// Names and roles, the reader's against the page's. For every control on every recorded screen of a built replica, the
// name and role the reader gives it (packages/script/html.mjs: what plans name steps by) and the ones the page code
// gives it on the served screen (controlOf in the page, page-naming.mjs: what the live outline and walker use). They
// have to be the same, or a plan's step could find a different control live, and a write would click it.
// It also lists the controls the live walker's search skips because they have no size on the page.
// Offline: the replica's own server, headless Chromium, every request off this machine refused.
//   node packages/selftest/name-parity.mjs <built demo> [--port 47801] [--out <report.json>]
// Exits 1 on a difference. capture-run runs it on its own recording (nameParity()).
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { at } from '@stuntdouble/core/lib/at.mjs';
import { CONTROL_NAME_SRC } from '@stuntdouble/capture/page-naming.mjs';
import { readScreen } from '@scenecast/script/html.mjs';

// The reader's walk, in the page: the same elements in the same order (not hidden by an attribute or an inline style,
// not in an svg; inside aria-hidden or inert, not a control), each named the shared way.
const PAGE_WALK = `(() => { ${CONTROL_NAME_SRC}
  const hiddenEl = e => e.hasAttribute('hidden') || /display\\s*:\\s*none|visibility\\s*:\\s*hidden/i.test(e.getAttribute('style') || '') || e.localName === 'svg' || e.localName === 'head';
  const out = [];
  const walk = (e, aria) => {
    for (const c of e.children) {
      if (hiddenEl(c)) continue;
      const a = aria || c.getAttribute('aria-hidden') === 'true' || c.hasAttribute('inert');
      if (!a) { const d = domControl(c); if (d.control && (d.name || /textbox|searchbox|combobox/.test(d.role))) { const r = c.getBoundingClientRect(); out.push({ role: d.role, name: d.name, zero: !r.width || !r.height }); } }
      walk(c, a);
    }
  };
  walk(document, false);
  return out;
})()`;

const norm = s => String(s || '').toLowerCase().replace(/[“”"'’‘]/g, '').replace(/\s+/g, ' ').trim();
const key = c => `${c.role}|${norm(c.name)}`;

export async function nameParity({ demo, port = 47801, log = () => {} }) {
  const dir = resolve(demo), snaps = join(dir, 'data', 'snaps');
  const files = readdirSync(snaps).filter(f => f.endsWith('.html')).sort();
  const server = spawn(process.execPath, [at('player', 'serve.mjs'), '--demo', dir, '--port', String(port)], { stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/manifest.json')).ok) break; } catch (e) {} await new Promise(r => setTimeout(r, 250)); }
  // One that won't start ends the server too: nothing is left on the port.
  const browser = await chromium.launch({ channel: 'chromium', headless: true }).catch(e => { server.kill(); throw e; });
  const out = { screens: 0, controls: 0, same: 0, differ: [], zero: 0, zeroOn: [] };
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    // Nothing leaves this machine: the replica's own server only.
    await page.route('**/*', r => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
    for (const f of files) {
      const reader = readScreen([{ key: 'main', html: readFileSync(join(snaps, f), 'utf8') }]).controls.map(c => ({ role: c.role, name: c.name }));
      await page.goto(`${base}/snaps/${f}`, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
      const live = await page.evaluate(PAGE_WALK).catch(e => ({ error: e.message }));
      if (!Array.isArray(live)) { out.differ.push({ file: f, error: live.error }); continue; }
      out.screens++; out.controls += reader.length;
      const zero = live.filter(c => c.zero);
      out.zero += zero.length;
      if (zero.length) out.zeroOn.push({ file: f, n: zero.length, some: [...new Set(zero.map(c => `${c.role}|${c.name}`))].slice(0, 8) });
      // Compared as a count of each role and name, so a parser's different nesting of bad HTML doesn't misalign them.
      const count = list => list.reduce((m, c) => m.set(key(c), (m.get(key(c)) || 0) + 1), new Map());
      const r = count(reader), l = count(live);
      const onlyReader = [], onlyPage = [];
      for (const [k, n] of r) { const d = n - (l.get(k) || 0); if (d > 0) onlyReader.push(d > 1 ? `${k} ×${d}` : k); }
      for (const [k, n] of l) { const d = n - (r.get(k) || 0); if (d > 0) onlyPage.push(d > 1 ? `${k} ×${d}` : k); }
      out.same += reader.length - onlyReader.reduce((s, k) => s + (+(/×(\d+)$/.exec(k) || [0, 1])[1]), 0);
      if (onlyReader.length || onlyPage.length) { out.differ.push({ file: f, onlyReader, onlyPage }); log(`${f}: reader ${onlyReader.length}, page ${onlyPage.length}`); }
    }
  } finally {
    await browser.close().catch(() => {});
    server.kill();
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const args = process.argv.slice(2);
  const demo = args.find(a => !a.startsWith('--'));
  const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const port = +(opt('--port') || 47801);
  if (!demo) { console.error('usage: node packages/selftest/name-parity.mjs <built demo> [--port N] [--out report.json]'); process.exit(2); }
  if (port >= 47621 && port <= 47630) { console.error('refusing: 47621–47630 are the app\'s receiver ports'); process.exit(2); }
  const r = await nameParity({ demo, port, log: m => console.log(m) });
  if (opt('--out')) writeFileSync(opt('--out'), JSON.stringify(r, null, 1));
  console.log(`${r.screens} screens, ${r.controls} controls: ${r.same} the same, ${r.differ.length} screens differ; ${r.zero} controls with no size (the live search skips them) on ${r.zeroOn.length} screens`);
  process.exit(r.differ.length ? 1 : 0);
}
