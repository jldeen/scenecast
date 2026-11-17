// Closed shadow roots, for the serializer: the page's own code can't reach them (element.shadowRoot is null), the
// DevTools protocol can. Each closed root in the tab (every frame, every process) is put in its window's
// __scShadow map, keyed by its host, just before a snapshot. Returns how many it found.
async function EXPOSE_SHADOW(p) {
  await p.attach();
  const sessions = new Set([undefined, ...p.frames().map(f => f.sessionId)]);
  let n = 0;
  for (const sid of sessions) {
    await p.cmd(sid, 'DOM.enable').catch(() => {});
    try {
      const { root } = await p.cmd(sid, 'DOM.getDocument', { depth: -1, pierce: true });
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
          const r = await p.cmd(sid, 'DOM.resolveNode', { backendNodeId });
          await p.cmd(sid, 'Runtime.callFunctionOn', { objectId: r.object.objectId, functionDeclaration: 'function () { (window.__scShadow = window.__scShadow || new WeakMap()).set(this.host, this); }' });
          n++;
        } catch (e) {}
      }
    } finally { await p.cmd(sid, 'DOM.disable').catch(() => {}); }
  }
  return n;
}
