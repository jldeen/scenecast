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

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  (async () => {
    if (m.op === 'port') { await chrome.storage.local.set({ port: +m.port }); RX = 'http://127.0.0.1:' + +m.port; return { receiver: RX }; }
    const alive = await fetch(RX + '/ping').then(r => r.json()).catch(() => null);
    return { receiver: RX, connected: !!alive, raw: alive && alive.raw, status: await OPS.recordStatus() };
  })().then(reply, e => reply({ error: String(e) }));
  return true;
});

(async () => {
  const st = await chrome.storage.local.get(['port', 'recording']);
  if (st.port) RX = 'http://127.0.0.1:' + st.port;
  await CDPX.ready;
  startLoop();
  // A recording was running when the worker stopped: pick it up from the receiver's checkpoint.
  if (st.recording) {
    for (let i = 0; i < 30; i++) { if (await fetch(RX + '/ping').then(r => r.ok, () => false)) break; await sleep(2000); }
    const r = await START({ ...st.recording, resume: true }).catch(e => ({ error: String(e) }));
    await rlog('service worker restarted mid-recording: ' + JSON.stringify(r).slice(0, 400));
    if (r && r.error) await chrome.storage.local.remove('recording');
  }
})();
