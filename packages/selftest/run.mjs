// npm test: the unit tests, the extension in branded Chrome and Edge, the capture test and the end-to-end selftest, on macOS, Windows and Linux. Builds the
// scenecast binary first unless SCENECAST_BIN points at one.
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const step = (name, cmd, args) => {
  console.log(`\n== ${name}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) { console.log(`${name} failed`); process.exit(r.status || 1); }
};
if (!process.env.SCENECAST_BIN) step('cargo build', 'cargo', ['build', '-q', '-p', 'scenecast-cli']);
step('unit', process.execPath, ['--test', 'packages/player/bundle-flow.test.mjs', 'packages/player/launch.test.mjs', 'packages/player/presenter-key.test.mjs', 'packages/player/serve.test.mjs', 'packages/checks/path.test.mjs', 'packages/kit/compile/flow.test.mjs', 'packages/kit/lib/preflight.test.mjs']);
step('browsers', process.execPath, ['packages/selftest/extension-browsers.mjs']);
step('capture', process.execPath, ['packages/selftest/capture-fixture.mjs']);
step('selftest', process.execPath, ['packages/selftest/selftest.mjs']);
