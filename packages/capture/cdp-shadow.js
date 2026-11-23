// Closed shadow roots, for the serializer, in the capture browser (inlined by host.mjs before the recorder): the
// page's own code can't reach them (element.shadowRoot is null), the DevTools protocol can, as the extension's
// shadow.js does through chrome.debugger. Each closed root (the page and every frame in another process) is put in
// its window's __scShadow map, keyed by its host, just before a snapshot. Returns how many it found.
async function EXPOSE_SHADOW(p) {
  const ctx = p.context();
  const sessions = [];
  try { sessions.push(await ctx.newCDPSession(p)); } catch (e) {}
  // A frame in its own process has a session of its own; one in the page's process is in the page's document.
  for (const f of p.frames()) if (f !== p.mainFrame()) { try { sessions.push(await ctx.newCDPSession(f)); } catch (e) {} }
  const cmd = (s, m, a) => { let t; return Promise.race([s.send(m, a), new Promise((_, rej) => { t = setTimeout(() => rej(new Error(m + ': no answer')), 8000); })]).finally(() => clearTimeout(t)); };
  let n = 0;
  for (const s of sessions) {
    try {
      await cmd(s, 'DOM.enable').catch(() => {});
      const { root } = await cmd(s, 'DOM.getDocument', { depth: -1, pierce: true });
      const closed = [];
      const walk = node => {
        for (const sr of node.shadowRoots || []) { if (sr.shadowRootType === 'closed') closed.push(sr.backendNodeId); walk(sr); }
        for (const c of node.children || []) walk(c);
        if (node.contentDocument) walk(node.contentDocument);
        if (node.templateContent) walk(node.templateContent);
      };
      walk(root);
      for (const backendNodeId of closed) {
        try {
          const r = await cmd(s, 'DOM.resolveNode', { backendNodeId });
          await cmd(s, 'Runtime.callFunctionOn', { objectId: r.object.objectId, functionDeclaration: 'function () { (window.__scShadow = window.__scShadow || new WeakMap()).set(this.host, this); }' });
          n++;
        } catch (e) {}
      }
    } catch (e) {} finally { await cmd(s, 'DOM.disable').catch(() => {}); await s.detach().catch(() => {}); }
  }
  return n;
}
