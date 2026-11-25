// Leave out (reset.md "## Leave out"): items a demo's tenant has that the capture leaves out, filtered from what the
// page is given, in the capture browser only. Requests go out as they are; only the response's body changes, so the
// app draws itself without the item (no hole, counts right) and nothing reaches the tenant.
//   filterBody(text, rules) → { ok, body, removed: [{ rule, field, value, shows }], refs } | { ok: false, why }
// A rule: { id, items, fields, values, refs?, shows? } from a pack's filters entry and the demo's Leave out lines:
//   items   where the item arrays are: dotted keys, each optionally [*] (every element) or [Key=Value] (the elements
//           whose Key is Value): "plugins", "Groups[Type=Message].Suggestions", "Groups[*].Suggestions". The first key
//           must be there, an array: else the response isn't the one the pack knows (ok: false)
//   fields  the item's fields (dotted, "From.EmailAddress.Address") any of which equal to a value (exact, trimmed, case
//           aside) leaves it out
//   refs    [{ list, by }]: other lists that name items by a field (LayoutHints.BestMatchSuggestions by ReferenceId);
//           their entries for a removed item go too, so nothing dangles
//   shows   the item's field whose text must then never be on a screen (the negative check); else the value
// A DOM rule (kind "dom"), for a list an app draws from its own store: leave-out-page.js.

const norm = v => String(v == null ? '' : v).trim().toLowerCase();
const get = (o, path) => String(path || '').split('.').filter(Boolean).reduce((x, k) => (x == null ? x : x[k]), o);
const SEG = /^([^[\]]+)(?:\[(\*|([^=\]]+)=([^\]]*))\])?$/;

// Every array at a path (each segment's [*] or [Key=Value] picks the elements it goes on from).
export function arraysAt(root, path) {
  let cur = [root];
  for (const seg of String(path).split('.')) {
    const m = SEG.exec(seg);
    if (!m) return [];
    const next = [];
    for (const o of cur) {
      if (!o || typeof o !== 'object') continue;
      const v = o[m[1]];
      if (m[2] === undefined) next.push(v);
      else if (Array.isArray(v)) for (const x of v) if (m[2] === '*' || (x && norm(x[m[3]]) === norm(m[4]))) next.push(x);
    }
    cur = next;
  }
  return cur.filter(Array.isArray);
}

// Is a rule's response the one its pack knows: its first key there, an array.
export function hasShape(root, items) {
  const m = SEG.exec(String(items).split('.')[0]);
  return !!m && !!root && typeof root === 'object' && Array.isArray(root[m[1]]);
}

export function filterBody(text, rules) {
  let root;
  try { root = JSON.parse(text); } catch (e) { return { ok: false, why: "the response isn't JSON" }; }
  const removed = [];
  let refs = 0;
  for (const r of rules) {
    if (!hasShape(root, r.items)) return { ok: false, why: `the response has no ${String(r.items).split('.')[0].replace(/\[.*$/, '')} list (${r.id})` };
    const fields = [].concat(r.fields || r.field || []), values = (r.values || []).map(norm);
    const gone = [];
    for (const arr of arraysAt(root, r.items)) {
      const keep = [];
      for (const it of arr) {
        const field = fields.find(f => { const v = get(it, f); return v != null && typeof v !== 'object' && values.includes(norm(v)); });
        if (field === undefined) { keep.push(it); continue; }
        const hit = String(get(it, field));
        gone.push(it);
        removed.push({ rule: r.id, field, value: hit, shows: String((r.shows && get(it, r.shows)) || hit) });
      }
      if (keep.length !== arr.length) arr.splice(0, arr.length, ...keep);
    }
    for (const ref of r.refs || []) {
      const keys = new Set(gone.map(it => get(it, ref.by)).filter(v => v != null).map(String));
      if (!keys.size) continue;
      for (const arr of arraysAt(root, ref.list)) for (let i = arr.length - 1; i >= 0; i--) if (keys.has(String(get(arr[i], ref.by)))) { arr.splice(i, 1); refs++; }
    }
  }
  return { ok: true, body: removed.length ? JSON.stringify(root) : text, removed, refs };
}

// A filter's rule from its pack entry and the demo's values for it.
// id: the pack's and the filter's ("teams:team-tree"); app: the demo's app it's for. A response filter has url (where
// its responses come from, as the browser's request patterns write it) and match (a guard entry, over "METHOD
// host/path"); a DOM filter (kind "dom") has hosts and list (leave-out-page.js).
export const ruleOf = (filter, values, { id = filter.id, app = null, hosts = [] } = {}) => filter.kind === 'dom'
  ? { id, app, kind: 'dom', hosts, list: filter.list, values }
  : { id, app, kind: 'response', url: filter.url, match: filter.match, items: filter.items, fields: [].concat(filter.fields || filter.field || []), refs: filter.refs || [], shows: filter.shows || null, values };
