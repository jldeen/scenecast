// Every selftest's first call, before it starts anything: nothing a test starts reaches a presenter's Scenecast.
//   const g = await selftestGuard({ tmp, receivers: [RX], extensions: [RX], dirs: [] })
// It refuses (exits) a receiver port in the app's 47621–47630, a recorder built to look there, a port already in use,
// and then fences everything the test starts (SCENECAST_TEST_FENCE, @stuntdouble/core/lib/test-fence.mjs): the engine
// sends no command to the app's ports, starts no receiver there, builds no recorder that looks there, and loads no demo,
// raw folder, recorder extension or capture profile outside the test's own folders (tmp and dirs). A command or a
// receiver with no port of its own gets the test's (REPLICA_RX_PORT), and the recorder extension's default folder is
// the test's (SCENECAST_EXTENSION_DIR), never Documents/Scenecast.
//   await g.own(port)   before sending a receiver anything: it must be one this test started (its raw folder is the
//                       test's), not another test's or the app's on the same port.
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve, sep } from 'node:path';
import { fencePath, fencePort, APP_PORTS } from '@stuntdouble/core/lib/test-fence.mjs';

const busy = port => new Promise(res => { const s = createServer().once('error', () => res(true)).once('listening', () => s.close(() => res(false))).listen(port, '127.0.0.1'); });
const realOf = p => { let r; try { r = realpathSync.native(p); } catch (e) { r = resolve(p); } return process.platform === 'win32' ? r.toLowerCase() : r; };
const realTemp = () => realOf(tmpdir());
const refuse = why => { console.log(`selftest guard: ${why}`); process.exit(1); };

// kept: a folder another selftest kept (SCENECAST_SELFTEST_KEEP, --keep) that this one works on: it must be in the
// temp folder, never a presenter's demo.
export async function selftestGuard({ tmp, receivers = [], extensions = [], dirs = [], kept = [], ports = [] } = {}) {
  if (!tmp) refuse('no temp folder of its own');
  const temp = realTemp();
  for (const k of kept) if (!realOf(k).startsWith(temp + sep)) refuse(`${k} isn't a folder a selftest kept (it's outside ${tmpdir()})`);
  dirs = [...dirs, ...kept];
  process.env.SCENECAST_TEST_FENCE = [tmp, ...dirs].join(delimiter);
  try {
    for (const p of receivers) fencePort(p);
    for (const p of extensions) fencePort(p, 'extension');
  } catch (e) { refuse(e.message); }
  for (const p of [...new Set([...receivers, ...ports])]) if (await busy(p)) refuse(`port ${p} is in use: stop whatever is on it and run again`);
  if (receivers.length) process.env.REPLICA_RX_PORT = String(receivers[0]);
  else if (process.env.REPLICA_RX_PORT) { try { fencePort(process.env.REPLICA_RX_PORT); } catch (e) { refuse(e.message); } }
  process.env.SCENECAST_EXTENSION_DIR = join(tmp, 'Recorder Extension');
  return {
    // A receiver this test started: its raw folder is the test's own.
    async own(port) {
      fencePort(port);
      const p = await fetch(`http://127.0.0.1:${port}/ping`).then(r => r.json()).catch(() => null);
      if (!p) throw new Error(`no receiver on ${port}`);
      try { fencePath(p.raw || p.demo, 'receiver\'s raw folder'); } catch (e) { throw new Error(`port ${port}: a receiver this test didn't start (${p.demo || p.raw})`); }
      return p;
    },
  };
}
// A test of the app itself on the app's own ports (the packaged app, its update): it can't be fenced off them, so it
// refuses to start while anything is on 47621–47630 or a Scenecast it didn't start is running (a presenter's: its
// receiver would be asked to make way, and her browser's recorder could find the test's).
export async function appPortsGuard({ ports = [] } = {}) {
  for (let p = APP_PORTS[0]; p <= APP_PORTS[1]; p++) if (await busy(p)) refuse(`something is on the app's port ${p}: this test runs in CI, or quit Scenecast first`);
  const running = scenecastRunning();
  if (running) refuse(`Scenecast is running (${running}): this test runs in CI, or quit Scenecast first`);
  for (const p of ports) if (await busy(p)) refuse(`port ${p} is in use: stop whatever is on it and run again`);
}
function scenecastRunning() {
  if (process.platform === 'darwin') return ((spawnSync('pgrep', ['-fl', 'Scenecast.app/Contents/MacOS/'], { encoding: 'utf8' }).stdout || '').trim().split('\n').filter(Boolean)[0] || '').slice(0, 120) || null;
  if (process.platform === 'win32') return /Scenecast\.exe/i.test(spawnSync('tasklist', ['/FI', 'IMAGENAME eq Scenecast.exe', '/NH'], { encoding: 'utf8' }).stdout || '') ? 'Scenecast.exe' : null;
  return null;
}
export { APP_PORTS };
