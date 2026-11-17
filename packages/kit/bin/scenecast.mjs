#!/usr/bin/env node
// replica: the replica-kit command line. Run `replica help` for the commands.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { KIT, KIT_VERSION, loadDemo, arg } from '../lib/demo.mjs';

const [cmd, ...rest] = process.argv.slice(2);
// Children get the signals this process gets, so stopping `replica serve` stops the server too.
const kids = new Set();
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { for (const k of kids) k.kill(sig); process.exit(130); });
const node = (script, args, opts = {}) => new Promise(res => { const p = spawn(process.execPath, [join(KIT, script), ...args], { stdio: 'inherit', ...opts }); kids.add(p); p.on('close', code => { kids.delete(p); res(code); }); });
const exit = code => process.exit(code || 0);
const HELP = `replica-kit ${KIT_VERSION}: record a live web demo once, replay it offline the same way every time.

  replica new <name> [--dir <parent>] [--title "…"] [--port N] [--app id=url …]
                                   a new demo folder from the template
  replica agent [<outDir>]         build the capture agent (agent.js) to run with playwright-chrome
  replica receiver                 the local receiver the agent posts captures to (keep it running)
  replica record start [--resume] [--no-auto] | status | stop
                                   record the demo once; each new screen's side states are captured as you go
  replica record side hovers|clicks|drags|groups|chips|zoom|list [--app id] ['{json options}']
                                   one side path on the screen an app is on (one the automatic pass capped)
  replica cmd <op> ['{json}']      one command to the agent (snap, tabs, eval, click, …)
  replica run <script.js> ['{json}']  a capture script on the agent (capture/lib.js helpers in scope)
  replica flow [--from-raw]        recording.json + flow.overrides.mjs → flow.json
  replica build                    flow, then raw captures → data/ (scrubbed), then the secret scan
  replica serve [--open] [--pace N] [--port N]
  replica text "<old>" "<new>" [--in snap]   a wording or date tweak (shows on reload, no build)
  replica quick                    check only what changed since the last pass (seconds) → .out/quick.md
  replica status                   where the demo is, and the next step (after an interruption, start here)
  replica save "<message>"         secret scan, then commit (after every step that works)
  replica release [--push]         bake the tweaks in, the full checklist, scan, commit (and push)
  replica check [--runs 2] [--zoom 150] [--speed 10]   the recorded path, twice: identical, no errors, no network
  replica fidelity [--skip a,b]    the whole fidelity checklist (docs/checklist.md) → .out/fidelity.md
  replica sheet                    real vs replica contact sheet (after check)
  replica scan [<dir>]             secret scan: fails on any token, key or script
  replica install-skill            installs the "replicate a demo" skill to ~/.copilot/skills

Every demo command takes --demo <dir>, or runs from inside the demo folder.`;

function rx() { try { return loadDemo(rest).cfg.receiverPort; } catch (e) { return 47621; } }
async function send(op, args = {}, tmo = 900) {
  const { send } = await import(join(KIT, 'capture/cli.mjs'));
  process.env.REPLICA_RX_PORT = process.env.REPLICA_RX_PORT || String(rx());
  const r = await send({ op, ...args }, tmo);
  console.log(JSON.stringify(r.ok ? r.value : { error: r.error }, null, 1));
  return r.ok && !(r.value && r.value.error) ? 0 : 1;
}
const jsonArg = () => { const j = rest.find(a => a.trim().startsWith('{')); return j ? JSON.parse(j) : {}; };

async function scaffold() {
  const VALUED = new Set(['--dir', '--title', '--port', '--app']);
  const name = rest.find((a, i) => !a.startsWith('--') && !VALUED.has(rest[i - 1]));
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) { console.log('replica new <name>: lowercase letters, digits and dashes'); return 1; }
  const dir = resolve(arg(rest, '--dir', '.'), name);
  if (existsSync(dir) && readdirSync(dir).length) { console.log(`${dir} exists and isn't empty`); return 1; }
  // --app id=url: the app's tab is found by its host (edit match in demo.json when two apps share one); its
  // presenter key is a letter of its id.
  const apps = [], used = new Set();
  rest.forEach((a, i) => {
    if (a !== '--app') return;
    const v = rest[i + 1], eq = v.indexOf('=');
    const id = v.slice(0, eq), url = v.slice(eq + 1);
    const key = [...id.toUpperCase()].find(c => /[A-Z]/.test(c) && !used.has(c) && !'PN'.includes(c)) || [...'ABCDEFGHIJKLMOQRSTUVWXYZ'].find(c => !used.has(c));
    used.add(key);
    let match = url; try { match = new URL(url).host; } catch (e) {}
    apps.push({ id, key, title: id.replace(/^./, c => c.toUpperCase()), url, match });
  });
  if (!apps.length) apps.push({ id: 'app', key: 'A', title: 'App', url: 'https://example.com/', match: 'example.com' });
  const port = +arg(rest, '--port', 0) || 4620 + ([...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 300);
  const title = arg(rest, '--title', name.replace(/-/g, ' ').replace(/^./, c => c.toUpperCase()));
  const sub = s => s.replace(/__NAME__/g, name).replace(/__TITLE__/g, title).replace(/__PORT__/g, String(port))
    .replace(/__APPS__/g, '[\n' + apps.map(a => '    ' + JSON.stringify(a).replace(/","/g, '", "').replace(/":/g, '": ')).join(',\n') + '\n  ]')
    .replace(/\| __APPKEYS__ \|/g, apps.map(a => `| **⌥${a.key}** | Switch to ${a.title}, like clicking its Chrome tab. |`).join('\n'));
  const copy = (from, to) => {
    mkdirSync(to, { recursive: true });
    for (const f of readdirSync(from)) {
      const s = join(from, f), d = join(to, f === 'gitignore' ? '.gitignore' : f);
      if (statSync(s).isDirectory()) copy(s, d); else writeFileSync(d, sub(readFileSync(s, 'utf8')));
    }
  };
  copy(join(KIT, 'template'), dir);
  mkdirSync(join(dir, 'data'), { recursive: true });
  console.log(`new demo: ${dir}
  apps: ${apps.map(a => `${a.id} (⌥${a.key}) ${a.url}`).join(', ')}
  replica port: ${port}
next: edit demo.json (apps, Chrome profile, busy markers), then follow the kit README's "Make a replica".`);
  return 0;
}

async function main() {
  switch (cmd) {
    case undefined: case 'help': case '--help': case '-h': console.log(HELP); return 0;
    case 'new': return scaffold();
    case 'agent': { const out = rest.find(a => !a.startsWith('--')); return node('capture/build.mjs', [...(out ? [out] : []), '--port', String(rx())]); }
    case 'receiver': return node('capture/receiver.mjs', ['--demo', loadDemo(rest).dir]);
    case 'cmd': { const [op, j] = rest; return send(op, j && j.startsWith('{') ? JSON.parse(j) : {}); }
    case 'run': {
      const { send: s, flowScript } = await import(join(KIT, 'capture/cli.mjs'));
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
      console.log('replica record start|status|stop|side'); return 1;
    }
    case 'flow': return node('compile/flow.mjs', rest);
    case 'build': {
      const demo = loadDemo(rest);
      let code = await node('compile/flow.mjs', ['--demo', demo.dir, ...(rest.includes('--from-raw') ? ['--from-raw'] : [])]);
      if (code) return code;
      code = await node('capture/process.mjs', ['--demo', demo.dir]);
      if (code) return code;
      return node('checks/secrets.mjs', [demo.dir]);
    }
    case 'serve': return node('engine/serve.mjs', rest.includes('--demo') ? rest : ['--demo', loadDemo(rest).dir, ...rest]);
    case 'check': return node('checks/check.mjs', rest.includes('--demo') ? rest : ['--demo', loadDemo(rest).dir, ...rest]);
    case 'fidelity': return node('checks/fidelity.mjs', rest.includes('--demo') ? rest : ['--demo', loadDemo(rest).dir, ...rest]);
    case 'quick': return node('checks/fidelity.mjs', ['--quick', ...(rest.includes('--demo') ? rest : ['--demo', loadDemo(rest).dir, ...rest])]);
    case 'text': return (await import('../lib/workflow.mjs')).text(rest);
    case 'status': return (await import('../lib/workflow.mjs')).status(rest);
    case 'save': return (await import('../lib/workflow.mjs')).save(rest);
    case 'release': return (await import('../lib/workflow.mjs')).release(rest, (script, a) => node(script, a));
    case 'sheet': return node('checks/contact-sheet.mjs', rest.includes('--demo') ? rest : ['--demo', loadDemo(rest).dir, ...rest]);
    case 'hovers': return node('checks/hover-check.mjs', rest.includes('--demo') ? rest : ['--demo', loadDemo(rest).dir, ...rest]);
    case 'scan': return node('checks/secrets.mjs', rest.length ? rest : [process.cwd()]);
    case 'install-skill': return new Promise(res => { const p = spawn('bash', [join(KIT, 'skill/install.sh')], { stdio: 'inherit' }); p.on('close', res); });
    default: console.log(`unknown command ${cmd}\n\n${HELP}`); return 1;
  }
}
exit(await main());
