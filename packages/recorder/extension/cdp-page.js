// Playwright-shaped pages over chrome.debugger, for the recorder extension's service worker. The capture driver,
// the recorder and the side-state audits (driver.js, recorder.js, flows/*) were written against Playwright's page
// and frame; this gives them the same calls (evaluate, frames, frameElement, mouse, keyboard, screenshot, CDP
// sessions, request) on the presenter's own tabs, through the DevTools protocol the extension may speak.
// Cross-origin iframes in their own process (OOPIFs) are attached as flattened sessions, so frames() lists them
// like Playwright does. Nothing here clicks or types unless the driver asks.
const CDPX = (() => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const tabs = new Map(); // tabId → Page
  const b64of = buf => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  // What Playwright hands back for a screenshot or a body: something with toString('base64').
  const B64 = b64 => ({ b64, toString(enc) { return enc === 'base64' ? b64 : atob(b64); } });
  // A renderer that stops answering never calls back: every call gets SEND_MS (a big snapshot takes tens of seconds),
  // so nothing in the recorder can wait for ever.
  const SEND_MS = 150000;
  const send = (tabId, sessionId, method, params) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${method}: no answer in ${SEND_MS / 1000} s`)), SEND_MS);
    chrome.debugger.sendCommand(sessionId ? { tabId, sessionId } : { tabId }, method, params || {}, r => { clearTimeout(t); const e = chrome.runtime.lastError; if (e) rej(new Error(`${method}: ${e.message}`)); else res(r); });
  });
  const KEYS = {
    Enter: { code: 'Enter', keyCode: 13, text: '\r' }, Escape: { code: 'Escape', keyCode: 27 }, Backspace: { code: 'Backspace', keyCode: 8 },
    Tab: { code: 'Tab', keyCode: 9 }, Delete: { code: 'Delete', keyCode: 46 }, ' ': { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
    ArrowUp: { code: 'ArrowUp', keyCode: 38 }, ArrowDown: { code: 'ArrowDown', keyCode: 40 }, ArrowLeft: { code: 'ArrowLeft', keyCode: 37 }, ArrowRight: { code: 'ArrowRight', keyCode: 39 },
    Home: { code: 'Home', keyCode: 36 }, End: { code: 'End', keyCode: 35 }, PageUp: { code: 'PageUp', keyCode: 33 }, PageDown: { code: 'PageDown', keyCode: 34 },
    Shift: { code: 'ShiftLeft', keyCode: 16 }, Control: { code: 'ControlLeft', keyCode: 17 }, Alt: { code: 'AltLeft', keyCode: 18 }, Meta: { code: 'MetaLeft', keyCode: 91 },
  };
  const MODS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
  const keyDef = k => KEYS[k] || (k.length === 1
    ? { key: k, code: /[a-z]/i.test(k) ? 'Key' + k.toUpperCase() : /\d/.test(k) ? 'Digit' + k : '', keyCode: /[a-z0-9]/i.test(k) ? k.toUpperCase().charCodeAt(0) : 0, text: k }
    : { key: k, code: k, keyCode: 0 });
  const wrapFn = (fn, arg) => typeof fn === 'function' ? `(${fn})(${arg === undefined ? '' : JSON.stringify(arg)})` : String(fn);
  const unwrap = (r, what) => {
    if (r.exceptionDetails) { const d = r.exceptionDetails; throw new Error(`${what}: ${(d.exception && (d.exception.description || d.exception.value)) || d.text}`); }
    return r.result ? r.result.value : undefined;
  };

  class ElementHandle {
    constructor(frame, objectId) { this.frame = frame; this.objectId = objectId; }
    async call(fn, arg) {
      const r = await this.frame.page.cmd(this.frame.sessionId, 'Runtime.callFunctionOn', { objectId: this.objectId, functionDeclaration: `function (a) { return (${fn})(this, a); }`, arguments: [{ value: arg }], returnByValue: true, awaitPromise: true });
      return unwrap(r, 'element');
    }
    evaluate(fn, arg) { return this.call(fn, arg); }
    getAttribute(n) { return this.call((e, n) => e.getAttribute(n), n); }
    // The border box in the top page's coordinates (frame offsets included), like Playwright.
    async boundingBox() {
      const r = await this.call(e => { const b = e.getBoundingClientRect(); return b.width || b.height ? { x: b.x, y: b.y, width: b.width, height: b.height } : null; });
      if (!r) return null;
      const off = await this.frame.offset();
      return { x: r.x + off.x, y: r.y + off.y, width: r.width, height: r.height };
    }
  }

  class Frame {
    constructor(page, id, sessionId) { this.page = page; this.id = id; this.sessionId = sessionId; this._url = ''; this.parentId = null; }
    url() { return this._url; }
    parentFrame() { return this.parentId ? this.page._frames.get(this.parentId) || null : null; }
    async context() {
      for (let i = 0; i < 60; i++) { const c = this.page._ctx.get(this.id); if (c) return c; await sleep(50); }
      throw new Error('no execution context for frame ' + this._url.slice(0, 80));
    }
    async evaluate(fn, arg) {
      const expression = wrapFn(fn, arg);
      for (let attempt = 0; ; attempt++) {
        const contextId = await this.context();
        try {
          return unwrap(await this.page.cmd(this.sessionId, 'Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true }), 'evaluate');
        } catch (e) {
          // The context went away under us (a navigation): once more, on the new one.
          if (attempt < 1 && /context|Cannot find|destroyed/i.test(e.message)) { if (this.page._ctx.get(this.id) === contextId) this.page._ctx.delete(this.id); continue; }
          throw e;
        }
      }
    }
    // The <iframe> element in the parent frame's document.
    async frameElement() {
      const parent = this.parentFrame();
      if (!parent) throw new Error('main frame has no frame element');
      const owner = await this.page.cmd(parent.sessionId, 'DOM.getFrameOwner', { frameId: this.id });
      const r = await this.page.cmd(parent.sessionId, 'DOM.resolveNode', { backendNodeId: owner.backendNodeId, executionContextId: await parent.context() });
      return new ElementHandle(parent, r.object.objectId);
    }
    // Where this frame's viewport starts in the top page: each <iframe>'s content box, summed up the chain.
    async offset() {
      let x = 0, y = 0, f = this;
      while (f.parentFrame()) {
        const el = await f.frameElement();
        const b = await el.call(e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return { x: r.x + parseFloat(s.borderLeftWidth) + parseFloat(s.paddingLeft), y: r.y + parseFloat(s.borderTopWidth) + parseFloat(s.paddingTop) }; });
        x += b.x; y += b.y; f = f.parentFrame();
      }
      return { x, y };
    }
    getByText(text, o = {}) { return locator(this, text, o); }
  }

  // getByText(text).first(): the smallest visible element with that text (all the flows need).
  function locator(frame, text, o) {
    const find = () => frame.evaluate(({ text, exact }) => {
      const norm = s => (s || '').replace(/\s+/g, ' ').trim();
      const els = [...document.querySelectorAll('body *')].filter(e => { const t = norm(e.innerText); return exact ? t === text : t.includes(text); });
      els.sort((a, b) => { const A = a.getBoundingClientRect(), B = b.getBoundingClientRect(); return A.width * A.height - B.width * B.height; });
      const e = els.find(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      if (!e) return null;
      const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
    }, { text, exact: !!o.exact });
    const L = {
      first: () => L,
      async count() { return (await find()) ? 1 : 0; },
      async isVisible() { return !!(await find()); },
      async boundingBox() { const b = await find(); if (!b) return null; const off = await frame.offset(); return { ...b, x: b.x + off.x, y: b.y + off.y }; },
      async click() { const b = await L.boundingBox(); if (!b) throw new Error('not found: ' + text); await frame.page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); },
    };
    return L;
  }

  class Page {
    constructor(ctx, tab) {
      this.ctx = ctx; this.tabId = tab.id; this._tabUrl = tab.url || tab.pendingUrl || ''; this._title = tab.title || '';
      this.attached = false; this._attaching = null;
      this._frames = new Map(); this._ctx = new Map();
      this._main = null; this._pos = { x: 0, y: 0 }; this._buttons = 0; this._mods = 0;
      this.net = new Map(); this.netAt = Date.now();
      this.mouse = {
        move: (x, y, o = {}) => this.mouseMove(x, y, o.steps || 1),
        down: (o = {}) => this.mouseButton('mousePressed', o.button || 'left', o.clickCount || 1),
        up: (o = {}) => this.mouseButton('mouseReleased', o.button || 'left', o.clickCount || 1),
        click: async (x, y, o = {}) => { await this.mouseMove(x, y, 1); for (let i = 1; i <= (o.clickCount || 1); i++) { await this.mouseButton('mousePressed', o.button || 'left', i); if (o.delay) await sleep(o.delay); await this.mouseButton('mouseReleased', o.button || 'left', i); } },
        wheel: async (dx, dy) => { await this.attach(); await this.cmd(undefined, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: this._pos.x, y: this._pos.y, deltaX: dx, deltaY: dy, modifiers: this._mods }); },
      };
      this.keyboard = {
        press: async (key, o = {}) => {
          const parts = key.length > 1 ? key.split('+') : [key], k = parts.pop();
          for (const m of parts) await this.key('keyDown', m);
          await this.key('keyDown', k); if (o.delay) await sleep(o.delay); await this.key('keyUp', k);
          for (const m of parts.reverse()) await this.key('keyUp', m);
        },
        down: k => this.key('keyDown', k),
        up: k => this.key('keyUp', k),
        type: async (text, o = {}) => { for (const ch of text) { await this.keyboard.press(ch === '\n' ? 'Enter' : ch); if (o.delay) await sleep(o.delay); } },
        insertText: async text => { await this.attach(); await this.cmd(undefined, 'Input.insertText', { text }); },
      };
      this.request = ctx.request;
    }
    context() { return this.ctx; }
    cmd(sessionId, method, params) { return send(this.tabId, sessionId, method, params); }
    async attach() {
      if (this.attached) return;
      if (!this._attaching) this._attaching = (async () => {
        const attach = () => new Promise(res => chrome.debugger.attach({ tabId: this.tabId }, '1.3', () => res(chrome.runtime.lastError)));
        let e = await attach();
        // Still attached from before the worker restarted: that session announced its frames and contexts to the
        // worker that's gone. A fresh one announces them again.
        if (e && /already attached/i.test(e.message)) { await chrome.debugger.detach({ tabId: this.tabId }).catch(() => {}); e = await attach(); }
        if (e) throw new Error('attach: ' + e.message);
        this.attached = true;
        await this.enableSession(undefined);
      })().finally(() => { this._attaching = null; });
      return this._attaching;
    }
    async enableSession(sessionId) {
      await this.cmd(sessionId, 'Page.enable');
      const tree = await this.cmd(sessionId, 'Page.getFrameTree');
      const walk = (n, parentId) => { this.addFrame(n.frame, sessionId, parentId); for (const c of n.childFrames || []) walk(c, n.frame.id); };
      walk(tree.frameTree, tree.frameTree.frame.parentId);
      await this.cmd(sessionId, 'Runtime.enable');
      await this.cmd(sessionId, 'Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }).catch(() => {});
      await this.cmd(sessionId, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
    }
    addFrame(fr, sessionId, parentId) {
      let f = this._frames.get(fr.id);
      if (!f) { f = new Frame(this, fr.id, sessionId); this._frames.set(fr.id, f); }
      f.sessionId = sessionId;
      if (fr.url !== undefined) f._url = fr.url + (fr.urlFragment || '');
      if (parentId) f.parentId = parentId;
      if (!f.parentId && sessionId === undefined) this._main = f;
      return f;
    }
    onEvent(sessionId, method, p) {
      switch (method) {
        case 'Page.frameAttached': this.addFrame({ id: p.frameId }, (this._frames.get(p.frameId) || {}).sessionId || sessionId, p.parentFrameId); break;
        case 'Page.frameNavigated': this.addFrame(p.frame, sessionId, p.frame.parentId); break;
        case 'Page.navigatedWithinDocument': { const f = this._frames.get(p.frameId); if (f) f._url = p.url; break; }
        case 'Page.frameDetached': if (p.reason !== 'swap') { this._frames.delete(p.frameId); this._ctx.delete(p.frameId); } break;
        case 'Page.loadEventFired': if (!sessionId && this._onLoad) this._onLoad(); break;
        case 'Runtime.executionContextCreated': { const a = p.context.auxData || {}; if (a.isDefault && a.frameId) this._ctx.set(a.frameId, p.context.id); break; }
        case 'Runtime.executionContextDestroyed': for (const [k, v] of this._ctx) if (v === p.executionContextId && (this._frames.get(k) || {}).sessionId === sessionId) this._ctx.delete(k); break;
        case 'Runtime.executionContextsCleared': for (const [k] of this._ctx) if ((this._frames.get(k) || {}).sessionId === sessionId) this._ctx.delete(k); break;
        case 'Target.attachedToTarget':
          if (p.targetInfo.type === 'iframe') this.enableSession(p.sessionId).catch(() => {});
          else this.cmd(p.sessionId, 'Runtime.runIfWaitingForDebugger').catch(() => {});
          break;
        case 'Target.detachedFromTarget': for (const [k, f] of this._frames) if (f.sessionId === p.sessionId) { this._frames.delete(k); this._ctx.delete(k); } break;
        // Requests in flight, for the quiet wait (event streams and sockets stay open; they don't count).
        case 'Network.requestWillBeSent': if (!/^(EventSource|WebSocket|Ping|Other)$/.test(p.type || '')) { this.net.set(p.requestId, Date.now()); this.netAt = Date.now(); } break;
        case 'Network.loadingFinished': case 'Network.loadingFailed': if (this.net.delete(p.requestId)) this.netAt = Date.now(); break;
      }
    }
    onDetach() { this.attached = false; this._frames.clear(); this._ctx.clear(); this._main = null; this.net.clear(); }
    url() { return this._main ? this._main._url : this._tabUrl; }
    async title() { return this.attached ? this.mainFrame().evaluate(() => document.title).catch(() => this._title) : this._title; }
    mainFrame() { if (!this._main) throw new Error('tab not attached'); return this._main; }
    frames() { const m = this._main; if (!m) return []; return [m, ...[...this._frames.values()].filter(f => f !== m && this.reaches(f))]; }
    // Frames this page's own process no longer has (on a real Copilot tab, 18 of 24 tracked frames were gone from
    // the page: about:blank ones with no script context, each costing a wait on every call into the page's frames).
    async prune() {
      if (!this.attached) return 0;
      const tree = await this.cmd(undefined, 'Page.getFrameTree').catch(() => null);
      if (!tree) return 0;
      const live = new Set(), walk = n => { live.add(n.frame.id); for (const c of n.childFrames || []) walk(c); };
      walk(tree.frameTree);
      let n = 0;
      for (const [id, f] of this._frames) if (!f.sessionId && !live.has(id)) { this._frames.delete(id); this._ctx.delete(id); n++; }
      return n;
    }
    reaches(f) { for (let i = 0; f && i < 20; i++) { if (f === this._main) return true; f = f.parentFrame(); } return false; }
    async evaluate(fn, arg) { await this.attach(); return this.mainFrame().evaluate(fn, arg); }
    async bringToFront() {
      const t = await chrome.tabs.update(this.tabId, { active: true }).catch(() => null);
      if (t) await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
    }
    async goto(url) {
      await this.attach();
      const loaded = new Promise(res => { this._onLoad = res; setTimeout(res, 30000); });
      await this.cmd(undefined, 'Page.navigate', { url });
      await loaded; this._onLoad = null;
      return null;
    }
    async mouseMove(x, y, steps) {
      await this.attach();
      const { x: x0, y: y0 } = this._pos;
      for (let i = 1; i <= steps; i++) {
        await this.cmd(undefined, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + (x - x0) * i / steps, y: y0 + (y - y0) * i / steps, buttons: this._buttons, button: this._buttons ? 'left' : 'none', modifiers: this._mods });
      }
      this._pos = { x, y };
    }
    async mouseButton(type, button, clickCount) {
      await this.attach();
      this._buttons = type === 'mousePressed' ? 1 : 0;
      await this.cmd(undefined, 'Input.dispatchMouseEvent', { type, x: this._pos.x, y: this._pos.y, button, buttons: this._buttons, clickCount, modifiers: this._mods });
    }
    async key(type, k) {
      await this.attach();
      const d = keyDef(k);
      if (MODS[k]) this._mods = type === 'keyDown' ? this._mods | MODS[k] : this._mods & ~MODS[k];
      const text = type === 'keyDown' && !(this._mods & (MODS.Control | MODS.Meta | MODS.Alt)) ? d.text : undefined;
      await this.cmd(undefined, 'Input.dispatchKeyEvent', { type: type === 'keyDown' ? (text ? 'keyDown' : 'rawKeyDown') : 'keyUp', key: d.key || k, code: d.code, windowsVirtualKeyCode: d.keyCode, nativeVirtualKeyCode: d.keyCode, text, unmodifiedText: text, modifiers: this._mods });
    }
    // A real screenshot of the tab as it is (the fidelity reference), with the text caret hidden as Playwright does.
    async screenshot(o = {}) {
      await this.attach();
      const hide = '(() => { if (document.getElementById("__sc_caret")) return; const s = document.createElement("style"); s.id = "__sc_caret"; s.textContent = "*,*::before,*::after{caret-color:transparent !important}"; (document.head || document.documentElement).appendChild(s); })()';
      await this.cmd(undefined, 'Runtime.evaluate', { expression: hide }).catch(() => {});
      try {
        const params = { format: 'png', fromSurface: true, captureBeyondViewport: false };
        if (o.clip) params.clip = { x: o.clip.x, y: o.clip.y, width: o.clip.width, height: o.clip.height, scale: 1 };
        const r = await Promise.race([this.cmd(undefined, 'Page.captureScreenshot', params), sleep(o.timeout || 60000).then(() => { throw new Error('screenshot timed out'); })]);
        return B64(r.data);
      } finally { await this.cmd(undefined, 'Runtime.evaluate', { expression: 'document.getElementById("__sc_caret")?.remove()' }).catch(() => {}); }
    }
    viewportSize() { return null; }
    async setViewportSize() {}
    getByText(text, o = {}) { return locator(this.mainFrame(), text, o); }
    async close() { await chrome.tabs.remove(this.tabId).catch(() => {}); }
  }

  // Requests from the extension itself: no CORS, and the cookies of the sites it may read (host permissions).
  const respOf = async r => {
    const buf = await r.arrayBuffer();
    const headers = {}; r.headers.forEach((v, k) => { headers[k] = v; });
    const text = () => new TextDecoder().decode(buf);
    return { ok: () => r.ok, status: () => r.status, headers: () => headers, text: async () => text(), json: async () => JSON.parse(text()), body: async () => B64(b64of(buf)) };
  };
  const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => { throw new Error('request timed out'); })]);
  const request = {
    get: (url, o = {}) => withTimeout(fetch(url, { credentials: 'include', cache: /^http:\/\/127\.0\.0\.1/.test(url) ? 'no-store' : 'force-cache' }).then(respOf), o.timeout || 60000),
    post: (url, o = {}) => withTimeout(fetch(url, { method: 'POST', body: typeof o.data === 'string' ? o.data : JSON.stringify(o.data), headers: { 'content-type': 'application/json' } }).then(respOf), o.timeout || 60000),
  };

  const ctx = {
    request,
    pages() { return [...tabs.values()]; },
    async newCDPSession(target) {
      const page = target instanceof Frame ? target.page : target, sessionId = target instanceof Frame ? target.sessionId : undefined;
      await page.attach();
      return { send: (m, p) => page.cmd(sessionId, m, p), detach: async () => {} };
    },
    // The tab the presenter is looking at.
    async activePage() { const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); return t && tabs.get(t.id); },
    // A new tab, in the background unless active, attached and loaded: for side states swept in parallel.
    async newPage(url, o = {}) {
      const t = await chrome.tabs.create({ url: 'about:blank', active: !!o.active, ...(o.windowId ? { windowId: o.windowId } : {}) });
      let p = tabs.get(t.id); if (!p) { p = new Page(ctx, t); tabs.set(t.id, p); }
      await p.attach();
      if (url) await p.goto(url);
      return p;
    },
    async detachAll() { for (const p of tabs.values()) if (p.attached) await chrome.debugger.detach({ tabId: p.tabId }).catch(() => {}); },
  };

  const usable = t => t && t.id !== undefined && t.id >= 0 && /^(https?|file):|^about:blank/i.test(t.url || t.pendingUrl || '');
  const track = t => { if (!usable(t)) return; let p = tabs.get(t.id); if (!p) { p = new Page(ctx, t); tabs.set(t.id, p); } else if (!p.attached) { p._tabUrl = t.url || p._tabUrl; p._title = t.title || p._title; } };
  chrome.tabs.onCreated.addListener(track);
  chrome.tabs.onUpdated.addListener((id, ch, t) => track(t));
  chrome.tabs.onRemoved.addListener(id => tabs.delete(id));
  // Switching tabs wakes a stopped worker too (it resumes a recording on start).
  chrome.tabs.onActivated.addListener(() => {});
  chrome.debugger.onEvent.addListener((src, method, params) => { const p = tabs.get(src.tabId); if (p) p.onEvent(src.sessionId, method, params); });
  chrome.debugger.onDetach.addListener((src, reason) => { const p = tabs.get(src.tabId); if (p) { p.onDetach(); p.detachReason = reason; } });
  const ready = chrome.tabs.query({}).then(all => all.forEach(track));
  return { ctx, ready, Page, Frame, B64, b64of };
})();
