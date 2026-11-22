// The stuntdouble binary (Rust: the format, the build, the CLI) for this OS and CPU. In order:
//   STUNTDOUBLE_BINARY                     a binary you built yourself
//   @stuntdouble/build-<os>-<cpu>          the prebuilt one, an optional dependency of this package (esbuild-style)
//   target/{release,debug}/stuntdouble     this repository's own build, when running from a checkout
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64'];
export const EXE = process.platform === 'win32' ? 'stuntdouble.exe' : 'stuntdouble';
export const platformPackage = (key = `${process.platform}-${process.arch}`) => `@stuntdouble/build-${key}`;

export function binaryPath() {
  if (process.env.STUNTDOUBLE_BINARY) return process.env.STUNTDOUBLE_BINARY;
  const key = `${process.platform}-${process.arch}`;
  try {
    const bin = join(dirname(require.resolve(platformPackage(key) + '/package.json')), 'bin', EXE);
    if (existsSync(bin)) return bin;
  } catch (e) {}
  // A checkout: the binary cargo built, next to packages/.
  for (let d = dirname(fileURLToPath(import.meta.url)), i = 0; i < 6; i++, d = dirname(d)) {
    for (const p of ['release', 'debug']) { const bin = join(d, 'target', p, EXE); if (existsSync(bin)) return bin; }
  }
  if (!PLATFORMS.includes(key)) throw new Error(`StuntDouble has no prebuilt binary for ${key}: build it (cargo build --release -p stuntdouble-cli) and set STUNTDOUBLE_BINARY`);
  throw new Error(`${platformPackage(key)} isn't installed. It's an optional dependency of @stuntdouble/build: install again without --omit=optional, or build the binary (cargo build --release -p stuntdouble-cli) and set STUNTDOUBLE_BINARY.`);
}
