// What's a control on a page, its role and its name: one rule for every reader of a page, recorded (Scenecast's reader,
// @scenecast/script/html.mjs) or live (a run, the outline the AI sees). Self-contained (nothing from outside its
// body), so a run can send it to the page as it is:
//
//   const named = await page.evaluate(`(() => { const controlOf = ${controlOf}; return [...document.querySelectorAll('*')]
//     .map(el => controlOf(el, { tag: e => e.localName, attr: (e, n) => e.getAttribute(n), text: e => e.innerText,
//       byId: id => document.getElementById(id), labels: e => [...(e.labels || [])] })).filter(c => c.control); })()`);
//
// acc:  tag(el) → its tag, lowercase; attr(el, name) → the attribute's value, or null when it has none;
//       text(el) → the words it shows (innerText); byId(id) → the first element with that id, or null;
//       labels(el) → the <label> elements tied to it (`for` its id, or around it), in page order.
// →     { control, role, name }: whether it's a control; its role; its name ('' when it has none, or when it isn't a
//       control: names are only worked out for controls).
// The rule in words: docs/engine/plan-format.md, "Controls, their roles and names".
export function controlOf(el, acc) {
  const tag = acc.tag(el), attr = n => acc.attr(el, n), has = n => attr(n) != null;
  // Invisible characters (zero-width spaces and joiners, direction marks) out; spaces as one.
  const clean = s => String(s == null ? '' : s).replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
  const editable = /^(|true|plaintext-only)$/.test(has('contenteditable') ? String(attr('contenteditable')).toLowerCase() : 'no');
  const type = String(attr('type') || 'text').toLowerCase();
  const roleAttr = attr('role') || '';
  // Its role: the role attribute, else what its tag is.
  const role = roleAttr || (tag === 'a' && has('href') ? 'link'
    : tag === 'button' || tag === 'summary' ? 'button'
    : tag === 'select' ? 'combobox'
    : tag === 'textarea' ? 'textbox'
    : tag === 'input' ? (type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : /^(button|submit|reset|image)$/.test(type) ? 'button' : type === 'search' ? 'searchbox' : 'textbox')
    : editable ? 'textbox' : tag);
  // A control: something to click, pick or type in.
  const control = tag === 'input' ? !/^(hidden|password)$/.test(type)
    : /^(button|summary|select|textarea)$/.test(tag) || (tag === 'a' && has('href')) || editable
      || /^(button|link|tab|menuitem|menuitemcheckbox|menuitemradio|option|treeitem|switch|checkbox|radio|textbox|searchbox|combobox|gridcell)$/.test(roleAttr)
      || ((roleAttr === 'row' || roleAttr === 'listitem') && has('tabindex'))
      || attr('tabindex') === '0';
  if (!control) return { control, role, name: '' };
  // Its name: the first of these that isn't empty (cleaned as above): aria-label; the words of the elements aria-labelledby
  // names; the words of its <label>s (an input, select or textarea); its own words (not for a box you type in);
  // placeholder, data-placeholder, aria-placeholder, title, alt, value. A name said twice in a row ("Share Share")
  // once; at most 90 characters.
  const words = els => els.map(e => acc.text(e)).join(' ');
  const by = has('aria-labelledby') ? words(attr('aria-labelledby').split(/\s+/).map(id => id && acc.byId(id)).filter(Boolean)) : '';
  const label = /^(input|select|textarea)$/.test(tag) ? words(acc.labels(el) || []) : '';
  const own = tag === 'input' || tag === 'textarea' || editable ? '' : acc.text(el);
  const name = [attr('aria-label'), by, label, own, attr('placeholder'), attr('data-placeholder'), attr('aria-placeholder'), attr('title'), attr('alt'), attr('value')]
    .map(clean).find(Boolean) || '';
  return { control, role, name: name.replace(/^(.{2,}?) ?\1$/, '$1').slice(0, 90) };
}
