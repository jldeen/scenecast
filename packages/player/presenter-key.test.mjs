import test from 'node:test';
import assert from 'node:assert/strict';
import { presenterKey } from './app/presenter-key.js';

const event = (altKey, ctrlKey = false, metaKey = false, shiftKey = false) => ({ altKey, ctrlKey, metaKey, shiftKey });

test('Windows presenter shortcuts require Ctrl+Alt, including reverse focus', () => {
  assert.equal(presenterKey(event(true), 'Windows'), false);
  assert.equal(presenterKey(event(true, true), 'Win32'), true);
  assert.equal(presenterKey(event(true, true, false, true), 'Windows'), true);
  assert.equal(presenterKey(event(true, true, true), 'Windows'), false);
});

test('macOS presenter shortcuts accept Option but not Command', () => {
  assert.equal(presenterKey(event(true), 'macOS'), true);
  assert.equal(presenterKey(event(true, false, false, true), 'MacIntel'), true);
  assert.equal(presenterKey(event(true, false, true), 'MacIntel'), false);
  assert.equal(presenterKey(event(false, true), 'MacIntel'), false);
});
