import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterBody, arraysAt, ruleOf } from './leave-out.mjs';
import { readFileSync } from 'node:fs';

test('leave out: a catalog item by name, and nothing else changes', () => {
  const body = JSON.stringify({ plugins: [{ name: 'Contoso Ledger', connectors: [{ name: 'Contoso Ledger' }] }, { name: 'Fabrikam Payroll' }, { name: 'Contoso Notes' }] });
  const r = filterBody(body, [ruleOf({ id: 'catalog', items: 'plugins', field: 'name' }, [' fabrikam payroll '])]);
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(r.body).plugins.map(p => p.name), ['Contoso Ledger', 'Contoso Notes']);
  assert.deepEqual(r.removed, [{ rule: 'catalog', field: 'name', value: 'Fabrikam Payroll', shows: 'Fabrikam Payroll' }]);
  assert.deepEqual(r.kept, { catalog: 2 });
  // Nothing to leave out: the body as it came.
  assert.equal(filterBody(body, [ruleOf({ id: 'catalog', items: 'plugins', field: 'name' }, ['Northwind'])]).body, body);
});

test('leave out: mail by sender in one group of a mixed list, its refs too, and the subject is what must not show', () => {
  const mail = (id, from, subject) => ({ ReferenceId: id, From: { EmailAddress: { Name: 'Notices', Address: from } }, Subject: subject, Text: subject });
  const body = JSON.stringify({
    Groups: [
      { Type: 'Message', Suggestions: [mail('m1', 'Notices-NoReply@fabrikam.test', 'Weekly digest'), mail('m2', 'avery@contoso.test', 'Order 12 shipped'), mail('m3', 'notices-noreply@fabrikam.test', 'Role assigned')] },
      { Type: 'People', Suggestions: [{ ReferenceId: 'p1', DisplayName: 'Avery Chen', From: { EmailAddress: { Address: 'notices-noreply@fabrikam.test' } } }] },
    ],
    LayoutHints: { BestMatchSuggestions: [{ ReferenceId: 'm1' }, { ReferenceId: 'p1' }, { ReferenceId: 'm2' }, { ReferenceId: 'm3' }] },
  });
  const f = { id: 'mail', items: 'Groups[Type=Message].Suggestions', field: 'From.EmailAddress.Address', refs: [{ list: 'LayoutHints.BestMatchSuggestions', by: 'ReferenceId' }], shows: 'Subject' };
  const r = filterBody(body, [ruleOf(f, ['notices-noreply@fabrikam.test'])]);
  const j = JSON.parse(r.body);
  assert.deepEqual(j.Groups[0].Suggestions.map(s => s.ReferenceId), ['m2']);
  assert.equal(j.Groups[1].Suggestions.length, 1, 'only the Message group');
  assert.deepEqual(j.LayoutHints.BestMatchSuggestions.map(x => x.ReferenceId), ['p1', 'm2'], 'no dangling ref, the rest in order');
  assert.deepEqual(r.removed.map(x => x.shows), ['Weekly digest', 'Role assigned']);
  assert.equal(r.refs, 2);
  // A response with no Message group is fine; one with no Groups isn't the one the pack knows.
  assert.equal(filterBody(JSON.stringify({ Groups: [{ Type: 'People', Suggestions: [] }] }), [ruleOf(f, ['x'])]).ok, true);
  assert.match(filterBody(JSON.stringify({ Results: [] }), [ruleOf(f, ['x'])]).why, /no Groups list/);
  assert.match(filterBody('<html>', [ruleOf(f, ['x'])]).why, /isn't JSON/);
});

test('leave out: a team by any of its fields, across groups', () => {
  const body = JSON.stringify({ Groups: [
    { Type: 'TeamsChannel', Suggestions: [{ ReferenceId: 't1', Name: 'Operations' }, { ReferenceId: 't2', Name: 'Field Ops ' }, { ReferenceId: 'c1', Name: 'General', TeamName: 'field ops' }, { ReferenceId: 'c2', Name: 'General', TeamName: 'Operations' }] },
    { Type: 'Site', Suggestions: [{ ReferenceId: 's1', Title: 'Field Ops' }, { ReferenceId: 's2', Title: 'Field Ops Archive' }] },
  ] });
  const r = filterBody(body, [ruleOf({ id: 'team', items: 'Groups[*].Suggestions', fields: ['Name', 'TeamName', 'Title'] }, ['Field Ops'])]);
  assert.deepEqual(arraysAt(JSON.parse(r.body), 'Groups[*].Suggestions').map(a => a.map(s => s.ReferenceId)), [['t1', 'c2'], ['s2']]);
  assert.deepEqual(r.removed.map(x => x.value), ['Field Ops ', 'field ops', 'Field Ops']);
});

// leave-out-page.js in a small DOM: elements with attributes, words and siblings, and a MutationObserver that runs on
// what it was told to watch. → { list, run(rules), change(kind, attr), marked(), writes, window }
function pageWith() {
  const writes = [];
  let watcher = null;
  class El {
    constructor(attrs = {}, words = [], label = '') { this.attrs = { ...attrs }; this.words = words.map(w => ({ nodeValue: w })); this.label = label; this.kids = []; this.parent = null; }
    getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
    setAttribute(n, v) { writes.push(n); this.attrs[n] = String(v); }
    removeAttribute(n) { writes.push(n); delete this.attrs[n]; }
    hasAttribute(n) { return n in this.attrs; }
    appendChild(k) { k.parent = this; this.kids.push(k); return k; }
    get nextElementSibling() { const s = this.parent ? this.parent.kids : []; return s[s.indexOf(this) + 1] || null; }
  }
  const root = new El(), head = root.appendChild(new El()), list = root.appendChild(new El());
  const all = () => { const out = []; const walk = e => e.kids.forEach(k => { out.push(k); walk(k); }); walk(root); return out; };
  const is = (el, sel) => { const m = /^\[([\w-]+)(?:=([\w-]+))?\]$/.exec(sel); return !!m && el.hasAttribute(m[1]) && (!m[2] || el.getAttribute(m[1]) === m[2]); };
  const document = {
    documentElement: root, head,
    querySelectorAll: sel => all().filter(e => is(e, sel)),
    getElementById: id => all().find(e => e.id === id) || null,
    createElement: () => new El(),
    createTreeWalker: el => { const nodes = [el, ...el.kids].flatMap(e => e.words); let i = 0; return { nextNode: () => nodes[i++] || null }; },
  };
  class MutationObserver { constructor(fn) { this.fn = fn; } observe(target, opts) { this.opts = opts; watcher = this; } }
  const window = {};
  const src = readFileSync(new URL('./leave-out-page.js', import.meta.url), 'utf8').replace(/^\/\/.*\n/gm, '').trim();
  const page = new Function('window', 'document', 'location', 'NodeFilter', 'MutationObserver', `return ${src}`)(window, document, { host: 'chat.example.test' }, { SHOW_TEXT: 4 }, MutationObserver);
  return {
    writes, window,
    item: (name, attrs = {}) => list.appendChild(new El({ role: 'treeitem', ...attrs }, [name], name)),
    group: of => list.appendChild(new El({ role: 'group' }, [], `${of}'s group`)),
    run: rules => page(rules),
    // A change the page makes: the watcher runs only for what it watches (an attribute, only one it names).
    change: (kind, attr) => { const o = watcher.opts; if (kind === 'attributes' ? o.attributes && (!o.attributeFilter || o.attributeFilter.includes(attr)) : o[kind]) watcher.fn([]); },
    marked: () => all().filter(e => e.hasAttribute('data-d1-leaveout')).map(e => e.label),
  };
}

test("Leave out in the page: the marks follow the names and the rules as they are now", () => {
  const p = pageWith();
  const a = p.item('Team A'), b = p.item('Team B'), c = (p.group('Team B'), p.item('Team C'));
  const rules = values => [{ id: 'teams', hosts: ['chat.example.test'], list: '[role=treeitem]', values }];
  p.run(rules(['Team B']));
  assert.deepEqual(p.marked(), ['Team B', "Team B's group"]);
  // The list reuses the left-out item's node for one she keeps: it shows again, and so does the group after it.
  b.words[0].nodeValue = 'Team D';
  p.change('characterData');
  assert.deepEqual(p.marked(), []);
  // A name that changes in place, by its aria-label alone, to one she leaves out.
  c.attrs['aria-label'] = 'Team B';
  p.change('attributes', 'aria-label');
  assert.deepEqual(p.marked(), ['Team C']);
  // New values for the rule: the old marks go, the new ones come.
  p.window.__d1lo.set(rules(['Team A']));
  assert.deepEqual(p.marked(), ['Team A']);
  assert.equal(a.getAttribute('data-d1-leaveout'), 'teams');
  // Nothing changed: nothing written (its own writes would run it again).
  p.writes.length = 0;
  p.change('childList');
  assert.deepEqual(p.writes, []);
});
