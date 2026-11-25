// A hover's card, by its text: what the replica shows when the pointer is on a control (a tooltip, a popup, or what
// changes in place). One rule for the recorded hovers (a build's data/snaps/hovers-<app>.json defs) and the ones a
// run's sweep captures, so "the same hover" means the same words, numbers aside.

const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
// Markup to its words.
export const textOf = html => String(html || '').replace(/<[^>]*>/g, ' ').replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/g, (m, k) => ENT[k]).replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d));
// Lower case, every number as #, spaces as one.
export const cardNorm = s => textOf(s).toLowerCase().replace(/\d+(?:[.,:]\d+)*/g, '#').replace(/\s+/g, ' ').trim();
// The same card: the same words (numbers may differ); two long ones, the same first 60 characters.
export function cardMatch(a, b) {
  const x = cardNorm(a), y = cardNorm(b);
  if (!x || !y) return false;
  return x === y || (x.length >= 24 && y.length >= 24 && x.slice(0, 60) === y.slice(0, 60));
}
// What changes in place, as words: the parts it adds and the text it sets.
export const opsText = (ops, partHtml = o => o.html) => (ops || []).map(o => o.kind === 'add' ? textOf(partHtml(o)) : o.kind === 'addText' || o.kind === 'text' ? String(o.text || '') : '').join(' ');
// A built hover's card: its popup's words, or what it changes in place ('' when that's only a look, no words).
export const defCard = def => (def && def.portals && def.portals.length ? def.portals.map(q => q.text || '').join(' ') : opsText(def && def.ops)).trim();
