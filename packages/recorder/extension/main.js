// The extension's glue: the receiver's port (the popup can change it), the command loop, and resuming a recording
// when Chrome restarts the service worker (MV3 can stop it at any time; the recording's checkpoint is on the
// receiver, and which recording was running is in chrome.storage).
const KEEP = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
const START = OPS.recordStart, STOP = OPS.recordStop, ABORT = OPS.recordAbort;
OPS.recordStart = async c => {
  const r = await START(c);
  if (r && r.recording) await chrome.storage.local.set({ recording: { ...c, resume: undefined } });
  return r;
};
OPS.recordStop = async c => { const r = await STOP(c); await chrome.storage.local.remove('recording'); return r; };
OPS.recordAbort = async c => { const r = await ABORT(c); await chrome.storage.local.remove('recording'); return r; };
// The extension's own state, for the popup and the CLI (record status shows it too).
OPS.extension = async () => ({ version: chrome.runtime.getManifest().version, receiver: RX, tabs: CDPX.ctx.pages().length, watching: CDPX.ctx.pages().filter(p => p.attached).map(p => p.url().slice(0, 120)) });

// Finding the receiver: the port it was built for (or saved in the popup), else the next few, where the desktop app
// puts it when that one is taken. Only a scenecast receiver counts.
const PORTS = [...new Set([DEFAULT_PORT, 47621].flatMap(p => Array.from({ length: 10 }, (_, i) => p + i)))];
async function pingAt(rx, ms = 800) {
  try { const r = await fetch(rx + '/ping', { signal: AbortSignal.timeout(ms) }); return r.ok ? await r.json() : null; } catch (e) { return null; }
}
async function findReceiver() {
  const here = await pingAt(RX);
  if (here && (here.app === 'scenecast-receiver' || here.raw)) return here;
  for (const p of PORTS) {
    const rx = 'http://127.0.0.1:' + p;
    if (rx === RX) continue;
    const r = await pingAt(rx, 500);
    if (r && r.app === 'scenecast-receiver') { RX = rx; return r; }
  }
  return null;
}
// After an update the app writes the new recorder into this folder: reload from it (an unpacked extension reads its
// files from disk), once the folder really holds the version the receiver expects.
async function reloadIfStale(alive) {
  const want = alive && alive.recorderVersion, have = chrome.runtime.getManifest().version;
  if (!want || want === have) return;
  const onDisk = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' }).then(r => r.json()).catch(() => null);
  if (onDisk && onDisk.version === want) { await rlog(`recorder ${have} → ${want}: reloading`).catch(() => {}); chrome.runtime.reload(); }
}
// The command loop calls this when the receiver doesn't answer.
var onReceiverLost = async () => { const r = await findReceiver(); if (r) { await reloadIfStale(r); await sleep(500); } else await sleep(2000); };

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  (async () => {
    if (m.op === 'port') { await chrome.storage.local.set({ port: +m.port }); RX = 'http://127.0.0.1:' + +m.port; return { receiver: RX }; }
    const alive = await findReceiver();
    return { receiver: RX, connected: !!alive, raw: alive && alive.raw, version: chrome.runtime.getManifest().version, status: await OPS.recordStatus() };
  })().then(reply, e => reply({ error: String(e) }));
  return true;
});

(async () => {
  const st = await chrome.storage.local.get(['port', 'recording']);
  if (st.port) RX = 'http://127.0.0.1:' + st.port;
  await CDPX.ready;
  const alive = await findReceiver();
  if (alive) await reloadIfStale(alive);
  startLoop();
  // A recording was running when the worker stopped: pick it up from the receiver's checkpoint.
  if (st.recording) {
    for (let i = 0; i < 30; i++) { if (await findReceiver()) break; await sleep(2000); }
    const r = await START({ ...st.recording, resume: true }).catch(e => ({ error: String(e) }));
    await rlog('service worker restarted mid-recording: ' + JSON.stringify(r).slice(0, 400));
    if (r && r.error) await chrome.storage.local.remove('recording');
  }
})();
