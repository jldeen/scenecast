// The fence a selftest puts around the engine: the app's receivers and a presenter's folders are out of reach.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fencePort, fencePath } from './test-fence.mjs';
import { send } from '@stuntdouble/capture/cli.mjs';
import { buildExtension } from '@stuntdouble/capture/build.mjs';

test('in a selftest: never the app\'s receivers, never a folder outside the test\'s own', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'fence-'));
  const env = { SCENECAST_SELFTEST: tmp };
  assert.throws(() => fencePort(47621, 'receiver', env), /app's receivers/);
  assert.doesNotThrow(() => fencePort(47741, 'receiver', env));
  // A recorder looks on its port and the nine after it.
  assert.throws(() => fencePort(47612, 'extension', env), /app's receivers/);
  assert.doesNotThrow(() => fencePort(47611, 'extension', env));
  assert.doesNotThrow(() => fencePath(join(tmp, 'demo', 'raw'), 'raw folder', env));
  assert.throws(() => fencePath(join(homedir(), 'Documents', 'Scenecast', 'a-demo'), 'demo', env), /own folders/);
  // Outside a selftest it does nothing.
  assert.doesNotThrow(() => fencePort(47621, 'receiver', {}));
  process.env.SCENECAST_SELFTEST = tmp;
  try {
    await assert.rejects(send({ op: 'recordStatus' }, 1, 47621), /app's receivers/);
    assert.throws(() => buildExtension(join(tmp, 'ext'), 47621), /app's receivers/);
    assert.throws(() => buildExtension(join(homedir(), 'Documents', 'Scenecast', 'Recorder Extension'), 47741), /own folders/);
  } finally { delete process.env.SCENECAST_SELFTEST; }
});
