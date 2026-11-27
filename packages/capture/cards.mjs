// Whether a list a service answered has the card a plan step clicks (a pack's service `cards`: IQ's plugin list). The
// card's words are the item's own, as the page draws them: its name, its description, then the pack's type label
// (suffix: " Plugin"). Read without knowing the service's field names: an object in the answer whose name is where the
// card starts and whose description is the rest (or whose one text is the whole card).
//   cardIn(json, card, { suffix }) → the item's name, or null
//   shownIn(json, max) → the names of what the longest list in the answer holds (for "it showed: …")
const norm = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
const NAME = /^(displayName|name|title)$/i;

function* objects(v, depth = 0) {
  if (depth > 12 || !v || typeof v !== 'object') return;
  if (!Array.isArray(v)) yield v;
  for (const x of Array.isArray(v) ? v : Object.values(v)) yield* objects(x, depth + 1);
}

export function cardIn(json, card, { suffix = '' } = {}) {
  let want = norm(card);
  if (suffix && want.endsWith(norm(suffix))) want = want.slice(0, -norm(suffix).length).trim();
  if (!want) return null;
  for (const o of objects(json)) {
    const texts = Object.values(o).filter(x => typeof x === 'string' && x.trim()), n = texts.map(norm);
    for (const [i, a] of n.entries()) {
      if (a === want) return texts[i].trim();
      if (!want.startsWith(a + ' ')) continue;
      const rest = want.slice(a.length).trim();
      if (n.some((b, j) => j !== i && b === rest)) return texts[i].trim();
    }
  }
  return null;
}

export function shownIn(json, max = 30) {
  let best = [];
  const lists = function* (v, depth = 0) { if (depth > 12 || !v || typeof v !== 'object') return; if (Array.isArray(v)) yield v; for (const x of Array.isArray(v) ? v : Object.values(v)) yield* lists(x, depth + 1); };
  for (const l of lists(json)) if (l.filter(x => x && typeof x === 'object').length > best.length) best = l.filter(x => x && typeof x === 'object');
  return best.slice(0, max).map(o => { const k = Object.keys(o).find(x => NAME.test(x) && typeof o[x] === 'string'); return k ? o[k] : Object.values(o).find(x => typeof x === 'string') || '?'; });
}
