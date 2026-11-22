// A file in another of the engine's packages, wherever the packages are: side by side (this repository, the desktop
// app's bundle, an npm install of @stuntdouble/*), else found the way Node finds a package (Scenecast's @scenecast/ai,
// script and editor next to an npm install). at('player', 'serve.mjs') or at('player/serve.mjs').
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// The folder that holds core/: packages/ in this repository, node_modules/@stuntdouble in an install.
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SCOPE = {"core":"@stuntdouble","capture":"@stuntdouble","player":"@stuntdouble","checks":"@stuntdouble","format":"@stuntdouble","apps":"@stuntdouble","build":"@stuntdouble","cli":"@stuntdouble","ai":"@scenecast","script":"@scenecast","editor":"@scenecast"};
const roots = new Map();
const nameOf = dir => { try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name; } catch (e) { return null; } };
// A package's folder by its short name (player, ai, …), or null when it isn't there.
export function root(name) {
  if (roots.has(name)) return roots.get(name);
  const full = (SCOPE[name] || '@stuntdouble') + '/' + name;
  let dir = join(ROOT, name);
  if (nameOf(dir) !== full) { dir = null; try { dir = dirname(require.resolve(full + '/package.json')); } catch (e) {} }
  roots.set(name, dir);
  return dir;
}
const split = parts => parts.join('/').split(/[\\/]/).filter(Boolean);
export const has = name => !!root(name);
export function at(...parts) {
  const [first, ...rest] = split(parts);
  return join(root(first) || join(ROOT, first), ...rest);
}
// The same, for a command that needs the package: it says which one to install when it isn't there.
export function need(...parts) {
  const first = split(parts)[0];
  if (!has(first)) { console.error(`${first}: this command needs ${SCOPE[first] || '@stuntdouble'}/${first}, which isn't installed`); process.exit(1); }
  return at(...parts);
}
