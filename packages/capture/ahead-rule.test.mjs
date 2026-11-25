import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { aheadFits } = new Function(readFileSync(new URL('./ahead-rule.js', import.meta.url), 'utf8') + '\nreturn { aheadTodo, aheadFits };')();
const c = (sel, text) => ({ sel, text });
const cands = [c('button', 'Done'), c('button', 'Overdue'), c('a', 'Help'), c('li', 'Row')];
const swept = keys => ({ hovers: { keys, waitMs: 900, n: 1, tried: keys.length } });

test('a twin that tried exactly what the screen would try now is used', () => {
  const r = aheadFits(swept(['button|Done', 'button|Overdue', 'a|Help']), { cands, seen: ['li|Row'], waitMs: 900 });
  assert.equal(r.hovers, true);
});

test('a control hovered on another screen since makes it a miss (the run hovers it there, not here)', () => {
  const r = aheadFits(swept(['button|Done', 'button|Overdue', 'a|Help']), { cands, seen: ['li|Row', 'a|Help'], waitMs: 900 });
  assert.equal(r.hovers, false);
  assert.match(r.why[0], /3 tried ahead, 2 to try/);
});

test('max, kinds that never show and the hover wait are as the run would use them now', () => {
  assert.equal(aheadFits(swept(['button|Done', 'button|Overdue']), { cands, max: 2, waitMs: 900 }).hovers, true);
  assert.equal(aheadFits(swept(['a|Help', 'li|Row']), { cands, skipSels: ['button'], waitMs: 900 }).hovers, true);
  const r = aheadFits(swept(['button|Done', 'button|Overdue']), { cands, max: 2, waitMs: 600 });
  assert.equal(r.hovers, false);
  assert.match(r.why[0], /waited 900 ms/);
});

test('hovers stopped part way are never used', () => {
  const r = aheadFits({ hovers: { keys: [], stopped: true, waitMs: 900 } }, { cands: [], waitMs: 900 });
  assert.equal(r.hovers, false);
  assert.match(r.why[0], /the answer ended/);
});

test('zoom: only a complete run, for this kind of screen, while the kind is still new', () => {
  const z = (complete, kind = '/audit|main') => ({ hovers: { keys: [], waitMs: 900 }, zoom: { kind, complete, entries: [] } });
  const now = { cands: [], waitMs: 900, kind: '/audit|main', newKind: true };
  assert.equal(aheadFits(z(true), now).zoom, true);
  assert.equal(aheadFits(z(false), now).zoom, false);
  assert.equal(aheadFits(z(true), { ...now, newKind: false }).zoom, false);
  assert.equal(aheadFits(z(true, '/|main'), now).zoom, false);
});
