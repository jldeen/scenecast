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
// A pack's guard: { allow: ['host/path-prefix' | '/regex over METHOD host/path/'], hosts: [more hosts its app uses],
// stayHeld: [entries as allow's: its own background calls to those hosts, held even while a write opens them] }.
// What the apps send while they're only looked at (telemetry, presence, search) goes in allow, from measured traffic,
// reviewed by hand; a tenant's own hosts only in a private pack (~/.stuntdouble/packs).
export function guardFor(cfg, list = packs()) {
  const byApp = packsForDemo(cfg, list);
  const hostOf = s => { try { return new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`).host; } catch (e) { return null; } };
  const hosts = new Set(), allow = [], stayHeld = [];
  for (const a of (cfg && cfg.apps) || []) {
    for (const h of [a.url, a.match].map(hostOf).filter(Boolean)) hosts.add(h);
    const p = byApp[a.id];
    if (!p) continue;
    for (const m of p.match || []) { const h = hostOf(m); if (h && !h.includes('*')) hosts.add(h); }
    for (const h of ((p.guard || {}).hosts) || []) hosts.add(h);
    for (const x of ((p.guard || {}).allow) || []) if (!allow.includes(x)) allow.push(x);
    for (const x of ((p.guard || {}).stayHeld) || []) if (!stayHeld.includes(x)) stayHeld.push(x);
  }
  for (const x of ((cfg && cfg.capture && cfg.capture.allow) || [])) if (!allow.includes(x)) allow.push(x);
  return { hosts: [...hosts], allow, stayHeld };
}

// A demo's pack-named services: what an app needs from a service of its own to show its recorded screens (IQ's
// plugin service). A pack's services: [{ name, match (a guard entry over "METHOD host/path"), start (its page asks for
// it as the app starts), waitS }]. The capture watches the page's own calls to them: one answering 500 means try
// later, not a half-done run. → [{ app, name, match, start, waitS }]
export function servicesFor(cfg, list = packs()) {
  const byApp = packsForDemo(cfg, list), out = [];
  for (const a of (cfg && cfg.apps) || []) for (const sv of ((byApp[a.id] || {}).services) || []) if (sv && sv.name && sv.match) out.push({ app: a.id, name: sv.name, match: sv.match, start: !!sv.start, waitS: +sv.waitS || 90, ...(sv.cards ? { cards: sv.cards } : {}) });
  return out;
}

// A demo's own-status controls: where an app shows the signed-in person's own status (Teams' avatar: Available, Away),
// which a replica would keep. A pack's ownStatus: { name (a /pattern/ over the control's name, by the reader's rule,
// whose group is the status), role, expect (what a save may show when the recording has none), waitS }.
// → [{ app, pack, label (what people call the app), name, role, expect, waitS }]
export function ownStatusFor(cfg, list = packs()) {
  const byApp = packsForDemo(cfg, list), out = [];
  for (const a of (cfg && cfg.apps) || []) {
    const p = byApp[a.id], o = p && p.ownStatus;
    if (!o || !o.name) continue;
    out.push({ app: a.id, pack: p.id, label: (p.names || [])[0] || p.title || p.id, name: o.name, role: o.role || null, expect: [].concat(o.expect || []), waitS: +o.waitS || 90 });
  }
  return out;
}

// Notices an app shows for a while that a replica must never keep (Teams' "Loading latest updates…"), for each of a
// demo's apps whose pack names them (notices: [{ words, close, waitS }]): words, the notice's own (it shows when the
// page's text has them); close, a /pattern/ over the name of its own close button; waitS, how long a save waits for it
// to go before closing it (60 s). → [{ app, pack, label, notices: [{ words, close, waitS }] }]
export function noticesFor(cfg, list = packs()) {
  const byApp = packsForDemo(cfg, list), out = [];
  for (const a of (cfg && cfg.apps) || []) {
    const p = byApp[a.id], ns = ((p && p.notices) || []).filter(n => n && typeof n.words === 'string' && n.words.trim());
    if (!ns.length) continue;
    out.push({ app: a.id, pack: p.id, label: (p.names || [])[0] || p.title || p.id, notices: ns.map(n => ({ words: n.words.trim(), close: n.close || null, waitS: n.waitS === undefined ? 60 : +n.waitS })) });
  }
  return out;
}

// Her own presence, for each of a demo's apps whose pack names where it comes from (presence: [{ id, url, match, why }]:
// url, a browser request pattern; match, a guard entry over "METHOD host/path"): in the capture browser, her entry in
// those answers reads as the status her recording shows (capture/presence.mjs). → [{ app, pack, rules: [{ id, url, match }] }]
export function presenceFor(cfg, list = packs()) {
  const byApp = packsForDemo(cfg, list), out = [];
  for (const a of (cfg && cfg.apps) || []) {
    const p = byApp[a.id], rs = ((p && p.presence) || []).filter(r => r && r.id && r.url && r.match);
    if (!rs.length || !p.ownStatus) continue;
    out.push({ app: a.id, pack: p.id, rules: rs.map(r => ({ id: r.id, url: r.url, match: r.match })) });
  }
  return out;
}

// A demo's pack filters, for reset.md's Leave out: what an app shows of the tenant's own data that a demo can leave out
// of its replica, in the capture browser only (packages/capture/leave-out.mjs). A pack's filters: [{ id, why, and either
// url (where its responses come from, a browser request pattern), match (a guard entry over "METHOD host/path"), items
// (where the items are), fields (any of which names one), refs?, shows?, or kind "dom" and list (a CSS selector of a
// list's items the app draws from its own store) }]. The values (which items) are the demo's own, never the pack's.
// → { "<pack>:<filter>": { ...filter, pack, app, hosts } }, for the demo's apps
export function filtersFor(cfg, list = packs()) {
  const byApp = packsForDemo(cfg, list), out = {};
  const hostOf = s => { try { return new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`).host; } catch (e) { return null; } };
  for (const a of (cfg && cfg.apps) || []) {
    const p = byApp[a.id];
    if (!p) continue;
    const hosts = [...new Set([a.url, a.match, ...(p.match || [])].map(hostOf).filter(h => h && !h.includes('*')))];
    for (const f of p.filters || []) if (f && f.id && !out[`${p.id}:${f.id}`]) out[`${p.id}:${f.id}`] = { ...f, pack: p.id, app: a.id, hosts };
  }
  return out;
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
      const lk = (w.check || {}).look;
      if (lk && !(lk.absent || lk.text || lk.rows || lk.sel || (lk.box && lk.equals))) out.push(`${at}: check look is absent, text, rows, sel, or box with equals`);
      const fd = (w.undo || {}).find;
      if (fd && (!fd.use || !fd.path || !fd.list || !fd.name || !fd.id || !fd.as || !fd.by)) out.push(`${at}: undo find needs use, path, list, name, id, as (the placeholder it fills) and by (what the script made: task, skill)`);
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
  // A guard's allow-list names what's let through: a host (and path), never everything; ' when body /pattern/' after it
  // narrows it to the bodies that only read. Its stay-held list (held even while a write opens the host) is named the
  // same way.
  for (const list of ['allow', 'stayHeld']) for (const e of ((p.guard || {})[list]) || []) {
    const [x, when] = typeof e === 'string' && e.includes(' when body ') ? e.split(' when body ') : [e, null];
    const re = typeof x === 'string' && /^\/.+\/[a-z]*$/.test(x);
    if (typeof x !== 'string' || !x.trim()) out.push(`guard.${list}: strings, a host and path prefix or a /pattern/`);
    else if (re ? /^\/(\.\*|\^?\.\*\$?)\/[a-z]*$/.test(x) : !/^[a-z0-9.-]+\.[a-z]{2,}(:\d+)?(\/|$)|^[0-9.]+(:\d+)?(\/|$)/i.test(x)) out.push(`guard.${list} "${x}": a host and path prefix ("host.example.com/api/") or a /pattern/ over "METHOD host/path", never everything`);
    if (when !== null && (!/^\/.+\/[a-z]*$/.test(when) || /^\/(\.\*|\^?\.\*\$?)\/[a-z]*$/.test(when))) out.push(`guard.${list} "${e}": after "when body", a /pattern/ the body has to match, not every body`);
  }
  for (const [name, a] of Object.entries(p.apis || {})) if (!a.open || !(a.host || a.hostPattern)) out.push(`apis ${name}: open (the page that signs in) and host or hostPattern`);
  // A service: a name people read, and the one call it is (a /pattern/ over "METHOD host/path", never everything).
  for (const sv of p.services || []) {
    if (!sv || !sv.name) out.push('services: every service has a name ("IQ\'s plugin service")');
    else if (typeof sv.match !== 'string' || !/^\/\^[A-Z]+ .+\/[a-z]*$/.test(sv.match)) out.push(`services ${sv.name}: match is a /^METHOD host\\/path$/ pattern`);
    // Its list's cards: which plan steps click one (a /pattern/ over the step's words), the type label they end with,
    // what the list is called; never a card's own words (those are a demo's, from its plan).
    const c = sv && sv.cards;
    if (c && (typeof c.steps !== 'string' || !/^\/.+\/[a-z]*$/.test(c.steps) || !c.list || !c.why)) out.push(`services ${sv.name}: cards has steps (a /pattern/ over a step's words), list and why`);
  }
  // Her own status: the control by a /pattern/ over its name whose group is the status, and what a save may show.
  { const o = p.ownStatus;
    if (o !== undefined) {
      if (!o || typeof o.name !== 'string' || !/^\/.*\(.+\).*\/[a-z]*$/.test(o.name)) out.push('ownStatus: name is a /pattern/ over the control\'s name, its group the status ("/^Your profile, status (.+?) for /")');
      if (!o || ![].concat(o.expect || []).length) out.push('ownStatus: expect (what a save may show when the recording has none: "Available")');
      if (!o || !o.why) out.push('ownStatus: why (plain words, with the evidence)');
    } }
  // Notices a replica must never keep: each by its own words, with why, and its close button by a /pattern/.
  if (p.notices !== undefined) {
    if (!Array.isArray(p.notices)) out.push('notices: a list ([{ words, close, waitS, why }])');
    else for (const n of p.notices) {
      if (!n || typeof n.words !== 'string' || !n.words.trim()) out.push('notices: words (the notice\'s own, as the page shows them)');
      if (n && n.close !== undefined && n.close !== null && !/^\/.+\/[a-z]*$/.test(String(n.close))) out.push('notices: close is a /pattern/ over its close button\'s name');
      if (n && n.waitS !== undefined && !(+n.waitS >= 0)) out.push('notices: waitS (seconds a save waits for it to go)');
      if (!n || !n.why) out.push('notices: why (plain words, with the evidence)');
    }
  }
  // Her own presence: where it comes from (a request pattern and a guard entry over one answer, never everything), why,
  // and only with ownStatus (the status it reads as).
  if (p.presence !== undefined) {
    if (!Array.isArray(p.presence)) out.push('presence: a list ([{ id, url, match, why }])');
    else for (const r of p.presence) {
      if (!r || !r.id || !/^[a-z0-9][a-z0-9-]*$/.test(r.id)) out.push('presence: every entry has an id (lowercase letters, digits and dashes)');
      if (!r || typeof r.url !== 'string' || !r.url || r.url === '*') out.push(`presence ${(r && r.id) || '?'}: url (a browser request pattern for its answers, never every request)`);
      if (!r || typeof r.match !== 'string' || !/^\/\^.+\$\/[a-z]*$/.test(r.match)) out.push(`presence ${(r && r.id) || '?'}: match (an anchored /^…$/ over "METHOD host/path")`);
      if (!r || !r.why) out.push(`presence ${(r && r.id) || '?'}: why (plain words, with the evidence)`);
    }
    if (!p.ownStatus) out.push('presence: only with ownStatus (the status her entry reads as)');
  }
  // A filter (Leave out): why, and the one response it reads (a pattern over "METHOD host/path", never everything) and
  // where its items are; or a DOM list. Never which items: those are a demo's.
  for (const f of p.filters || []) {
    const at = `filters ${(f && f.id) || '?'}`;
    if (!f || !f.id || !/^[a-z0-9][a-z0-9-]*$/.test(f.id)) out.push('filters: every filter has an id (lowercase letters, digits and dashes)');
    if (!f || !f.why) out.push(`${at}: why (plain words, with the evidence)`);
    if (f && f.values) out.push(`${at}: no values: which items is the demo's (reset.md's Leave out)`);
    if (f && f.kind === 'dom') { if (typeof f.list !== 'string' || !f.list.trim()) out.push(`${at}: list (a CSS selector of the list's items)`); continue; }
    if (f && f.kind !== undefined) out.push(`${at}: kind is "dom", or none (a response)`);
    if (!f || typeof f.match !== 'string' || !/^\/\^[A-Z]+ .+\/[a-z]*$/.test(f.match) || /^\/(\.\*|\^?\.\*\$?)\/[a-z]*$/.test(f.match)) out.push(`${at}: match is a /^METHOD host\\/path$/ pattern`);
    if (!f || typeof f.url !== 'string' || !/^\*?:?\/\/|^https?:|^\*:\/\//.test(f.url) || f.url === '*') out.push(`${at}: url is where its responses come from ("*://host/path*")`);
    if (!f || typeof f.items !== 'string' || !f.items) out.push(`${at}: items (where the item list is: "plugins", "Groups[Type=Message].Suggestions")`);
    if (!f || ![].concat(f.fields || []).length) out.push(`${at}: fields (the item's fields that name it)`);
    for (const r of (f && f.refs) || []) if (!r || !r.list || !r.by) out.push(`${at}: refs are { list, by }`);
  }
  const text = JSON.stringify(p, (k, v) => k.startsWith('_') ? undefined : v);
  if (SECRET.test(text)) out.push('looks like a credential or token: packs never hold them (an API undo uses the browser\'s signed-in session)');
  for (const f of [...(((p.flow || {}).vendorCss) || []), ...Object.values(((p.theme || {}).themes) || {}), ...Object.values(((p.platform || {}).platforms) || {}), ((p.build || {}).repairs || {}).css].filter(Boolean)) if (!packFile(p, f)) out.push(`missing file ${f}`);
  return out;
}
