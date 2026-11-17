import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScript } from './parse.mjs';
import { words, facts, align, pickItems, textMatcher } from './match.mjs';
import { applyEditorOverrides, checkFocusJson, checkEditorOverrides } from '../kit/lib/overrides.mjs';
import { stateSequence, beatPositions, beatAt, orderFocus } from '../player/app/focus-order.js';

test('Markdown: headings are beats, quotes are lines, Do: is the line\'s cue', () => {
  const s = parseScript('# Demo\n\nnotes here\n\n## Beat 1 · Open\n\n> Hello there,\n> everyone.\n\n**Do:** Start (⌥0).\n\n> Second line.\n\n## Money\n> It costs $5.\n');
  assert.equal(s.title, 'Demo');
  assert.deepEqual(s.beats.map(b => b.title), ['Open', 'Money']);
  assert.deepEqual(s.lines.map(l => [l.id, l.text, l.cue]), [['1.1', 'Hello there, everyone.', 'Start (⌥0).'], ['1.2', 'Second line.', ''], ['2.1', 'It costs $5.', '']]);
});

test('plain text: one line per line, beats optional', () => {
  assert.deepEqual(parseScript('First thing.\n\n- Second thing.\n').lines.map(l => [l.id, l.text]), [['1', 'First thing.'], ['2', 'Second thing.']]);
  const s = parseScript('Beat 1: Start\nOne.\nBeat 2\nTwo.\n', 'x.txt');
  assert.deepEqual(s.lines.map(l => l.id), ['1.1', '2.1']);
});

test('RunLines: a row is a beat, each narrative line a line', () => {
  const s = parseScript(JSON.stringify({ title: 'T', rows: [{ narrative: 'a one\nb two', demo_actions: '[OPEN] cue' }, { narrative: 'c three', demo_actions: '' }] }), 'x.sk');
  assert.deepEqual(s.lines.map(l => [l.id, l.text]), [['1.1', 'a one'], ['1.2', 'b two'], ['2.1', 'c three']]);
  assert.equal(s.beats[0].title, 'OPEN');
});

test('words: stems, numbers and codes; facts: numbers and names, not sentence starts', () => {
  assert.deepEqual(words('Orders moved by $35,073 on PO-450101 in November'), ['order', 'mov', '35073', 'po-450101', 'nov']);
  assert.deepEqual(words('approved'), words('approve'));
  assert.deepEqual(facts('Then Kestrel pays $1,200 for alpha-6. Brightline agreed.').map(f => f.text), ['Kestrel', '$1,200', 'alpha-6']);
});

test('align: lines keep their order, and a line nothing backs stays on the screen before it', () => {
  // 3 places; line 0 fits place 1, line 1 fits nothing, line 2 fits place 0 better than 2 (but can't go back).
  assert.deepEqual(align([[0, 5, 0], [0, 0, 0], [6, 0, 4]], 3), [1, 1, 2]);
  assert.deepEqual(align([[0, 0, 0]], 3), [0]);
});

test('picks: the best item first, others only for new words, never one inside another', () => {
  const screen = { items: [
    { i: 0, kind: 'text', role: 'paragraph', text: 'Kestrel moved the ship date by six days. Two builds are at risk.', box: [0, 0, 500, 40] },
    { i: 1, kind: 'text', role: 'generic', text: 'six days', box: [100, 0, 160, 20] },
    { i: 2, kind: 'control', role: 'button', text: 'Share', box: [600, 0, 650, 20] },
    { i: 3, kind: 'text', role: 'generic', text: 'Unrelated footer', box: [0, 900, 100, 920] },
  ] };
  const w = () => 3;
  const picks = pickItems(words('Kestrel moved it by six days, and I can share it.'), screen, w);
  assert.deepEqual(picks.map(p => [p.item, p.phrase || null]), [[0, 'Kestrel moved the ship date by six days.'], [2, null]]);
});

test('the text matcher puts lines on screens in order and flags unbacked lines and missing facts', async () => {
  const sc = (state, texts) => ({ state, items: texts.map((t, i) => ({ i, kind: 'text', role: 'heading', text: t, box: [0, i * 30, 200, i * 30 + 20] })) });
  const screens = { a: sc('a', ['Welcome', 'Inbox']), b: sc('b', ['Quarterly revenue grew 12%', 'Inbox']), c: sc('c', ['Settings and privacy', 'Inbox']) };
  const sequence = [{ state: 'a' }, { state: 'b' }, { state: 'c' }];
  const lines = [{ text: 'Good morning.' }, { text: 'Revenue grew 12% this quarter.' }, { text: 'Privacy settings live here, approved by Contoso.' }];
  const r = await textMatcher.match({ lines, screens, sequence });
  assert.deepEqual(r.map(x => [x.pos, x.picks.length]), [[0, 0], [1, 1], [2, 1]]);
  assert.deepEqual(r[2].missing, ['Contoso']);
});

test('editor overrides: checked, then edits added and beat starts set', () => {
  assert.deepEqual(checkEditorOverrides({ edits: [{ replace: ['Nov 12', 'Nov 19'] }], beats: { 2: { active: 'chat', states: { chat: 'b' } } } }), []);
  assert.equal(checkEditorOverrides({ edits: [{ remove: 'x' }], beats: { 12: {} } }).length, 3);
  const flow = { edits: [{ remove: 'old' }], beats: [{ active: 'chat', states: { chat: 'a', admin: 'x' } }, { active: 'chat', label: '1 start', states: { chat: 'a', admin: 'x' } }] };
  applyEditorOverrides(flow, { edits: [{ replace: ['Nov 12', 'Nov 19'] }], beats: { 1: { active: 'admin', states: { admin: 'y' } }, 2: { active: 'chat', states: { chat: 'c' } } } });
  assert.deepEqual(flow.edits, [{ remove: 'old' }, { replace: ['Nov 12', 'Nov 19'] }]);
  assert.deepEqual(flow.beats[1], { active: 'admin', label: '1 start', states: { chat: 'a', admin: 'y' } });
  assert.deepEqual(flow.beats[2].states, { chat: 'c', admin: 'y' });
  assert.deepEqual(checkFocusJson({ points: [{ id: 'a', beat: 1, app: 'chat', states: ['s'], find: 'x' }, { id: 'a', beat: 11, app: 'chat', states: [], union: [{ evil: 1 }] }] }).length, 4);
});

test('focus order: by beat, then where the screen comes in the run-through, keeping order on a screen', () => {
  const flow = { states: { a: { app: 'x' }, b: { app: 'x' }, c: { app: 'x' } }, beats: [{ active: 'x', states: { x: 'a' } }, { active: 'x', states: { x: 'b' } }], path: [{ checkpoint: 'a' }, { checkpoint: 'b' }, { checkpoint: 'c' }, { checkpoint: 'b' }] };
  const seq = stateSequence(flow);
  assert.deepEqual(seq.map(s => s.state), ['a', 'b', 'c', 'b']);
  assert.deepEqual(beatPositions(flow, seq), [0, 1]);
  assert.equal(beatAt(2, [0, 1]), 1);
  const pts = [{ id: 'c1', beat: 1, states: ['c'] }, { id: 'b1', beat: 1, states: ['b'] }, { id: 'a0', beat: 0, states: ['a'] }, { id: 'b2', beat: 1, states: ['b'] }];
  assert.deepEqual(orderFocus(pts, flow).map(p => p.id), ['a0', 'b1', 'b2', 'c1']);
});
