// In the page (page.evaluate): is a focus point's mark around something drawn where it is? The focus module hit-tests
// points inside the marked words (or element): something on top (a composer floating over the list, another row, a
// card) hides them, and words their list clips aren't hit at all. → { box, hits, points, top } (top: what's drawn at
// the middle), or null when the point isn't on this screen or the demo's focus module can't say.
export function focusLands(id) {
  const f = window.d1.focus, box = f.locate(id);
  if (!box || !f.shown) return null;
  const s = f.shown(id);
  return s && { box: box.map(Math.round), ...s };
}
