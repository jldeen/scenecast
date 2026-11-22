// The presenter guide's "On screen now" pictures (presenter/shots/*.png): each beat's starting screen, and the first
// screen it shows on each other app (presenter/notes.json `shots`, from `scenecast notes`). Rendered from the replica in
// headless Chrome at the demo's viewport, saved at half size. Pictures no beat uses any more are removed;
// shots/shots.json lists what each picture is of.
//   node checks/guide-shots.mjs --demo <dir> [--url http://127.0.0.1:N/]
// demo.json presenter.shotWait: { "<app>": ms } waits longer on a slow screen (a trace viewer drawing its snapshot).
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadDemo, arg } from '@stuntdouble/core/lib/demo.mjs';
import { replicaServer } from '@stuntdouble/core/lib/server.mjs';

const args = process.argv.slice(2);
const demo = loadDemo(args);
const nf = join(demo.dir, 'presenter', 'notes.json');
if (!existsSync(nf)) { console.log('no presenter/notes.json: run `scenecast notes` first'); process.exit(1); }
const notes = JSON.parse(readFileSync(nf, 'utf8'));
const out = join(demo.dir, 'presenter', 'shots');
mkdirSync(out, { recursive: true });
const wait = (demo.cfg.presenter || {}).shotWait || {};
const VP = demo.cfg.viewport;
const srv = await replicaServer(demo, arg(args, '--url'));
const b = await chromium.launch({ channel: process.env.REPLICA_CHROME_CHANNEL || 'chrome', headless: true });
try {
  const p = await b.newPage({ viewport: { width: VP.width, height: VP.height }, deviceScaleFactor: 0.5 });
  await p.goto(srv.url); await p.waitForFunction(() => window.d1 && window.d1.state && window.d1.state.active);
  for (const s of notes.shots) {
    await p.evaluate(async ([a, st]) => { await window.d1.go(a, st); window.d1.activate(a); await window.d1.idle(); }, [s.app, s.state]);
    await p.mouse.move(VP.width - 2, 2);
    await p.waitForTimeout(400 + (wait[s.app] || 0));
    await p.screenshot({ path: join(out, s.name + '.png') });
    console.log(`${s.name}: ${s.app} ${s.state} (beat${s.beats.length > 1 ? 's' : ''} ${s.beats.join(', ')})`);
  }
  const keep = new Set(notes.shots.map(s => s.name + '.png'));
  for (const f of readdirSync(out)) if (f.endsWith('.png') && !keep.has(f)) { rmSync(join(out, f)); console.log(`removed ${f} (no beat uses it)`); }
  // What these pictures are of, so a tool can tell when they need making again (the desktop app does).
  writeFileSync(join(out, 'shots.json'), JSON.stringify(notes.shots.map(s => [s.name, s.app, s.state])) + '\n');
  console.log(`${notes.shots.length} pictures → ${out}`);
} finally { await b.close(); srv.stop(); }
