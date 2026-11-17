import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const runPath = new Function(readFileSync(new URL('./path.js', import.meta.url), 'utf8') + '\nreturn runPath;')();

test('recorded paths use the Windows presenter modifier', async () => {
  const keys = [];
  const page = {
    viewportSize: () => ({ width: 1200, height: 800 }),
    evaluate: async fn => fn.toString().includes('userAgentData') ? 'Windows' : undefined,
    keyboard: { press: async key => keys.push(key) },
    mouse: { move: async () => {} },
    waitForFunction: async () => {},
  };
  await runPath(page, { apps: [{ id: 'admin', key: 'A' }], path: [{ app: 'admin' }] }, { speed: 10 });
  assert.deepEqual(keys, ['Control+Alt+Digit0', 'Control+Alt+KeyA']);
});
