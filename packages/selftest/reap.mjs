// Every process a selftest starts goes when the selftest does: passed, failed, crashed or stopped (Ctrl+C). Imported
// first by each selftest. Each child leads its own process group (Windows: its own tree), so a child's own children
// go too: killing the CLI alone left `edit` and the player's serve.mjs running, orphaned (22 found on one Mac, Nov 2026).
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const kids = new Set();
const spawn0 = childProcess.spawn;
childProcess.spawn = (cmd, args, opts) => {
  if (!Array.isArray(args)) { opts = args; args = []; }
  const o = { ...(opts || {}) };
  if (process.platform !== 'win32' && o.detached === undefined) o.detached = true;
  const p = spawn0(cmd, args, o);
  if (p.pid) { kids.add(p); p.once('exit', () => kids.delete(p)); }
  return p;
};
syncBuiltinESMExports();

export function reapAll() {
  for (const p of kids) {
    try {
      if (process.platform === 'win32') childProcess.spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(-p.pid, 'SIGTERM');
    } catch (e) { try { p.kill(); } catch (e2) {} }
  }
  kids.clear();
}
process.on('exit', reapAll);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { reapAll(); process.exit(130); });
process.on('uncaughtException', e => { console.error(e); reapAll(); process.exit(1); });
process.on('unhandledRejection', e => { console.error(e); reapAll(); process.exit(1); });
