import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extensionIn } from './profiles.mjs';

const profile = settings => {
  const dir = mkdtempSync(join(tmpdir(), 'profile-'));
  writeFileSync(join(dir, 'Preferences'), JSON.stringify({ extensions: { settings, ui: { developer_mode: false } } }));
  return dir;
};

test('the recorder loaded from its folder, or added from a store by its ID', () => {
  const dir = '/Users/x/Documents/Scenecast/Recorder Extension';
  const loaded = profile({ abc: { path: dir, state: 1 } });
  assert.deepEqual(extensionIn(loaded, [dir], []), { id: 'abc', path: dir, enabled: true, devMode: false });
  const store = profile({ storeid: { path: 'storeid/0.5.0_0', state: 1 }, other: { path: 'other/1.0_0' } });
  assert.equal(extensionIn(store, [dir], []).id, null, 'unknown until the store ID is known');
  assert.equal(extensionIn(store, [dir], ['storeid']).id, 'storeid');
  assert.equal(extensionIn(profile({ storeid: { path: 'storeid/0.5.0_0', disable_reasons: [1] } }), [dir], ['storeid']).enabled, false);
});
