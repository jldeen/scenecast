// Text drawn over other text: what a presenter would see as two lines on top of each other. Runs in the replica's shell
// page (page.evaluate(textOverlaps, appId)), on the app's own document and its same-origin frames. A text's line counts
// where it's painted: inside every ancestor that clips it, not hidden or transparent. Two lines overlap when their boxes
// share most of a line's height, neither contains the other, and nothing opaque between them in the stacking order
// hides the lower one (a sticky header over the chat, an image over its fallback initials).
// → [{ a, b, x, y }] (each pair's texts, cut to 80 characters, and where they meet, in the app's page coordinates)
export function textOverlaps(appId) {
  const frame = document.querySelector(`iframe[data-app="${appId}"]`);
  const top = frame && frame.contentDocument;
  if (!top || !top.body) return [];
  const docs = [top];
  for (const f of top.querySelectorAll('iframe')) { try { if (f.contentDocument && f.contentDocument.body) docs.push(f.contentDocument); } catch (e) { /* another origin */ } }
  const vw = top.defaultView.innerWidth, vh = top.defaultView.innerHeight;
  const out = [];
  for (const d of docs) {
    const win = d.defaultView;
    const off = d === top ? { x: 0, y: 0 } : (r => ({ x: r.left, y: r.top }))(win.frameElement.getBoundingClientRect());
    const runs = [];
    const walker = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent.replace(/\s+/g, ' ').trim();
      const el = n.parentElement;
      if (text.length < 2 || !el) continue;
      let clip = { x0: -Infinity, y0: -Infinity, x1: Infinity, y1: Infinity }, hidden = false;
      for (let e = el; e && e !== d.documentElement; e = e.parentElement) {
        const s = win.getComputedStyle(e);
        if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity < 0.05 || /^rect\(0(px)?,? 0/.test(s.clip) || /inset\(50%/.test(s.clipPath)) { hidden = true; break; }
        if (s.overflowX !== 'visible' || s.overflowY !== 'visible') {
          const r = e.getBoundingClientRect();
          clip = { x0: Math.max(clip.x0, r.left), y0: Math.max(clip.y0, r.top), x1: Math.min(clip.x1, r.right), y1: Math.min(clip.y1, r.bottom) };
        }
      }
      if (hidden) continue;
      const range = d.createRange(); range.selectNodeContents(n);
      for (const r of range.getClientRects()) {
        const x0 = Math.max(r.left, clip.x0), y0 = Math.max(r.top, clip.y0), x1 = Math.min(r.right, clip.x1), y1 = Math.min(r.bottom, clip.y1);
        if (x1 - x0 < 4 || y1 - y0 < 6 || y1 + off.y < 0 || y0 + off.y > vh || x1 + off.x < 0 || x0 + off.x > vw) continue;
        runs.push({ text: text.slice(0, 80), el, x0, y0, x1, y1, h: r.height });
      }
    }
    const opaque = e => {
      const s = win.getComputedStyle(e);
      const m = /rgba?\(([^)]+)\)/.exec(s.backgroundColor), parts = m ? m[1].split(/[\s,/]+/).filter(Boolean) : [];
      const alpha = !m ? 0 : parts.length > 3 ? parseFloat(parts[3]) * (/%$/.test(parts[3]) ? 0.01 : 1) : 1;
      return alpha >= 0.9 || s.backgroundImage !== 'none' || /^(IMG|VIDEO|CANVAS|svg|PICTURE)$/i.test(e.tagName);
    };
    for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) {
      const a = runs[i], b = runs[j];
      if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const ix = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), iy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      if (ix < 3 || iy < 0.4 * Math.min(a.h, b.h)) continue;
      const px = (Math.max(a.x0, b.x0) + Math.min(a.x1, b.x1)) / 2, py = (Math.max(a.y0, b.y0) + Math.min(a.y1, b.y1)) / 2;
      const stack = d.elementsFromPoint(px, py);
      const ia = stack.indexOf(a.el), ib = stack.indexOf(b.el);
      if (ia < 0 || ib < 0) continue;
      const [upper, lower] = ia < ib ? [ia, ib] : [ib, ia], lowEl = stack[lower];
      let covered = false;
      for (let k = upper; k < lower && !covered; k++) if (!stack[k].contains(lowEl) && opaque(stack[k])) covered = true;
      if (!covered) out.push({ a: a.text, b: b.text, x: Math.round(px + off.x), y: Math.round(py + off.y) });
    }
  }
  return out;
}
