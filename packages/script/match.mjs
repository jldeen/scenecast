// Script lines to the replica's screens and what on them backs each line. The AI step is pluggable: a matcher is
//   { name, async match({ lines, screens, sequence, flow }) } → one result per line, in order:
//   { pos, picks: [{ item, phrase?, score, words }], score, missing: [word…] }
// where `screens[state].items` is the screen's index (packages/player/app/focus-target.js items(): text blocks,
// controls, lists and regions, with their roles and boxes), `sequence` the run-through as screens (focus-order.js), and
// `pos` the place in it the line plays over. A pick is an item of that screen (with, for long text, the phrase in it).
// The default, `text`, is deterministic (text similarity weighted by how rare each word is, with accessibility roles),
// so CI runs it with no model. A demo can bring its own: demo.json { script: { matcher: "my-matcher.mjs" } } or
// scenecast script --matcher <file>: its default export is the matcher; it can use this file's helpers.

// ---- words ------------------------------------------------------------------------------------------------------
const STOP = new Set(`a an the and or but if so then than that this these those it its i i'm i've me my mine we we're we've our ours us you your yours he she they them their his her of to in on at by for with from as into onto about over under up down out off again also just only even still very really now here there what which who whom whose how why when where can could will would shall should may might must do does did done doing is are was were be been being am has have had having not no yes all any some each every more most much many let lets see look looks show shows showing showed watch thing things get gets got go goes going went come comes came make makes made way like well okay ok right hi hello thank thanks everyone something anything nothing already ever too own same other another`.split(/\s+/));
const MONTHS = { january: 'jan', february: 'feb', march: 'mar', april: 'apr', june: 'jun', july: 'jul', august: 'aug', september: 'sep', sept: 'sep', october: 'oct', november: 'nov', december: 'dec', monday: 'mon', tuesday: 'tue', wednesday: 'wed', thursday: 'thu', friday: 'fri', saturday: 'sat', sunday: 'sun' };
const norm = s => String(s || '').replace(/[\u2019\u2018]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2011\u2010\u2013\u2014]/g, '-').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
export function stem(w) {
  if (/^\d/.test(w)) return w;
  if (MONTHS[w]) return MONTHS[w];
  if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
  else if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 6 && w.endsWith('er')) w = w.slice(0, -2);
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}
// Content words in order: lower case, stemmed, numbers without $ and thousands commas, codes (PO-450101) whole.
export function words(s) {
  const out = [];
  const t = norm(s).toLowerCase().replace(/'s\b/g, '').replace(/(?<![\w-])\$?(\d[\d,]*)(\.\d+)?(?![\w-])/g, (m, a, b) => ' ' + a.replace(/,(?=\d{3}\b)/g, '') + (b || '') + ' ');
  for (let w of t.split(/[^a-z0-9.%-]+/)) {
    w = w.replace(/^[.\-%]+|[.\-]+$/g, '');
    if (!w) continue;
    const parts = /\d/.test(w) ? [w] : w.split('-');
    for (const p of parts) { if (!p || STOP.has(p) || (p.length < 2 && !/\d/.test(p))) continue; out.push(stem(p)); }
  }
  return out;
}
// The facts a line states that a screen should show: numbers, and names (capitalised, not starting a sentence).
export function facts(s) {
  const out = [], t = norm(s);
  const re = /\$?\b[A-Za-z-]*\d[\w,.-]*%?|[A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)*/g;
  let m;
  while ((m = re.exec(t))) {
    const before = t.slice(0, m.index).trimEnd();
    let f = m[0].replace(/^(?:I'm|I've|I'll|I'd|I)(?:\s+|$)/, '');
    if (/^[A-Z]/.test(m[0]) && f === m[0] && (!before || /[.!?:"]$/.test(before))) f = f.split(/\s+/).slice(1).join(' ');
    const w = words(f);
    if (f && w.length) out.push({ text: f.replace(/[.,]$/, ''), words: w });
  }
  return out;
}
export function sentences(text) {
  const out = [], re = /(?:[^.!?]|[.!?](?!\s|$))+(?:[.!?]+|$)/g;
  let m; while ((m = re.exec(text))) { const s = norm(m[0]); if (s) out.push(s); if (m.index === re.lastIndex) re.lastIndex++; }
  return out;
}

// ---- the text matcher ---------------------------------------------------------------------------------------------
const ROLE = { heading: 1.15, button: 1.05, link: 1.05, tab: 1.05, menuitem: 1.05, listitem: 1, gridcell: 1, cell: 1, paragraph: 1, generic: 1, list: 0.55, grid: 0.5, dialog: 0.5, region: 0.5, complementary: 0.45, navigation: 0.45, img: 0.9 };
export const LIMITS = { pick: 1.6, back: 2.6, picks: 3, move: 0.12, long: 180 };

// How strongly an item backs a line: the shared words, by rarity, scaled by how much of the item (or of the best
// sentence in a long one) the line covers, with a bonus for words in the same order, and the item's role.
export function scoreItem(lineWords, item, w) {
  const L = new Set(lineWords);
  // The whole item, and each sentence of a longer one (a phrase the focus point finds on its own).
  const parts = item.kind === 'text' || item.kind === 'item' ? sentences(item.text) : [];
  const units = [...(item.text.length <= LIMITS.long ? [{ text: item.text, phrase: null }] : []), ...(parts.length > 1 || item.text.length > LIMITS.long ? parts.map(s => ({ text: s, phrase: s })) : [])];
  let best = null;
  for (const u of units) {
    const uw = words(u.text);
    if (!uw.length) continue;
    const U = new Set(uw), shared = [...U].filter(x => L.has(x));
    if (!shared.length) continue;
    const s = shared.reduce((n, x) => n + w(x), 0), all = [...U].reduce((n, x) => n + w(x), 0);
    let pairs = 0;
    for (let i = 0; i + 1 < lineWords.length; i++) for (let j = 0; j + 1 < uw.length; j++) if (lineWords[i] === uw[j] && lineWords[i + 1] === uw[j + 1]) { pairs++; break; }
    const q = (s * (0.35 + 0.65 * s / all) + pairs * 0.6 * s / shared.length) * (ROLE[item.role] || 1) * (item.kind === 'region' ? 0.6 : 1);
    if (!best || q > best.score + 1e-9) best = { score: q, words: shared.sort(), phrase: u.phrase };
  }
  return best;
}

// The items that back a line on one screen: the best first, then others only for words not covered yet (at most 3),
// never one inside another.
export function pickItems(lineWords, screen, w) {
  const cands = [];
  for (const it of screen.items) { const s = scoreItem(lineWords, it, w); if (s && s.score >= LIMITS.pick) cands.push({ item: it.i, ...s, box: it.box }); }
  cands.sort((a, b) => b.score - a.score || a.item - b.item);
  const picks = [], covered = new Set();
  const within = (a, b) => a[0] >= b[0] - 1 && a[1] >= b[1] - 1 && a[2] <= b[2] + 1 && a[3] <= b[3] + 1;
  for (const c of cands) {
    if (picks.length >= LIMITS.picks) break;
    const fresh = c.words.filter(x => !covered.has(x));
    if (!fresh.length) continue;
    const share = fresh.reduce((n, x) => n + w(x), 0) / c.words.reduce((n, x) => n + w(x), 0);
    const q = c.score * share;
    if (q < (picks.length ? LIMITS.back : LIMITS.pick)) continue;
    if (picks.some(p => within(c.box, p.box) || within(p.box, c.box))) continue;
    picks.push({ item: c.item, phrase: c.phrase || undefined, score: Math.round(q * 100) / 100, words: c.words, box: c.box });
    for (const x of c.words) covered.add(x);
  }
  return picks;
}

// Lines in order over the run-through: each line at a place no earlier than the line before, the most backing in total,
// moving on only when it pays (a line nothing backs stays on the screen before it).
export function align(scores, M) {
  const n = scores.length, NEG = -1e18;
  if (!n) return [];
  const dp = scores.map(() => new Float64Array(M).fill(NEG)), from = scores.map(() => new Int32Array(M).fill(-1));
  for (let j = 0; j < M; j++) dp[0][j] = scores[0][j] - LIMITS.move * j;
  for (let i = 1; i < n; i++) {
    let best = NEG, arg = -1;
    for (let j = 0; j < M; j++) {
      // The best earlier place, with the cost of moving from it to j.
      const v = dp[i - 1][j] + LIMITS.move * j;
      if (v > best + 1e-12) { best = v; arg = j; }
      dp[i][j] = scores[i][j] + best - LIMITS.move * j;
      from[i][j] = arg;
    }
  }
  let j = 0; for (let k = 1; k < M; k++) if (dp[n - 1][k] > dp[n - 1][j] + 1e-12) j = k;
  const out = new Array(n);
  for (let i = n - 1; i >= 0; i--) { out[i] = j; j = from[i][j]; }
  return out;
}

export const textMatcher = {
  name: 'text',
  async match({ lines, screens, sequence }) {
    // Word rarity over every item of every screen: a word on every screen says little about which one a line means.
    const df = new Map(); let N = 0;
    for (const sc of Object.values(screens)) for (const it of sc.items) { N++; for (const x of new Set(words(it.text))) df.set(x, (df.get(x) || 0) + 1); }
    const w = x => Math.log(1 + N / (df.get(x) || 0.5)) * (/^\d/.test(x) ? 1.5 : 1);
    const lw = lines.map(l => words(l.text));
    const perState = new Map();
    for (const st of new Set(sequence.map(x => x.state))) if (screens[st]) perState.set(st, lw.map(L => pickItems(L, screens[st], w)));
    const scores = lines.map((l, i) => sequence.map(x => (perState.get(x.state) || [])[i] ? perState.get(x.state)[i].reduce((n, p) => n + p.score, 0) : 0));
    const at = align(scores, sequence.length);
    return lines.map((l, i) => {
      const st = sequence[at[i]].state;
      // ⌥F order: the order the line mentions them.
      const first = p => Math.min(...p.words.map(x => lw[i].indexOf(x)).filter(k => k >= 0));
      const picks = [...((perState.get(st) || [])[i] || [])].sort((a, b) => first(a) - first(b) || a.item - b.item);
      const have = new Set(screens[st] ? screens[st].items.flatMap(it => words(it.text)) : []);
      const missing = facts(l.text).filter(f => !f.words.every(x => have.has(x))).map(f => f.text);
      return { pos: at[i], picks, score: Math.round(scores[i][at[i]] * 100) / 100, missing };
    });
  },
};

export async function loadMatcher(spec, dir) {
  if (!spec || spec === 'text') return textMatcher;
  const { pathToFileURL } = await import('node:url');
  const { resolve } = await import('node:path');
  const m = await import(pathToFileURL(resolve(dir, spec)).href);
  const matcher = m.default || m.matcher;
  if (!matcher || typeof matcher.match !== 'function') throw new Error(`${spec}: its default export needs match({ lines, screens, sequence, flow })`);
  return matcher;
}
