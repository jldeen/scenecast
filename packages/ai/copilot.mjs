// GitHub Copilot, through the presenter's own GitHub sign-in: the GitHub Copilot SDK (@github/copilot-sdk), the
// supported way for an app to use Copilot on a user's behalf (github.com/github/copilot-sdk, docs/auth). The
// presenter signs in with GitHub's device flow (a code to enter at github.com/login/device); the SDK keeps the
// credential in the system's own store (Keychain, Credential Manager). No keys to hand out: requests use the
// presenter's Copilot plan.
//
// The SDK's runtime (about 80 MB a system) isn't in the installers: it's fetched the first time someone signs in,
// from this repository's release (or npm), and checked against the SHA-256 below before it's used.
import { createHash } from 'node:crypto';
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

export const RUNTIME_VERSION = '1.0.31';
const RUNTIME_SHA256 = {
  'darwin-arm64': '4c524040680d984a372861a694595c726e59d45f6973d053bd673bdcbafdcd7a',
  'darwin-x64': '0e0bc355a943e1c04daa909a63d5ea0b1f936eb3d71e1d638ca7770a82660eb0',
  'linux-x64': '534fdc852884c9044d656a7c15ebbf58885eedc304baad58859ce845b4327cc5',
  'win32-arm64': '7c2c81c905d05ad509dd9b272436aa2dfdbccc9532c58cb174dd75c853960595',
  'win32-x64': '51c919b52c80e4e3262361d0fd46723ec0875c20098c4e4a62b8624efd80f44e',
};
const RELEASE = `https://github.com/jldeen/scenecast/releases/download/copilot-runtime-${RUNTIME_VERSION}`;
const NPM = 'https://registry.npmjs.org/@github';

export const aiHome = () => process.env.SCENECAST_AI_HOME || join(homedir(), '.scenecast', 'ai');
// The AI's log (aiHome()/logs/ai.log): every sign-in step and what Copilot answered, never a token.
export const logFile = () => join(aiHome(), 'logs', 'ai.log');
export function log(what, data) {
  try {
    mkdirSync(join(aiHome(), 'logs'), { recursive: true });
    const clean = JSON.stringify(data === undefined ? null : data, (k, v) => /token|secret|password/i.test(k) ? '[hidden]' : v);
    appendFileSync(logFile(), `${new Date().toISOString()} ${what} ${clean}\n`);
  } catch (e) {}
}
const platform = () => `${process.platform}-${process.arch}`;

// The settings the presenter controls (Settings → Copilot in the app).
export const SETTINGS_DEFAULTS = { model: 'auto', pageText: true };
export function readSettings() {
  try { return { ...SETTINGS_DEFAULTS, ...JSON.parse(readFileSync(join(aiHome(), 'settings.json'), 'utf8')) }; } catch (e) { return { ...SETTINGS_DEFAULTS }; }
}
export function writeSettings(patch) {
  const s = { ...readSettings(), ...patch };
  for (const k of Object.keys(s)) if (!(k in SETTINGS_DEFAULTS)) delete s[k];
  mkdirSync(aiHome(), { recursive: true });
  writeFileSync(join(aiHome(), 'settings.json'), JSON.stringify(s, null, 2));
  return s;
}

function sdkInstalledRuntime() {
  try { createRequire(import.meta.url).resolve(`@github/copilot-sdk-${platform()}/package.json`); return true; } catch (e) { return false; }
}
const runtimeDir = () => join(aiHome(), 'runtime', RUNTIME_VERSION, platform());
const entry = dir => join(dir, 'package', 'prebuilds', platform(), process.platform === 'win32' ? 'copilot-runtime.exe' : 'copilot-runtime');

// Where the runtime is: COPILOT_CLI_PATH, the SDK's own platform package (a checkout), or the downloaded copy.
export function runtimeState() {
  if (process.env.COPILOT_CLI_PATH) return { ready: true, where: 'COPILOT_CLI_PATH' };
  if (!RUNTIME_SHA256[platform()]) return { ready: false, unsupported: true, platform: platform() };
  if (existsSync(join(runtimeDir(), 'package', 'prebuilds', platform(), 'runtime.node'))) return { ready: true, where: 'downloaded', entry: entry(runtimeDir()) };
  if (sdkInstalledRuntime()) return { ready: true, where: 'node_modules' };
  return { ready: false, platform: platform(), mb: 80 };
}

async function download(url, file, onBytes) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = +res.headers.get('content-length') || 0;
  const out = createWriteStream(file);
  const hash = createHash('sha256');
  let got = 0;
  for await (const chunk of res.body) { hash.update(chunk); got += chunk.length; out.write(chunk); onBytes && onBytes(got, total); }
  await new Promise((ok, bad) => out.end(e => e ? bad(e) : ok()));
  return hash.digest('hex');
}

// Fetches the runtime once (GitHub first: it's reachable where npm is blocked), checks it, unpacks it.
export async function ensureRuntime(on = () => {}) {
  const st = runtimeState();
  if (st.ready) { if (st.entry) process.env.COPILOT_CLI_PATH = st.entry; return st; }
  if (st.unsupported) throw new Error(`Copilot isn't available for ${st.platform} yet`);
  const want = RUNTIME_SHA256[platform()];
  const dir = runtimeDir(), tmp = dir + '.part';
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const tgz = join(tmp, 'runtime.tgz');
  const name = `copilot-sdk-${platform()}`;
  let last = null;
  for (const url of [`${RELEASE}/${name}-${RUNTIME_VERSION}.tgz`, `${NPM}/${name}/-/${name}-${RUNTIME_VERSION}.tgz`]) {
    try {
      let shown = 0;
      const sha = await download(url, tgz, (got, total) => { if (got - shown > 4e6 || got === total) { shown = got; on({ event: 'runtime', got, total }); } });
      if (sha !== want) throw new Error(`${url}: its SHA-256 is ${sha}, not ${want}`);
      last = null;
      break;
    } catch (e) { last = e; }
  }
  if (last) { rmSync(tmp, { recursive: true, force: true }); throw new Error(`couldn't get Copilot ready: ${last.message}`); }
  const r = spawnSync('tar', ['-xzf', 'runtime.tgz'], { cwd: tmp, stdio: 'pipe' });
  if (r.status !== 0) throw new Error(`couldn't unpack Copilot: ${String(r.stderr || r.error)}`);
  rmSync(tgz, { force: true });
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
  process.env.COPILOT_CLI_PATH = entry(dir);
  on({ event: 'runtime', ready: true });
  return runtimeState();
}

let SDK = null;
async function sdk() {
  if (!SDK) SDK = await import('@github/copilot-sdk');
  return SDK;
}

// A client for this app: its own Copilot data folder (never the presenter's Copilot CLI's), the presenter's stored
// sign-in, or a token from SCENECAST_COPILOT_TOKEN (tests; never stored).
export async function client({ logLevel } = {}) {
  await ensureRuntime();
  const { CopilotClient } = await sdk();
  const token = process.env.SCENECAST_COPILOT_TOKEN;
  const base = join(aiHome(), 'copilot');
  mkdirSync(base, { recursive: true });
  const c = new CopilotClient({ mode: 'empty', baseDirectory: base, logLevel: logLevel || process.env.SCENECAST_AI_LOG_LEVEL || 'warning', ...(token ? { gitHubToken: token, useLoggedInUser: false } : { useLoggedInUser: true }) });
  await c.start();
  return c;
}

const NO_TOOLS = { availableTools: [], onPermissionRequest: async () => ({ kind: 'denied-interactively-by-user' }) };

export async function status() {
  const rt = runtimeState();
  if (!rt.ready) return { signedIn: false, runtime: rt };
  const c = await client();
  try {
    const a = await c.getAuthStatus();
    return { signedIn: !!a.isAuthenticated, login: a.login || null, host: a.host || null, runtime: rt, via: process.env.SCENECAST_COPILOT_TOKEN ? 'token' : 'sign-in' };
  } finally { await c.stop().catch(() => {}); }
}

export async function models() {
  const c = await client();
  try { return (await c.listModels()).map(m => ({ id: m.id, name: m.name || m.id })); } finally { await c.stop().catch(() => {}); }
}

// The steps of a GitHub sign-in, from the runtime's login flow (login: its begin/advance), to "completed":
//   device-code              the code for the presenter to enter; advance waits until they have
//   needs-plaintext-consent  GitHub accepted it, but the system keychain can't be reached (the runtime's own Keychain
//                            access is off in an app it doesn't ship with: "Keytar disabled: system keychain
//                            unreachable"). "allow" keeps the sign-in in this app's own Copilot folder
//                            (aiHome()/copilot/config.json, readable by this user only); anything else drops it.
//   needs-account-selection  the first account
// Anything else is an error that says what happened.
export async function loginFlow(login, on = () => {}) {
  const begun = await login.begin({ kind: 'githubDotCom', method: 'device-code' });
  let step = begun.step;
  for (let i = 0; i < 8; i++) {
    log('sign-in step', step);
    if (step.kind === 'device-code') on({ event: 'device-code', userCode: step.userCode, verificationUri: step.verificationUri, expiresIn: step.expiresIn });
    else if (step.kind === 'open-url') on({ event: 'open-url', url: step.url });
    else if (step.kind === 'error') throw new Error(`GitHub sign-in: ${step.message}`);
    else if (step.kind === 'completed') {
      const r = step.result || {};
      if (r.status === 'completed') return r;
      if (r.status === 'needs-plaintext-consent') { step = await login.advance({ flowId: begun.flowId, input: 'allow' }); continue; }
      if (r.status === 'needs-account-selection' && (r.accounts || []).length) { const a = r.accounts[0]; step = await login.advance({ flowId: begun.flowId, input: a.selectionId || a.id }); continue; }
      throw new Error(`GitHub sign-in ended as "${r.status}"`);
    }
    step = await login.advance({ flowId: begun.flowId });
  }
  throw new Error('GitHub sign-in didn\'t finish');
}

// Sign in with GitHub's device flow: on({ event: 'device-code', userCode, verificationUri, expiresIn }) for the app to
// show, then it waits until the presenter has entered the code (or it runs out).
export async function signIn(on = () => {}) {
  await ensureRuntime(on);
  log('sign-in start', { runtime: runtimeState(), home: aiHome() });
  // Sign-in logs in full (aiHome()/copilot/logs): where the credential went, and why.
  const c = await client({ logLevel: 'debug' });
  try {
    const s = await c.createSession({ model: 'auto', ...NO_TOOLS });
    await loginFlow(s.rpc.accounts.login, on);
    const sa = await s.rpc.accounts.get({ query: { kind: 'status' } }).catch(e => ({ error: String(e.message || e) }));
    const errs = await s.rpc.accounts.get({ query: { kind: 'lastErrors' } }).catch(e => ({ error: String(e.message || e) }));
    const a = await c.getAuthStatus();
    log('sign-in after', { session: sa, lastErrors: errs, client: a });
    if (!a.isAuthenticated) throw new Error(`GitHub accepted the code, but Copilot didn't keep the sign-in (${a.statusMessage || 'not authenticated'})`);
    return { signedIn: true, login: a.login };
  } catch (e) {
    log('sign-in error', { message: String(e && e.message || e) });
    throw new Error(`${String(e && e.message || e)}. Details: ${logFile()}`);
  } finally { await c.stop().catch(() => {}); }
}

export async function signOut() {
  if (!runtimeState().ready) return { signedIn: false };
  const c = await client();
  try {
    const users = await c.rpc.account.getAllUsers().catch(() => []);
    for (const u of Array.isArray(users) ? users : []) await c.rpc.account.logout(u.selectionId ? { selectionId: u.selectionId } : { authInfo: u.authInfo }).catch(() => {});
    const a = await c.getAuthStatus();
    return { signedIn: !!a.isAuthenticated };
  } finally { await c.stop().catch(() => {}); }
}

// One question to Copilot, no tools: just the answer's text.
export async function ask({ system, prompt, model, timeoutMs = 180000 }) {
  const c = await client();
  try {
    const a = await c.getAuthStatus();
    if (!a.isAuthenticated) throw new Error('sign in to GitHub first (Settings → Copilot)');
    const s = await c.createSession({ model: model || readSettings().model || 'auto', ...NO_TOOLS, systemMessage: { mode: 'replace', content: system } });
    const r = await s.sendAndWait({ prompt }, timeoutMs);
    return (r && r.data && r.data.content) || '';
  } finally { await c.stop().catch(() => {}); }
}
