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
// Present: a stage window opened into a browser that's already running ignores --start-fullscreen and
// --window-position (they only apply when the browser starts). Put the newest stage window on its screen (the
// projector), full screen. c.url: the stage's address (its guide, presenter.html, isn't it).
OPS.stageWindow = async c => {
  for (let i = 0; i < 20; i++) {
    const tabs = (await chrome.tabs.query({})).filter(t => { const u = t.url || t.pendingUrl || ''; return u.startsWith(c.url) && !/\/presenter\.html/.test(u); });
    const t = tabs.sort((a, b) => b.id - a.id)[0];
    if (t) {
      if (c.place) await chrome.windows.update(t.windowId, { state: 'normal', left: c.place.x, top: c.place.y, width: c.place.width, height: c.place.height });
      await chrome.windows.update(t.windowId, { state: 'fullscreen', focused: true });
      await poll(300);
      return { window: t.windowId, state: (await chrome.windows.get(t.windowId)).state };
    }
    await poll(500);
  }
  return { error: 'no stage window' };
};
// Stop presenting: close the stage and guide windows Scenecast opened. Only windows whose every tab is on the stage's
// address (c.url): nothing else of the presenter's.
OPS.closeStage = async c => {
  // App windows (the stage and guide open as --app windows) aren't listed unless asked for.
  const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal', 'popup', 'app'] });
  const ours = wins.filter(w => (w.tabs || []).length && w.tabs.every(t => (t.url || t.pendingUrl || '').startsWith(c.url)));
  for (const w of ours) await chrome.windows.remove(w.id).catch(() => {});
  return { closed: ours.length };
};
OPS.reload = async () => { setTimeout(() => chrome.runtime.reload(), 300); return 'reloading'; };
// The receiver: the one it has while that answers; else the first that does on the default port and the few after
// it (the app's own first). Looked for every 2 s while there's none, and every 15 s for the app's.
// Built for the app's ports (47621 on) it looks there; built for another port (a test's) only near that one, so a test's
// browser never finds a presenter's Scenecast.
const APP_PORTS = Array.from({ length: 10 }, (_, i) => 47621 + i);
const PORTS = [...new Set([DEFAULT_PORT, ...(APP_PORTS.includes(DEFAULT_PORT) ? APP_PORTS : []), ...Array.from({ length: 10 }, (_, i) => DEFAULT_PORT + i)])];
// Who this recorder is, to the receiver (one recorder per receiver): an id kept across restarts, the browser, its tabs.
let AGENT_ID = null;
const BROWSER = (() => { const b = (navigator.userAgentData && navigator.userAgentData.brands || []).map(x => x.brand).find(x => /Edge|Chrome|Chromium/.test(x) && !/Not/.test(x)); return b || 'Chromium'; })();
async function AGENT_QS() {
  if (!AGENT_ID) { const st = await chrome.storage.local.get('agentId'); AGENT_ID = st.agentId || ('ext-' + Math.random().toString(36).slice(2, 10)); if (!st.agentId) await chrome.storage.local.set({ agentId: AGENT_ID }); }
  const tabs = await chrome.tabs.query({}).then(t => t.length).catch(() => 0);
  return `?agent=${encodeURIComponent(AGENT_ID)}&browser=${encodeURIComponent(BROWSER)}&tabs=${tabs}&v=${encodeURIComponent(RECORDER_VERSION)}`;
}
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

// Chrome shows "started debugging this browser" while any tab is attached. Not recording, and nothing asked of a tab
// for 20 s (Record's quiet check looks at each app's tab, then waits for Start): let go of them, so the bar isn't on
// the stage. A tab is attached again when it's next needed.
const IDLE_RELEASE_MS = 20000;
setInterval(() => {
  if (REC.on || OP_BUSY || Date.now() - LAST_OP < IDLE_RELEASE_MS) return;
  if (CDPX.ctx.pages().some(p => p.attached)) CDPX.ctx.detachAll().catch(() => {});
}, 5000);

(async () => {
  const st = await chrome.storage.local.get(['port', 'recording']);
  if (st.port) RX = 'http://127.0.0.1:' + st.port;
  await findReceiver().catch(() => {});
  await CDPX.ready;
  startLoop();
  // A recording was running when the worker stopped: pick it up from the receiver's checkpoint.
  if (st.recording) {
    for (let i = 0; i < 30; i++) { if (await findReceiver().catch(() => null)) break; await poll(2000); }
    const r = await START({ ...st.recording, resume: true }).catch(e => ({ error: String(e) }));
    await rlog('service worker restarted mid-recording: ' + JSON.stringify(r).slice(0, 400));
    if (r && r.error) await chrome.storage.local.remove('recording');
  }
})();
