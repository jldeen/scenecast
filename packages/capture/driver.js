// Capture driver, inlined by build.mjs into dist/agent.js for playwright-chrome's browser_run_code_unsafe (or a
// local Playwright page in the kit's self-test). It runs on the presenter's signed-in Chrome, starts a command loop
// that long-polls the local receiver (RX, set by build.mjs), and returns. Commands come from capture/cli.mjs
// (bash). Nothing here clicks or types unless a command says so; the recorder (recorder.js) only watches.
const ctx = page0.context();
// Every fixed wait is counted (SLEPT.ms), so the recorder can say how much of its time was waiting rather than work.
// Only deliberate waits inside work (settle delays in a sweep, before a click): timeouts, polling loops and the command
// loop use poll(), which isn't counted. Counting those too made "fixed waits" more than the time it measured (a 3 s
// timeout counted in full each time, and loops running side by side counted twice).
const SLEPT = { ms: 0 };
const sleep = ms => { SLEPT.ms += ms; return new Promise(r => setTimeout(r, ms)); };
const poll = ms => new Promise(r => setTimeout(r, ms));
// Is the screen quiet? No DOM change for ms, no finite animation running, and (where the browser's requests are
// visible: the extension) no request in flight and none finished in the last ms. Long-lived streams and sockets
// don't count. Waiting for this, never a fixed delay, is what keeps the recorder quick on a quick page.
const QUIET_PAGE = `(() => { const w = window; if (!w.__scq) { w.__scq = { at: performance.now() }; try { new MutationObserver(() => { w.__scq.at = performance.now(); }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true }); } catch (e) {} }
  let anims = 0; try { anims = document.getAnimations().filter(a => a.playState === 'running' && a.effect && isFinite(a.effect.getComputedTiming().endTime)).length; } catch (e) {}
  return { mut: performance.now() - w.__scq.at, anims }; })()`;
async function isQuiet(p, ms, f) {
  const q = await (f || p.mainFrame()).evaluate(QUIET_PAGE).catch(() => null);
  if (!q || q.mut < ms || q.anims) return false;
  if (p.net) { const now = Date.now(); if ([...p.net.values()].some(t => now - t < 15000) || now - p.netAt < ms) return false; }
  return true;
}
async function waitQuiet(p, ms = 300, maxMs = 5000, f) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) { if (await isQuiet(p, ms, f)) return true; await poll(60); }
  return false;
}
const post = (path, data) => page0.request.post(RX + path, { data, timeout: 180000 }).then(r => r.json()).catch(e => ({ error: String(e && e.message || e) }));
const get = path => page0.request.get(RX + path, { timeout: 60000 }).then(r => r.json()).catch(e => ({ op: 'idle', error: String(e) }));
const rlog = msg => post('/log', { msg });
const SERX = opts => `(${SER})(${JSON.stringify(opts || {})})`;
// Closed shadow roots are out of the page's own reach; the extension hands them to the serializer (EXPOSE_SHADOW,
// through the DevTools protocol). Playwright's agent has no way to, so it's a no-op there.
const exposeShadow = typeof EXPOSE_SHADOW === 'function' ? EXPOSE_SHADOW : async () => 0;

// A tab by its mark (sessionStorage d1tab, set by the mark op) or by part of its URL. In the extension only tabs it
// already watches are asked for a mark, and a tab is attached before it's handed back.
async function pageFor(spec) {
  if (!spec) return (ctx.activePage && await ctx.activePage()) || page0;
  const markOf = p => Promise.race([p.evaluate(() => sessionStorage.getItem('d1tab')), poll(3000).then(() => null)]).catch(() => null);
  for (const p of ctx.pages()) { if (p.attached === false) continue; if ((await markOf(p)) === spec) return p; }
  // A marked tab among the ones whose address matches wins even if it isn't attached yet (after the recorder reloads).
  const hits = ctx.pages().filter(p => p.url().includes(spec));
  for (const p of hits) if (p.attached === false && hits.length > 1) { if (p.attach) await p.attach().catch(() => {}); if ((await markOf(p)) === spec) return p; }
  for (const p of hits) { if (p.attach) await p.attach(); return p; }
  throw new Error('no tab ' + spec);
}
function frameFor(p, spec) {
  if (!spec) return p.mainFrame();
  const f = p.frames().find(x => x.url().startsWith(spec) || x.url().includes(spec));
  if (!f) throw new Error('no frame ' + spec);
  return f;
}

// Resources: Playwright's request context first (no CSP or CORS), then the page's own fetch, then the browser cache.
async function viaRequest(p, url) {
  try {
    const r = await p.request.get(url, { timeout: 30000, failOnStatusCode: false });
    if (!r.ok()) return { url, error: 'http ' + r.status(), via: 'request' };
    const type = r.headers()['content-type'] || '';
    if (/css/i.test(type) || /\.css(\?|$)/i.test(url)) return { url, text: await r.text(), type, via: 'request' };
    return { url, b64: (await r.body()).toString('base64'), type, via: 'request' };
  } catch (e) { return { url, error: String(e.message || e).slice(0, 200), via: 'request' }; }
}
async function viaPage(f, url) {
  return f.evaluate(async u => {
    try {
      const same = new URL(u).origin === location.origin;
      const r = await fetch(u, { credentials: same ? 'include' : 'omit', cache: 'force-cache' });
      if (!r.ok) return { url: u, error: 'http ' + r.status, via: 'page' };
      const b = await r.blob();
      const type = b.type || r.headers.get('content-type') || '';
      if (/css/i.test(type) || /\.css(\?|$)/i.test(u)) return { url: u, text: await b.text(), type, via: 'page' };
      const d = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(null); fr.readAsDataURL(b); });
      return { url: u, dataUrl: d, type, via: 'page' };
    } catch (e) { return { url: u, error: String(e).slice(0, 200), via: 'page' }; }
  }, url).catch(e => ({ url, error: String(e.message || e).slice(0, 200), via: 'page' }));
}
const CDP = new Map();
async function viaCdp(p, f, url) {
  try {
    let s = CDP.get(f);
    if (!s) { s = await ctx.newCDPSession(f === p.mainFrame() ? p : f); CDP.set(f, s); }
    const tree = await s.send('Page.getFrameTree');
    const ids = []; const walk = n => { ids.push(n.frame.id); (n.childFrames || []).forEach(walk); }; walk(tree.frameTree);
    for (const frameId of ids) {
      try {
        const r = await s.send('Page.getResourceContent', { frameId, url });
        return r.base64Encoded ? { url, b64: r.content, type: '', via: 'cdp' } : { url, text: r.content, type: /\.css(\?|$)/i.test(url) ? 'text/css' : '', via: 'cdp' };
      } catch (e) {}
    }
    return { url, error: 'not in cache', via: 'cdp' };
  } catch (e) { return { url, error: String(e.message || e).slice(0, 200), via: 'cdp' }; }
}
const cssRefs = (text, base) => {
  const out = [];
  const add = v => { v = v.trim().replace(/^['"]|['"]$/g, ''); if (!v || /^(data:|#|about:)/i.test(v)) return; try { out.push(new URL(v, base).href); } catch (e) {} };
  for (const m of text.matchAll(/url\(\s*("([^"]*)"|'([^']*)'|[^)]*)\s*\)/g)) add(m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[1]);
  for (const m of text.matchAll(/@import\s+["']([^"']+)["']/g)) add(m[1]);
  return out;
};
async function fetchResources(p, docs) {
  const where = new Map();
  for (const d of docs) for (const u of d.urls) if (!/^blob:/i.test(u) && !where.has(u)) where.set(u, d.frame);
  let queue = [...where.keys()];
  const seen = new Set(); const stats = { request: 0, page: 0, cdp: 0, failed: [] };
  while (queue.length) {
    const ask = queue.filter(u => !seen.has(u)); ask.forEach(u => seen.add(u));
    const { missing = ask } = await post('/have', { urls: ask });
    const next = [];
    for (let i = 0; i < missing.length; i += 6) {
      const items = await Promise.all(missing.slice(i, i + 6).map(async u => {
        const f = where.get(u) || p.mainFrame();
        let it = await viaRequest(p, u);
        if (it.error) { const a = await viaPage(f, u); if (!a.error) it = a; }
        if (it.error) { const c = await viaCdp(p, f, u); if (!c.error) it = c; }
        if (it.error) stats.failed.push(u.slice(0, 120) + ' ' + it.error); else stats[it.via]++;
        const isCss = /css/i.test(it.type || '') || /\.css(\?|$)/i.test(u);
        if (!it.error && isCss && it.text) {
          const text = it.text;
          for (const n of cssRefs(text, u)) if (!seen.has(n) && !where.has(n)) { where.set(n, f); next.push(n); }
        }
        return it;
      }));
      await post('/res', { items });
    }
    queue = next;
  }
  return stats;
}

// A frame that stops answering (Microsoft apps keep about:blank frames like that; on a presenter's real tabs one held
// Record on "Starting…" for minutes) gets ms to answer, then is left out until it navigates. The main frame is never
// left out: a page that doesn't answer is a real failure.
// noContext: 'skip' for any frame with no script context yet, 'blank' for about:blank ones only. On real tabs most
// frames are like that (Copilot: 18 of 24, Teams: 9 of 13, all about:blank), and each cost 3 s of waiting for one.
const STUCK = new Map();
const noContext = (p, f) => p._ctx instanceof Map && !p._ctx.has(f.id);
async function frameEval(p, f, fn, arg, ms, o = {}) {
  const url = f.url(), main = f === p.mainFrame();
  if (!main && STUCK.get(f) === url) throw new Error('frame left out (it stopped answering)');
  if (!main && o.noContext && (o.noContext === 'skip' || /^about:/.test(url)) && noContext(p, f)) throw new Error('frame has no script context');
  let t;
  const late = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('frame timeout')), ms); });
  try { return await Promise.race([f.evaluate(fn, arg), late]); } catch (e) {
    if (e.message === 'frame timeout') {
      if (!main) STUCK.set(f, url);
      rlog(`${main ? 'the page' : 'a frame'} (${url.slice(0, 100)}) didn't answer in ${ms / 1000} s${main ? '' : '; left out'}`);
    }
    throw e;
  } finally { clearTimeout(t); }
}

// Child frames are keyed f0, f1, … on their <iframe> (data-d1-frame). A frame keeps its key from one snapshot to
// the next, so a flow that names a frame (frame: 'f4') means the same frame on every screen.
async function frameKeys(p) {
  const keys = new Map(), used = new Set(), fresh = [];
  for (const f of p.frames()) {
    if (f === p.mainFrame()) continue;
    try { const el = await f.frameElement(); const k = await el.getAttribute('data-d1-frame'); if (k && !used.has(k)) { used.add(k); keys.set(f, k); } else fresh.push([f, el]); } catch (e) {}
  }
  let n = 0;
  for (const [f, el] of fresh) { while (used.has('f' + n)) n++; const k = 'f' + n; used.add(k); try { await el.evaluate((e, kk) => e.setAttribute('data-d1-frame', kk), k); keys.set(f, k); } catch (e) {} }
  return keys;
}

// One full snapshot of a tab: screenshot first (the exact state), then every frame's DOM, then the resources.
// A clean picture of a screen (opts.clean, the screens themselves and their zoom levels): no text caret, no scrollbar
// the replica doesn't draw (overlay ones, which show for a second after a scroll, and every one on a Mac), no focus
// ring a click left, and the pointer parked in the top right corner, where the checker parks it (so a row it was
// resting on isn't shaded).
// Nov 2026, on real Chrome: the checks found a scrollbar, a caret and a hovered row in the pictures, not the pages.
const CLEAN_CSS = '*{caret-color:transparent!important}';
// Scrollbars the replica doesn't draw: overlay ones (they show only while scrolling), and on a Mac every one, as the
// replica's macOS look has none (player/app/variants.js); with a mouse connected macOS shows classic bars (Nov 23,
// Jessica's Mac: a scrollbar in the admin capture). Windows' are drawn by the replica, so they stay in the picture.
const CLEAN_BARS = '*{scrollbar-width:none!important}*::-webkit-scrollbar{display:none!important}';
// The page's scrollbars hidden by the browser itself (Emulation.setScrollbarsHidden), not only by CSS: Chrome on a Mac
// draws its overlay scrollbar over the page, and the style didn't take it out of the picture (Nov 23, 0.5.4-rc.1 on
// Jessica's Mac). Only where the style hides them too, so nothing moves.
async function hideBars(p, hidden) {
  const params = { hidden };
  if (p.cmd) return p.cmd(undefined, 'Emulation.setScrollbarsHidden', params).catch(() => {});
  let s = LIGHT.get(p);
  if (!s || s === true) { s = await ctx.newCDPSession(p).catch(() => null); if (!s) return; LIGHT.set(p, s); }
  await s.send('Emulation.setScrollbarsHidden', params).catch(() => {});
}
async function cleanFor(p, id = '') {
  const done = [];
  let bars = false;
  // The page's scroll containers and the room their scrollbars take (offsetWidth - clientWidth), for the log: a clean
  // picture that still shows a scrollbar then says which container had one, and whether hiding it worked.
  const room = [];
  for (const f of p.frames()) {
    const ok = await frameEval(p, f, ([css, bars]) => {
      const list = () => [...document.querySelectorAll('*')].filter(e => { const o = getComputedStyle(e).overflowY; return (o === 'auto' || o === 'scroll') && e.scrollHeight > e.clientHeight; }).slice(0, 8).map(e => (e.id ? '#' + e.id : e.tagName.toLowerCase()) + ':' + (e.offsetWidth - e.clientWidth));
      const before = list();
      const d = document.createElement('div'); d.style.cssText = 'position:absolute;top:-999px;width:100px;height:100px;overflow:scroll';
      (document.body || document.documentElement).appendChild(d); const overlay = d.offsetWidth - d.clientWidth === 0 || /Mac/.test(navigator.platform); d.remove();
      const st = document.createElement('style'); st.setAttribute('data-sc-clean', ''); st.textContent = css + (overlay ? bars : '');
      document.documentElement.appendChild(st);
      return { bars: overlay, before, after: list() };
    }, [CLEAN_CSS, CLEAN_BARS], 3000, { noContext: 'skip' }).catch(() => false);
    if (ok) { done.push(f); if (ok.before && ok.before.length) room.push(`${f === p.mainFrame() ? 'main' : 'frame'} ${ok.before.join(' ')} -> ${ok.after.join(' ')}`); }
    if (ok && ok.bars && f === p.mainFrame()) bars = true;
  }
  if (bars) await hideBars(p, true);
  // The style in effect before the picture: two frames in the page.
  await p.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))).catch(() => {});
  if (room.length) await rlog(`clean ${id}: scrollbars ${bars ? 'hidden' : 'kept'}; room before -> after: ${room.join('; ')}`);
  // Parked, unless that changes the screen (a menu or card open because the pointer is on it); back where it was after
  // the picture, so nothing the page does with the pointer changes (it held a click otherwise, real-tabs).
  const look = () => p.evaluate(() => (document.body ? document.body.innerText.length : 0) + '|' + document.querySelectorAll('[aria-expanded="true"],[role=dialog],[role=menu],[role=tooltip]').length).catch(() => null);
  const w = await p.evaluate(() => innerWidth).catch(() => null), was = p._pos ? { ...p._pos } : null;
  let parked = false;
  if (w && was) {
    const before = await look();
    await p.mouse.move(w - 1, 2).catch(() => {});
    await poll(150);
    parked = true;
    if ((await look()) !== before) { await p.mouse.move(was.x, was.y).catch(() => {}); await poll(250); parked = false; }
  }
  // A control left focused by a click (a menu's button after Escape) shows its focus ring: not in the picture, unless
  // letting go of it changes the screen. Text boxes keep theirs (what's typed and the caret are the screen).
  const unfocus = () => p.evaluate(() => {
    const a = document.activeElement;
    if (!a || a === document.body || a === document.documentElement || a.matches('input,textarea,select,[contenteditable]:not([contenteditable=false])')) return false;
    window.__scFocus = a; a.blur(); return true;
  }).catch(() => false);
  const refocus = () => p.evaluate(() => { const a = window.__scFocus; delete window.__scFocus; if (a && a.isConnected) a.focus({ preventScroll: true }); }).catch(() => {});
  const seen = await look();
  let blurred = await unfocus();
  if (blurred) { await poll(100); if ((await look()) !== seen) { await refocus(); await poll(150); blurred = false; } }
  return async () => { if (bars) await hideBars(p, false); if (blurred) await refocus(); if (parked) await p.mouse.move(was.x, was.y).catch(() => {}); for (const f of done) await frameEval(p, f, () => { for (const s of document.querySelectorAll('style[data-sc-clean]')) s.remove(); }, undefined, 3000, { noContext: 'skip' }).catch(() => {}); };
}
async function snap(p, id, opts = {}) {
  const t0 = Date.now();
  if (opts.shot !== false) {
    const undo = opts.clean ? await cleanFor(p, id) : null;
    try { const b = await p.screenshot({ timeout: 60000 }); await post('/shot', { id, b64: b.toString('base64') }); } finally { if (undo) await undo(); }
  }
  const keys = await frameKeys(p);
  await exposeShadow(p).catch(e => rlog(`snap ${id}: closed shadow roots: ${e.message}`));
  const docs = [];
  for (const [f, key] of [[p.mainFrame(), 'main'], ...keys]) {
    try {
      const r = await frameEval(p, f, SERX({}), undefined, f === p.mainFrame() ? 120000 : 20000, { noContext: 'blank' });
      docs.push({ key, parent: f === p.mainFrame() ? null : (keys.get(f.parentFrame()) || 'main'), frameUrl: f.url(), frame: f, ...r });
    } catch (e) { await rlog(`snap ${id}: frame ${key} failed: ${e.message}`); }
  }
  const stats = await fetchResources(p, docs);
  const out = docs.map(d => { const { frame, ...rest } = d; return rest; });
  await post('/snap', { id, docs: out, stats, opts, ms: Date.now() - t0 });
  return { id, docs: out.map(d => `${d.key} ${Math.round(d.html.length / 1024)}KB ${d.urls.length} urls`), stats: { ...stats, failed: stats.failed.slice(0, 20) }, ms: Date.now() - t0 };
}

// Streaming frames: <body> only (CSS comes from the final snapshot), every everyMs until it's done or maxS.
// until 'quiet': done when nothing changed for settleS. until { busy, done, approve } (lists of { sel } or
// { text }): done when nothing changed for settleS, no busy marker shows, and a done marker shows (if given), or
// stopped at an approval (an approve marker showing, then quiet). Copilot: busy [{ text: 'Working on it' },
// { sel: '[aria-label="Stop"]' }], approve [{ sel: 'button', text: 'Approve' }].
const STREAMS = {};
async function stream(p, name, { everyMs = 600, maxS = 900, until = 'quiet', settleS = 6 } = {}) {
  const st = STREAMS[name] = { n: 0, state: 'running', t0: Date.now() };
  let prev = '', quiet = 0;
  const spec = typeof until === 'object' ? until : {};
  const markers = () => p.evaluate(spec => {
    const vis = e => !!e.offsetParent || e.getClientRects().length > 0;
    const any = list => (list || []).some(m => m.sel ? [...document.querySelectorAll(m.sel)].some(e => vis(e) && (m.text === undefined || e.innerText.trim() === m.text)) : document.body.innerText.includes(m.text));
    return { working: any(spec.busy), said: any(spec.done), approve: any(spec.approve) };
  }, spec).catch(() => ({}));
  while (!st.stop && Date.now() - st.t0 < maxS * 1000) {
    const t = Date.now() - st.t0;
    try {
      const r = await p.evaluate(SERX({ body: true, css: false }));
      if (r.html !== prev) {
        prev = r.html;
        await fetchResources(p, [{ urls: r.urls, frame: p.mainFrame() }]);
        await post('/frame', { stream: name, n: st.n++, t, html: r.html, urls: r.urls, inline: r.inline, meta: r.meta });
        quiet = 0;
      } else quiet++;
    } catch (e) { await rlog(`stream ${name}: ${e.message}`); }
    if (typeof until === 'object') {
      const s = await markers();
      st.last = s;
      if (s.approve && !st.approveAt) st.approveAt = Date.now() - st.t0;
      if (s.approve && quiet * everyMs > settleS * 1000) { st.state = 'approve'; break; }
      if ((!spec.done || s.said) && !s.working && !s.approve && quiet * everyMs > settleS * 1000) { st.state = 'done'; break; }
    } else if (until === 'quiet' && quiet * everyMs > settleS * 1000) { st.state = 'done'; break; }
    await poll(everyMs);
  }
  if (st.state === 'running') st.state = st.stop ? 'stopped' : 'timeout';
  st.secs = Math.round((Date.now() - st.t0) / 1000);
  await rlog(`stream ${name} ${st.state} ${st.n} frames ${st.secs}s`);
  return st;
}

// The tab shown light (or back as the system has it): prefers-color-scheme for this tab only, for as long as the
// recorder is attached to it (the take). Apps that follow the system's theme go light; the presenter's other tabs
// and the system don't change.
const LIGHT = new WeakMap();
async function light(p, on) {
  const media = { features: on ? [{ name: 'prefers-color-scheme', value: 'light' }] : [] };
  if (p.cmd) { if (p.attach) await p.attach(); await p.cmd(undefined, 'Emulation.setEmulatedMedia', media); p.media = on ? media : null; LIGHT.set(p, on); return on; }
  let s = LIGHT.get(p);
  if (!s || s === true) { s = await ctx.newCDPSession(p); LIGHT.set(p, s); }
  await s.send('Emulation.setEmulatedMedia', media);
  return on;
}
const H = {
  sleep, poll, light, isQuiet, waitQuiet, post, rlog, snap, stream, STREAMS, pageFor, frameFor, SERX, fetchResources,
  async mark(p, kind) { await p.evaluate(k => sessionStorage.setItem('d1tab', k), kind); },
  async tabs() { const out = []; for (const p of ctx.pages()) { let m = null; try { if (p.attached !== false) m = await p.evaluate(() => sessionStorage.getItem('d1tab')); } catch (e) {} out.push({ url: p.url().slice(0, 160), title: (await p.title().catch(() => '')).slice(0, 80), mark: m }); } return out; },
  // Centre of the smallest visible element whose text matches, in page coordinates (frame offsets included).
  async find(p, { frame, text, sel, exact = true, minX, maxX, nth = 0 } = {}) {
    const f = frameFor(p, frame);
    const r = await f.evaluate(({ text, sel, exact, minX, maxX, nth }) => {
      const els = [...document.querySelectorAll(sel || 'a,button,[role=button],[role=link],[role=tab],[role=menuitem],[role=treeitem],[role=option],[role=switch],input,span,div,p,li')].filter(e => {
        const b = e.getBoundingClientRect(); if (!(b.width > 0 && b.height > 0 && b.bottom > 0 && b.top < innerHeight)) return false;
        if (minX !== undefined && b.x < minX) return false; if (maxX !== undefined && b.x > maxX) return false;
        if (text === undefined) return true;
        const t = (e.innerText || e.getAttribute('aria-label') || '').trim();
        return exact ? t === text : t.includes(text);
      });
      els.sort((a, b) => { const A = a.getBoundingClientRect(), B = b.getBoundingClientRect(); return A.width * A.height - B.width * B.height; });
      const e = text === undefined ? els[0] : els[nth]; if (!e) return null;
      const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height };
    }, { text, sel, exact, minX, maxX, nth });
    if (!r) return null;
    if (f !== p.mainFrame()) { const bb = await (await f.frameElement()).boundingBox(); r.x += bb.x; r.y += bb.y; }
    return r;
  },
};

const OPS = {
  async ping() { return { ok: true, pages: ctx.pages().length }; },
  // What this recorder sees: who it is, every tab it tracks (attached or not, its mark), and the active one.
  async diag() {
    const pages = [];
    for (const p of ctx.pages()) { let mark = null; try { if (p.attached !== false) mark = await p.evaluate(() => sessionStorage.getItem('d1tab')); } catch (e) {} const frames = p.attached !== false && p._ctx ? p.frames().map(f => ({ url: f.url().slice(0, 100), context: p._ctx.has(f.id), child: !!f.sessionId })) : undefined; pages.push({ url: p.url().slice(0, 160), title: (await p.title().catch(() => '')).slice(0, 80), attached: p.attached !== false, mark, frames }); }
    const act = ctx.activePage ? await ctx.activePage().catch(() => null) : null;
    return { agent: typeof AGENT_ID !== 'undefined' ? AGENT_ID : null, receiver: RX, pages, active: act ? act.url().slice(0, 160) : null, recording: typeof REC !== 'undefined' ? !!REC.on : null };
  },
  async tabs() { return H.tabs(); },
  // The browser's open web pages, in its own order, for New demo: from its tab list, without attaching to any of them.
  async openTabs() {
    const all = typeof chrome !== 'undefined' && chrome.tabs ? await chrome.tabs.query({}) : ctx.pages().map(p => ({ url: p.url(), title: '' }));
    return all.filter(t => /^https?:/i.test(t.url || '')).map(t => ({ title: String(t.title || '').slice(0, 120), url: String(t.url).slice(0, 400), active: !!t.active }));
  },
  async mark(c) { const p = await pageFor(c.url); await H.mark(p, c.kind); return 'ok'; },
  async front(c) { const p = await pageFor(c.tab); await p.bringToFront(); return p.url(); },
  async goto(c) { const p = await pageFor(c.tab); await p.goto(c.url, { waitUntil: 'domcontentloaded' }); return p.url(); },
  async snap(c) { const p = await pageFor(c.tab); return snap(p, c.id, c); },
  async shot(c) { const p = await pageFor(c.tab); const b = await p.screenshot({ timeout: 60000 }); await post('/shot', { id: c.id, b64: b.toString('base64') }); return 'ok'; },
  async stream(c) { const p = await pageFor(c.tab); stream(p, c.name, c); return 'started'; },
  async streamStatus(c) { const s = STREAMS[c.name]; return s ? { n: s.n, state: s.state, secs: Math.round((Date.now() - s.t0) / 1000), last: s.last, approveAt: s.approveAt } : null; },
  async streamStop(c) { if (STREAMS[c.name]) STREAMS[c.name].stop = true; return 'ok'; },
  async eval(c) { const p = await pageFor(c.tab); return frameFor(p, c.frame).evaluate(c.expr); },
  async find(c) { const p = await pageFor(c.tab); return H.find(p, c); },
  async click(c) {
    const p = await pageFor(c.tab);
    const pt = c.x !== undefined ? { x: c.x, y: c.y } : await H.find(p, c);
    if (!pt) throw new Error('not found: ' + JSON.stringify(c));
    await p.mouse.move(pt.x, pt.y, { steps: 6 }); await sleep(150); await p.mouse.click(pt.x, pt.y); return pt;
  },
  async hover(c) { const p = await pageFor(c.tab); const pt = c.x !== undefined ? { x: c.x, y: c.y } : await H.find(p, c); if (!pt) throw new Error('not found'); await p.mouse.move(pt.x, pt.y, { steps: 8 }); return pt; },
  async type(c) { const p = await pageFor(c.tab); await p.keyboard.type(c.text, { delay: c.delay || 15 }); return 'ok'; },
  async press(c) { const p = await pageFor(c.tab); await p.keyboard.press(c.key); return 'ok'; },
  // Empties the box that has the focus, the way a person would (select its text, Backspace), so typing replaces what
  // was there: Copilot puts the last unsent prompt back in its box (Nov 20: a prompt typed on top of it, doubled).
  // Cmd+A as a key event selects nothing on a Mac. Returns how many characters there were.
  async clear(c) {
    const p = await pageFor(c.tab);
    const had = await p.mainFrame().evaluate(() => {
      let e = document.activeElement;
      while (e && e.shadowRoot && e.shadowRoot.activeElement) e = e.shadowRoot.activeElement;
      if (!e) return 0;
      if (e.localName === 'input' || e.localName === 'textarea') { if (!e.value) return 0; e.select(); return e.value.length; }
      if (!e.isContentEditable) return 0;
      while (e.parentElement && e.parentElement.isContentEditable) e = e.parentElement;
      const n = (e.innerText || '').replace(/[\u200b\u200c\s]+/g, '').length;
      if (!n) return 0;
      const r = document.createRange(); r.selectNodeContents(e); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      return n;
    });
    if (had) { await sleep(100); await p.keyboard.press('Backspace'); await sleep(200); }
    return had;
  },
  async wheel(c) { const p = await pageFor(c.tab); if (c.x !== undefined) await p.mouse.move(c.x, c.y); await p.mouse.wheel(0, c.dy || 0); await sleep(400); return 'ok'; },
  // The page as the AI sees it (outline-page.js): its controls by role and name, where they are, and its words.
  async observe(c) { const p = await pageFor(c.tab); return p.mainFrame().evaluate(`(${OUTLINE_PAGE})(${JSON.stringify(c.opts || {})})`); },
  async js(c) { const AF = Object.getPrototypeOf(async function () {}).constructor; return new AF('ctx', 'page', 'H', c.code)(ctx, c.tab ? await pageFor(c.tab) : page0, H); },
};

let RUNNING = true;
// A command running, and when the last one that could touch a tab finished: the extension lets go of tabs nothing has
// asked for in a while (main.js). Status questions don't count.
let OP_BUSY = 0, LAST_OP = Date.now();
const QUIET_OPS = new Set(['recordStatus', 'extension']);
function startLoop() { (async () => {
  await rlog('agent started; pages ' + ctx.pages().length);
  while (RUNNING) {
    const c = await get('/cmd' + (typeof AGENT_QS === 'function' ? await AGENT_QS() : ''));
    if (c.error) { await poll(2000); continue; }
    if (!c.op || c.op === 'idle') continue;
    if (c.op === 'quit') { RUNNING = false; await post('/cmd/result', { id: c.id, ok: true, value: 'bye' }); break; }
    const t0 = Date.now(), quiet = QUIET_OPS.has(c.op);
    if (!quiet) OP_BUSY++;
    try {
      const f = OPS[c.op]; if (!f) throw new Error('unknown op ' + c.op);
      const v = await f(c);
      await post('/cmd/result', { id: c.id, ok: true, value: v === undefined ? null : v, ms: Date.now() - t0 });
    } catch (e) { await post('/cmd/result', { id: c.id, ok: false, error: String(e && e.stack || e).slice(0, 1500), ms: Date.now() - t0 }); }
    finally { if (!quiet) { OP_BUSY--; LAST_OP = Date.now(); } }
  }
})(); }
