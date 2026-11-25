// The negative check of reset.md's Leave out, before the capture browser saves a screen (the capture host loads this
// by name: host-ops capLeaveOut's check). What she leaves out must be nowhere on the screen, in any frame:
//   words  her lines' words (Shows:, else the quoted words): leftOut() (landing.mjs) on the screen as the reader reads
//          it must mark nothing. They catch a leak from a path no filter covers (a new mail pushed to the page).
//   exact  each item the filters took out, by its own text (a mail's Subject, a plugin's name): in no item's words and
//          no control's name, however long.
//   leaveHits(docs, { words, exact }) → [{ by: 'words' | 'removed', value, frame, role, text, near }]; none: clean
import { readScreen } from '@scenecast/script/html.mjs';
import { leftOut, pnorm } from './landing.mjs';

const cut = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

export function leaveHits(docs, { words = [], exact = [] } = {}) {
  const sc = readScreen(docs);
  const entries = [...(sc.items || []).map(i => ({ x: i, text: i.text, role: i.role })), ...(sc.controls || []).map(c => ({ x: c, text: c.name, role: c.role }))];
  // Where it is: the element's role and words, and the words around it (its row's, else the items beside it).
  const where = (e, by, value) => {
    const { x } = e, inRow = y => x.row !== undefined && y.list === x.list && y.row === x.row && y !== x;
    let near = (sc.items || []).filter(inRow).map(i => i.text);
    if (!near.length && x.i !== undefined && sc.items.includes(x)) near = [sc.items[x.i - 1], sc.items[x.i + 1]].filter(Boolean).map(i => i.text);
    return { by, value, frame: x.frame || 'main', role: e.role || null, text: cut(e.text, 160), near: cut(near.join(' · '), 200) };
  };
  const hits = [];
  for (const v of words) {
    const marked = leftOut(sc, [v]);
    if (marked === sc) continue;
    const left = [...marked.items.filter(i => i.left).map(i => ({ x: sc.items[i.i], text: i.text, role: i.role })), ...marked.controls.filter(c => c.left).map(c => ({ x: sc.controls[c.i], text: c.name, role: c.role }))];
    // The entry with the words itself, else the first of its row.
    const own = left.filter(e => pnorm(e.text).includes(pnorm(v)));
    for (const e of (own.length ? own : left).slice(0, 3)) hits.push(where(e, 'words', v));
  }
  for (const v of exact) {
    const n = pnorm(v);
    if (!n) continue;
    for (const e of entries.filter(e => pnorm(e.text).includes(n)).slice(0, 3)) hits.push(where(e, 'removed', v));
  }
  return hits;
}
