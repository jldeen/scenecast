// App packs: everything a real app needs to be recorded, built and shown, kept once per app (packs/<id>/pack.json and
// the files next to it), never per demo. A second demo of the same app needs no tuning. Format: README.md.
//
// Packs come from the built-in folder (packs/), then from external folders (STUNTDOUBLE_PACKS, a path list, or
// ~/.stuntdouble/packs), which merge over the built-in pack of the same id: private parts (the GitHub Copilot app's
// message allow-list, tenant names, pre-release hosts) live only there, never in this repository. A demo's own
// demo.json always wins over both.
//
// Packs are found by URL (the page's, or a frame's), never by the demo's own app id: demos name their apps freely.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, delimiter, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

export const BUILTIN = join(dirname(fileURLToPath(import.meta.url)), 'packs');
export const PACK_KIND = 'stuntdouble-app-pack';
export const PACK_VERSION = 1;

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
// External over built-in: objects merge key by key, lists and values are replaced (a list in the external pack is the
// whole list), and a key set to null removes it. Lists of entries with ids (build.rules, writes, effects, safe) merge
// entry by entry: an external entry with a known id merges over it (a private API undo added to a public write), a new
// id is added, and { id, off: true } removes one.
const BY_ID = new Set(['rules', 'writes', 'effects', 'safe']);
export function mergePack(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === null) delete out[k];
    else if (BY_ID.has(k) && Array.isArray(v) && Array.isArray(base[k])) {
      const list = base[k].map(x => ({ ...x }));
      for (const e of v) {
        const i = list.findIndex(x => e && x.id === e.id);
        if (e && e.off) { if (i >= 0) list.splice(i, 1); } else if (i >= 0) list[i] = mergePack(list[i], e); else list.push(e);
      }
      out[k] = list;
    } else out[k] = isObj(v) && isObj(base[k]) ? mergePack(base[k], v) : v;
  }
  return out;
}

export function externalDirs(env = process.env) {
  const list = env.STUNTDOUBLE_PACKS !== undefined ? env.STUNTDOUBLE_PACKS.split(delimiter).filter(Boolean) : [join(homedir(), '.stuntdouble', 'packs')];
  return list.map(d => d.startsWith('~/') ? join(homedir(), d.slice(2)) : d).filter(d => existsSync(d) && statSync(d).isDirectory());
}

function readDir(dir, source) {
  const out = [];
  for (const id of readdirSync(dir).sort()) {
    const f = join(dir, id, 'pack.json');
    if (!existsSync(f)) continue;
    const p = JSON.parse(readFileSync(f, 'utf8'));
    if (p.kind && p.kind !== PACK_KIND) continue;
    out.push({ ...p, id: p.id || id, _dirs: [join(dir, id)], _source: source });
  }
  return out;
}

// Every pack: built-in, then each external folder over it. { dirs } overrides where external packs are looked for.
export function loadPacks({ dirs, builtin = BUILTIN } = {}) {
  const byId = new Map();
  for (const p of readDir(builtin, 'builtin')) byId.set(p.id, p);
  for (const d of dirs || externalDirs()) {
    for (const p of readDir(d, 'external')) {
      const base = byId.get(p.id);
      byId.set(p.id, base ? { ...mergePack(base, p), _dirs: [...base._dirs, ...p._dirs], _source: base._source + '+external' } : p);
    }
  }
  return [...byId.values()];
}

let cache = null;
export const packs = () => (cache || (cache = loadPacks()));
export const resetPacks = () => { cache = null; };

const hit = (m, s) => m.length > 2 && m.startsWith('/') && m.endsWith('/') ? new RegExp(m.slice(1, -1)).test(s) : s.includes(m);
const matches = (list, s) => (list || []).some(m => hit(m, s));
// The pack for a URL or an app's match string (or null). A frame's URL finds the pack whose frames.match lists its
// host (IQ's Power BI frames) when no pack claims it as its own page.
export function packFor(urlOrMatch, list = packs()) {
  const s = String(urlOrMatch || '');
  if (!s) return null;
  return list.find(p => matches(p.match, s)) || list.find(p => matches((p.frames || {}).match, s)) || null;
}
// The pack a talk track means ("In the admin center…", "open Agent 365"): its title or one of its names, longest first.
export function packForName(text, list = packs()) {
  const t = String(text || '').toLowerCase();
  let best = null, len = 0;
  for (const p of list) for (const n of [p.title, ...(p.names || [])].filter(Boolean)) {
    const k = n.toLowerCase();
    if (k.length > len && new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(t)) { best = p; len = k.length; }
  }
  return best;
}

// A file a pack names (vendor CSS, a theme, a repair map): looked for in the pack's folders, the last (external) first.
export function packFile(pack, rel) {
  if (!pack || !rel) return null;
  if (isAbsolute(rel)) return existsSync(rel) ? rel : null;
  for (const d of [...(pack._dirs || [])].reverse()) { const f = join(d, rel); if (existsSync(f)) return f; }
  return null;
}
export const readPackJson = (pack, rel) => { const f = packFile(pack, rel); return f ? JSON.parse(readFileSync(f, 'utf8')) : null; };

// The demo's apps with their packs: { <demo app id>: pack }. demo.json apps[].pack names one ("teams") or turns it
// off (false); otherwise the app's url, then its match string, finds it. demo.json packs.off lists pack ids to leave
// out (all of a pack), packs.offRules rule ids ("github:staff-toggle").
export function packsForDemo(cfg, list = packs()) {
  const off = new Set(((cfg && cfg.packs) || {}).off || []);
  if (cfg && cfg.packs === false) return {};
  const out = {};
  for (const a of (cfg && cfg.apps) || []) {
    if (a.pack === false) continue;
    const p = typeof a.pack === 'string' ? list.find(x => x.id === a.pack) : (packFor(a.url, list) || packFor(a.match, list));
    if (p && !off.has(p.id)) out[a.id] = p;
  }
  return out;
}

const key = x => JSON.stringify(x);
const union = (a = [], b = []) => { const seen = new Set(a.map(key)); return [...a, ...b.filter(x => !seen.has(key(x)))]; };

// The packs a demo's build uses (each page and frame then finds its own by URL): every pack, less demo.json
// packs.off and the packs of apps marked pack: false. packs: false turns them all off.
export function activePacks(cfg, list = packs()) {
  if (cfg && cfg.packs === false) return [];
  const off = new Set(((cfg && cfg.packs) || {}).off || []);
  for (const a of (cfg && cfg.apps) || []) if (a.pack === false) { const p = packFor(a.url, list) || packFor(a.match, list); if (p) off.add(p.id); }
  return list.filter(p => !off.has(p.id));
}

// The recording settings for a demo: its apps' packs under its own demo.json record (the demo always wins). Busy and
// ignore lists are joined; step groups and timings come from a pack only when the demo has none; each app gets its own
// sweep budget (autoPerApp), hover wait range (hoverDelayMs), zoom levels (zoomsPerApp) and frames to skip.
// Returns { record, used }.
export function applyPacks(cfg, list = packs()) {
  const own = (cfg && cfg.record) || {};
  const rec = { ...own };
  const used = [];
  const perApp = {}, hover = {}, zooms = {};
  for (const [appId, p] of Object.entries(packsForDemo(cfg, list))) {
    used.push({ app: appId, pack: p.id });
    const r = p.record || {};
    if (r.busy) rec.busy = union(rec.busy, r.busy);
    if (r.ignore) rec.ignore = union(rec.ignore, r.ignore);
    if (r.groups && !own.groups) rec.groups = { ...(rec.groups || {}), ...r.groups };
    for (const k of ['streamMinMs', 'streamMaxMs', 'settleMs']) if (r[k] != null && own[k] == null) rec[k] = r[k];
    if (r.auto) perApp[appId] = { ...r.auto, ...((own.autoPerApp || {})[appId] || {}) };
    if (r.hoverDelayMs) hover[appId] = r.hoverDelayMs;
    if (r.zooms) zooms[appId] = r.zooms;
    if (p.frames && p.frames.skip) rec.skipFrames = union(rec.skipFrames, p.frames.skip);
  }
  if (Object.keys(perApp).length) rec.autoPerApp = perApp;
  if (Object.keys(hover).length && !own.hoverDelayMs) rec.hoverDelayMs = hover;
  if (Object.keys(zooms).length && !own.zoomsPerApp) rec.zoomsPerApp = zooms;
  return { record: rec, used };
}

const packOf = (appOrPack, cfg) => typeof appOrPack === 'object' ? appOrPack : ((cfg && packsForDemo(cfg)[appOrPack]) || packs().find(x => x.id === appOrPack));
// A theme pack (themes/<theme>.json: the player's extractThemePack output) of an app's pack, by demo app id or pack id.
export function themePack(appOrPack, themeId, cfg) {
  const p = packOf(appOrPack, cfg);
  const t = p && ((p.theme || {}).themes || {})[themeId];
  return t ? readPackJson(p, t) : null;
}
// A platform pack (platforms/<platform>.json: the player's extractPlatformPack output: header controls, shortcuts).
export function platformPack(appOrPack, platform, cfg) {
  const p = packOf(appOrPack, cfg);
  const f = p && ((p.platform || {}).platforms || {})[platform];
  return f ? readPackJson(p, f) : null;
}

// The pack write a plan step makes (or null). step is a parsed plan step ({ kind: 'click', target } or { kind: 'press',
// key }); field is the focused field for a key press ({ name, role }). A write's on.target / on.field is text or /regex/.
const like = (m, s) => m == null || (s != null && (m.length > 2 && m.startsWith('/') && m.lastIndexOf('/') > 0 ? new RegExp(m.slice(1, m.lastIndexOf('/')), m.slice(m.lastIndexOf('/') + 1) || 'i').test(s) : String(s).toLowerCase() === m.toLowerCase()));
const isRe = m => typeof m === 'string' && m.length > 2 && m.startsWith('/') && m.lastIndexOf('/') > 0;
const stepIs = (on = {}, step, field) => {
  if (on.kind === 'switch') return step.kind === 'click' && like(on.target, step.target);
  if (on.kind !== step.kind) return false;
  if (on.kind === 'press') return on.key === step.key && like(on.field, field && field.name);
  if (on.kind === 'type') return like(on.field, step.target || (field && field.name));
  return like(on.target, step.target);
};
export function writeFor(pack, step, field) {
  if (!pack || !step) return null;
  return (pack.writes || []).find(w => stepIs(w.on, step, field)) || null;
}
// The pack's safe entry for a plan step (or null): a control that looks like a write but only opens a picker or a
// menu ("Add content to Our numbers"); the write is a later step (Add to business plugin).
export function safeFor(pack, step, field) {
  if (!pack || !step) return null;
  return (pack.safe || []).find(s => stepIs(s.on, step, field)) || null;
}

// A check step only looks: no step that could send, save, delete or change a setting.
const WRITE_WORDS = /^(?:click|select|choose|tap|press|type)\b.*\b(?:send|post|save|delete|remove|approve|add|submit|certif|endorse|merge|publish|enable|disable|switch|turn (?:on|off)|create|resolve|archive)\b/i;
// A safe entry only opens a picker or a menu, and is never a sign-in or account control.
const OPENS = /\bonly opens\b[^.;]*\b(?:picker|menu)\b/i;
const SIGN_IN = /\b(?:sign|log)[ -]?(?:in|on|out)\b|\baccount\b|\bpassword\b|\bauthenticat|\bconsent\b/i;
const WRITE_NAME = /^(?:send|post|save|delete|remove|approve|submit|merge|publish|confirm|certified|promoted|commit|resolve|archive)\b/i;
const SECRET = /(?:authorization"\s*:\s*"|\bbearer\s+[a-z0-9._-]{12,}|\beyJ[a-zA-Z0-9_-]{20,}\.|\bghp_[A-Za-z0-9]{20,}|\bgithub_pat_|\bxox[bp]-|\bsk-[A-Za-z0-9]{20,}|access[_-]?token"\s*:\s*"[^"]{8,}|password"\s*:\s*"[^"]+)/i;

// The read-only guard for a demo (stage D): every request that isn't a read is held unless its app's pack allows it.
// A pack's guard: { allow: ['host/path-prefix' | '/regex over METHOD host/path/'], hosts: [more hosts its app uses] }.
// What the apps send while they're only looked at (telemetry, presence, search) goes in allow, from measured traffic,
// reviewed by hand; a tenant's own hosts only in a private pack (~/.stuntdouble/packs).
export function guardFor(cfg, list = packs()) {
  const byApp = packsForDemo(cfg, list);
  const hostOf = s => { try { return new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`).host; } catch (e) { return null; } };
  const hosts = new Set(), allow = [];
  for (const a of (cfg && cfg.apps) || []) {
    for (const h of [a.url, a.match].map(hostOf).filter(Boolean)) hosts.add(h);
    const p = byApp[a.id];
    if (!p) continue;
    for (const m of p.match || []) { const h = hostOf(m); if (h && !h.includes('*')) hosts.add(h); }
    for (const h of ((p.guard || {}).hosts) || []) hosts.add(h);
    for (const x of ((p.guard || {}).allow) || []) if (!allow.includes(x)) allow.push(x);
  }
  for (const x of ((cfg && cfg.capture && cfg.capture.allow) || [])) if (!allow.includes(x)) allow.push(x);
  return { hosts: [...hosts], allow };
}

// Problems with a pack's shape (the tests and the drafting tool check every pack with it).
export function checkPack(p) {
  const out = [];
  if (!p.id || !/^[a-z0-9][a-z0-9-]*$/.test(p.id)) out.push('id: lowercase letters, digits and dashes');
  if (!Array.isArray(p.match) || !p.match.length) out.push('match: at least one URL substring');
  const ids = new Set();
  for (const r of ((p.build || {}).rules || [])) {
    if (!r.id) out.push('build.rules: every rule has an id (a demo turns one off by it)');
    else if (ids.has(r.id)) out.push(`build.rules: id ${r.id} twice`); else ids.add(r.id);
    const kinds = ['raw', 'text', 'drop', 'block', 're', 'css'].filter(k => r[k] !== undefined);
    if (kinds.length !== 1) out.push(`build.rules ${r.id || '?'}: one of raw, text, drop, block, re, css`);
  }
  for (const [name, rule] of Object.entries(((p.flow || {}).layout) || {})) {
    if (!rule.kind) out.push(`flow.layout ${name}: kind (responsive, pin, set, stick, float, chips, gridfit)`);
    if (rule.kind === 'responsive' && rule.bands) out.push(`flow.layout ${name}: bands are the engine's, from the recorded width; a pack gives the app's own breakpoint (below, CSS px) and its zoom`);
  }
  for (const [what, list] of [['writes', p.writes], ['effects', p.effects]]) {
    for (const w of list || []) {
      const at = `${what} ${w.id || '?'}`;
      if (!w.id) out.push(`${at}: id`);
      if (!w.what) out.push(`${at}: what (plain words)`);
      if (what === 'writes' && !(w.on && w.on.kind)) out.push(`${at}: on (the step that writes: click, press, type, switch)`);
      if (what === 'writes' && w.undo === undefined) out.push(`${at}: undo (steps, api, or null with irreversible: true or a note)`);
      if (!w.check) out.push(`${at}: check (read-only)`);
      for (const s of ((w.check || {}).steps || [])) if (WRITE_WORDS.test(s)) out.push(`${at}: check step "${s}" could change something; checks only look`);
      if (w.undo && w.undo.api && !w.undo.api.use) out.push(`${at}: undo.api.use names an api (apis.<name>) whose host comes from the browser's own requests`);
    }
  }
  for (const s of p.safe || []) {
    const at = `safe ${s.id || '?'}`, on = s.on || {};
    if (!s.id) out.push(`${at}: id`);
    if (on.kind !== 'click' || !on.target) out.push(`${at}: on { kind: 'click', target } (the control that opens a picker or a menu)`);
    if (!OPENS.test(s.what || '')) out.push(`${at}: what says it only opens a picker or a menu ("… only opens the add picker; … is what adds")`);
    if (SIGN_IN.test([on.target, on.field, s.what].filter(Boolean).join(' '))) out.push(`${at}: a sign-in or account control is never safe`);
    const literal = on.target && !isRe(on.target) ? on.target : null;
    if (literal && WRITE_NAME.test(literal)) out.push(`${at}: "${literal}" names a write`);
    const hits = (p.writes || []).filter(w => literal ? stepIs(w.on, { kind: 'click', target: literal }) : w.on && w.on.target && !isRe(w.on.target) && like(on.target, w.on.target));
    for (const w of hits) out.push(`${at}: write ${w.id} has the same step; a safe step never writes`);
  }
  // A guard's allow-list names what's let through: a host (and path), never everything.
  for (const x of ((p.guard || {}).allow) || []) {
    const re = typeof x === 'string' && /^\/.+\/[a-z]*$/.test(x);
    if (typeof x !== 'string' || !x.trim()) out.push('guard.allow: strings, a host and path prefix or a /pattern/');
    else if (re ? /^\/(\.\*|\^?\.\*\$?)\/[a-z]*$/.test(x) : !/^[a-z0-9.-]+\.[a-z]{2,}(:\d+)?(\/|$)|^[0-9.]+(:\d+)?(\/|$)/i.test(x)) out.push(`guard.allow "${x}": a host and path prefix ("host.example.com/api/") or a /pattern/ over "METHOD host/path", never everything`);
  }
  for (const [name, a] of Object.entries(p.apis || {})) if (!a.open || !(a.host || a.hostPattern)) out.push(`apis ${name}: open (the page that signs in) and host or hostPattern`);
  const text = JSON.stringify(p, (k, v) => k.startsWith('_') ? undefined : v);
  if (SECRET.test(text)) out.push('looks like a credential or token: packs never hold them (an API undo uses the browser\'s signed-in session)');
  for (const f of [...(((p.flow || {}).vendorCss) || []), ...Object.values(((p.theme || {}).themes) || {}), ...Object.values(((p.platform || {}).platforms) || {}), ((p.build || {}).repairs || {}).css].filter(Boolean)) if (!packFile(p, f)) out.push(`missing file ${f}`);
  return out;
}
