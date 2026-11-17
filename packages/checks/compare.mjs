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
