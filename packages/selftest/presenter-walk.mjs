// The presenter guide on the fixture (called by selftest.mjs once the fixture replica is built and released, or on its
// own on a kept self-test demo): notes from the fixture's own script (examples/fixture-app/script.md, the one script
// to focus points reads), then a script with parts, a beat with no screen of its own, watch-outs and an End;
// `scenecast notes`, `scenecast guide-shots`, then the walk (`scenecast notes --check`) as a Mac and as Edge on
// Windows: ⌥G opens the guide, it follows the stage, Back/Next browse without moving it, "Go to this beat on stage"
// moves it, → steps over the beat with no screen, the timer runs and resets; a script change shows as out of date;
// the text and RunLines formats; the checklist's notes item, and quick only when the guide's inputs changed.
//   node packages/selftest/presenter-walk.mjs <demo dir>      (SCENECAST_BIN, else target/debug/scenecast)
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { freePort } from '../kit/lib/server.mjs';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(KIT, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const binary = () => process.env.SCENECAST_BIN ? resolvePath(process.env.SCENECAST_BIN) : join(ROOT, 'target', 'debug', process.platform === 'win32' ? 'scenecast.exe' : 'scenecast');
const scenecast = (BIN, DEMO, ...args) => new Promise(res => {
  const env = typeof args[args.length - 1] === 'object' ? args.pop() : {};
  const p = spawn(BIN, args, { cwd: DEMO, env: { ...process.env, REPLICA_NO_OPEN: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d); p.on('close', code => res({ code, out }));
});

export function fixtureScript(flow) {
  const K = flow.beats.length - 1;
  const t = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  let md = `# Fixture script: The supplier delay\n\n# Part 1 · What's at risk · 0:00–${t(30 * 2)}\nThe delay, and the orders it touches.\n\n## Backstage · before the talk\n- **Start presenting** in the app and press **⌥0**.\n- **Open presenter guide** and keep it on the laptop screen.\n\n`;
  for (let n = 1; n <= K; n++) {
    if (n === 3) md += `# Part 2 · What it costs · ${t(60)}–${t(30 * (K + 1))}\nThe cost, from the same answer.\n\n`;
    md += `## ${n}. Beat ${n}, on ${flow.beats[n].active} · ${t(30 * (n - 1))}–${t(30 * n)}\n*Screen:* ${flow.beats[n].active} (**⌥${n}**)\n\n**Say**\n\n> Line one of beat ${n}, with *emphasis* and \`code\`.\n>\n> Line two of beat ${n}. Press **⌥F** when it shows.\n${n === 2 ? '>\n> *(If it\'s slow)* Give it a second; it\'s thinking.\n' : ''}\n**Do**\n\n- Press **⌥${n}**.\n${n === 1 ? '  - Then **⌥F**.\n' : ''}- Click **Next thing**.\n\n`;
  }
  md += `## ${K + 1}. Takeaways · ${t(30 * K)}–${t(30 * K + 20)}\n*Screen:* the answer stays\n\n**Say**\n\n> Three things to remember.\n\n`;
  md += `## If something goes wrong\n- **Stuck zoomed in:** press **Esc**.\n- **Lost your place:** in beat 2, press **⌥2**.\n\n## After the talk\nLeave the last screen up.\n`;
  return md;
}

export async function presenterWalk({ DEMO, check, BIN = binary() }) {
  const run = (...a) => scenecast(BIN, DEMO, ...a);
  const notesOf = () => JSON.parse(readFileSync(join(DEMO, 'presenter', 'notes.json'), 'utf8'));
  const flow = JSON.parse(readFileSync(join(DEMO, 'flow.json'), 'utf8'));
  const K = flow.beats.length - 1;
  const t0 = Date.now();
  // A clean start (the walk can run again on a kept demo): no guide yet.
  rmSync(join(DEMO, 'presenter'), { recursive: true, force: true });
  const cfg0 = JSON.parse(readFileSync(join(DEMO, 'demo.json'), 'utf8'));
  if (cfg0.presenter) { delete cfg0.presenter; writeFileSync(join(DEMO, 'demo.json'), JSON.stringify(cfg0, null, 2) + '\n'); }
  // The script the app keeps (script.md, the one script to focus points reads): the guide reads it as it is.
  copyFileSync(join(ROOT, 'examples', 'fixture-app', 'script.md'), join(DEMO, 'script.md'));
  let r = await run('notes');
  let N = notesOf();
  check('presenter: notes from the demo\'s own script (the one focus points come from)', r.code === 0 && N.script === 'script.md' && N.beats.length === 6 && N.beats[1].title === 'The question' && N.beats[1].say.length === 5 && N.beats[4].say[0].text === 'Then I ask what it will cost us.' && N.beats[1].do.length === 2, r.out + JSON.stringify(N.beats.map(b => [b.title, b.say.length, b.do.length])));
  // The richer script, in presenter/ (looked for first).
  const SCRIPT = join(DEMO, 'presenter', 'script.md');
  mkdirSync(dirname(SCRIPT), { recursive: true });
  writeFileSync(SCRIPT, fixtureScript(flow));
  r = await run('notes');
  N = notesOf();
  const B = N.beats, LAST = B.length - 1;
  check('presenter: scenecast notes', r.code === 0 && B.length === K + 3 && N.title === 'The supplier delay' && N.parts.length === 2 && N.parts[1].from === 3 && N.channel.startsWith('scenecast-presenter:'), r.out);
  check('presenter: talk track word for word, alternatives, clicks with sub-steps', B[2].say.length === 3 && B[2].say[2].alt === "If it's slow" && B[1].say[0].text === 'Line one of beat 1, with *emphasis* and `code`.' && B[1].do.length === 3 && B[1].do[1].level === 1, JSON.stringify([B[1], B[2].say]));
  check('presenter: watch-outs by beat (beat 2), the rest before the talk', B[2].watch.some(w => /Lost your place/.test(w)) && B[0].watch.some(w => /Stuck zoomed in/.test(w)) && !B[1].watch.length, JSON.stringify(B.map(b => b.watch)));
  check('presenter: times and the timer\'s start', B[1].start === 0 && B[2].time === '0:30–1:00' && B[K + 1].end === 30 * K + 20, JSON.stringify(B.map(b => b.time)));
  check('presenter: focus points per beat', (flow.focus || []).every(p => (B[p.beat || 0].focus || []).length > 0), JSON.stringify(B.map(b => b.focus)));
  const SB = N.stage.beats;
  check('presenter: each beat on the stage; the extra beat shares the last one\'s screen', SB.slice(1, K + 1).every(b => b.own && b.jump === b.n) && !SB[K + 1].own && JSON.stringify(SB[K + 1].lands) === JSON.stringify(SB[K].lands) && !SB[LAST].own, JSON.stringify(SB));
  let t1 = Date.now();
  r = await run('guide-shots');
  const shotSecs = Math.round((Date.now() - t1) / 1000);
  check('presenter: scenecast guide-shots', r.code === 0 && N.shots.every(s => existsSync(join(DEMO, 'presenter', 'shots', s.name + '.png'))), r.out);
  // The walk: script ↔ guide ↔ replica, as a Mac and as Edge on Windows.
  t1 = Date.now();
  r = await run('notes', '--check');
  const walkSecs = Math.round((Date.now() - t1) / 1000);
  let rep = JSON.parse(readFileSync(join(DEMO, '.out', 'notes-check.json'), 'utf8'));
  const ids = ['script', 'focus-beats', 'stage', 'pictures', 'window-opens', 'window-content', 'window-follows', 'window-browses', 'window-clicker', 'window-goes', 'timer', 'steps', 'errors'];
  check('presenter walk: ⌥G opens the guide; it follows, browses, a clicker\'s Page Down moves the stage, goes, steps, times; script, guide and replica agree', r.code === 0 && rep.pass && ids.every(id => (rep.items.find(i => i.id === id) || {}).status === 'pass') && /over \d+ beats?/.test((rep.items.find(i => i.id === 'steps') || {}).detail), r.out);
  // In Edge too, where it's installed (the macOS and Windows runners): on Windows, its real Ctrl+Alt keys.
  if (process.platform === 'win32' || process.platform === 'darwin') {
    r = await run('notes', '--check', { REPLICA_CHROME_CHANNEL: 'msedge' });
    rep = JSON.parse(readFileSync(join(DEMO, '.out', 'notes-check.json'), 'utf8'));
    check(`presenter walk in Edge (${process.platform === 'win32' ? 'Windows, Ctrl+Alt' : 'Mac, ⌥'})`, r.code === 0 && rep.pass && ids.every(id => (rep.items.find(i => i.id === id) || {}).status === 'pass') && (process.platform !== 'win32' || /Ctrl\+Alt\+G/.test(rep.items.find(i => i.id === 'window-opens').detail)), r.out);
  }
  r = await run('notes', '--check', '--as-windows');
  rep = JSON.parse(readFileSync(join(DEMO, '.out', 'notes-check.json'), 'utf8'));
  check('presenter walk as Edge on Windows: Ctrl+Alt keys, the guide reads Ctrl+Alt', r.code === 0 && rep.pass && rep.windows && /Ctrl\+Alt\+G/.test(rep.items.find(i => i.id === 'window-opens').detail), r.out);
  // On Windows, Alt+G alone does nothing (Edge keeps Alt for its menus); Ctrl+Alt+G opens the guide. The guide is
  // served at /presenter.html, with its notes and pictures from the demo's presenter/ folder.
  {
    const port = await freePort();
    const srv = spawn(process.execPath, [join(KIT, 'player', 'serve.mjs'), '--demo', DEMO, '--port', String(port), '--no-editor'], { cwd: DEMO, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, REPLICA_NO_OPEN: '1' } });
    const url = await new Promise(res => { let o = ''; srv.stdout.on('data', d => { o += d; const m = /(http:\/\/127\.0\.0\.1:\d+\/)/.exec(o); if (m) res(m[1]); }); setTimeout(() => res(null), 15000); });
    const b = await chromium.launch({ channel: process.env.REPLICA_CHROME_CHANNEL || 'chrome', headless: true });
    try {
      const served = await Promise.all(['presenter.html', 'presenter/presenter.js', 'presenter/notes.json', `presenter/shots/${N.shots[0].name}.png`, 'presenter/..%2Fdemo.json'].map(async p => (await fetch(url + p)).status));
      check('presenter: the guide, its notes and pictures are served; nothing outside presenter/', served.join() === '200,200,200,200,404', served.join());
      const ctx = await b.newContext();
      const p = await ctx.newPage();
      await (await ctx.newCDPSession(p)).send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0', platform: 'Win32', userAgentMetadata: { platform: 'Windows', platformVersion: '15.0.0', architecture: 'x86', model: '', mobile: false, brands: [{ brand: 'Microsoft Edge', version: '142' }] } });
      await p.goto(url); await p.waitForFunction(() => window.d1 && window.d1.presenter);
      const pages = () => ctx.pages().length;
      await p.keyboard.press('Alt+KeyG'); await sleep(600);
      const altAlone = pages();
      await p.keyboard.press('Control+Alt+KeyG'); await sleep(600);
      check('presenter: on Windows Alt+G does nothing, Ctrl+Alt+G opens the guide', altAlone === 1 && pages() === 2, JSON.stringify({ altAlone, after: pages() }));
    } finally { await b.close(); srv.kill(); }
  }
  // A change to the script shows: the check says notes.json is out of date until `scenecast notes` runs.
  writeFileSync(SCRIPT, fixtureScript(flow).replace('Line two of beat 2.', 'Line two of beat 2, changed.'));
  r = await run('notes', '--check');
  rep = JSON.parse(readFileSync(join(DEMO, '.out', 'notes-check.json'), 'utf8'));
  const sc = rep.items.find(i => i.id === 'script') || {};
  check('presenter: a script change shows as out of date', r.code === 1 && sc.status === 'fail' && /Beat 2: say/.test(sc.detail), JSON.stringify(sc));
  writeFileSync(SCRIPT, fixtureScript(flow));
  // The other formats: plain text and RunLines.
  writeFileSync(join(DEMO, 'presenter', 'script.txt'), `Title: Plain\n\nRun the replica.\n\nBeat 1: Open (0:20)\nScreen: the chat\nHello, everyone.\nDo: Press ⌥1.\nBeat 2: The answer (0:40)\nIt pulls it together.\nWatch: Wait for it.\n`);
  r = await run('notes', '--script', join(DEMO, 'presenter', 'script.txt'));
  N = notesOf();
  check('presenter: a plain-text script', r.code === 0 && N.title === 'Plain' && N.beats.length === 4 && N.beats[2].time === '0:20–1:00' && N.beats[1].do.length === 1 && N.beats[2].watch[0] === 'Wait for it.' && N.beats[0].do[0].text === 'Run the replica.', JSON.stringify(N.beats.map(b => [b.title, b.time, b.say, b.do, b.watch])));
  writeFileSync(join(DEMO, 'presenter', 'script.sk'), JSON.stringify({ title: 'RunLines', rows: [{ time: '~10s', narrative: 'Hi.\nLet me show you.', demo_actions: '[OPEN] Walk on · DO NOT CLICK' }, { time: '~40s', narrative: 'One question.', demo_actions: '[ONE QUESTION]' }] }));
  r = await run('notes', '--script', join(DEMO, 'presenter', 'script.sk'));
  N = notesOf();
  check('presenter: a RunLines script', r.code === 0 && N.title === 'RunLines' && N.beats[1].title === 'Open' && N.beats[1].say.length === 2 && N.beats[1].do.length === 2 && N.beats[2].time === '0:10–0:50', JSON.stringify(N.beats.map(b => [b.title, b.time, b.say.length, b.do.length])));
  r = await run('notes', '--script', SCRIPT);
  const cfg = JSON.parse(readFileSync(join(DEMO, 'demo.json'), 'utf8'));
  check('presenter: back to the Markdown script (demo.json presenter.script)', r.code === 0 && cfg.presenter.script === 'presenter/script.md', r.out);
  // The checklist's notes item; quick runs it only when the guide's inputs changed.
  r = await run('check', '--only', 'notes');
  const fid = JSON.parse(readFileSync(join(DEMO, '.out', 'fidelity.json'), 'utf8'));
  check('presenter: the checklist\'s notes item', r.code === 0 && (fid.items.find(i => i.id === 'notes') || {}).status === 'pass', r.out.slice(-600));
  // (The editor's test left a date change, "due Monday": the script's focus points follow it.)
  r = await run('quick');
  const q1 = JSON.parse(readFileSync(join(DEMO, '.out', 'quick.json'), 'utf8'));
  // quick makes the notes again from the changed script itself, then checks the guide.
  writeFileSync(SCRIPT, fixtureScript(flow).replace('Three things to remember.', 'Two things to remember.'));
  r = await run('quick');
  const q2 = JSON.parse(readFileSync(join(DEMO, '.out', 'quick.json'), 'utf8'));
  const q2notes = q2.items.find(i => i.id === 'notes') || {};
  r = await run('quick');
  const q3 = JSON.parse(readFileSync(join(DEMO, '.out', 'quick.json'), 'utf8'));
  check('quick: the guide is checked when its script changes, and not again until it changes',
    q1.pass && q2.pass && q2notes.status === 'pass' && !q2.scope.length && q3.pass && !q3.items.some(i => i.id === 'notes') && notesOf().beats.some(b => b.say.some(x => x.text === 'Two things to remember.')),
    JSON.stringify([q1.items.map(i => i.id), q2.items.map(i => [i.id, i.status]), q3.items.map(i => i.id)]));
  return { secs: Math.round((Date.now() - t0) / 1000), shotSecs, walkSecs };
}

if (process.argv[1] && process.argv[1].endsWith('presenter-walk.mjs')) {
  const fails = [];
  const check = (name, ok, detail) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? `: ${detail}` : '')); if (!ok) fails.push(name); };
  const t = await presenterWalk({ DEMO: process.argv[2], check });
  console.log(`${fails.length ? `${fails.length} FAILED` : 'ALL PASS'} (${JSON.stringify(t)})`);
  process.exit(fails.length ? 1 : 0);
}
