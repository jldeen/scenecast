// npm test: the unit tests, the extension in branded Chrome and Edge, the capture test, the end-to-end selftest and the
// three AI modes (ai-modes.mjs, on the stand-in model), on macOS, Windows and Linux. Builds the
// scenecast binary first unless SCENECAST_BIN points at one.
import './reap.mjs';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const step = (name, cmd, args) => {
  console.log(`\n== ${name}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) { console.log(`${name} failed`); process.exit(r.status || 1); }
};
if (!process.env.SCENECAST_BIN) step('cargo build', 'cargo', ['build', '-q', '-p', 'stuntdouble-cli']);
// The unit tests are package.json's test:unit list, so the two can't drift apart.
const units = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts['test:unit'].split(/\s+/).filter(a => a.endsWith('.test.mjs'));
step('unit', process.execPath, ['--test', ...units]);
step('asset build', process.execPath, ['packages/selftest/asset-build.mjs']);
step('mixed fallback', process.execPath, ['packages/selftest/mixed-fallback.mjs']);
step('browsers', process.execPath, ['packages/selftest/extension-browsers.mjs']);
step('capture', process.execPath, ['packages/selftest/capture-fixture.mjs']);
step('two recorders', process.execPath, ['packages/selftest/two-recorders.mjs']);
step('real tabs', process.execPath, ['packages/selftest/real-tabs.mjs']);
step('redirected tab', process.execPath, ['packages/selftest/redirect-tab.mjs']);
step('pause and go on', process.execPath, ['packages/selftest/pause-go-on.mjs']);
step('selftest', process.execPath, ['packages/selftest/selftest.mjs']);
step('fidelity loop', process.execPath, ['packages/selftest/fidelity-loop.mjs']);
step('real Chrome checker', process.execPath, ['packages/selftest/real-chrome-checker.mjs']);
step('capture browser', process.execPath, ['packages/selftest/capture-browser.mjs']);
step('ai modes', process.execPath, ['packages/selftest/ai-modes.mjs']);
