#!/usr/bin/env node
// StuntDouble's packages as npm tarballs, for a demo outside this repository while @stuntdouble isn't published:
// every @stuntdouble package, plus the binary for this OS and CPU (target/release/stuntdouble, built if missing).
//   node scripts/stuntdouble-pack.mjs [--out <dir>]             tarballs into <dir> (default target/stuntdouble-pack)
//   node scripts/stuntdouble-pack.mjs --into <demo>             …into <demo>/vendor/stuntdouble, and <demo>/package.json
//                                                               depends on them (file:), replacing an older set
// Then, in the demo: npm install (gh detour run -- npm install on a managed laptop), and npx stunt …
// --binary <file> --platform <os-cpu> packs a binary built elsewhere (a Windows one from CI) instead of this machine's.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = k => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
const INTO = opt('--into') && resolve(opt('--into'));
const OUT = INTO ? join(INTO, 'vendor', 'stuntdouble') : resolve(opt('--out') || join(ROOT, 'target', 'stuntdouble-pack'));
const PACKAGES = ['core', 'capture', 'player', 'checks', 'format', 'apps', 'build', 'cli'];
const PLATFORM = opt('--platform') || `${process.platform}-${process.arch}`;
const [OS, CPU] = PLATFORM.split('-');
const EXE = OS === 'win32' ? 'stuntdouble.exe' : 'stuntdouble';
const npm = (args, cwd) => execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' }).trim().split('\n').pop();

let binary = opt('--binary') && resolve(opt('--binary'));
if (!binary) {
  binary = join(ROOT, 'target', 'release', EXE);
  if (!existsSync(binary)) execFileSync('cargo', ['build', '--release', '-p', 'stuntdouble-cli'], { cwd: ROOT, stdio: 'inherit' });
}
const version = JSON.parse(readFileSync(join(ROOT, 'packages', 'core', 'package.json'), 'utf8')).version;
mkdirSync(OUT, { recursive: true });
// A new set replaces the old one: every tarball but another platform's binary of this same version (one packed with
// --platform), which stays.
const isBin = f => /^stuntdouble-build-[a-z0-9]+-[a-z0-9]+-/.test(f);
for (const f of readdirSync(OUT)) {
  if (!/^stuntdouble-.*\.tgz$/.test(f)) continue;
  const keep = isBin(f) ? !f.startsWith(`stuntdouble-build-${PLATFORM}-`) && f.endsWith(`-${version}.tgz`) : !!opt('--platform');
  if (!keep) rmSync(join(OUT, f));
}
const made = [];
if (!opt('--platform')) for (const p of PACKAGES) made.push(npm(['pack', '--silent', '--pack-destination', OUT], join(ROOT, 'packages', p)));
// The binary's own package, as @stuntdouble/build finds it: @stuntdouble/build-<os>-<cpu>/bin/stuntdouble.
const plat = mkdtempSync(join(tmpdir(), 'stuntdouble-bin-'));
mkdirSync(join(plat, 'bin'));
copyFileSync(binary, join(plat, 'bin', EXE));
chmodSync(join(plat, 'bin', EXE), 0o755);
writeFileSync(join(plat, 'package.json'), JSON.stringify({ name: `@stuntdouble/build-${PLATFORM}`, version, description: `The stuntdouble binary for ${OS} ${CPU}.`, os: [OS], cpu: [CPU], files: ['bin/'], license: 'MIT', preferUnplugged: true }, null, 2) + '\n');
made.push(npm(['pack', '--silent', '--pack-destination', OUT], plat));
rmSync(plat, { recursive: true, force: true });
console.log(`StuntDouble ${version}: ${made.length} tarball(s) in ${OUT}`);

if (INTO) {
  const f = join(INTO, 'package.json');
  const pkg = JSON.parse(readFileSync(f, 'utf8'));
  const rel = t => 'file:' + relative(INTO, join(OUT, t)).split('\\').join('/');
  const tars = readdirSync(OUT).filter(t => t.endsWith('.tgz'));
  const tarOf = name => tars.find(t => t === `${name.replace('@', '').replace('/', '-')}-${version}.tgz`);
  for (const k of ['dependencies', 'optionalDependencies']) for (const d of Object.keys(pkg[k] || {})) if (d.startsWith('@stuntdouble/')) delete pkg[k][d];
  pkg.dependencies = pkg.dependencies || {};
  for (const p of PACKAGES) pkg.dependencies[`@stuntdouble/${p}`] = rel(tarOf(`@stuntdouble/${p}`));
  pkg.optionalDependencies = pkg.optionalDependencies || {};
  for (const t of tars.filter(isBin)) pkg.optionalDependencies[t.replace(/^stuntdouble-(build-[a-z0-9]+-[a-z0-9]+)-.*$/, '@stuntdouble/$1')] = rel(t);
  writeFileSync(f, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`${f}: depends on StuntDouble ${version} (vendor/stuntdouble). Now: npm install`);
}
