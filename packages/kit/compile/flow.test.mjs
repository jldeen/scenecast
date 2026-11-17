import test from 'node:test';
import assert from 'node:assert/strict';
import { validate } from './flow.mjs';

test('app shortcuts cannot collide with focus, next or fill', () => {
  const flow = key => ({
    apps: [{ id: 'app', key }],
    states: { start: { app: 'app', snap: 'start' } },
    beats: [{ active: 'app', states: { app: 'start' } }],
  });
  for (const key of ['F', 'f', 'N', 'P', '1', '?']) {
    assert.ok(validate(flow(key)).some(p => p.startsWith('app key')), key);
  }
  assert.deepEqual(validate(flow('A')), []);
});
