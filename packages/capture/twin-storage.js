// A twin window's own storage (host-ops capTwins installs it before the twin loads, in every frame): what a twin's page
// writes stays in that window. The app's real storage is shared with the recorded tab (one profile), and a twin's
// click that saves UI state (a collapsed nav, a dismissed bubble, "Show more") would otherwise change the recorded
// tab's later screens, live through storage events.
//   localStorage    reads fall through to the real store; writes and removals go to a shadow of this window
//   cookies         document.cookie writes go to a shadow (reads merge it in); cookieStore writes do nothing
//   IndexedDB       put, add, delete, clear and a cursor's update or delete become a count() (a request that writes
//                   nothing and succeeds); deleteDatabase does nothing
//   Cache API       put, add, addAll and delete do nothing
//   BroadcastChannel  a twin sends nothing (it still hears the others)
// Not covered: a worker's or the service worker's own writes, and a schema upgrade (a twin runs the same build).
(() => {
  if (window.__d1twin) return;
  Object.defineProperty(window, '__d1twin', { value: true });
  const shadowOf = real => {
    const own = new Map(), gone = new Set();
    const keys = () => {
      const out = [];
      for (let i = 0; i < real.length; i++) { const k = real.key(i); if (!gone.has(k) && !own.has(k)) out.push(k); }
      return [...out, ...own.keys()];
    };
    const api = {
      getItem: k => { k = String(k); return own.has(k) ? own.get(k) : gone.has(k) ? null : real.getItem(k); },
      setItem: (k, v) => { k = String(k); own.set(k, String(v)); gone.delete(k); },
      removeItem: k => { k = String(k); own.delete(k); gone.add(k); },
      clear: () => { for (const k of keys()) gone.add(k); own.clear(); },
      key: i => { const ks = keys(); return i >= 0 && i < ks.length ? ks[i] : null; },
      get length() { return keys().length; },
    };
    return new Proxy(api, {
      get: (t, p) => typeof p === 'symbol' || p in t ? t[p] : t.getItem(p),
      set: (t, p, v) => { t.setItem(p, v); return true; },
      deleteProperty: (t, p) => { t.removeItem(p); return true; },
      has: (t, p) => p in t || t.getItem(p) !== null,
      ownKeys: () => keys(),
      getOwnPropertyDescriptor: (t, p) => { const v = t.getItem(p); return v === null ? undefined : { value: v, writable: true, enumerable: true, configurable: true }; },
    });
  };
  try { const ls = shadowOf(window.localStorage); Object.defineProperty(window, 'localStorage', { get: () => ls, configurable: true }); } catch (e) {}
  try {
    const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie'), own = new Map();
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get() {
        const m = new Map(String(desc.get.call(document)).split(/;\s*/).filter(Boolean).map(c => { const i = c.indexOf('='); return i < 0 ? [c, ''] : [c.slice(0, i), c.slice(i + 1)]; }));
        for (const [k, v] of own) { if (v === null) m.delete(k); else m.set(k, v); }
        return [...m].map(([k, v]) => `${k}=${v}`).join('; ');
      },
      set(v) {
        const [pair, ...attrs] = String(v).split(';'), i = pair.indexOf('='), k = (i < 0 ? pair : pair.slice(0, i)).trim();
        const gone = attrs.some(a => /^\s*max-age\s*=\s*(0|-)/i.test(a) || (/^\s*expires\s*=/i.test(a) && Date.parse(a.slice(a.indexOf('=') + 1)) < Date.now()));
        own.set(k, gone ? null : (i < 0 ? '' : pair.slice(i + 1).trim()));
      },
    });
  } catch (e) {}
  try { if (window.cookieStore) { const cs = window.cookieStore; cs.set = async () => undefined; cs.delete = async () => undefined; } } catch (e) {}
  try {
    const S = IDBObjectStore.prototype;
    for (const m of ['put', 'add', 'delete', 'clear']) S[m] = function () { return this.count(); };
    const C = IDBCursor.prototype;
    for (const m of ['update', 'delete']) C[m] = function () { return this.source.count(); };
    IDBFactory.prototype.deleteDatabase = function () {
      const r = new EventTarget();
      Object.assign(r, { result: undefined, error: null, readyState: 'done', onsuccess: null, onerror: null, onblocked: null });
      setTimeout(() => { const e = new Event('success'); r.dispatchEvent(e); if (typeof r.onsuccess === 'function') r.onsuccess(e); }, 0);
      return r;
    };
  } catch (e) {}
  try {
    const K = Cache.prototype;
    K.put = async () => undefined; K.add = async () => undefined; K.addAll = async () => undefined; K.delete = async () => false;
    CacheStorage.prototype.delete = async () => false;
  } catch (e) {}
  try { BroadcastChannel.prototype.postMessage = function () {}; } catch (e) {}
})();
