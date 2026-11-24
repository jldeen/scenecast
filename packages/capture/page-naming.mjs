// The control rule (@stuntdouble/core/lib/control-name.mjs) as page code: one source for every reader of a live page,
// put in front of what runs there (the outline the AI sees, outline-page.js via build.mjs; the live walker's search of
// a page and its frames, packages/ai/live.mjs; name-parity's check). In the page: domControl(el) → { control, role,
// name }, with the accessors the rule's comment gives for a live page (innerText, the document's ids, the field's
// <label>s).
import { controlOf } from '@stuntdouble/core/lib/control-name.mjs';

export const CONTROL_NAME_SRC = `const controlOf = ${String(controlOf)};
const NAMING_ACC = { tag: e => e.localName, attr: (e, n) => e.getAttribute(n), text: e => e.innerText,
  byId: id => document.getElementById(id), labels: e => [...(e.labels || [])] };
const domControl = e => controlOf(e, NAMING_ACC);`;
