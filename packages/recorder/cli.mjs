// Sends one command to the capture agent (through the receiver) and prints its result.
//   node capture/cli.mjs <op> '<json args>' [timeoutS]
// e.g. cli.mjs snap '{"tab":"app:chat","id":"chat-start"}'      cli.mjs recordStatus
// cli.mjs run <file.js> ['{"tab":"…"}'] runs a flow script (capture/lib.js is prepended) as the 'js' op.
// REPLICA_RX_PORT picks the receiver's port (47621).
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function send(cmd, tmo = 300, port = process.env.REPLICA_RX_PORT || 47621) {
  const RX = `http://127.0.0.1:${port}`;
  const { id } = await (await fetch(RX + '/cmd', { method: 'POST', body: JSON.stringify(cmd) })).json();
  const t0 = Date.now();
  for (;;) {
    const r = await (await fetch(RX + '/result?id=' + id)).json();
    if (!r.pending) return r.ok ? { ok: true, value: r.value } : { ok: false, error: r.error };
    if (Date.now() - t0 > +tmo * 1000) return { ok: false, error: 'timeout waiting for ' + id };
    await new Promise(r => setTimeout(r, 300));
  }
}
export function flowScript(file, extra = {}) {
  const here = dirname(fileURLToPath(import.meta.url));
  const hp = readFileSync(join(here, 'hover-page.js'), 'utf8').replace(/^\/\/.*\n/gm, '');
  return { op: 'js', tab: extra.tab, code: `const ARGS = ${JSON.stringify(extra)};\nconst HOVER_PAGE = ${JSON.stringify(hp)};\n` + readFileSync(join(here, 'lib.js'), 'utf8') + '\n' + readFileSync(file, 'utf8') };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let [op, args = '{}', tmo = '300'] = process.argv.slice(2);
  let cmd;
  if (op === 'run') { cmd = flowScript(args, process.argv[4] ? JSON.parse(process.argv[4]) : {}); tmo = process.argv[5] || '900'; }
  else cmd = { op, ...JSON.parse(args) };
  const r = await send(cmd, tmo);
  console.log(JSON.stringify(r.ok ? r.value : { error: r.error }, null, 1));
  process.exit(r.ok ? 0 : 1);
}
