import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterBody, arraysAt, ruleOf } from './leave-out.mjs';

test('leave out: a catalog item by name, and nothing else changes', () => {
  const body = JSON.stringify({ plugins: [{ name: 'Contoso Ledger', connectors: [{ name: 'Contoso Ledger' }] }, { name: 'Fabrikam Payroll' }, { name: 'Contoso Notes' }] });
  const r = filterBody(body, [ruleOf({ id: 'catalog', items: 'plugins', field: 'name' }, [' fabrikam payroll '])]);
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(r.body).plugins.map(p => p.name), ['Contoso Ledger', 'Contoso Notes']);
  assert.deepEqual(r.removed, [{ rule: 'catalog', field: 'name', value: 'Fabrikam Payroll', shows: 'Fabrikam Payroll' }]);
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
