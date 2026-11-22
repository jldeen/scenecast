#!/usr/bin/env node
// The stunt command (also stuntdouble): the stuntdouble binary for this OS, run with the engine's packages and this Node.
// With no binary for this OS, the engine's own commands (serve, check, record, notes, …) still run, straight on the
// JavaScript engine; only what the binary does itself (new, build's Rust steps, sync, schema, validate) needs it.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { binaryPath } from '@stuntdouble/build';

const require = createRequire(import.meta.url);
const core = dirname(require.resolve('@stuntdouble/core/package.json'));
const args = process.argv.slice(2);
let cmd = null;
try { cmd = [binaryPath(), args]; } catch (e) {
  const BINARY_ONLY = new Set(['new', 'init', 'sync', 'schema', 'validate', 'inspect', 'add-scene', 'add-hotspot', 'add-guide-mark', 'add-section', 'export-html', 'migrate', 'install-skill', 'fidelity', 'build', 'scrub']);
  if (!args.length || BINARY_ONLY.has(args[0])) { console.error('stunt: ' + e.message); process.exit(1); }
  cmd = [process.execPath, [join(core, 'bin', 'engine.mjs'), ...args]];
}
const env = { ...process.env, STUNTDOUBLE_JS: dirname(core), STUNTDOUBLE_NODE: process.env.STUNTDOUBLE_NODE || process.execPath };
const child = spawn(cmd[0], cmd[1], { stdio: 'inherit', env });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
child.on('error', e => { console.error(`stunt: can't run ${cmd[0]}: ${e.message}`); process.exit(1); });
child.on('exit', (code, signal) => process.exit(signal ? 130 : code ?? 1));
