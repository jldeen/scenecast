// A replica server for a check or a tool: the one at --url if it answers, else one started on a free port for the
// run (never the demo's own port, which may be the presenter's window).
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { KIT } from './demo.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
export const freePort = () => new Promise(res => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const answers = async url => { try { return (await fetch(url + '__replica/status')).ok; } catch (e) { return false; } };

export async function replicaServer(demo, url = null) {
  if (url && await answers(url)) return { url, stop: () => {} };
  const port = url ? +new URL(url).port : await freePort();
  const p = spawn(process.execPath, [join(KIT, 'player/serve.mjs'), '--demo', demo.dir, '--port', String(port), '--no-editor'], { stdio: 'ignore', env: { ...process.env, REPLICA_NO_OPEN: '1' } });
  const u = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 150 && !(await answers(u)); i++) await sleep(100);
  if (!(await answers(u))) { p.kill(); throw new Error('the replica server did not start'); }
  return { url: u, stop: () => p.kill() };
}
