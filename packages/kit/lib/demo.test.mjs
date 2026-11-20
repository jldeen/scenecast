import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordOpts } from './demo.mjs';

test('a demo made before 0.4.3 gets the recorder\'s side-path budget, not its template\'s 240 s a screen', () => {
  const old = { record: { settleMs: 2500, auto: { maxS: 240, hoverMax: 40, clickMax: 25 } } };
  assert.deepEqual(recordOpts(old), { settleMs: 2500, auto: { hoverMax: 40, clickMax: 25 } });
  assert.equal(old.record.auto.maxS, 240, 'the demo itself is left as it is');
});

test('a budget the presenter set is kept', () => {
  assert.deepEqual(recordOpts({ record: { auto: { maxS: 60, hoverMax: 40, clickMax: 25 } } }).auto.maxS, 60);
  assert.deepEqual(recordOpts({ record: { auto: { maxS: 240, zoom: false } } }).auto, { maxS: 240, zoom: false });
  assert.deepEqual(recordOpts({}), {});
});
