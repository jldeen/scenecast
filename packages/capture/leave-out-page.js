// Leave out, for a list an app draws from its own store (Teams' left rail, from IndexedDB): installed at document start
// (host-ops capLeaveOut, in every tab and frame) with its rules. Each item of the list whose own name (its aria-label,
// or one of its first pieces of text) equals a value is marked data-d1-leaveout, and so is what's under it (the group
// right after it, a team's channels); a stylesheet hides marked nodes, so screenshots, hovers and zoom levels never
// show them, and serialize.js leaves them out of every snapshot. Nothing is removed: the app (React) keeps its own
// nodes, and a re-render is marked again in the same mutation callback, before it's drawn. Only for flow lists, where a
// hidden item leaves no hole.
//   rules: [{ id, hosts: ['teams.cloud.microsoft', …], list: CSS selector of the items, values: [name, …] }]
(rules => {
  // Again in a document that has it (a new set, or none: off): its marks follow the new rules.
  if (window.__d1lo) { window.__d1lo.set(rules); return; }
  let mine = [];
  const api = { marked: 0, set: null };
  Object.defineProperty(window, '__d1lo', { value: api });
  const norm = s => String(s || '').trim().toLowerCase();
  // Its own name: its aria-label, or one of its first few pieces of text (an avatar's initials can come first). No
  // layout read: it runs on every change.
  const namesOf = el => {
    const out = [el.getAttribute('aria-label')];
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(), k = 0; n && k < 4; n = w.nextNode()) { const t = n.nodeValue.trim(); if (t) { out.push(t); k++; } }
    return out.filter(Boolean).map(norm);
  };
  const style = () => {
    if (document.getElementById('d1-leaveout-css') || !document.documentElement) return;
    const st = document.createElement('style');
    st.id = 'd1-leaveout-css';
    st.textContent = '[data-d1-leaveout]{display:none !important}';
    (document.head || document.documentElement).appendChild(st);
  };
  const mark = () => {
    style();
    for (const r of mine) {
      let els = [];
      try { els = document.querySelectorAll(r.list); } catch (e) { continue; }
      const want = r.values.map(norm);
      for (const el of els) {
        if (el.hasAttribute('data-d1-leaveout') || !namesOf(el).some(n => want.includes(n))) continue;
        el.setAttribute('data-d1-leaveout', r.id);
        // What's under it, when the list draws that beside it rather than in it: the group right after it (a team's
        // channels), or the items after it one level down (a flat tree), up to the next at its level.
        const lvl = +el.getAttribute('aria-level') || 0;
        for (let next = el.nextElementSibling; next; next = next.nextElementSibling) {
          if (next.getAttribute('role') === 'group') { next.setAttribute('data-d1-leaveout', r.id); break; }
          if (!(lvl && +next.getAttribute('aria-level') > lvl)) break;
          next.setAttribute('data-d1-leaveout', r.id);
        }
        api.marked++;
      }
    }
  };
  api.set = rs => {
    mine = (rs || []).filter(r => (r.hosts || []).some(h => location.host === h || location.host.endsWith('.' + h)));
    const ids = new Set(mine.map(r => r.id));
    for (const el of document.querySelectorAll('[data-d1-leaveout]')) if (!ids.has(el.getAttribute('data-d1-leaveout'))) el.removeAttribute('data-d1-leaveout');
    if (mine.length) mark();
  };
  new MutationObserver(() => { if (mine.length) mark(); }).observe(document, { childList: true, subtree: true, characterData: true });
  api.set(rules);
})
