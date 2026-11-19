// Gets the installers' extras ready, and writes the `tauri build` overlay config (src-tauri/tauri.bundle.json):
//   - Node.js, so presenters need nothing installed: the current LTS line's binary for this OS, checked against
//     nodejs.org's SHA-256 list, into src-tauri/node/ (on the Mac both arm64 and x64, joined into one universal binary).
//   - The updater's signed update files, when TAURI_SIGNING_PRIVATE_KEY is set.
//   - Signing, only when its secrets are in the environment; unsigned otherwise (see docs/app/signing.md).
//       macOS:   APPLE_CERTIFICATE (+ _PASSWORD) and APPLE_SIGNING_IDENTITY; notarized with APPLE_ID, APPLE_PASSWORD
//                and APPLE_TEAM_ID. Tauri reads these itself; without them the app is ad-hoc signed.
//       Windows: WINDOWS_CERTIFICATE (a base64 .pfx) and WINDOWS_CERTIFICATE_PASSWORD: imported into the user's store,
//                and its thumbprint set in the overlay.
//   node scripts/prepare-bundle.mjs [--node-major 22]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TAURI = join(HERE, '..', 'src-tauri');
const NODE_DIR = join(TAURI, 'node');
const args = process.argv.slice(2);
const MAJOR = args.includes('--node-major') ? +args[args.indexOf('--node-major') + 1] : 22;
const platform = process.platform;

async function get(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function bundleNode() {
  const index = JSON.parse((await get('https://nodejs.org/dist/index.json')).toString());
  const release = index.find(r => r.version.startsWith(`v${MAJOR}.`) && r.lts);
  if (!release) throw new Error(`no Node ${MAJOR} LTS release`);
  const v = release.version;
  const sums = (await get(`https://nodejs.org/dist/${v}/SHASUMS256.txt`)).toString();
  const fetchChecked = async name => {
    const want = sums.split('\n').map(l => l.trim().split(/\s+/)).find(([, f]) => f === name)?.[0];
    if (!want) throw new Error(`${name} isn't in ${v}'s SHASUMS256.txt`);
    const data = await get(`https://nodejs.org/dist/${v}/${name}`);
    const got = createHash('sha256').update(data).digest('hex');
    if (got !== want) throw new Error(`${name}: SHA-256 ${got}, expected ${want}`);
    return data;
  };
  rmSync(NODE_DIR, { recursive: true, force: true });
  mkdirSync(NODE_DIR, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'scenecast-node-'));
  const unpack = async (name, flags) => {
    const file = join(work, name);
    writeFileSync(file, await fetchChecked(name));
    execFileSync('tar', [flags, file, '-C', work]);
  };
  if (platform === 'darwin') {
    const slices = [];
    for (const arch of ['arm64', 'x64']) {
      await unpack(`node-${v}-darwin-${arch}.tar.gz`, '-xzf');
      slices.push(join(work, `node-${v}-darwin-${arch}`, 'bin', 'node'));
    }
    execFileSync('lipo', ['-create', ...slices, '-output', join(NODE_DIR, 'node')]);
    execFileSync('chmod', ['755', join(NODE_DIR, 'node')]);
    copyFileSync(join(work, `node-${v}-darwin-arm64`, 'LICENSE'), join(NODE_DIR, 'LICENSE'));
  } else if (platform === 'win32') {
    await unpack(`node-${v}-win-x64.zip`, '-xf');
    copyFileSync(join(work, `node-${v}-win-x64`, 'node.exe'), join(NODE_DIR, 'node.exe'));
    copyFileSync(join(work, `node-${v}-win-x64`, 'LICENSE'), join(NODE_DIR, 'LICENSE'));
  } else {
    await unpack(`node-${v}-linux-x64.tar.xz`, '-xJf');
    copyFileSync(join(work, `node-${v}-linux-x64`, 'bin', 'node'), join(NODE_DIR, 'node'));
    execFileSync('chmod', ['755', join(NODE_DIR, 'node')]);
    copyFileSync(join(work, `node-${v}-linux-x64`, 'LICENSE'), join(NODE_DIR, 'LICENSE'));
  }
  rmSync(work, { recursive: true, force: true });
  return v;
}

function windowsSigning() {
  if (!process.env.WINDOWS_CERTIFICATE) return null;
  const file = join(tmpdir(), 'scenecast-signing.pfx');
  writeFileSync(file, Buffer.from(process.env.WINDOWS_CERTIFICATE, 'base64'));
  const ps = `$p = ConvertTo-SecureString -String $env:WINDOWS_CERTIFICATE_PASSWORD -Force -AsPlainText; ` +
    `(Import-PfxCertificate -FilePath '${file}' -CertStoreLocation Cert:\\CurrentUser\\My -Password $p).Thumbprint`;
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { env: { WINDOWS_CERTIFICATE_PASSWORD: '', ...process.env } });
    return { certificateThumbprint: out.toString().trim().split(/\s+/).pop(), digestAlgorithm: 'sha256', timestampUrl: process.env.WINDOWS_TIMESTAMP_URL || 'http://timestamp.digicert.com' };
  } finally {
    rmSync(file, { force: true });
  }
}

const version = await bundleNode();
const overlay = { bundle: { resources: { 'node/': 'node/' } } };
let signed = 'unsigned';
if (platform === 'darwin') {
  if (process.env.APPLE_SIGNING_IDENTITY) {
    signed = `signed as ${process.env.APPLE_SIGNING_IDENTITY}${process.env.APPLE_ID ? ', notarized' : ''}`;
  } else {
    // Ad-hoc: runs on Apple silicon; Gatekeeper asks once (Control-click → Open).
    overlay.bundle.macOS = { signingIdentity: '-' };
    signed = 'ad-hoc signed (no Developer ID in the environment)';
  }
} else if (platform === 'win32') {
  const w = windowsSigning();
  if (w) { overlay.bundle.windows = w; signed = `signed (certificate ${w.certificateThumbprint.slice(0, 8)}…)`; }
}
// In-app updates: the signed update files (macOS .app.tar.gz, Windows installers) and their .sig, when the updater's
// signing key is in the environment (TAURI_SIGNING_PRIVATE_KEY, a GitHub Actions secret).
let updates = 'no updater key: no update files';
if (process.env.TAURI_SIGNING_PRIVATE_KEY) { overlay.bundle.createUpdaterArtifacts = true; updates = 'signed update files'; }
writeFileSync(join(TAURI, 'tauri.bundle.json'), JSON.stringify(overlay, null, 2) + '\n');
console.log(`installer: Node ${version}${platform === 'darwin' ? ' (universal)' : ''}, ${signed}, ${updates}; overlay: src-tauri/tauri.bundle.json`);
