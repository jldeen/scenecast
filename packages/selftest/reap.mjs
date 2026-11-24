// Every process a selftest starts goes when the selftest does: passed, failed, crashed or stopped (Ctrl+C). Imported
// first by each selftest. Each child leads its own process group (Windows: its own tree), so a child's own children
// go too: killing the CLI alone left `edit` and the player's serve.mjs running, orphaned (22 found on one Mac, Nov 2026).
// When a child ends, what's left in its group ends with it: a check that crashed (no Edge) after starting a replica
// server left that server in the CLI's group once the CLI had gone, and the group was no longer reaped (two found on
// Jessica's Mac, Nov 23). What's meant to outlive a command (a receiver, the capture host, a browser it opens) starts
// detached, in a group of its own. And every replica server a test's processes start goes with its parent
// (REPLICA_EXIT_WITH_PARENT, inherited): one a SIGKILL leaves behind too.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

process.env.REPLICA_EXIT_WITH_PARENT = '1';
const kids = new Set();
const endGroup = p => { if (process.platform !== 'win32' && p.pid) try { process.kill(-p.pid, 'SIGTERM'); } catch (e) {} };
const spawn0 = childProcess.spawn;
childProcess.spawn = (cmd, args, opts) => {
  if (!Array.isArray(args)) { opts = args; args = []; }
  const o = { ...(opts || {}) };
  if (process.platform !== 'win32' && o.detached === undefined) o.detached = true;
  const p = spawn0(cmd, args, o);
  // Its group still has members when the leader ends (so its number can't be anyone else's): they go now.
  if (p.pid) { kids.add(p); p.once('exit', () => { kids.delete(p); if (o.detached) endGroup(p); }); }
  return p;
};
syncBuiltinESMExports();

// One child and everything it started (its group; on Windows, its process tree).
export function endTree(p) {
  try {
    if (process.platform === 'win32') childProcess.spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-p.pid, 'SIGTERM');
  } catch (e) { try { p.kill(); } catch (e2) {} }
}
export function reapAll() {
  for (const p of kids) endTree(p);
  kids.clear();
}
process.on('exit', reapAll);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { reapAll(); process.exit(130); });
process.on('uncaughtException', e => { console.error(e); reapAll(); process.exit(1); });
process.on('unhandledRejection', e => { console.error(e); reapAll(); process.exit(1); });
