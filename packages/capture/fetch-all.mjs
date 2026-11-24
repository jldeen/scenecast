// Fetch on every target of a browser: each page, its frames and workers, and the service and shared workers, the ones
// there now and every new one (held at its start until it's set, so its first request is seen too). A browser-wide
// Fetch.enable isn't enough: it only catches targets made after it, and none once it's been turned off and on (Nov 23:
// a guard turned on for a second walk saw nothing, and a page's POST went out).
// Its own DevTools connection, beside Playwright's: this one only intercepts.
//   const tf = await fetchEveryTarget(port, { onPaused: async e => null | { fail: true } | { url } })
//   await tf.set(patterns | null)     intercept these (Fetch.enable on every target), or nothing
//   tf.targets()                      how many targets it has
//   await tf.close()
const KINDS = new Set(['page', 'iframe', 'worker', 'shared_worker', 'service_worker']);

export async function fetchEveryTarget(port, { onPaused = async () => null, log = () => {} } = {}) {
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error(`no DevTools connection on ${port}`)); });
  let n = 0, patterns = null, closed = false;
  const pending = new Map(), sessions = new Map();
  const send = (method, params = {}, sessionId) => closed ? Promise.reject(new Error('closed')) : new Promise((res, rej) => {
    const id = ++n;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const fetchOn = sessionId => patterns ? send('Fetch.enable', { patterns }, sessionId) : send('Fetch.disable', {}, sessionId);
  // A new target: Fetch first, then its own children attached the same way, then it goes on.
  async function attached({ sessionId, targetInfo, waitingForDebugger }) {
    const kind = targetInfo.type;
    if (KINDS.has(kind)) { sessions.set(sessionId, kind); if (patterns) await fetchOn(sessionId).catch(() => {}); }
    if (kind !== 'browser') await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId).catch(() => {});
    if (waitingForDebugger) await send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
  }
  async function paused(sessionId, e) {
    const r = await onPaused(e).catch(() => null);
    if (r && r.fail) return send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'BlockedByClient' }, sessionId).catch(() => {});
    return send('Fetch.continueRequest', { requestId: e.requestId, ...(r && r.url && r.url !== e.request.url ? { url: r.url } : {}) }, sessionId).catch(() => {});
  }
  ws.onmessage = ev => {
    const m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
    if (m.id) { const p = pending.get(m.id); if (p) { pending.delete(m.id); if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result); } return; }
    if (m.method === 'Target.attachedToTarget') attached(m.params);
    else if (m.method === 'Target.detachedFromTarget') sessions.delete(m.params.sessionId);
    else if (m.method === 'Fetch.requestPaused' && m.sessionId) paused(m.sessionId, m.params);
  };
  ws.onclose = () => { closed = true; for (const p of pending.values()) p.rej(new Error('closed')); pending.clear(); };
  // Every target there is now, and every new one.
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  return {
    async set(p) {
      patterns = p && p.length ? p : null;
      await Promise.all([...sessions.keys()].map(s => fetchOn(s).catch(() => {})));
    },
    targets: () => sessions.size,
    async close() { if (closed) return; patterns = null; closed = true; try { ws.close(); } catch (e) {} },
  };
}
