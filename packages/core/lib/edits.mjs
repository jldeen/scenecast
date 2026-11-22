// Text edits (flow.edits) — one implementation for the build (capture/process.mjs bakes them into data/) and the
// server (engine/serve.mjs applies the ones not baked yet as it serves each page, so a tweak shows on reload).
//   { remove: 'sentence' }               removed, with the space after it, everywhere
//   { replace: [a, b] }                  a → b everywhere
//   { replace: [a, b], in: [snap ids] }  a → b in those captures only (exact text)
//   { remove: 'sentence', in: [ids] }    removed in those captures only
//   { dropTooltip: 'label', in: [ids] }  a tooltip left in a capture (build only)
// Apostrophes match any form (' ’ &#39; &apos;) and spaces any run of whitespace, so captured text matches.
export const textRe = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "(?:'|\u2019|&#39;|&apos;)").replace(/ /g, '\\s+');
export const editSig = e => JSON.stringify([e.remove || null, e.replace || null, e.dropTooltip || null, e.in || null]);
export function compileEdits(edits) {
  return (edits || []).filter(e => e.remove || e.replace).map(e => ({
    ...e, n: 0, sig: editSig(e), what: e.remove || e.replace[0], to: e.remove ? '' : e.replace[1],
    re: new RegExp(e.remove ? textRe(e.remove) + '\\s?' : textRe(e.replace[0]), 'g'),
  }));
}
// Applies the edits that apply to a capture (id: a snap id, or null for stream frames and hover data).
export function applyEdits(text, compiled, id = null) {
  for (const e of compiled) {
    if (e.in && !(id && e.in.includes(id))) continue;
    text = text.replace(e.re, () => { e.n++; return e.to; });
  }
  return text;
}
// Every string in a JSON value (hover data holds HTML in strings).
export function applyEditsJson(value, compiled) {
  const walk = v => typeof v === 'string' ? applyEdits(v, compiled) : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v;
  return walk(value);
}
