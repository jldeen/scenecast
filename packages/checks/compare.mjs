// Pixel-compares PNG pairs in headless Chrome: share of pixels that differ and the box around them.
// Used by check.mjs (run vs run), contact-sheet.mjs (real vs replica) and fidelity.mjs.
export async function comparePngs(page, pairs) {
  return page.evaluate(async pairs => {
    const load = b64 => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = 'data:image/png;base64,' + b64; });
    const out = [];
    for (const [a, b] of pairs) {
      const [A, B] = await Promise.all([load(a), load(b)]);
      const w = Math.min(A.width, B.width), h = Math.min(A.height, B.height);
      const c = new OffscreenCanvas(w, h), g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(A, 0, 0); const da = g.getImageData(0, 0, w, h).data;
      g.clearRect(0, 0, w, h); g.drawImage(B, 0, 0); const db = g.getImageData(0, 0, w, h).data;
      let bad = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
      for (let i = 0, p = 0; i < da.length; i += 4, p++) {
        if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 60) {
          bad++; const x = p % w, y = (p / w) | 0;
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
      out.push({ pct: +(100 * bad / (w * h)).toFixed(3), box: bad ? [x0, y0, x1, y1] : null });
    }
    return out;
  }, pairs);
}

// Mean luminance (0 black … 1 white) of PNGs, from a 96×54 thumbnail: light mode reads well above 0.5.
export async function luminance(page, pngs) {
  return page.evaluate(async pngs => {
    const out = [];
    for (const b64 of pngs) {
      const i = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = 'data:image/png;base64,' + b64; });
      const c = new OffscreenCanvas(96, 54), g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(i, 0, 0, 96, 54);
      const d = g.getImageData(0, 0, 96, 54).data;
      let sum = 0; for (let k = 0; k < d.length; k += 4) sum += (0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2]) / 255;
      out.push(+(sum / (d.length / 4)).toFixed(3));
    }
    return out;
  }, pngs);
}

// Real vs replica in detail (the fidelity loop): the share of pixels that differ, the regions they fall in (16 px cells
// with any differing pixel, joined when they touch, largest first), and two pictures: the pair side by side with the
// regions outlined, and a diff (differing pixels in red over a faded copy of the real page).
//   pairs: [{ real: base64 PNG, replica: base64 PNG }] → [{ pct, box, size, regions: [{ x, y, w, h, px }], sideBySide, diff }]
export async function diffDetail(page, pairs, { label = [] } = {}) {
  return page.evaluate(async ({ pairs, label }) => {
    const load = b64 => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = 'data:image/png;base64,' + b64; });
    const b64Of = async c => { const b = await c.convertToBlob({ type: 'image/png' }); const buf = new Uint8Array(await b.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); return btoa(s); };
    const out = [];
    for (const [k, { real, replica }] of pairs.entries()) {
      const [A, B] = await Promise.all([load(real), load(replica)]);
      const w = Math.min(A.width, B.width), h = Math.min(A.height, B.height);
      const c = new OffscreenCanvas(w, h), g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(A, 0, 0); const da = g.getImageData(0, 0, w, h).data;
      g.clearRect(0, 0, w, h); g.drawImage(B, 0, 0); const db = g.getImageData(0, 0, w, h).data;
      const C = 16, cw = Math.ceil(w / C), ch = Math.ceil(h / C), cells = new Uint32Array(cw * ch);
      const dd = new ImageData(w, h); const dp = dd.data;
      let bad = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
      for (let i = 0, p = 0; i < da.length; i += 4, p++) {
        const x = p % w, y = (p / w) | 0;
        const off = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 60;
        if (off) {
          bad++; cells[((y / C) | 0) * cw + ((x / C) | 0)]++;
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
          dp[i] = 230; dp[i + 1] = 20; dp[i + 2] = 20; dp[i + 3] = 255;
        } else { const v = 255 - ((255 - (0.3 * da[i] + 0.59 * da[i + 1] + 0.11 * da[i + 2])) * 0.25); dp[i] = dp[i + 1] = dp[i + 2] = v; dp[i + 3] = 255; }
      }
      // Regions: touching cells (8 neighbours) with differing pixels.
      const seen = new Uint8Array(cw * ch), regions = [];
      for (let s = 0; s < cells.length; s++) {
        if (!cells[s] || seen[s]) continue;
        const stack = [s]; seen[s] = 1; let rx0 = cw, ry0 = ch, rx1 = 0, ry1 = 0, px = 0;
        while (stack.length) {
          const q = stack.pop(), qx = q % cw, qy = (q / cw) | 0; px += cells[q];
          if (qx < rx0) rx0 = qx; if (qy < ry0) ry0 = qy; if (qx > rx1) rx1 = qx; if (qy > ry1) ry1 = qy;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const nx = qx + dx, ny = qy + dy, n = ny * cw + nx;
            if (nx >= 0 && ny >= 0 && nx < cw && ny < ch && cells[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
          }
        }
        regions.push({ x: rx0 * C, y: ry0 * C, w: Math.min(w, (rx1 + 1) * C) - rx0 * C, h: Math.min(h, (ry1 + 1) * C) - ry0 * C, px });
      }
      regions.sort((a, b) => b.px - a.px);
      // Side by side: real | replica, regions outlined on both, with a caption.
      const gap = 12, top = 34, sbs = new OffscreenCanvas(w * 2 + gap, h + top), sg = sbs.getContext('2d');
      sg.fillStyle = '#fff'; sg.fillRect(0, 0, sbs.width, sbs.height);
      sg.fillStyle = '#1b1b1b'; sg.font = '600 18px sans-serif';
      sg.fillText('Real' + (label[k] ? ' · ' + label[k] : ''), 8, 23); sg.fillText(`Replica · ${(100 * bad / (w * h)).toFixed(3)}% of pixels differ`, w + gap + 8, 23);
      sg.drawImage(A, 0, top); sg.drawImage(B, w + gap, top);
      sg.strokeStyle = 'rgb(230,20,20)'; sg.lineWidth = 3;
      for (const r of regions.slice(0, 20)) { sg.strokeRect(r.x, r.y + top, r.w, r.h); sg.strokeRect(r.x + w + gap, r.y + top, r.w, r.h); }
      const dc = new OffscreenCanvas(w, h); dc.getContext('2d').putImageData(dd, 0, 0);
      out.push({
        pct: +(100 * bad / (w * h)).toFixed(3), box: bad ? [x0, y0, x1, y1] : null,
        size: { real: [A.width, A.height], replica: [B.width, B.height] },
        regions: regions.slice(0, 40), sideBySide: await b64Of(sbs), diff: await b64Of(dc),
      });
    }
    return out;
  }, { pairs, label });
}
