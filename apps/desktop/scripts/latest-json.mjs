// Writes the in-app updater's feed (latest.json) for a release: each platform's update and its signature, from the
// installers job's files. The app reads it from the newest GitHub release (tauri.conf.json plugins.updater).
//   node scripts/latest-json.mjs <dist-dir> <version> <base-url> [notes-file]
// The files: macOS *.app.tar.gz (+ .sig), Windows *-setup.exe and *.msi (+ .sig). Prints the asset names to upload.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const [dist, version, base, notesFile] = process.argv.slice(2);
if (!dist || !version || !base) { console.error('usage: latest-json.mjs <dist-dir> <version> <base-url> [notes-file]'); process.exit(2); }
const files = [];
(function walk(d) { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else files.push(p); } })(dist);
const find = re => files.find(f => re.test(basename(f)) && existsSync(f + '.sig'));
const entry = f => ({ signature: readFileSync(f + '.sig', 'utf8').trim(), url: `${base.replace(/\/$/, '')}/${encodeURIComponent(basename(f))}` });

const platforms = {};
const mac = find(/\.app\.tar\.gz$/);
// One universal app for both kinds of Mac.
if (mac) for (const k of ['darwin-aarch64', 'darwin-x86_64']) platforms[k] = entry(mac);
const nsis = find(/-setup\.exe$/), msi = find(/\.msi$/);
if (nsis) { platforms['windows-x86_64'] = entry(nsis); platforms['windows-x86_64-nsis'] = entry(nsis); }
if (msi) platforms['windows-x86_64-msi'] = entry(msi);
if (!Object.keys(platforms).length) { console.error(`no signed updates in ${dist} (no .sig files: is TAURI_SIGNING_PRIVATE_KEY set?)`); process.exit(1); }

const notes = notesFile && existsSync(notesFile) ? readFileSync(notesFile, 'utf8').split('\n').filter(l => !l.startsWith('# ')).join('\n').trim() : `Scenecast ${version}`;
const feed = { version, notes, pub_date: new Date().toISOString(), platforms };
writeFileSync(join(dist, 'latest.json'), JSON.stringify(feed, null, 2) + '\n');
console.log(join(dist, 'latest.json'));
for (const f of new Set([mac, nsis, msi].filter(Boolean))) console.log(f), console.log(f + '.sig');
