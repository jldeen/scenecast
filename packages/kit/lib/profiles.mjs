// The presenter's browser profiles (Edge or Chrome): their names and pictures, which are open in the running browser,
// and which have the recorder extension loaded. Read from the browser's own files (Local State, each profile's
// Preferences); the browser is never touched.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

// Where the recorder extension goes: a folder people can find (Documents/Scenecast/Recorder Extension), unless
// SCENECAST_EXTENSION_DIR says otherwise.
export function extensionDir(env = process.env, home = homedir(), platform = process.platform) {
  if (env.SCENECAST_EXTENSION_DIR) return env.SCENECAST_EXTENSION_DIR;
  const base = platform === 'win32' ? (env.USERPROFILE || home) : home;
  return join(base, 'Documents', 'Scenecast', 'Recorder Extension');
}
// Where earlier versions put it (still found, so a presenter who loaded it there keeps it).
export const OLD_EXTENSION_DIR = join(homedir(), '.scenecast', 'extension');

const readJson = f => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch (e) { return null; } };
const same = (a, b) => { try { return resolve(a).toLowerCase() === resolve(b).toLowerCase(); } catch (e) { return false; } };

// Whether a profile has the Scenecast recorder loaded: an unpacked extension whose folder's manifest is ours (or is
// one of the folders scenecast writes it to).
export function recorderIn(profileDir, dirs = []) {
  const found = [];
  for (const f of ['Secure Preferences', 'Preferences']) {
    const p = readJson(join(profileDir, f));
    const settings = p && p.extensions && p.extensions.settings;
    if (!settings) continue;
    for (const [id, e] of Object.entries(settings)) {
      if (!e || !e.path || found.some(x => x.id === id)) continue;
      const name = (e.manifest && e.manifest.name) || (readJson(join(e.path, 'manifest.json')) || {}).name;
      if (name === 'Scenecast Recorder' || dirs.some(d => same(d, e.path))) {
        const dr = e.disable_reasons;
        found.push({ id, path: e.path, enabled: e.state !== 0 && !(Array.isArray(dr) ? dr.length : dr) });
      }
    }
  }
  return found;
}

// Each profile: { dir, name, open, active, recorder, devMode, picture (a data: URL, or null), color }.
// openDirs: the profiles the running browser has open (its --profile-directory flags), on top of Local State's.
export function listProfiles(userDataDir, { openDirs = [], extDirs = [extensionDir(), OLD_EXTENSION_DIR], pictures = true } = {}) {
  const state = readJson(join(userDataDir, 'Local State')) || {};
  const prof = state.profile || {};
  const cache = prof.info_cache || {};
  const active = prof.last_active_profiles || [];
  const dirs = new Set([...Object.keys(cache), ...active, ...openDirs].filter(d => existsSync(join(userDataDir, d))));
  if (!dirs.size && existsSync(join(userDataDir, 'Default'))) dirs.add('Default');
  return [...dirs].map(dir => {
    const c = cache[dir] || {};
    let picture = null;
    if (pictures) for (const f of [c.gaia_picture_file_name, 'Google Profile Picture.png', 'Edge Profile Picture.png'].filter(Boolean)) {
      const p = join(userDataDir, dir, f);
      if (existsSync(p)) { try { picture = 'data:image/png;base64,' + readFileSync(p).toString('base64'); break; } catch (e) { /* unreadable */ } }
    }
    const color = typeof c.default_avatar_fill_color === 'number' ? '#' + ((c.default_avatar_fill_color >>> 0) & 0xffffff).toString(16).padStart(6, '0') : null;
    const recorder = recorderIn(join(userDataDir, dir), extDirs);
    const prefs = readJson(join(userDataDir, dir, 'Preferences')) || {};
    // true or false when the profile says; null when it doesn't (Chrome leaves it out until it's switched).
    const ui = prefs.extensions && prefs.extensions.ui;
    const devMode = ui && typeof ui.developer_mode === 'boolean' ? ui.developer_mode : null;
    return { dir, name: c.name || c.gaia_given_name || dir, open: active.includes(dir) || openDirs.includes(dir), active: active.includes(dir), recorder: recorder.length > 0, recorderOff: recorder.length > 0 && !recorder.some(r => r.enabled), devMode, picture, color };
  });
}

// The profile to record in: the one the demo names, else one that's open with the recorder loaded, else one with
// the recorder, else the open one, else Default. Returns { dir, why }.
export function pickProfile(profiles, chosen) {
  if (chosen) return { dir: chosen, why: 'chosen for this demo' };
  const open = profiles.filter(p => p.open);
  const pick = open.find(p => p.recorder) || profiles.find(p => p.recorder) || open[0];
  if (pick) return { dir: pick.dir, why: pick.recorder ? (pick.open ? 'open, with the recorder' : 'has the recorder') : 'open in the browser' };
  return { dir: 'Default', why: 'the default profile' };
}
