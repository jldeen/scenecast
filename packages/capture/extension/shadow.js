// Closed shadow roots, for the serializer: the page's own code can't reach them (element.shadowRoot is null), the
// DevTools protocol can. Each closed root in the tab (every frame, every process) is put in its window's
// __scShadow map, keyed by its host, just before a snapshot. Returns how many it found.
async function EXPOSE_SHADOW(p) {
  await p.attach();
  // A frame's process that stopped answering never answers these either: its frames left out (frameEval) are skipped,
  // and each process gets a few seconds.
  const out = f => typeof STUCK !== 'undefined' && STUCK.get(f) === f.url();
  const sessions = new Set([undefined, ...p.frames().filter(f => !out(f)).map(f => f.sessionId)]);
  const cmd = (sid, m, a) => { let t; return Promise.race([p.cmd(sid, m, a), new Promise((_, rej) => { t = setTimeout(() => rej(new Error(m + ': no answer')), 8000); })]).finally(() => clearTimeout(t)); };
  let n = 0;
  for (const sid of sessions) {
    await cmd(sid, 'DOM.enable').catch(() => {});
    try {
      const { root } = await cmd(sid, 'DOM.getDocument', { depth: -1, pierce: true });
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
          const r = await cmd(sid, 'DOM.resolveNode', { backendNodeId });
          await cmd(sid, 'Runtime.callFunctionOn', { objectId: r.object.objectId, functionDeclaration: 'function () { (window.__scShadow = window.__scShadow || new WeakMap()).set(this.host, this); }' });
          n++;
        } catch (e) {}
      }
    } catch (e) {} finally { await cmd(sid, 'DOM.disable').catch(() => {}); }
  }
  return n;
}
