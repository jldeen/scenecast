// The fence a selftest puts around the engine. While SCENECAST_TEST_FENCE is set (the test's own folders, by the path
// delimiter; packages/selftest/guard.mjs sets it, and everything a test starts inherits it), nothing reaches a
// presenter's Scenecast:
//   - the app's receivers, 47621–47630: no command is sent there, no receiver starts there, and no recorder is built
//     to look there (an extension built for a port looks on it and the nine after it);
//   - her folders: a demo, raw captures, the recorder extension or a capture profile outside the test's own is refused.
// Outside a selftest it does nothing.
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path';

export const APP_PORTS = [47621, 47630];
const inApp = p => p >= APP_PORTS[0] && p <= APP_PORTS[1];
// An extension's reach: its own port and the nine after it.
const reachesApp = p => p + 9 >= APP_PORTS[0] && p <= APP_PORTS[1];

// A path as it really is (macOS's /var is /private/var), for one that may not exist yet too.
function real(p) {
  let at = resolve(p);
  const rest = [];
  while (!existsSync(at) && dirname(at) !== at) { rest.unshift(basename(at)); at = dirname(at); }
  try { at = realpathSync.native(at); } catch (e) {}
  const full = rest.length ? join(at, ...rest) : at;
  // Windows: one folder whatever its letters' case.
  return process.platform === 'win32' ? full.toLowerCase() : full;
}
export function fenced(env = process.env) {
  return env.SCENECAST_TEST_FENCE ? env.SCENECAST_TEST_FENCE.split(delimiter).filter(Boolean).map(real) : null;
}
// Where the engine makes its own scratch folders (a cold start's clones): the test's own folder in a selftest.
export const scratchDir = (env = process.env) => (fenced(env) || [])[0] || tmpdir();
// what: 'receiver' (a command to it, or one starting on it) or 'extension' (a recorder built to look there).
export function fencePort(port, what = 'receiver', env = process.env) {
  if (!fenced(env)) return;
  const p = +port;
  if (what === 'extension' ? reachesApp(p) : inApp(p)) throw new Error(`a selftest never reaches the app's receivers (${APP_PORTS.join('–')}): ${what} on ${port}`);
}
export function fencePath(path, what = 'folder', env = process.env) {
  const dirs = fenced(env);
  if (!dirs || !path) return;
  const r = real(path);
  if (!dirs.some(d => r === d || r.startsWith(d.endsWith(sep) ? d : d + sep))) throw new Error(`a selftest keeps to its own folders: the ${what} ${path} is outside them`);
}
