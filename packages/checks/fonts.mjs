// The font check of real vs replica (real-vs-replica.mjs): which fonts the real page had loaded, where each one's
// @font-face rule takes it from, and whether the replica has the same font. A face's source is a file (url()), a font
// carried in the stylesheet itself (a data: url), or one installed on the computer (local()): the same data, or the
// same installed font on both sides, is the same font.
import { createHash } from 'node:crypto';

export const normFamily = s => String(s || '').trim().replace(/^["']|["']$/g, '').toLowerCase();
const KEYWORD = { normal: '400', bold: '700' };
export const normWeight = w => String(w || 'normal').trim().split(/\s+/).map(x => KEYWORD[x] || x).join(' ');
const sha256 = buf => createHash('sha256').update(buf).digest('hex');

// A loaded face as the capture gives its parts (capture/serialize.js meta.fontFaces).
export function loadedFace(f) {
  const name = String(f.family || '').trim().replace(/^["']|["']$/g, '');
  return { family: normFamily(name), name, weight: normWeight(f.weight), style: String(f.style || 'normal').trim() };
}
// A loaded face as a recording from before meta.fontFaces names it ("<family> <weight> <style>"), the weight one value
// or a range ("Segoe Serif 420 625 normal": a variable font's 420 to 625). known: the families the page's @font-face
// rules declare, to tell a range from a family that ends in a number ("Font 2 400 normal").
export function parseLoaded(s, known = null) {
  const p = String(s).trim().split(/\s+/);
  const style = p.pop();
  const read = n => {
    const q = p.slice(), weight = [];
    while (q.length > 1 && weight.length < n && /^(\d+(\.\d+)?|normal|bold)$/.test(q[q.length - 1])) weight.unshift(q.pop());
    const name = q.join(' ').trim().replace(/^["']|["']$/g, '');
    return { family: normFamily(name), name, weight: normWeight(weight.join(' ')), style };
  };
  const range = read(2), one = read(1);
  return known && !known.has(range.family) && known.has(one.family) ? one : range;
}

// A data: url's bytes (percent-escapes are bytes, not text).
export function dataBytes(url) {
  const m = /^data:[^,]*?(;base64)?,(.*)$/s.exec(url || '');
  if (!m) return null;
  if (m[1]) return Buffer.from(m[2], 'base64');
  return Buffer.from(m[2].split(/(%[0-9a-f]{2})/i).flatMap(p => /^%[0-9a-f]{2}$/i.test(p) ? [parseInt(p.slice(1), 16)] : [...Buffer.from(p, 'latin1')]));
}
// A @font-face src value: its fonts carried in the rule (the SHA-256 of each data: url's bytes) and the installed
// fonts it names (local()).
export function srcParts(src) {
  const s = String(src || '');
  const data = [...s.matchAll(/url\(\s*["']?(data:[^"')]+)["']?\s*\)/g)].map(m => dataBytes(m[1])).filter(Boolean).map(sha256);
  const locals = [...s.matchAll(/local\(\s*["']?([^"')]+?)["']?\s*\)/g)].map(m => m[1].trim().toLowerCase());
  return { data, locals };
}

// real: [{ family, name, weight, style, by: 'stylesheet' | 'script', files: [{ url, sha256 }], candidates, data, locals }]
// rep: { loaded: [{ family }], faces: [{ family, weight, style, src }] }; repSha(src) → the SHA-256 of each file the
// replica's src names.
export function fontVerdicts(real, rep, repSha) {
  if (!real) return [];
  return real.map(r => {
    const loaded = rep.loaded.some(x => normFamily(x.family) === r.family);
    const faces = rep.faces.filter(x => normFamily(x.family) === r.family);
    const exact = faces.find(x => normWeight(x.weight) === r.weight && x.style === r.style) || faces[0];
    const parts = srcParts(exact && exact.src);
    const repFiles = exact ? repSha(exact.src) : [];
    const have = [...repFiles, ...parts.data];
    const want = [...(r.files.length ? r.files : r.candidates), ...(r.data || []).map(sha => ({ url: 'data:', sha256: sha }))];
    const base = { family: r.family, name: r.name, weight: r.weight, style: r.style, loadedBy: r.by, real: want.map(x => ({ url: x.url.split('?')[0], sha256: x.sha256 })), replica: have };
    // Matched by its file: a face this screen doesn't use isn't loaded, but it's there, from the same file.
    base.used = loaded;
    // Only installed fonts on the real page (local()), and the replica's rule names the same ones: the same font, if
    // the replica could load that face here (an installed font is this computer's, not the recording's).
    const locals = r.locals || [];
    if (!want.length && locals.length && locals.every(l => parts.locals.includes(l))) {
      const here = rep.loaded.some(x => normFamily(x.family) === r.family && normWeight(x.weight) === r.weight && (x.style || 'normal') === r.style);
      return here ? { ...base, status: 'match', why: 'a font installed on the computer, named the same in both' } : { ...base, status: 'unverified', why: 'a font installed on the computer that the replica didn\'t load here' };
    }
    if (!have.length) return { ...base, status: 'substituted', why: r.by === 'script' ? 'the real page loaded this font by script (no @font-face rule was captured); the replica falls back' : 'the replica has no file for this font and falls back' };
    if (!want.length) return { ...base, status: 'unverified', why: 'the real page\'s file for this font was not captured' };
    if (have.some(s => want.some(x => x.sha256 === s))) return { ...base, status: 'match' };
    return { ...base, status: 'different-file', why: 'the replica loads another file for this font than the real page did' };
  });
}
