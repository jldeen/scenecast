// Focus points (the demo's focus.mjs): ⌥F zooms to the next point for the beat and draws its mark, the way Jessica
// does it by hand with Sysinternals ZoomIt for Mac 12.3 (Ctrl+1 zoom, then a Control-drag rectangle or Shift+Control-drag
// arrow). ⌥⇧F goes back one point; Esc erases the mark and zooms out. Measured from a 60 fps recording of her own ZoomIt
// (her settings, the defaults here; focus.mjs `options` can change zoom, pen and color: defaultZoomFactor 2, animateZoom
// on, rootPenWidth 5, default pen colour). Made for the Ignite '26 Demo 1 replica.
// - Zoom in: 30 steps a second, each ×1.1 (1.1, 1.21 … 1.9487), then the zoom factor. The point under the pointer stays
//   put (near an edge the view stops at the edge). Zoom out: ×0.8 a step down to 1, then its window fades (~120 ms).
// - While zoomed, moving the pointer pans (the point under it stays put). Drawing freezes the view and hides the pointer.
// - Pen: macOS systemRed, PEN × zoom points wide. Rectangles have round joins. An arrow's head sits where the drag
//   started; its barbs are 4 pen widths at ±30°, notched 1.79 widths back along a round-capped shaft.
// The page is re-rendered at the zoom (sharp at 4K), not scaled as a bitmap the way ZoomIt does.
const STEP = 1000 / 30, FIRST = 17, IN = 1.1, OUT = 0.8, FADE = 120;
const HEAD = 4, BARB = Math.PI / 6, NOTCH = 1.79;
const DRAG = 450, SETTLE = 250;
// Her ZoomIt zoom factor (the most ⌥F zooms), the margin kept around a point, and the wheel/↑↓ step, top and stop.
const MARGIN = 0.09, NUDGE = 1.1, MAXZ = 8, HOLD = 450;
const SVG = 'http://www.w3.org/2000/svg';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const frame = () => new Promise(r => requestAnimationFrame(r));
const N = s => s.replace(/[\u2019\u2018]/g, "'").replace(/[\u2011\u2010]/g, '-').replace(/\u00a0/g, ' ');

export function createFocus({ stage, points, current, docsOf, openGroup, groupButton, go = null, options = {}, speed = 1 }) {
  const ZOOM = options.zoom || 2, PEN = options.pen || 5, RED = options.color || 'rgb(255, 56, 60)';
  // The replica's clock (?speed=, for the checks): every animation is that much shorter and ends the same.
  const T = ms => ms / Math.max(1, speed);
  const st = { run: 0, shown: null, hit: 0, s: 1, A: [0, 0], z: 0, draw: false, marks: [], cursor: -1, gen: 0, vp: null, p0: null, last: null };
  const svg = document.createElementNS(SVG, 'svg');
  Object.assign(svg.style, { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', zIndex: 5, pointerEvents: 'none', overflow: 'visible', transformOrigin: '50% 50%' });
  stage.appendChild(svg);
  const cover = document.createElement('div');
  Object.assign(cover.style, { position: 'fixed', inset: 0, zIndex: 2147483000, pointerEvents: 'none', cursor: 'default' });
  document.body.appendChild(cover);

  // ZoomIt works in screen points; at a browser zoom other than 100% a CSS pixel isn't one.
  const pt = () => { const r = window.outerWidth && window.innerWidth ? window.outerWidth / window.innerWidth : 1; return r > 0.2 && r < 6 ? Math.round(r * 100) / 100 : 1; };
  const W = () => window.innerWidth, H = () => window.innerHeight;
  const clampA = (A, s) => [Math.min(Math.max(A[0], 0), W() * (1 - 1 / s)), Math.min(Math.max(A[1], 0), H() * (1 - 1 / s))];
  const fixedA = (F, s) => clampA([F[0] * (1 - 1 / s), F[1] * (1 - 1 / s)], s);
  function apply(s, A) {
    st.s = s; st.A = A;
    stage.style.transformOrigin = '0 0';
    stage.style.transform = s === 1 ? '' : `scale(${s}) translate(${-A[0]}px, ${-A[1]}px)`;
  }
  const toContent = p => [st.A[0] + p[0] / st.s, st.A[1] + p[1] / st.s];
  const live = my => my === st.gen;

  // A timeline of zoom steps, each shown from its time on (ZoomIt's steps, not a tween).
  async function steps(list, my) {
    stage.style.willChange = 'transform';
    const t0 = performance.now();
    for (let i = 0; i < list.length;) {
      await frame(); if (!live(my)) return false;
      const t = performance.now() - t0; let j = i;
      while (j < list.length && list[j].t <= t) j++;
      if (j > i) { apply(list[j - 1].s, list[j - 1].A); i = j; }
    }
    stage.style.willChange = '';
    return true;
  }
  function inSteps(F, Z) {
    const out = []; let s = IN, k = 0;
    for (; s < Z - 1e-6; s *= IN, k++) out.push({ t: T(FIRST + STEP * k), s, A: fixedA(F, s) });
    out.push({ t: T(FIRST + STEP * k), s: Z, A: fixedA(F, Z) });
    return out;
  }
  function outSteps() {
    const s0 = st.s, F = s0 > 1 ? [st.A[0] / (1 - 1 / s0), st.A[1] / (1 - 1 / s0)] : [0, 0];
    const out = []; let s = s0 * OUT, k = 0;
    for (; s > 1 + 1e-6; s *= OUT, k++) out.push({ t: T(FIRST + STEP * k), s, A: fixedA(F, s) });
    out.push({ t: T(FIRST + STEP * k), s: 1, A: [0, 0] });
    return out;
  }

  // Marks: drawn in page coordinates inside the zoomed stage, so they shrink away with it on zoom out.
  function render() {
    svg.replaceChildren();
    for (const m of st.marks) {
      const w = m.pen;
      if (m.kind === 'rect') {
        const [x0, y0] = m.a, [x1, y1] = m.b;
        const r = document.createElementNS(SVG, 'rect');
        for (const [k, v] of Object.entries({ x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0), fill: 'none', stroke: RED, 'stroke-width': w, 'stroke-linejoin': 'round' })) r.setAttribute(k, v);
        svg.appendChild(r);
      } else {
        const [px, py] = m.a, [qx, qy] = m.b, len = Math.hypot(qx - px, qy - py);
        if (len < 1) continue;
        const ux = (qx - px) / len, uy = (qy - py) / len, rot = a => [ux * Math.cos(a) - uy * Math.sin(a), ux * Math.sin(a) + uy * Math.cos(a)];
        const [b1x, b1y] = rot(BARB), [b2x, b2y] = rot(-BARB), L = HEAD * w, bx = px + ux * NOTCH * w, by = py + uy * NOTCH * w;
        const head = document.createElementNS(SVG, 'polygon');
        head.setAttribute('points', [[px, py], [px + b1x * L, py + b1y * L], [bx, by], [px + b2x * L, py + b2y * L]].map(p => p.join(',')).join(' '));
        head.setAttribute('fill', RED);
        svg.appendChild(head);
        if (len > NOTCH * w) {
          const l = document.createElementNS(SVG, 'line');
          for (const [k, v] of Object.entries({ x1: bx, y1: by, x2: qx, y2: qy, stroke: RED, 'stroke-width': w, 'stroke-linecap': 'round' })) l.setAttribute(k, v);
          svg.appendChild(l);
        }
      }
    }
  }
  const ease = t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  // A drag from a to b (screen points while zoomed), drawn live like ZoomIt's rubber band.
  async function drag(kind, a, b, my, ms = T(DRAG), linear = false) {
    const m = { kind, pen: PEN / pt(), a: toContent(a), b: toContent(a) };
    st.marks.push(m);
    const B = toContent(b), t0 = performance.now();
    for (;;) {
      await frame(); if (!live(my)) return false;
      const k = Math.min(1, (performance.now() - t0) / ms), e = linear ? k : ease(k);
      m.b = [m.a[0] + (B[0] - m.a[0]) * e, m.a[1] + (B[1] - m.a[1]) * e]; render();
      if (k >= 1) return true;
    }
  }

  function setCover() {
    cover.style.pointerEvents = st.z ? 'auto' : 'none';
    cover.style.cursor = st.draw ? 'none' : 'default';
  }
  function clear() {
    st.gen++; st.z = 0; st.draw = false; st.marks = []; st.vp = st.p0 = null; st.shown = null; render();
    svg.style.opacity = ''; svg.style.transform = ''; stage.style.willChange = '';
    apply(1, [0, 0]); setCover();
  }
  async function zoomIn(F, Z, my) {
    st.z = 1; st.vp = F.slice(); st.p0 = null; setCover();
    if (!await steps(inSteps(F, Z), my)) return false;
    st.z = 2; return true;
  }
  async function zoomOut(my) {
    if (!st.z) return true;
    st.z = 3; setCover();
    if (!await steps(outSteps(), my)) return false;
    // ZoomIt's window (with the drawing) fades and shrinks a touch as it closes.
    if (st.marks.length) {
      const t0 = performance.now();
      for (;;) { await frame(); if (!live(my)) return false; const k = Math.min(1, (performance.now() - t0) / T(FADE)); svg.style.opacity = String(1 - k); svg.style.transform = `scale(${1 - 0.015 * k})`; if (k >= 1) break; }
    }
    st.marks = []; render(); svg.style.opacity = ''; svg.style.transform = '';
    st.z = 0; st.draw = false; st.shown = null; setCover();
    return true;
  }

  // Where a point's text (or element) is, in page coordinates; the box around all of its parts.
  function locate(p, cur = current()) {
    const docs = docsOf(cur.doc);
    // A frame's offset in the page, and its scale when the page shows it scaled (a CSS transform, as the Playwright
    // trace viewer does with its snapshot): a point p in the frame is at [x + k·p.x, y + k·p.y].
    const off = d => {
      let x = 0, y = 0, k = 1, w = d.defaultView;
      while (w && w !== window && w.frameElement) {
        const fe = w.frameElement, r = fe.getBoundingClientRect(), s = fe.offsetWidth ? r.width / fe.offsetWidth : 1;
        if (Math.abs(s - 1) < 0.001) { x += r.x; y += r.y; }
        else { x = r.x + s * (fe.clientLeft + x); y = r.y + s * (fe.clientTop + y); k *= s; }
        w = w.parent;
      }
      return [x, y, k];
    };
    const place = (o, r) => [o[0] + o[2] * r.left, o[1] + o[2] * r.top, o[0] + o[2] * r.right, o[1] + o[2] * r.bottom];
    const one = t => {
      // { text, up }: the block around the text (a selector for closest(), or a number of parents up).
      if (typeof t !== 'string' && t.text) {
        const f = one(t.text); if (!f) return null;
        let el = f.el; if (typeof t.up === 'number') for (let i = 0; i < t.up && el.parentElement; i++) el = el.parentElement; else el = el.closest(t.up);
        if (!el) return null;
        return { el, rects: [place(off(el.ownerDocument), el.getBoundingClientRect())] };
      }
      if (typeof t !== 'string') {
        for (const d of docs) { const el = [...d.querySelectorAll(t.sel)].find(x => { const r = x.getBoundingClientRect(); return r.width > 2 && r.height > 2; }); if (el) return { el, rects: [place(off(d), el.getBoundingClientRect())] }; }
        return null;
      }
      const re = new RegExp(N(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'));
      for (const d of docs) {
        if (!d.body) continue;
        const w = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT), nodes = []; let all = '';
        for (let n; (n = w.nextNode());) {
          const el = n.parentElement, lv = el && el.closest('[aria-live]');
          if (!el || el.closest('script,style') || (lv && (lv.offsetWidth <= 2 || lv.offsetHeight <= 2)) || !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
          // Text in different elements reads with a space between (a step's label and its model name).
          if (nodes.length && nodes[nodes.length - 1][0].parentElement !== el && !/\s$/.test(all)) all += ' ';
          nodes.push([n, all.length]); all += N(n.data);
        }
        let m, from = 0;
        while ((m = re.exec(all.slice(from)))) {
          const a = from + m.index, z = a + m[0].length; from = Math.max(z, a + 1);
          const at = k => { let i = nodes.length - 1; while (i > 0 && nodes[i][1] > k) i--; return [nodes[i][0], k - nodes[i][1]]; };
          const rg = d.createRange(), [sn, so] = at(a), [en, eo] = at(z - 1); rg.setStart(sn, Math.min(so, sn.length)); rg.setEnd(en, Math.min(eo + 1, en.length));
          const o = off(d);
          const rects = [...rg.getClientRects()].filter(r => r.width > 1 && r.height > 1).map(r => place(o, r));
          if (rects.length) return { el: sn.parentElement, rects };
        }
      }
      return null;
    };
    const parts = (p.find ? [p.find] : p.union).map(one);
    if (parts.some(x => !x)) return null;
    const rs = parts.flatMap(x => x.rects), g = p.grow || [0, 0, 0, 0];
    // grow: page pixels added to the box (left, top, right, bottom), e.g. to take in a row's icons.
    return { el: parts[0].el, box: [Math.min(...rs.map(r => r[0])) - g[0], Math.min(...rs.map(r => r[1])) - g[1], Math.max(...rs.map(r => r[2])) + g[2], Math.max(...rs.map(r => r[3])) + g[3]] };
  }
  const here = (p, cur = current()) => cur && p.app === cur.id && p.states.includes(cur.state);
  const ready = (p, cur = current()) => here(p, cur) && (p.open ? p.open.every(l => groupButton(cur.app, l)) || !!locate(p, cur) : !!locate(p, cur));
  // A point one step on from this screen (`via: { from: [states], to: state }`: a tab, a panel, a hover card): ⌥F takes
  // that step itself (the shell's own move, as the click would), then frames it.
  const reachable = (p, cur = current()) => !!(go && p.via && cur && p.app === cur.id && (p.via.from || []).includes(cur.state));
  const can = (p, cur) => ready(p, cur) || reachable(p, cur);

  // The mark around a box at zoom Z, in page coordinates, and everything it covers (box, mark and pen). Pads and the
  // arrow's length are in screen points, as she'd drag them; the pen is PEN × Z points on screen.
  const DIRS = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0], ne: [0.8, -0.6], nw: [-0.8, -0.6], se: [0.8, 0.6], sw: [-0.8, 0.6] };
  function markAt(p, box, Z) {
    const k = 1 / pt(), pen = PEN * k;
    if (p.mark !== 'arrow') {
      // Padded, but never past the page's edges: a target flush against the screen's edge (a list's first column)
      // gets its mark drawn just inside the screen, not cut off.
      const px = 12 * k / Z, py = 8 * k / Z, h = pen / 2;
      const a = [Math.max(box[0] - px, h), Math.max(box[1] - py, h)], b = [Math.min(box[2] + px, W() - h), Math.min(box[3] + py, H() - h)];
      return { kind: 'rect', a, b, ext: [a[0] - h, a[1] - h, b[0] + h, b[1] + h] };
    }
    const g = 8 * k / Z, d = p.dir || 'sw', inset = Math.min(28 * k / Z, (box[2] - box[0]) / 2), v = DIRS[d];
    const tip = [d.includes('w') ? box[0] + (d.length > 1 ? inset : -g) : d.includes('e') ? box[2] - (d.length > 1 ? inset : -g) : (box[0] + box[2]) / 2,
      d.includes('s') ? box[3] + g : d.includes('n') ? box[1] - g : (box[1] + box[3]) / 2];
    const L = (p.len || 150) * k / Z, b = [tip[0] + v[0] * L, tip[1] + v[1] * L], h = HEAD * pen;
    return { kind: 'arrow', a: tip, b, ext: [Math.min(box[0], tip[0] - h, b[0] - pen), Math.min(box[1], tip[1] - h, b[1] - pen), Math.max(box[2], tip[0] + h, b[0] + pen), Math.max(box[3], tip[1] + h, b[1] + pen)] };
  }
  // The view at zoom Z: everything centred where the page allows (the view stops at the screen's edges, as ZoomIt's does).
  function frameAt(p, box, Z) {
    const mk = markAt(p, box, Z), e = mk.ext, c = [(e[0] + e[2]) / 2, (e[1] + e[3]) / 2];
    const A = Z > 1 ? clampA([c[0] - W() / (2 * Z), c[1] - H() / (2 * Z)], Z) : [0, 0];
    const sc = q => [(q[0] - A[0]) * Z, (q[1] - A[1]) * Z];
    return { Z, A, F: Z > 1 ? [A[0] / (1 - 1 / Z), A[1] / (1 - 1 / Z)] : [0, 0], kind: mk.kind, a: sc(mk.a), b: sc(mk.b), on: [...sc(e.slice(0, 2)), ...sc(e.slice(2))], center: c, ext: e };
  }
  const inside = (f, m) => f.on[0] >= W() * m - 0.5 && f.on[1] >= H() * m - 0.5 && f.on[2] <= W() * (1 - m) + 0.5 && f.on[3] <= H() * (1 - m) + 0.5;
  // The largest zoom up to `top` whose framing passes `ok` (it gets easier as the zoom drops); 1 if none does.
  function largest(ok, top) {
    if (ok(top)) return top;
    if (!ok(1)) return 1;
    let lo = 1, hi = top;
    for (let n = 0; n < 24; n++) { const m = (lo + hi) / 2; if (ok(m)) lo = m; else hi = m; }
    return Math.floor(lo * 1000) / 1000;
  }
  // Zoom to fit: the whole target and its mark, with a margin on every side, never past her zoom factor; 1× (no zoom)
  // when it doesn't fit even then. Centred where the page allows; if the page puts the target against the screen's edge
  // (no zoom gives it the margin there), the most zoom that keeps the mark on screen.
  function fitZ(p, box) {
    const top = Math.min(ZOOM, p.maxZoom || ZOOM);
    const fits = Z => { const e = markAt(p, box, Z).ext; return (e[2] - e[0]) * Z <= W() * (1 - 2 * MARGIN) && (e[3] - e[1]) * Z <= H() * (1 - 2 * MARGIN); };
    const z = largest(fits, top);
    return z > 1 && !inside(frameAt(p, box, z), 0) ? largest(Z => inside(frameAt(p, box, Z), 0), z) : z;
  }
  function plan(p, box) {
    const f = frameAt(p, box, fitZ(p, box));
    f.edge = !inside(f, MARGIN);
    // An arrow whose tail would leave the screen (only where the view stops at an edge) gets shorter.
    if (f.kind === 'arrow') {
      const k = 1 / pt(), dx = f.b[0] - f.a[0], dy = f.b[1] - f.a[1], L = Math.hypot(dx, dy), room = (x, y) => x >= 0 && y >= 0 && x <= W() && y <= H();
      let len = L; while (len > 40 * k && !room(f.a[0] + dx / L * len, f.a[1] + dy / L * len)) len -= 10 * k;
      f.b = [f.a[0] + dx / L * len, f.a[1] + dy / L * len];
    }
    return f;
  }
  // How far the wheel or ↑ can zoom before the mark leaves the screen (it stops there once; pushing again goes on).
  function limitFor(ext, center) {
    const ok = Z => { const A = clampA([center[0] - W() / (2 * Z), center[1] - H() / (2 * Z)], Z); return (ext[0] - A[0]) * Z >= -0.5 && (ext[1] - A[1]) * Z >= -0.5 && (ext[2] - A[0]) * Z <= W() + 0.5 && (ext[3] - A[1]) * Z <= H() + 0.5; };
    return largest(ok, MAXZ);
  }
  const r2 = a => a.map(v => Math.round(v * 100) / 100);

  async function show(i, my) {
    const p = points[i];
    if (!ready(p) && reachable(p)) {
      await go(p.app, p.via.to); if (!live(my)) return;
      for (let n = 0; n < 100 && !ready(p); n++) { await sleep(50); if (!live(my)) return; }
    }
    const cur = current();
    if (p.open) { let opened = false; for (const l of p.open) opened = openGroup(cur.app, l) || opened; if (opened) { await sleep(T(420)); if (!live(my)) return; } }
    let t = locate(p); if (!t) return;
    const before = r2(t.box);
    // Off screen, or too near the top or bottom for the margin: scroll it to the middle first.
    const off = t.box[1] < 0 || t.box[3] > H() || t.box[0] < 0 || t.box[2] > W();
    if (off || !inside(frameAt(p, t.box, fitZ(p, t.box)), MARGIN)) {
      t.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      let prev = '', same = 0;
      // Until the smooth scroll has started and finished: at least 300 ms, then 6 still frames.
      for (let n = 0; n < 150 && (n < 18 || same < 6); n++) { await frame(); if (!live(my)) return; const b = (locate(p) || {}).box; const k = String(b); same = k === prev ? same + 1 : 0; prev = k; }
      t = locate(p); if (!t) return;
    }
    const g = plan(p, t.box);
    st.last = { id: p.id, before, edge: g.edge, Z: g.Z, A: r2(g.A), kind: g.kind, a: r2(g.a), b: r2(g.b), on: r2(g.on), box: r2(t.box), W: W(), H: H(), pt: pt() };
    st.shown = { p, center: g.center, ext: g.ext, limit: limitFor(g.ext, g.center) };
    if (g.Z > 1) { if (!await zoomIn(g.F, g.Z, my)) return; await sleep(T(SETTLE)); if (!live(my)) return; }
    else { st.z = 2; st.vp = null; }
    st.draw = true; setCover();
    await drag(g.kind, g.a, g.b, my);
  }

  // Wheel or ↑/↓ while zoomed: ×1.1 a step, around the point's centre. Zooming in stops once where the mark would leave
  // the screen; another push after a beat goes past it.
  function nudge(dir) {
    if (st.z !== 2 || st.run) return false;
    const now = performance.now(), sh = st.shown, lim = sh ? sh.limit : MAXZ;
    let s = st.s * (dir > 0 ? NUDGE : 1 / NUDGE);
    if (dir > 0 && sh) {
      if (st.s < lim - 1e-3 && s > lim) { s = lim; st.hit = now; }
      else if (Math.abs(st.s - lim) <= 1e-3 && now - (st.hit || 0) < HOLD) return true;
    }
    s = Math.round(Math.min(Math.max(s, 1), MAXZ) * 1e4) / 1e4;
    const c = sh ? sh.center : [st.A[0] + W() / (2 * st.s), st.A[1] + H() / (2 * st.s)];
    apply(s, s > 1 ? clampA([c[0] - W() / (2 * s), c[1] - H() / (2 * s)], s) : [0, 0]);
    st.vp = s > 1 ? [st.A[0] / (1 - 1 / s), st.A[1] / (1 - 1 / s)] : null; st.p0 = null;
    return true;
  }
  // A new window size, browser zoom or display: frame the point again for it, at once, and again as the page settles
  // into its own new layout (it may re-render for the new width).
  let resizing = 0;
  function reframe() {
    if (st.z !== 2 || st.run || !st.shown) return null;
    const p = st.shown.p, s0 = st.s, A0 = st.A;
    apply(1, [0, 0]);
    const t = locate(p);
    if (!t) { apply(s0, A0); return null; }
    const g = plan(p, t.box);
    apply(g.Z, g.A);
    st.marks = [{ kind: g.kind, pen: PEN / pt(), a: toContent(g.a), b: toContent(g.b) }]; render();
    st.shown = { p, center: g.center, ext: g.ext, limit: limitFor(g.ext, g.center) };
    st.last = { ...st.last, edge: g.edge, Z: g.Z, A: r2(g.A), a: r2(g.a), b: r2(g.b), on: r2(g.on), box: r2(t.box), W: W(), H: H(), pt: pt() };
    st.vp = g.Z > 1 ? g.F.slice() : null;
    return String([g.Z, g.A, g.a, g.b]);
  }
  window.addEventListener('resize', () => {
    const my = ++resizing;
    requestAnimationFrame(() => requestAnimationFrame(async () => {
      // Every 200 ms until the framing comes out the same twice (or 5 s).
      let prev = null;
      for (let n = 0; n < 25 && my === resizing; n++) { const k = reframe(); if (k && k === prev) return; prev = k; await sleep(200); }
    }));
  });

  async function step(dir) {
    const my = ++st.gen, cur = current();
    let i = st.cursor + dir;
    while (i >= 0 && i < points.length && !can(points[i], cur)) i += dir;
    // Nothing further this way on this screen. If she's still on (or one step from) the point she's at, that's the end
    // of the beat's points here: ⌥F does nothing (wrapping round from there looped her back through the beat, reopening
    // its menus). Only a screen she got to some other way (an app key or a click, past this screen's points) wraps
    // around to the screen's points from the other end.
    if ((i < 0 || i >= points.length) && st.cursor >= 0 && can(points[st.cursor], cur)) return;
    if (i < 0 || i >= points.length) { i = dir > 0 ? 0 : points.length - 1; while (i >= 0 && i < points.length && i !== st.cursor && !can(points[i], cur)) i += dir; }
    if (i < 0 || i >= points.length || (i === st.cursor && !can(points[i], cur))) return;
    st.cursor = i; st.run++;
    try {
      if (st.z && !await zoomOut(my)) return;
      if (!live(my)) return;
      await show(i, my);
    } finally { st.run--; }
  }

  cover.addEventListener('mousemove', e => {
    if (st.z !== 2 || st.draw || !st.vp) return;
    if (!st.p0) { st.p0 = [e.clientX, e.clientY]; return; }
    st.vp = [Math.min(Math.max(st.vp[0] + e.clientX - st.p0[0], 0), W()), Math.min(Math.max(st.vp[1] + e.clientY - st.p0[1], 0), H())];
    st.p0 = [e.clientX, e.clientY];
    apply(st.s, fixedA(st.vp, st.s));
  });
  // Left button. A click (the pointer moves under 4 px between press and release) zooms out and lands on what was under
  // it, so "⌥F, then click X" works without Esc first. A drag (4 px or more) is ZoomIt's: drawing mode, the view freezes.
  // Right button: out of drawing mode, the drawing goes.
  let press = null;
  cover.addEventListener('mousedown', e => { e.preventDefault(); if (e.button === 0 && st.z === 2) press = { x: e.clientX, y: e.clientY, moved: false }; });
  window.addEventListener('mousemove', e => {
    if (!press || press.moved || !(e.buttons & 1) || Math.hypot(e.clientX - press.x, e.clientY - press.y) < 4) return;
    press.moved = true; st.draw = true; setCover();
  }, true);
  window.addEventListener('mouseup', e => {
    if (e.button !== 0 || !press) return;
    const p = press; press = null;
    if (p.moved || st.z !== 2 || Math.hypot(e.clientX - p.x, e.clientY - p.y) >= 4) return;
    passClick(toContent([e.clientX, e.clientY]));
  }, true);
  // Zoom out (no fade wait beyond ZoomIt's own), then a real click sequence on the element at that page point, in
  // whichever frame it's in. Esc's own extras (a demo closing its menu) don't run: the click decides.
  async function passClick(pt) {
    const my = ++st.gen; st.run++;
    try { if (!await zoomOut(my)) return; } finally { st.run--; }
    await frame();
    const sr = stage.getBoundingClientRect();
    let doc = document, x = sr.left + pt[0], y = sr.top + pt[1], el = doc.elementFromPoint(x, y);
    while (el && el.localName === 'iframe' && el.contentDocument) { const r = el.getBoundingClientRect(); x -= r.left; y -= r.top; doc = el.contentDocument; el = doc.elementFromPoint(x, y); }
    if (!el) return;
    const v = doc.defaultView, o = { bubbles: true, cancelable: true, composed: true, view: v, clientX: x, clientY: y, button: 0 };
    el.dispatchEvent(new v.MouseEvent('mousedown', { ...o, buttons: 1 }));
    if (el.matches('input, textarea, select, [contenteditable="true"]')) el.focus();
    el.dispatchEvent(new v.MouseEvent('mouseup', o));
    el.dispatchEvent(new v.MouseEvent('click', o));
  }
  cover.addEventListener('contextmenu', e => { e.preventDefault(); if (st.z === 2 && st.draw) { st.gen++; st.draw = false; st.marks = []; render(); st.p0 = null; setCover(); } });
  let wheel = 0, wheelAt = 0;
  cover.addEventListener('wheel', e => {
    e.preventDefault();
    // A mouse wheel's notch is one step (whatever its size at this zoom); a trackpad's small scrolls add up to steps.
    if (e.wheelDeltaY && e.wheelDeltaY % 120 === 0) { for (let n = Math.abs(e.wheelDeltaY / 120); n > 0; n--) nudge(Math.sign(e.wheelDeltaY)); return; }
    const now = performance.now(); if (now - wheelAt > 250) wheel = 0; wheelAt = now;
    const dy = e.deltaMode ? e.deltaY * 40 : e.deltaY; wheel += Math.sign(dy) * Math.min(Math.abs(dy), 40);
    while (Math.abs(wheel) >= 40) { const d = Math.sign(wheel); nudge(-d); wheel -= d * 40; }
  }, { passive: false });

  return {
    next: () => step(1),
    // For checks: the click a press-and-release at a screen point makes while zoomed.
    clickAt: (x, y) => st.z === 2 ? passClick(toContent([x, y])) : null,
    back: () => step(-1),
    // Esc: erase and zoom out. True when it was zoomed (so the key goes no further).
    // Keys while zoomed: Esc out; ↑/↓ zoom in and out. True when the key was ZoomIt's.
    key(e) {
      if (e.key === 'Escape') return this.esc();
      if (st.z === 2 && !e.altKey && !e.metaKey && !e.ctrlKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { nudge(e.key === 'ArrowUp' ? 1 : -1); return true; }
      return false;
    },
    nudge,
    esc() { if (!st.z) return false; const my = ++st.gen; st.run++; zoomOut(my).finally(() => st.run--); return true; },
    // ⌥0 and beat jumps: out at once, and the sequence restarts at that beat.
    reset(beat) { clear(); st.cursor = beat ? points.findIndex(p => p.beat >= beat) - 1 : -1; if (st.cursor < -1) st.cursor = points.length - 1; },
    clear,
    get zoomed() { return !!st.z; },
    // For tests.
    at(id) { clear(); st.cursor = points.findIndex(p => p.id === id) - 1; },
    state: () => ({ run: st.run, limit: st.shown ? st.shown.limit : null, s: st.s, A: st.A.slice(), z: st.z, draw: st.draw, cursor: st.cursor, id: st.cursor >= 0 ? points[st.cursor].id : null, last: st.last, marks: st.marks.map(m => ({ kind: m.kind, a: m.a.map(v => Math.round(v * 100) / 100), b: m.b.map(v => Math.round(v * 100) / 100) })) }),
    ready: () => points.map(p => ready(p) ? p.id : null).filter(Boolean),
    locate: id => { const p = points.find(x => x.id === id); const t = p && locate(p); return t && t.box; },
    // Where a point that isn't in the list would land (the script matcher and the editor check a target with it).
    locatePoint: p => { const t = locate(p); return t ? { box: t.box } : null; },
    // The editor's changes, at once: the new list, zoomed out, the sequence from the start of the beat.
    setPoints(list) { const at = st.cursor >= 0 && points[st.cursor] ? points[st.cursor].id : null; clear(); points.splice(0, points.length, ...list); st.cursor = at ? points.findIndex(p => p.id === at) : -1; },
    get points() { return points.slice(); },
    // Play explicit ZoomIt moves (screen points): for the side-by-side clip against the real ZoomIt recording.
    async play(moves) {
      const my = ++st.gen;
      for (const m of moves) {
        if (!live(my)) return;
        if (m.zoom) { if (!await zoomIn(m.at, m.zoom, my)) return; }
        else if (m.draw) { st.draw = true; setCover(); if (!await drag(m.draw, m.a, m.b, my, m.ms, m.linear)) return; }
        else if (m.out) { if (!await zoomOut(my)) return; }
        else if (m.wait) await sleep(m.wait);
      }
    },
  };
}
