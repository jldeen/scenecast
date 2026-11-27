import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leaveOutOf } from './leave-run.mjs';
import { leaveHits } from './leave-check.mjs';

const RESET = `# Reset: Mail

## Leave out

- mail: mail from "alerts@fabrikam.test"
  From: mail-app:hide-sender
  Shows: "From: Fabrikam Alerts"
- mail: mail from "notices@fabrikam.test"
  From: mail-app:hide-sender
  Shows: "From: Fabrikam Notices"
- chat: team "Contoso Beta"
  From: chat-app:team-tree
`;
const demo = { dir: '/nowhere', cfg: { apps: [{ id: 'mail' }, { id: 'chat' }] } };
const filters = {
  'mail-app:hide-sender': { id: 'hide-sender', pack: 'mail-app', app: 'mail', hosts: ['mail.test'], url: '*://mail.test/api/list*', match: '/^GET mail\\.test\\/api\\/list$/', items: 'items', fields: ['from'], shows: 'subject' },
  'chat-app:team-tree': { id: 'team-tree', pack: 'chat-app', app: 'chat', hosts: ['chat.test'], kind: 'dom', list: '[role=treeitem]' },
};
const packs = { filtersFor: () => filters };

test('leave out: one rule per filter with every line\'s values, the words per app, and a filter no pack has refuses', () => {
  const lo = leaveOutOf({ demo, packs, text: RESET });
  assert.deepEqual(lo.problems, []);
  assert.deepEqual(lo.rules.map(r => [r.id, r.app, r.kind, r.values]), [
    ['mail-app:hide-sender', 'mail', 'response', ['alerts@fabrikam.test', 'notices@fabrikam.test']],
    ['chat-app:team-tree', 'chat', 'dom', ['Contoso Beta']],
  ]);
  assert.equal(lo.rules[0].shows, 'subject');
  assert.deepEqual(lo.rules[1].hosts, ['chat.test']);
  assert.deepEqual(lo.words, { mail: ['From: Fabrikam Alerts', 'From: Fabrikam Notices'], chat: ['Contoso Beta'] });
  assert.match(leaveOutOf({ demo, packs, text: RESET.replace('chat-app:team-tree', 'chat-app:team-list') }).problems[0], /chat-app:team-list, and no app pack of this demo has that filter/);
  assert.match(leaveOutOf({ demo, packs, text: RESET.replace('- chat: team', '- mail: team') }).problems[0], /is for mail, and chat-app:team-tree is chat's/);
  assert.deepEqual(leaveOutOf({ demo, packs, text: '# Reset: Mail\n' }), { lines: [], rules: [], words: {}, problems: [], skipped: [] });
  // An app the plan never goes to: its lines skipped, never applied (and never refused).
  const mailOnly = leaveOutOf({ demo, packs, text: RESET, apps: new Set(['mail']) });
  assert.deepEqual(mailOnly.rules.map(r => r.id), ['mail-app:hide-sender']);
  assert.deepEqual(Object.keys(mailOnly.words), ['mail']);
  assert.deepEqual(mailOnly.skipped, [{ app: 'chat', what: 'team "Contoso Beta"', from: 'chat-app:team-tree', why: 'the plan never goes to chat' }]);
});

test('leave out\'s negative check: her words in a row, where it is; a removed item by its own text anywhere; a clean screen', () => {
  const page = body => [{ key: 'main', html: `<html><body>${body}</body></html>` }];
  const list = rows => `<ul aria-label="Recent">${rows.map(r => `<li>${r}</li>`).join('')}</ul>`;
  const clean = page(`<h1>Add content</h1>${list(['<span>Quarterly plan</span><span>From: Contoso Finance</span>'])}`);
  assert.deepEqual(leaveHits(clean, { words: ['From: Fabrikam Alerts'], exact: ['Weekly digest'] }), []);
  const leak = leaveHits(page(list(['<span>Weekly digest</span><span>From: Fabrikam Alerts</span>', '<span>Quarterly plan</span>'])), { words: ['From: Fabrikam Alerts'], exact: [] });
  assert.equal(leak.length, 1);
  assert.deepEqual({ ...leak[0] }, { by: 'words', value: 'From: Fabrikam Alerts', frame: 'main', role: 'generic', text: 'From: Fabrikam Alerts', near: 'Weekly digest' });
  // A removed item's own text counts anywhere, a long control's name too; her words don't count in a name of 80 or
  // more (a tree named by everything under it).
  const long = `Teams and channels: Contoso Alpha, Contoso Beta, Northwind Ops, and every channel under them, 14 in all`;
  assert.deepEqual(leaveHits(page(`<div role="tree" aria-label="${long}"><div role="treeitem">Contoso Alpha</div></div>`), { words: ['Contoso Beta'], exact: [] }), []);
  const exact = leaveHits(page(`<button aria-label="Open the mail Weekly digest from last Monday, with its attachments and every reply under it">Open</button>`), { words: [], exact: ['Weekly digest'] });
  assert.equal(exact.length, 1);
  assert.equal(exact[0].by, 'removed');
  assert.equal(exact[0].role, 'button');
});
