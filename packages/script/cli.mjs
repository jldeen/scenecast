// The engine side of `scenecast script <file>` (the scenecast binary runs it):
//   node packages/script/cli.mjs <script file> --demo <dir> [--url <replica>] [--matcher text|<file.mjs>] [--no-write]
//     [--no-pdf] [--out <dir>] [--strict]
// Prints one `@script {json}` line per step (parsed, indexed, matched, landed, done), then a summary. --strict exits 1
// when any line is not backed.
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { loadDemo, arg } from '@stuntdouble/core/lib/demo.mjs';
import { runScript } from './index.mjs';
// Exit once everything printed is out (a pipe to the app is written asynchronously; exiting at once cut it at 64 KB).
const exitWhenOut = code => process.stdout.write('', () => process.exit(code));

const args = process.argv.slice(2);
const opt = new Set(['--demo', '--url', '--matcher', '--out', '--channel']);
const file = args.find((a, i) => !a.startsWith('--') && !opt.has(args[i - 1]));
if (!file) { console.log('scenecast script <script file: .md, .txt or .sk> [--matcher text|<file.mjs>] [--no-write] [--no-pdf] [--strict]'); exitWhenOut(1); await new Promise(() => {}); }
const demo = loadDemo(args);
const path = existsSync(resolve(file)) ? resolve(file) : resolve(demo.dir, file);
if (!existsSync(path)) { console.log(`no script at ${file}`); exitWhenOut(1); await new Promise(() => {}); }
try {
  const { report, sheet, pdf, cues } = await runScript({
    demo, file: path, url: arg(args, '--url', null), matcher: arg(args, '--matcher', null), out: arg(args, '--out') ? resolve(arg(args, '--out')) : undefined,
    channel: arg(args, '--channel', undefined), write: !args.includes('--no-write'), pdf: !args.includes('--no-pdf'),
    on: e => console.log('@script ' + JSON.stringify(e)),
  });
  const s = report.summary;
  for (const l of report.lines) if (l.status !== 'backed') console.log(`${l.status === 'unbacked' ? 'NOT BACKED' : 'PARTLY    '} ${l.id} ${l.text.slice(0, 90)}${l.missing.length ? `  (not on screen: ${l.missing.join(', ')})` : ''}`);
  console.log(`${s.lines} lines: ${s.backed} backed, ${s.partial} partly, ${s.unbacked} not backed; ${s.points} focus points${args.includes('--no-write') ? ' (focus.json not written)' : ' in focus.json'}`);
  console.log(`sheet: ${sheet}${pdf ? `\npdf:   ${pdf}` : ''}\ncues:  ${cues}`);
  exitWhenOut(args.includes('--strict') && s.unbacked ? 1 : 0);
} catch (e) {
  console.log('@script ' + JSON.stringify({ event: 'error', error: String(e.message || e) }));
  console.error(`script: ${e.stack || e}`);
  exitWhenOut(2);
}
