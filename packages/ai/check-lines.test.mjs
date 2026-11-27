import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimOf, readClaim, routeTo, checkable, checkValues, rowsAfter, byName } from './check-lines.mjs';
import { parsePlan } from './plan.mjs';
import { parseReset, formatReset } from './reset.mjs';
import { resetSteps } from './make.mjs';
import { undoGroups } from './reset-run.mjs';
import { readScreen, BOX_MAX } from '@scenecast/script/html.mjs';

const PLAN = parsePlan(`# T

## Beat 1 · Tasks

- Go to tasks
  Lands on: tasks-home · "No tasks yet"
- Type "Call Kestrel" in "New task"
  Lands on: tasks-typed · box "New task" says "Call Kestrel"
- Press Enter — ask first
  Writes: adds the task "Call Kestrel" · fixture-tasks:new-task
  Lands on: tasks-saved · "Task saved: Call Kestrel"
- Click "Stats"
  Lands on: tasks-stats · "Task stats"

## Beat 2 · Admin

- Go to admin
  Lands on: admin-home · "Fixture Admin"
- Type "alpha" in "Search tools by name"
- Press Enter
  Lands on: admin-alpha · "alpha-0"
- Click "Overview"
  Lands on: admin-overview · "About this tool"
`);
const PACK = {
  id: 'fixture-tasks',
  writes: [{ id: 'new-task', check: { open: 'http://t/', look: { absent: '{typed}' }, lands: 'Tasks', expect: 'No task the run added.' } },
    { id: 'words', check: { expect: 'Each switch is as the demo starts.' } }],
  effects: [{ id: 'memories', what: 'Notes a run saves', check: { steps: ['Click "Settings"', 'Click "Notes"'], look: { box: 'instructions', equals: '{instructions}' }, expect: 'The instructions are the demo\'s.' } },
    { id: 'sends', what: 'A run can send', check: { steps: ['Click "Send all"'], look: { text: 'Sent' }, expect: 'Sent.' } }],
};
const packs = { forApp: { tasks: PACK, admin: null } };
const ctx = (o = {}) => ({ plan: PLAN, packs, values: { tasks: { typed: ['Call Kestrel'], instructions: 'Be brief.' } }, appIds: ['tasks', 'admin'], ...o });
const line = (app, text, from = null, screen = null) => ({ app, screen, text, from });

test('a Check line\'s claim, in the forms ai reset writes; anything else is no claim', () => {
  assert.deepEqual(claimOf('"Added" lists Sync, Notes and Pins'), { kind: 'list', subject: 'Added', items: ['Sync', 'Notes', 'Pins'] });
  assert.deepEqual(claimOf('Sync tool is version 1.4.9'), { kind: 'version', subject: 'Sync tool', value: '1.4.9' });
  assert.deepEqual(claimOf('"Specific users" is picked (All users | Specific users)'), { kind: 'choice', value: 'Specific users', options: ['All users', 'Specific users'] });
  assert.equal(claimOf('Recent has no task from the run, other than the ones the demo keeps'), null);
});

test('read on the reader\'s screen: pass, wrong, or can\'t (the screen doesn\'t say), never wrong for what it can\'t see', () => {
  const sc = { text: 'Plugins\nSync tool\nVersion 1.4.9', headings: ['Added (4)'], theme: null,
    controls: [{ role: 'switch', name: 'Enable Sync', on: false }, { role: 'switch', name: 'Enable Notes', on: true }, { role: 'button', name: 'Pins, turned off' },
      { role: 'radio', name: 'All users', on: false }, { role: 'radio', name: 'Specific users', on: true }] };
  const r = t => readClaim(claimOf(t), sc).status;
  assert.deepEqual(['"Sync" is off', '"Pins" is off', '"Notes" is off', '"Turbo" is on'].map(r), ['pass', 'pass', 'wrong', 'cant']);
  // A list is what it holds: its heading's count changes with what's in it.
  assert.deepEqual(['"Added (4)" lists Sync and Notes', '"Added (3)" lists Sync and Notes', '"Added" lists Sync'].map(r), ['pass', 'pass', 'wrong']);
  assert.deepEqual(['Sync tool is version 1.4.9', 'Sync tool is version 1.5.0', '"Specific users" is picked (All users | Specific users)', 'renders light'].map(r), ['pass', 'wrong', 'pass', 'cant']);
  // Radios that don't say which is picked: can't.
  assert.equal(readClaim(claimOf('"Specific users" is picked (All users | Specific users)'), { ...sc, controls: [{ role: 'radio', name: 'All users' }, { role: 'radio', name: 'Specific users' }] }).status, 'cant');
});

test('a label\'s rows against the recording\'s: a row it didn\'t have is a leftover; one it had, gone or moved, isn\'t', () => {
  const sc = rows => ({ text: '', controls: [], items: [{ text: 'Home', region: 1 }, { text: 'Recent', region: 1 }, ...rows.map(t => ({ text: t, region: 1 })), { text: 'Other', region: 2 }] });
  const kept = ['Plan A', 'Plan B', 'Plan B'];
  assert.deepEqual(rowsAfter(sc(kept), 'Recent'), kept);
  const r = rows => readClaim({ kind: 'rows', label: 'Recent' }, sc(rows), { kept });
  assert.equal(r(['Plan B', 'Plan A']).status, 'pass');
  assert.deepEqual(r(['Plan A', 'Plan B', 'Plan B', 'Plan B']), { status: 'wrong', why: 'Recent also has "Plan B"' });
  assert.equal(readClaim({ kind: 'rows', label: 'Recent' }, sc(kept), { kept: null }).status, 'cant');
});

test('a box\'s text: read whole up to a bound, and an exact match on one cut there can\'t be decided', () => {
  const page = t => [{ key: 'main', html: `<html><body><label for="i">Custom instructions</label><textarea id="i">${t}</textarea></body></html>` }];
  const short = readScreen(page('Be brief. '.repeat(40)));
  const box = short.controls.find(c => c.name === 'Custom instructions');
  assert.equal(box.value.length, 399);
  assert.equal(box.cut, undefined);
  const eq = text => ({ kind: 'equals', field: 'instructions', text });
  assert.equal(readClaim(eq('Be brief. '.repeat(40)), short).status, 'pass');
  assert.equal(readClaim(eq('Be kind.'), short).status, 'wrong');
  const long = readScreen(page('x'.repeat(BOX_MAX + 10)));
  assert.equal(long.controls.find(c => c.name === 'Custom instructions').cut, true);
  assert.equal(readClaim(eq('x'.repeat(BOX_MAX + 10)), long).status, 'cant');
});

test('a read-only way to a check\'s screen: the plan\'s own navigation (a search too), never through a write', () => {
  assert.deepEqual(routeTo(PLAN, 'tasks', 'tasks-home').route, { home: true, steps: [] });
  assert.match(routeTo(PLAN, 'tasks', 'tasks-stats').why, /passes Press Enter, which writes/);
  const r = routeTo(PLAN, 'admin', 'admin-overview');
  assert.deepEqual(r.route.steps.map(s => s.kind), ['type', 'press', 'click']);
  assert.match(routeTo(PLAN, 'tasks', 'tasks-gone').why, /never lands on tasks-gone/);
});

test('one rule for what can be checked: a claim in a known form on a screen a check gets to, or a pack check with a look', () => {
  assert.equal(checkable(line('tasks', 'shows "No tasks yet"'), ctx()).ok, true);
  assert.match(checkable(line('tasks', 'everything is fine'), ctx()).why, /can't check "everything is fine" on its own/);
  assert.match(checkable(line('tasks', 'shows "Task stats"', null, 'tasks-stats'), ctx()).why, /which writes/);
  // Only a way there or a proof is the plan's doing; a check's own words, values or pack aren't.
  assert.equal(checkable(line('tasks', 'shows "Task stats"', null, 'tasks-stats'), ctx()).plan, true);
  assert.equal(checkable(line('tasks', 'everything is fine'), ctx()).plan, undefined);
  assert.equal(checkable(line('tasks', 'No task the run added', 'beat 1'), ctx({ values: {} })).plan, undefined);
  assert.match(checkable(line('nope', 'shows "x"'), ctx()).why, /which app/);
  // A pack check: its look, the values from the plan (what was typed) and the demo.
  const p = checkable(line('tasks', 'No task the run added', 'beat 1'), ctx());
  assert.deepEqual([p.ok, p.claim, p.route.open, p.route.lands], [true, { kind: 'absent', texts: ['Call Kestrel'] }, 'http://t/', 'Tasks']);
  assert.match(checkable(line('tasks', 'No task the run added', 'beat 1'), ctx({ values: {} })).why, /nothing gives \{typed\}/);
  const e = checkable(line('tasks', 'The instructions are the demo\'s', 'fixture-tasks: memories'), ctx());
  assert.deepEqual([e.ok, e.claim, e.route.steps.map(s => s.target)], [true, { kind: 'equals', field: 'instructions', text: 'Be brief.' }, ['Settings', 'Notes']]);
  // Words only, or a way there that could write: not a check.
  assert.match(checkable(line('tasks', 'Each switch is as the demo starts', 'beat 1, fixture-tasks:words'), ctx()).why, /only words/);
  assert.match(checkable(line('tasks', 'Sent', 'fixture-tasks: sends'), ctx()).why, /could write/);
  // A look that finds nothing needs words that prove its page.
  const noLands = { forApp: { tasks: { ...PACK, writes: [{ id: 'new-task', check: { open: 'http://t/', look: { absent: '{typed}' }, expect: 'No task the run added.' } }] } } };
  assert.match(checkable(line('tasks', 'No task the run added', 'beat 1'), ctx({ packs: noLands })).why, /an empty page would pass/);
});

test('what the plan\'s writes make, by name, from the recording; the demo\'s own values win', () => {
  const walker = { shown: id => id === 'tasks-saved' ? { title: 'Call Kestrel · Tasks', text: '' } : null, screen: () => null };
  const plan = parsePlan('# T\n\n## Beat 1 · A\n\n- Go to tasks\n- Type "Call Kestrel" in "New task"\n- Press Enter\n  Writes: sends it · fixture-tasks:new-task\n  Lands on: tasks-saved · "Task saved"\n');
  assert.deepEqual(checkValues({ plan, walker, cfg: { apps: [{ id: 'tasks', values: { instructions: 'Be brief.' } }] } }), { tasks: { typed: ['Call Kestrel'], task: ['Call Kestrel · Tasks'], instructions: 'Be brief.' } });
});

test('an API undo names what the script made: reset.md keeps the names, the approval lists finding them', () => {
  const text = formatReset({ title: 'T', writes: 1, undo: [{ app: 'tasks', steps: ['Undo with the app pack: fixture-tasks:new-task'], undoes: 'beat 1, Press Enter', note: 'if it can\'t: Click "Delete Call Kestrel"', names: ['Call Kestrel'] }], checks: [], needs: [{ kind: 'check', text: 'Check "tasks: x" can\'t be checked by a run: why' }] });
  assert.match(text, /\n {2}Names: "Call Kestrel"\n/);
  assert.match(text, /## Needs you\n\n- Check "tasks: x"/);
  assert.deepEqual(undoGroups(text)[0].names, ['Call Kestrel']);
  assert.deepEqual(parseReset(text).undo.beats[0].steps.map(s => s.text), ['Go to tasks', 'Undo with the app pack: fixture-tasks:new-task']);
  assert.ok(resetSteps(text).some(r => r.text === 'Find by name: "Call Kestrel"' && r.byName[0] === 'Call Kestrel'));
});

test('found by name: only the script\'s own names, never one the recording\'s start screen shows', () => {
  const start = { text: 'Recent\nWeekly plan\nTry these next', items: [{ text: 'Weekly plan' }] };
  assert.deepEqual(byName(['Kestrel summary', 'Weekly plan'], start), { mine: ['Kestrel summary'], kept: ['Weekly plan'] });
  assert.deepEqual(byName(['Kestrel summary'], null), { mine: ['Kestrel summary'], kept: [] });
});

test('a check\'s way there starts from the recording\'s own start screen when the plan names it otherwise', () => {
  const walker = { start: () => 'tasks-start', screen: id => id === 'tasks-start' ? { controls: [{ name: 'Refresh' }] } : null, shown: () => null };
  const plan = parsePlan('# T\n\n## Beat 1 · A\n\n- Go to tasks\n  Lands on: tasks-home · "No tasks yet"\n- Press Enter\n  Writes: adds it · fixture-tasks:new-task\n\n## Beat 2 · B\n\n- Go to tasks\n- Click "Refresh"\n  Lands on: tasks-fresh · "Up to date"\n');
  assert.deepEqual(routeTo(plan, 'tasks', 'tasks-fresh', { walker }).route.steps.map(s => s.target), ['Refresh']);
  assert.match(routeTo(plan, 'tasks', 'tasks-fresh').why, /which writes/);
});

test('a route never starts at a row of a list that says it has more rows than it shows: it takes the plan\'s search', () => {
  const plan = parsePlan('# T\n\n## Beat 1 · Tools\n\n- Go to admin\n  Lands on: admin-home · "Fixture Admin"\n- Type "echo" in "Search tools by name"\n- Press Enter\n  Lands on: admin-echo · "echo-4"\n- Click "echo-4"\n  Lands on: admin-tool · "Close details"\n');
  // The recorded start screen rendered the row; a virtualized grid (301 rows, a few shown) may not today.
  const start = said => ({ controls: [{ name: 'Search tools by name', role: 'searchbox' }, { name: 'alpha-0', role: 'row', list: 7, row: 8 }, { name: 'echo-4', role: 'row', list: 7, row: 9 }],
    items: [{ text: 'alpha-0', list: 7, row: 8 }, { text: 'echo-4', list: 7, row: 9 }], lists: { 7: ['Tools', 'grid', said] } });
  const walker = said => ({ start: () => 'admin-home', screen: id => id === 'admin-home' ? start(said) : null, shown: () => null });
  assert.deepEqual(routeTo(plan, 'admin', 'admin-tool', { walker: walker(301) }).route.steps.map(s => s.kind), ['type', 'press', 'click']);
  // A list that says nothing of its size (or shows all it says): its row starts a route.
  assert.deepEqual(routeTo(plan, 'admin', 'admin-tool', { walker: walker(null) }).route.steps.map(s => s.kind), ['click']);
  assert.deepEqual(routeTo(plan, 'admin', 'admin-tool', { walker: walker(2) }).route.steps.map(s => s.kind), ['click']);
});
