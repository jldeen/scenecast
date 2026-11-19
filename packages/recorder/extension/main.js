// The extension's glue: finding the receiver (the Scenecast app's, on its port or the next few: nothing to set), the
// command loop, and resuming a recording when Chrome restarts the service worker (MV3 can stop it at any time; the
// recording's checkpoint is on the receiver, and which recording was running is in chrome.storage).
const KEEP = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
const START = OPS.recordStart, STOP = OPS.recordStop, ABORT = OPS.recordAbort;
OPS.recordStart = async c => {
  const r = await START(c);
  if (r && r.recording) await chrome.storage.local.set({ recording: { ...c, resume: undefined } });
  return r;
};
OPS.recordStop = async c => { const r = await STOP(c); await chrome.storage.local.remove('recording'); return r; };
OPS.recordAbort = async c => { const r = await ABORT(c); await chrome.storage.local.remove('recording'); return r; };
// The app updated the extension's files: it reloads itself (after answering).
OPS.reload = async () => { setTimeout(() => chrome.runtime.reload(), 300); return 'reloading'; };
// The receiver: the one it has while that answers; else the first that does on the default port and the few after
// it (the app's own first). Looked for every 2 s while there's none, and every 15 s for the app's.
const PORTS = [...new Set([DEFAULT_PORT, ...Array.from({ length: 10 }, (_, i) => 47621 + i), ...Array.from({ length: 10 }, (_, i) => DEFAULT_PORT + i)])];
const pingAt = (port, ms = 1200) => { const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms); return fetch(`http://127.0.0.1:${port}/ping`, { signal: ac.signal }).then(r => r.json()).catch(() => null).finally(() => clearTimeout(t)); };
let found = null, lastLook = 0;
async function findReceiver() {
  const now = await pingAt(+RX.split(':').pop());
  if (now && now.ok && (now.owner === 'app' || Date.now() - lastLook < 15000)) { found = now; return now; }
  lastLook = Date.now();
  const all = await Promise.all(PORTS.map(async port => ({ port, p: await pingAt(port) })));
  const ok = all.filter(x => x.p && x.p.ok);
  const best = ok.find(x => x.p.owner === 'app') || ok.find(x => x.port === +RX.split(':').pop()) || ok[0];
  if (best) { RX = 'http://127.0.0.1:' + best.port; await chrome.storage.local.set({ port: best.port }); }
  found = best ? best.p : null;
  return found;
}
setInterval(() => { findReceiver().catch(() => {}); }, 2000);
// The extension's own state, for the popup and the CLI (record status shows it too).
OPS.extension = async () => ({ version: RECORDER_VERSION, manifest: chrome.runtime.getManifest().version, receiver: RX, tabs: CDPX.ctx.pages().length, watching: CDPX.ctx.pages().filter(p => p.attached).map(p => p.url().slice(0, 120)) });

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  (async () => {
    const alive = await findReceiver();
    return { receiver: RX, connected: !!alive, app: !!(alive && alive.owner === 'app'), demo: alive && alive.demo, status: await OPS.recordStatus() };
  })().then(reply, e => reply({ error: String(e) }));
  return true;
});

(async () => {
  const st = await chrome.storage.local.get(['port', 'recording']);
  if (st.port) RX = 'http://127.0.0.1:' + st.port;
  await findReceiver().catch(() => {});
  await CDPX.ready;
  startLoop();
  // A recording was running when the worker stopped: pick it up from the receiver's checkpoint.
  if (st.recording) {
    for (let i = 0; i < 30; i++) { if (await findReceiver().catch(() => null)) break; await sleep(2000); }
    const r = await START({ ...st.recording, resume: true }).catch(e => ({ error: String(e) }));
    await rlog('service worker restarted mid-recording: ' + JSON.stringify(r).slice(0, 400));
    if (r && r.error) await chrome.storage.local.remove('recording');
  }
})();
