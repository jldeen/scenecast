// In the page (page.evaluate): is a focus point's target drawn where its mark goes? Points across the target, in its
// own page, are hit-tested there: a point counts when the first thing drawn at it is the target or inside it.
// Something opaque on top (a composer floating over the list, another row, a card) hides it, and a target its list
// clips isn't hit at all. Returns { box, hits, points, top } (top: what's drawn at its centre), or null when the point
// isn't on this screen.
export function focusLands(id) {
  const box = window.d1.focus.locate(id), target = window.d1.focus.target(id);
  if (!box || !target) return null;
  const d = target.ownerDocument, r = target.getBoundingClientRect();
  const opaque = e => {
    if (/^(img|svg|canvas|video|picture)$/.test(e.localName)) return true;
    const cs = d.defaultView.getComputedStyle(e), m = cs.backgroundColor.match(/[\d.]+/g);
    return cs.backgroundImage !== 'none' || (m && (m.length < 4 || +m[3] > 0.5));
  };
  let hits = 0, points = 0;
  for (const fy of [0.25, 0.5, 0.75]) for (const fx of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    points++;
    for (const e of d.elementsFromPoint(r.left + r.width * fx, r.top + r.height * fy)) {
      if (e === target || target.contains(e)) { hits++; break; }
      if (!e.contains(target) && opaque(e)) break;
    }
  }
  const c = d.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { box: box.map(Math.round), hits, points, top: c ? (c.innerText || c.getAttribute('aria-label') || c.localName).replace(/\s+/g, ' ').trim().slice(0, 80) : null };
}
