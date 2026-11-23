// The in-app update, end to end on this machine: version N installed, N+1's signed update served locally, the app
// asked to update (the same code as its Update button, through its test hook), then: it relaunches on N+1, and the
// demos are still there. Unsigned builds (no Developer ID, no Authenticode): the updater's own signature is checked.
//   node apps/desktop/tests/update.test.mjs <old: Scenecast.app (macOS) | *-setup.exe (Windows)> <new update dir> <new version>
// The new update dir holds the N+1 update file and its .sig (macOS *.app.tar.gz, Windows *-setup.exe), signed with
// the key whose public half both builds have; the app reads latest.json from SCENECAST_UPDATE_URL.
import { execFileSync, spawn } from 'node:child_process';
import { realpathSync, cpSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAC = process.platform === 'darwin', WIN = process.platform === 'win32';
const [oldPath, newDir, newVersion] = process.argv.slice(2).map((a, i) => i < 2 ? resolve(a) : a);
if (!oldPath || !newDir || !newVersion) { console.log('usage: update.test.mjs <old app or installer> <new update dir> <new version>'); process.exit(2); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fails = [];
const check = (name, ok, detail) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? `: ${String(detail).slice(0, 1500)}` : '')); if (!ok) fails.push(name); return ok; };
async function waitFor(what, fn, ms = 60000, every = 500) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = e.message; } await sleep(every); }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last)}`);
}
// The real path: macOS's temp folder is under /var, a symlink, and the updater won't run an app from there.
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'scenecast-update-')));
const HOOK = join(tmp, 'hook'), LIB = join(tmp, 'Scenecast'), PORT = 47811;
let n = 0;
async function hook(action, args = {}, ms = 120000) {
  const name = `r${++n}`;
  mkdirSync(HOOK, { recursive: true });
  writeFileSync(join(HOOK, `${name}.tmp`), JSON.stringify({ action, ...args }));
  renameSync(join(HOOK, `${name}.tmp`), join(HOOK, `${name}.request.json`));
  const f = join(HOOK, `${name}.response.json`);
  return waitFor(`the app's answer to ${action}`, () => existsSync(f) && JSON.parse(readFileSync(f, 'utf8')), ms, 250);
}

let appDir, exe;
function install() {
  if (MAC) {
    appDir = join(tmp, 'Applications', 'Scenecast.app');
    cpSync(oldPath, appDir, { recursive: true, verbatimSymlinks: true });
    const bin = join(appDir, 'Contents', 'MacOS');
    exe = join(bin, readdirSync(bin)[0]);
  } else {
    execFileSync(oldPath, ['/S'], { stdio: 'inherit' });
    appDir = join(process.env.LOCALAPPDATA, 'Scenecast');
    exe = join(appDir, readdirSync(appDir).find(f => /\.exe$/i.test(f) && !/uninstall/i.test(f)));
  }
}
const installedVersion = () => MAC
  ? execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(appDir, 'Contents', 'Info.plist')]).toString().trim()
  : execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Item '${exe}').VersionInfo.ProductVersion`]).toString().trim();

const server = createServer((req, res) => {
  const f = join(newDir, decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1)));
  if (!f.startsWith(newDir) || !existsSync(f) || !statSync(f).isFile()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-length': statSync(f).size });
  createReadStream(f).pipe(res);
}).listen(PORT, '127.0.0.1');

let app;
try {
  install();
  const before = installedVersion();
  check(`version N installed (${before})`, before && before !== newVersion, before);
  execFileSync(process.execPath, [join(HERE, '..', 'scripts', 'latest-json.mjs'), newDir, newVersion, `http://127.0.0.1:${PORT}/`], { stdio: 'inherit' });
  const env = { ...process.env, SCENECAST_LIBRARY: LIB, SCENECAST_SELFTEST: HOOK, SCENECAST_UPDATE_URL: `http://127.0.0.1:${PORT}/latest.json` };
  app = spawn(exe, [], { env, stdio: 'ignore', detached: !WIN });
  const v0 = await hook('version', {}, 90000);
  check('the installed app runs version N', v0.ok && v0.value.version === before, JSON.stringify(v0));
  const made = await hook('create', { spec: { title: 'Kept demo', apps: [{ id: 'chat', url: 'http://127.0.0.1:47801/' }] } });
  check('a demo in the library before the update', made.ok, JSON.stringify(made));
  const c = await hook('update-check');
  check(`Check for updates finds ${newVersion}`, c.ok && c.value.available === newVersion, JSON.stringify(c));
  const u = await hook('update-install', {}, 300000);
  check('Update: downloads, checks its signature, installs', u.ok && u.value === 'restarting', JSON.stringify(u));
  // Windows: the installer relaunches the app as the signed-in user (through Explorer), so it runs without this
  // test's environment and can't answer the hook. See that it came back on its own, then start it again with the
  // test's environment to ask it.
  if (WIN) {
    const procs = () => { try { return JSON.parse(execFileSync('powershell', ['-NoProfile', '-Command', `@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${exe.replace(/'/g, "''")}' } | Select-Object ProcessId) | ConvertTo-Json -Compress`]).toString() || '[]'); } catch { return []; } };
    const back = await waitFor('the installer to relaunch Scenecast', () => { const p = [].concat(procs()).map(x => x.ProcessId).filter(id => id !== v0.value.pid); return p.length && p; }, 240000, 2000).catch(e => ({ error: e.message }));
    check('the update relaunched the app', Array.isArray(back), JSON.stringify(back));
    if (Array.isArray(back)) for (const pid of back) try { process.kill(pid); } catch { /* gone */ }
    await sleep(2000);
    app = spawn(exe, [], { env, stdio: 'ignore' });
  }
  // The new version answers the hook (relaunched by the update with the same environment, or started again above).
  const v1 = await waitFor(`Scenecast ${newVersion} to come back`, async () => {
    const r = await hook('version', {}, 15000).catch(() => null);
    return r && r.ok && r.value.version === newVersion && r;
  }, 240000, 1000).catch(e => ({ error: e.message }));
  check(`relaunched on ${newVersion}`, v1.ok && v1.value.pid !== v0.value.pid, JSON.stringify(v1));
  // The test feed doesn't outlive this run: the app the update relaunched checks the release feed (tauri.conf.json).
  if (!WIN) check('after the update, the release feed (the test feed isn\'t passed on)', v1.ok && v1.value.testFeed == null, JSON.stringify(v1.value || v1));
  check(`the installed app is ${newVersion}`, installedVersion() === newVersion, installedVersion());
  check('the demo is still there', existsSync(join(LIB, made.value.id, 'demo.json')));
  if (v1.value?.pid) try { process.kill(v1.value.pid); } catch { /* gone */ }
} catch (e) {
  check('ran', false, e.stack || e);
} finally {
  try { app?.kill(); } catch { /* gone */ }
  server.close();
  if (!process.env.SCENECAST_KEEP) rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
}
console.log(fails.length ? `${fails.length} FAILED` : 'ALL PASS');
process.exit(fails.length ? 1 : 0);
