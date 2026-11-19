#!/usr/bin/env node
// The engine side of the scenecast CLI (from replica-kit 1.4.0). The `scenecast` binary (Rust) runs this for every
// engine command; run it directly only to debug the engine: node packages/kit/bin/scenecast.mjs help
import { spawn } from 'node:child_process';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { KIT, KIT_VERSION, loadDemo, arg } from '../lib/demo.mjs';

const [cmd, ...rest] = process.argv.slice(2);
// Children get the signals this process gets, so stopping `scenecast serve` stops the server too.
const kids = new Set();
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { for (const k of kids) k.kill(sig); process.exit(130); });
const node = (script, args, opts = {}) => new Promise(res => { const p = spawn(process.execPath, [join(KIT, script), ...args], { stdio: 'inherit', ...opts }); kids.add(p); p.on('close', code => { kids.delete(p); res(code); }); });
const exit = code => process.exit(code || 0);
const HELP = `scenecast engine ${KIT_VERSION} (run through the scenecast binary; see docs/cli.md)

  preflight [--check] [--json|--ndjson]  profiles  open-in-browser [<url>]  extension [<outDir>]  agent [<outDir>]  receiver  record start|status|stop|side …  cmd <op> ['{json}']  run <script.js> ['{json}']
  flow [--from-raw]  build [--from-raw] [--force]  serve [--open] [--pace N] [--port N] [--release] [--no-editor]
  script <file> [--matcher text|<file.mjs>] [--no-write] [--no-pdf] [--strict]  edit [--no-open] [--port N]
  notes [--script <file>] [--check [--as-windows]]  guide-shots
  text "<old>" "<new>"  quick  status  save "<message>"  release [--push] [--skip-build]
  check [--runs 2]  checklist [--skip a,b] [--only a,b]  fidelity-compare|fidelity-fix|fidelity-report  sheet  hovers  scan [<dir>]

Every demo command takes --demo <dir>, or runs from inside the demo folder.`

// The receiver's port: --port, else REPLICA_RX_PORT (as preflight and the receiver use it), else the demo's, else the default.
function rx() { const given = arg(rest, '--port') || process.env.REPLICA_RX_PORT; if (given) return +given; try { return loadDemo(rest).cfg.receiverPort; } catch (e) { return 47621; } }
async function send(op, args = {}, tmo = 900) {
  const { send } = await import('../../recorder/cli.mjs');
  process.env.REPLICA_RX_PORT = process.env.REPLICA_RX_PORT || String(rx());
  const r = await send({ op, ...args }, tmo);
  console.log(JSON.stringify(r.ok ? r.value : { error: r.error }, null, 1));
  return r.ok && !(r.value && r.value.error) ? 0 : 1;
}
const jsonArg = () => { const j = rest.find(a => a.trim().startsWith('{')); return j ? JSON.parse(j) : {}; };

// Before a check: the presenter guide's notes made again from the script as it is now (they also carry the focus
// points and beats, which edits change), and its pictures when a beat now starts on another screen. Only for a demo
// that has a guide.
async function refreshGuide(demo) {
  const nf = join(demo.dir, 'presenter', 'notes.json');
  if (!existsSync(nf)) return 0;
  const { compileFlow } = await import('../compile/flow.mjs');
  const { writeNotes, scriptPath } = await import('../lib/notes.mjs');
  const file = scriptPath(demo);
  if (!existsSync(file)) return 0;
  const before = readFileSync(nf, 'utf8');
  const n = writeNotes(demo, (await compileFlow(demo)).flow, file);
  if (readFileSync(nf, 'utf8') !== before) console.log('presenter/notes.json: made again from the script');
  let made = null; try { made = readFileSync(join(demo.dir, 'presenter', 'shots', 'shots.json'), 'utf8').trim(); } catch (e) {}
  const want = JSON.stringify(n.shots.map(x => [x.name, x.app, x.state]));
  if (made !== want || n.shots.some(x => !existsSync(join(demo.dir, 'presenter', 'shots', x.name + '.png')))) return node('checks/guide-shots.mjs', ['--demo', demo.dir]);
  return 0;
}

async function main() {
  switch (cmd) {
    case undefined: case 'help': case '--help': case '-h': console.log(HELP); return 0;
    case 'new': console.log('scenecast new is in the scenecast binary (Rust): it writes the project and its manifest'); return 1;
    case 'extension': {
      // The recorder extension (MV3, Edge and Chrome), unpacked: ~/.scenecast/extension unless a folder is given.
      const { extensionDir } = await import('../lib/profiles.mjs');
      const out = rest.find((a, i) => !a.startsWith('--') && rest[i - 1] !== '--port' && rest[i - 1] !== '--demo') || extensionDir();
      return node('recorder/build.mjs', ['--extension', out, '--port', String(rx())]);
    }
    case 'agent': { const out = rest.find((a, i) => !a.startsWith('--') && rest[i - 1] !== '--port' && rest[i - 1] !== '--demo'); return node('recorder/build.mjs', [...(out ? [out] : []), '--port', String(rx())]); }
    // The browser's profiles (names, pictures, which are open, which have the recorder) and the one this demo uses.
    case 'profiles': { const { demoProfiles } = await import('../lib/preflight.mjs'); console.log(JSON.stringify(await demoProfiles(loadDemo(rest)))); return 0; }
    // Opens a page (edge://extensions) in a window of the demo's profile, in the running browser (never a restart).
    case 'open-in-browser': {
      const { demoProfiles, openInBrowser } = await import('../lib/preflight.mjs');
      const d = await demoProfiles(loadDemo(rest), { pictures: false });
      const url = rest.find((a, i) => !a.startsWith('--') && rest[i - 1] !== '--demo') || `${d.browser}://extensions`;
      const ok = await openInBrowser(url, { browser: d.browser, profile: d.pick.dir });
      console.log(JSON.stringify({ ok, browser: d.browser, profile: d.pick.dir, running: d.running, url })); return ok ? 0 : 1;
    }
    case 'preflight': return (await import('../lib/preflight.mjs')).main(rest, loadDemo);
    case 'receiver': return node('recorder/receiver.mjs', ['--demo', loadDemo(rest).dir]);
    case 'cmd': { const [op, j] = rest; return send(op, j && j.startsWith('{') ? JSON.parse(j) : {}); }
    case 'run': {
      const { send: s, flowScript } = await import('../../recorder/cli.mjs');
      let extra = jsonArg();
      try { const d = loadDemo(rest); extra = { apps: d.cfg.apps, ...extra }; } catch (e) {}
      process.env.REPLICA_RX_PORT = process.env.REPLICA_RX_PORT || String(rx());
      const r = await s(flowScript(resolve(rest[0]), extra), 1800);
      console.log(JSON.stringify(r.ok ? r.value : { error: r.error }, null, 1)); return r.ok ? 0 : 1;
    }
    case 'record': {
      const sub = rest[0];
      const demo = loadDemo(rest);
      if (sub === 'start') return send('recordStart', { apps: demo.cfg.apps.map(a => ({ id: a.id, match: a.match })), record: rest.includes('--no-auto') ? { ...demo.cfg.record, auto: false } : demo.cfg.record, zooms: demo.cfg.zooms, first: arg(rest, '--first'), allowDark: rest.includes('--allow-dark'), resume: rest.includes('--resume'), ...jsonArg() }, 300);
      if (sub === 'status') return send('recordStatus', {}, 30);
      if (sub === 'stop') return send('recordStop', {}, 600);
      if (sub === 'side') {
        const kind = rest[1];
        const extra = jsonArg();
        if (kind === 'zoom' && !extra.zooms) extra.zooms = demo.cfg.zooms;
        return send('recordSide', { kind, app: arg(rest, '--app'), ...extra }, 3600);
      }
      console.log('scenecast record start|status|stop|side'); return 1;
    }
    case 'flow': return node('kit/compile/flow.mjs', rest);
    case 'build': {
      const demo = loadDemo(rest);
      let code = await node('kit/compile/flow.mjs', ['--demo', demo.dir, ...(rest.includes('--compiled-flow') ? ['--compiled-flow'] : rest.includes('--from-raw') ? ['--from-raw'] : [])]);
      if (code) return code;
      code = await node('recorder/process.mjs', ['--demo', demo.dir, ...(rest.includes('--force') ? ['--force'] : [])]);
      if (code) return code;
      return node('checks/secrets.mjs', [demo.dir]);
    }
    case 'serve': return node('player/serve.mjs', rest.includes('--demo') ? rest : ['--demo', loadDemo(rest).dir, ...rest]);
    // The editor: the replica served for authoring, opened in edit mode (?edit=1). --no-open only prints the URL.
    // In this process (not a child), so whoever stops `scenecast edit` stops the server.
    case 'edit': {
      process.argv = [process.argv[0], join(KIT, 'player', 'serve.mjs'), ...(rest.includes('--demo') ? [] : ['--demo', loadDemo(rest).dir]), ...rest.filter(a => a !== '--no-open'), '--edit', ...(rest.includes('--no-open') ? [] : ['--open'])];
      await import('../../player/serve.mjs');
      return new Promise(() => {});
    }
    case 'script': return node('script/cli.mjs', rest.includes('--demo') ? rest : [...rest, '--demo', loadDemo(rest).dir]);
    case 'check': return node('checks/check.mjs', rest.includes('--demo') ? rest : ['--demo', loadDemo(rest).dir, ...rest]);
    // The checklist (scenecast check). `fidelity` is its old engine name.
    case 'checklist': case 'fidelity': { const demo = loadDemo(rest); if (!rest.includes('--url')) await refreshGuide(demo); return node('checks/fidelity.mjs', rest.includes('--demo') ? rest : ['--demo', demo.dir, ...rest]); }
    // The fidelity loop's steps (the scenecast binary runs the loop: compare, fix, build, compare again, report).
    case 'fidelity-compare': return node('checks/real-vs-replica.mjs', rest.includes('--demo') ? rest : ['--demo', loadDemo(rest).dir, ...rest]);
    case 'fidelity-fix': return node('fixer/fix.mjs', rest.includes('--demo') ? rest : ['--demo', loadDemo(rest).dir, ...rest]);
    case 'fidelity-report': return node('checks/fidelity-report.mjs', rest.includes('--demo') ? rest : ['--demo', loadDemo(rest).dir, ...rest]);
    // The presenter guide (⌥G): its notes from the script, its pictures, and the check that holds script, guide and
    // replica to each other.
    case 'notes': {
      const demo = loadDemo(rest);
      if (rest.includes('--check')) return node('checks/notes-check.mjs', ['--demo', demo.dir, ...rest.filter((a, i) => a !== '--check' && a !== '--demo' && rest[i - 1] !== '--demo')]);
      const { compileFlow } = await import('../compile/flow.mjs');
      const { writeNotes, scriptPath } = await import('../lib/notes.mjs');
      const file = arg(rest, '--script') ? resolve(arg(rest, '--script')) : scriptPath(demo);
      if (!existsSync(file)) { console.log(`no script at ${file}: write it there (Markdown, text or a RunLines .sk), set demo.json presenter.script, or pass --script <file>`); return 1; }
      if (arg(rest, '--script')) {
        const cfg = JSON.parse(readFileSync(join(demo.dir, 'demo.json'), 'utf8'));
        const r0 = relative(realpathSync(demo.dir), realpathSync(file)), rel = r0.startsWith('..') || isAbsolute(r0) ? file : r0.split('\\').join('/');
        if (!cfg.presenter || cfg.presenter.script !== rel) { cfg.presenter = { ...(cfg.presenter || {}), script: rel }; writeFileSync(join(demo.dir, 'demo.json'), JSON.stringify(cfg, null, 2) + '\n'); demo.cfg.presenter = cfg.presenter; console.log(`demo.json presenter.script: ${rel}`); }
      }
      const { flow } = await compileFlow(demo);
      const n = writeNotes(demo, flow, file);
      const share = n.stage.beats.filter(b => !b.own && b.n > 0 && b.n < n.beats.length - 1).map(b => b.n);
      console.log(`presenter/notes.json: "${n.title}", ${n.beats.length - 2} beats, ${n.beats.reduce((k, b) => k + b.say.length, 0)} lines, ${n.parts.length} parts, ${n.shots.length} pictures (scenecast guide-shots)${share.length ? `\n  beats with no screen of their own (→ steps the guide): ${share.join(', ')}` : ''}`);
      return 0;
    }
    case 'guide-shots': return node('checks/guide-shots.mjs', rest.includes('--demo') ? rest : ['--demo', loadDemo(rest).dir, ...rest]);
    case 'quick': { const demo = loadDemo(rest); await refreshGuide(demo); return node('checks/fidelity.mjs', ['--quick', ...(rest.includes('--demo') ? rest : ['--demo', demo.dir, ...rest])]); }
    case 'text': return (await import('../lib/workflow.mjs')).text(rest);
    case 'status': return (await import('../lib/workflow.mjs')).status(rest);
    case 'save': return (await import('../lib/workflow.mjs')).save(rest);
    case 'release': return (await import('../lib/workflow.mjs')).release(rest, (script, a) => node(script, a));
    case 'sheet': return node('checks/contact-sheet.mjs', rest.includes('--demo') ? rest : ['--demo', loadDemo(rest).dir, ...rest]);
    case 'hovers': return node('checks/hover-check.mjs', rest.includes('--demo') ? rest : ['--demo', loadDemo(rest).dir, ...rest]);
    case 'scan': return node('checks/secrets.mjs', rest.length ? rest : [process.cwd()]);
    default: console.log(`unknown command ${cmd}\n\n${HELP}`); return 1;
  }
}
exit(await main());
