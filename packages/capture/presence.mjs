// Her own presence, in the capture browser only: an app's presence answers (Teams' getpresence) say she's the status
// her recording shows (Available), whether or not she's at her computer. Only her own entry changes (the one that names
// her by her account's object id, read from the page's sign-in at run time), and only its availability and activity;
// everyone else's stays as the service says. The request goes out as it is: only the answer's body changes, as Leave
// out's filters do.
//   presenceBody(text, ids, status) → { ok, body, changed } | { ok: false, why }

const KEYS = /^(availability|activity)$/i;
const NESTED = /presence|status/i;

export function presenceBody(text, ids, status) {
  let root;
  try { root = JSON.parse(text); } catch (e) { return { ok: false, why: "the response isn't JSON" }; }
  const want = [].concat(ids || []).map(x => String(x || '').toLowerCase()).filter(x => x.length >= 8);
  if (!want.length || !status) return { ok: true, body: text, changed: 0 };
  let changed = 0;
  // An entry is hers when one of its own string fields names her (an MRI "8:orgid:<id>", an id, a userId).
  const hers = o => Object.values(o).some(v => typeof v === 'string' && want.some(id => v.toLowerCase().includes(id)));
  const set = o => { for (const k of Object.keys(o)) if (KEYS.test(k) && typeof o[k] === 'string' && o[k] !== status) { o[k] = status; changed++; } };
  const walk = o => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { for (const x of o) walk(x); return; }
    if (hers(o)) {
      set(o);
      // Its presence, when it's an object of its own ({ mri, presence: { availability, activity } }).
      for (const [k, v] of Object.entries(o)) if (NESTED.test(k) && v && typeof v === 'object' && !Array.isArray(v)) set(v);
    }
    for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v);
  };
  walk(root);
  return { ok: true, body: changed ? JSON.stringify(root) : text, changed };
}
