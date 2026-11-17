// A virtualized list or grid (only the rows in view exist): scrolls through it, keeps a copy of every row it renders,
// puts the copies back, and snapshots, so the replica has every real row and scrolls through all of them.
// Rows placed by index (position absolute with top, or a transform) keep their place. Rows in normal flow go back
// in index order. Runs as the recorder's list side path (recordSide), or on its own with cli.mjs run.
// ARGS: { tab | p, id, frameRe?, sel?: the list (default: the biggest scrolling grid/list), row?: row selector,
//         index?: the row's index attribute (aria-rowindex, aria-posinset, data-index, data-item-index) }
const a = ARGS.p || await H.pageFor(ARGS.tab);
await a.bringToFront(); await sleep(800);
let lf = a.mainFrame();
if (ARGS.frameRe) { const re = new RegExp(ARGS.frameRe); lf = a.frames().find(x => re.test(x.url())) || lf; }
const list = await lf.evaluate(async ARGS => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const scroller = e => { let s = e; while (s && !(s.scrollHeight > s.clientHeight + 50 && /(auto|scroll)/.test(getComputedStyle(s).overflowY))) s = s.parentElement; return s; };
  const lists = ARGS.sel ? [...document.querySelectorAll(ARGS.sel)] : [...document.querySelectorAll('[role=grid],[role=treegrid],[role=list],[role=listbox],[role=feed],[role=table],[role=tree]')];
  let grid = null, sc = null, best = 0;
  for (const g of lists) { const s = scroller(g); if (!s) continue; const h = s.scrollHeight; if (h > best) { best = h; grid = g; sc = s; } }
  if (!grid) return { error: 'no scrolling list' };
  const IDX = ARGS.index ? [ARGS.index] : ['aria-rowindex', 'aria-posinset', 'data-index', 'data-item-index', 'data-row-index'];
  const ROW = ARGS.row || '[role=row],[role=listitem],[role=option],[role=article],[role=treeitem],li';
  const idxOf = r => { for (const k of IDX) { const v = r.getAttribute(k); if (v !== null && v !== '') return v; } return null; };
  const rowsNow = () => [...grid.querySelectorAll(ROW)].filter(r => idxOf(r) !== null && !r.parentElement.closest(ROW));
  // The rows' container: the parent holding the most indexed rows (a header row sits elsewhere).
  const by = new Map(); for (const r of rowsNow()) by.set(r.parentElement, (by.get(r.parentElement) || 0) + 1);
  const box = [...by].sort((x, y) => y[1] - x[1]).map(x => x[0])[0];
  if (!box) return { error: 'no indexed rows (aria-rowindex, aria-posinset, data-index)' };
  const first = [...box.children].find(r => r.matches(ROW) && idxOf(r) !== null);
  const placed = /absolute/.test(getComputedStyle(first).position) || /translate|matrix/.test(first.style.transform || '');
  const seen = new Map();
  const take = () => { for (const r of rowsNow()) if (r.parentElement === box) { const i = idxOf(r); if (!seen.has(i)) seen.set(i, r.cloneNode(true)); } };
  sc.scrollTop = 0; await sleep(500); take();
  for (let k = 0; k < 600 && sc.scrollTop + sc.clientHeight < sc.scrollHeight - 2; k++) { sc.scrollTop += Math.round(sc.clientHeight * 0.6); await sleep(250); take(); }
  sc.scrollTop = 0; await sleep(800); take();
  const have = new Set(rowsNow().filter(r => r.parentElement === box).map(idxOf));
  const missing = [...seen].filter(([i]) => !have.has(i)).sort((x, y) => +x[0] - +y[0]);
  let added = 0;
  if (placed) for (const [, r] of missing) { r.setAttribute('data-d1-row', ''); box.appendChild(r); added++; }
  else {
    // In flow: every row, in index order, with the spacers that stood in for the rest emptied.
    const all = [...seen].sort((x, y) => +x[0] - +y[0]).map(([, r]) => r);
    for (const r of rowsNow().filter(r => r.parentElement === box)) r.remove();
    for (const r of all) { r.setAttribute('data-d1-row', ''); box.appendChild(r); added++; }
    for (const e of [box, ...box.children]) if (!e.matches(ROW)) { const st = e.style; if (st.paddingTop || st.paddingBottom) { st.paddingTop = '0px'; st.paddingBottom = '0px'; } }
    for (const sp of box.querySelectorAll(':scope > :not(' + ROW + ')')) if (!sp.childElementCount && (sp.style.height || sp.style.minHeight)) { sp.style.height = '0px'; sp.style.minHeight = '0px'; }
  }
  const count = grid.getAttribute('aria-rowcount') || grid.getAttribute('aria-setsize') || (first.getAttribute('aria-setsize'));
  const tag = grid.getAttribute('role') ? `[role=${grid.getAttribute('role')}]` : grid.localName;
  return { list: tag + (grid.getAttribute('aria-label') ? `[aria-label="${grid.getAttribute('aria-label')}"]` : ''), placed, count: count === null ? null : +count, seen: seen.size, added, rendered: rowsNow().length };
}, { sel: ARGS.sel, row: ARGS.row, index: ARGS.index });
await sleep(600);
if (list.error) throw new Error('list: ' + list.error);
const out = { list };
out.snap = (await H.snap(a, ARGS.id)).docs[0];
return out;
