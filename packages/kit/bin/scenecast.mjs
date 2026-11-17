#!/usr/bin/env node
// The engine side of the scenecast CLI (from replica-kit 1.4.0). The `scenecast` binary (Rust) runs this for every
// engine command; run it directly only to debug the engine: node packages/kit/bin/scenecast.mjs help
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { KIT, KIT_VERSION, loadDemo, arg } from '../lib/demo.mjs';

const [cmd, ...rest] = process.argv.slice(2);
// Children get the signals this process gets, so stopping `scenecast serve` stops the server too.
const kids = new Set();
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { for (const k of kids) k.kill(sig); process.exit(130); });
const node = (script, args, opts = {}) => new Promise(res => { const p = spawn(process.execPath, [join(KIT, script), ...args], { stdio: 'inherit', ...opts }); kids.add(p); p.on('close', code => { kids.delete(p); res(code); }); });
const exit = code => process.exit(code || 0);
const HELP = `scenecast engine ${KIT_VERSION} (run through the scenecast binary; see docs/cli.md)

  preflight [--check] [--json|--ndjson]  extension [<outDir>]  agent [<outDir>]  receiver  record start|status|stop|side …  cmd <op> ['{json}']  run <script.js> ['{json}']
  flow [--from-raw]  build [--from-raw] [--force]  serve [--open] [--pace N] [--port N] [--release] [--no-editor]
  script <file> [--matcher text|<file.mjs>] [--no-write] [--no-pdf] [--strict]  edit [--no-open] [--port N]
  text "<old>" "<new>"  quick  status  save "<message>"  release [--push] [--skip-build]
  check [--runs 2]  checklist [--skip a,b] [--only a,b]  fidelity-compare|fidelity-fix|fidelity-report  sheet  hovers  scan [<dir>]

Every demo command takes --demo <dir>, or runs from inside the demo folder.`

function rx() { try { return loadDemo(rest).cfg.receiverPort; } catch (e) { return 47621; } }
async function send(op, args = {}, tmo = 900) {
  const { send } = await import('../../recorder/cli.mjs');
  process.env.REPLICA_RX_PORT = process.env.REPLICA_RX_PORT || String(rx());
  const r = await send({ op, ...args }, tmo);
  console.log(JSON.stringify(r.ok ? r.value : { error: r.error }, null, 1));
  return r.ok && !(r.value && r.value.error) ? 0 : 1;
}
const jsonArg = () => { const j = rest.find(a => a.trim().startsWith('{')); return j ? JSON.parse(j) : {}; };

async function main() {
  switch (cmd) {
    case undefined: case 'help': case '--help': case '-h': console.log(HELP); return 0;
    case 'new': console.log('scenecast new is in the scenecast binary (Rust): it writes the project and its manifest'); return 1;
    case 'extension': {
      // The recorder extension (MV3, Edge and Chrome), unpacked: ~/.scenecast/extension unless a folder is given.
      const out = rest.find(a => !a.startsWith('--')) || join(homedir(), '.scenecast', 'extension');
      return node('recorder/build.mjs', ['--extension', out, '--port', String(rx())]);
    }
    case 'agent': { const out = rest.find(a => !a.startsWith('--')); return node('recorder/build.mjs', [...(out ? [out] : []), '--port', String(rx())]); }
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
    case 'checklist': case 'fidelity': return node('checks/fidelity.mjs', rest.includes('--demo') ? rest : ['--demo', loadDemo(rest).dir, ...rest]);
    // The fidelity loop's steps (the scenecast binary runs the loop: compare, fix, build, compare again, report).
    case 'fidelity-compare': return node('checks/real-vs-replica.mjs', rest.includes('--demo') ? rest : ['--demo', loadDemo(rest).dir, ...rest]);
    case 'fidelity-fix': return node('fixer/fix.mjs', rest.includes('--demo') ? rest : ['--demo', loadDemo(rest).dir, ...rest]);
    case 'fidelity-report': return node('checks/fidelity-report.mjs', rest.includes('--demo') ? rest : ['--demo', loadDemo(rest).dir, ...rest]);
    case 'quick': return node('checks/fidelity.mjs', ['--quick', ...(rest.includes('--demo') ? rest : ['--demo', loadDemo(rest).dir, ...rest])]);
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
