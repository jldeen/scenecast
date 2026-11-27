// The demo's reset, run by an unattended capture pass before and after it (stage D): the tenant as the demo starts
// before anything is recorded, and as it was found after. Fail closed: when the check before still fails after the
// fix, nothing is recorded.
//   The demo's own scripts (demo.json preflight.reset / resetFix), else reset.md (reset.mjs: Undo, then Set first,
//   then Check). reset.md's undo and set-first steps change the tenant, so each one runs only as approved (the
//   approval lists them: make.mjs resetSteps), with the guard open for that one step, the control matched again.
//   runReset({ demo, cmd, walker, phase: 'before' | 'after', approval, ran, results, shots }) →
//     { ok, kind?, how, did: [...], checks: [{ text, from, status: 'pass' | 'wrong' | 'cant', ok, why }], why }
// Its Check lines are read as check-lines.mjs says (checkLines). Before: a line it can't read stops it as itself
// (kind 'check'), with nothing undone; the undos run only for lines read and found wrong (theirs: the writes and
// leftovers each line comes from), then Set first, then every line again. An API undo with nothing a run recorded
// finds the script's own leftovers by name (the group's Names line, through its pack's find), never anything else.
// ran: the writes the run made ({ beat (1-based), text }); after it, only their undos run (then the rest, if the check
// still fails). results: what they made ({ task, skill, item, … } from run.json), for the undo's {placeholders}.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStep, formatStep } from './plan.mjs';
import { appTab, sleep } from './run.mjs';
import { norm } from './find.mjs';
import { checkable, claimOf, readClaim, routeKey, packIndex, rowsAfter, checkValues, byName, FORMS } from './check-lines.mjs';
import { readScreen } from '@scenecast/script/html.mjs';

// A reset.md Check line as "<app>: <claim>": a string (the older parser), or parseReset's { app, screen, text } with
// text the claim alone ("- tasks on tasks-home: no …").
export const checkLine = c => typeof c === 'string' ? c : (c.app ? `${c.app}: ${c.text}` : c.text);

// A pack's API undo filled in: its {placeholders} from the demo's own values (demo.json apps[].values: which business
// plugin, which workspace) and what the run made (run.json's results). The demo's values win. Each value goes in as a
// value only: encoded as one path segment (free text such as what was typed can't add a segment or a query), and into
// the body's strings as it is (it can't add a field). → { path, body, left: ['{name}', …] not known }
export function fillApi(api, results = {}, values = {}) {
  const vals = { ...(results || {}), ...(values || {}) };
  const known = k => vals[k] !== undefined && vals[k] !== null && vals[k] !== '';
  const left = [...new Set(`${api.path || ''} ${api.body ? JSON.stringify(api.body) : ''}`.match(/\{\w+\}/g) || [])].filter(x => !known(x.slice(1, -1)));
  if (left.length) return { path: null, body: null, left };
  const path = String(api.path || '').replace(/\{(\w+)\}/g, (m, k) => encodeURIComponent(String(vals[k])));
  const fillIn = v => typeof v === 'string' ? v.replace(/\{(\w+)\}/g, (m, k) => String(vals[k]))
    : Array.isArray(v) ? v.map(fillIn) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [fillIn(k), fillIn(x)])) : v;
  return { path, body: api.body ? fillIn(api.body) : null, left };
}

// The plan's own read-only steps from an app's start screen to one of its screens (a check on a screen other than the
// start): from the app's first "Go to", the steps the plan takes in that app (going back to it carries on where it
// was), up to the first that lands there. null when a write comes first (that screen is what a write made, not
// somewhere to go) or the plan never lands there.
export function pathTo(plan, app, screen, appOf = x => x) {
  let on = null, started = false;
  const out = [];
  for (const s of ((plan && plan.beats) || []).flatMap(b => b.steps)) {
    if (s.kind === 'app') {
      on = appOf(s.app);
      if (on === app && !started) { started = true; if (s.lands && s.lands.screen === screen) return []; }
      continue;
    }
    if (!started || on !== app) continue;
    if (s.writes) return null;
    out.push(s);
    if (s.lands && s.lands.screen === screen) return out;
  }
  return null;
}

// A Note's steps for when an API undo can't run ("…; if it can't: Click \"More actions\" › Click \"Delete\""), in order.
// Only a top-level › parts them: one in quotes (Click "A › B") or in parentheses ("(its More options › Delete)") is
// part of its step.
export function fallbackSteps(note) {
  const m = /if it can['’]t:\s*(.+)$/i.exec(String(note || ''));
  if (!m) return [];
  const out = [];
  let cur = '', depth = 0, quote = null;
  for (const ch of m[1]) {
    if (quote) { if (ch === quote) quote = null; }
    else if (ch === '"') quote = '"';
    else if (ch === '“') quote = '”';
    else if (ch === '(') depth++;
    else if (ch === ')' && depth) depth--;
    else if (ch === '›' && !depth) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(x => x.trim()).filter(Boolean);
}

const quoted = s => [...String(s).matchAll(/["“]([^"“”]+)["”]/g)].map(m => m[1]);

// reset.md's Undo sections, with what each group of steps undoes (reset.mjs writes "Undoes:" under a group's first).
export function undoGroups(text) {
  const out = [];
  for (const part of String(text).split(/^(?=## )/m)) {
    const m = /^## Undo · (.+)$/m.exec(part);
    if (!m) continue;
    let app = null, group = null;
    for (const raw of part.split('\n').slice(1)) {
      const step = /^- (.+)$/.exec(raw), undoes = /^\s+Undoes:\s*(.+)$/.exec(raw), note = /^\s+Note:\s*(.+)$/.exec(raw), names = /^\s+Names:\s*(.+)$/.exec(raw);
      if (step) {
        const s = parseStep(step[1]);
        if (s.kind === 'app') { app = s.app; continue; }
        group = { app, title: m[1].trim(), steps: [s], undoes: [], note: null, names: [] };
        out.push(group);
      } else if (undoes && group) group.undoes = undoes[1].split(/;\s*/).map(x => x.trim());
      else if (note && group) group.note = note[1].trim();
      else if (names && group) group.names = quoted(names[1]);
    }
  }
  // A step with no Undoes line of its own belongs to the group before it (the rest of that undo).
  const merged = [];
  for (const g of out) { const last = merged[merged.length - 1]; if (!g.undoes.length && last && last.app === g.app) last.steps.push(...g.steps); else merged.push(g); }
  return merged;
}
// "beat 7, Press Enter": does it undo one of these writes?
const undoesAny = (g, ran) => g.undoes.some(u => { const m = /^beat (\d+), (.+)$/.exec(u); return m && ran.some(w => w.beat === +m[1] && norm(w.text) === norm(m[2])); });

// One claim ("shows \"17 curated here\"", "\"Sync\" is off") read on a screen as the reader reads it (claimScreen):
// { ok, status, why }. A claim in no form it knows fails: a reset it can't verify isn't one.
export function checkClaim(claim, sc, opts = {}) {
  const c = claimOf(claim);
  if (!c) return { ok: false, status: 'cant', why: `can't check "${claim}" on its own: say it as ${FORMS}` };
  const r = readClaim(c, sc, opts);
  return { ok: r.status === 'pass', ...r };
}

// "<app>: <claim>" → { app, rest } when app is one of the demo's.
const appTextOf = appIds => t => { const m = /^([\w-]+)\s*:\s*(.*)$/.exec(t); return m && appIds.includes(m[1]) ? { app: m[1], rest: m[2] } : null; };
const allowedIn = approval => (part, t) => ((approval && approval.reset) || []).some(x => x.part === part && norm(x.text) === norm(t));

// One reset step that changes something: approved (its part and words are in the approval), its placeholders filled,
// run by the walker as a write (the guard open for that one step, the control matched again). An API undo goes to
// apiUndo when given. → step(part, app, s, approvedText, { note }) → { ok, missing?, why? }
function writeStepper({ walker, approval, results = {}, did, apiUndo = null }) {
  const allowed = allowedIn(approval);
  const fill = t => String(t).replace(/\{(\w+)\}/g, (m, k) => results[k] || m);
  const step = async (part, app, s, approvedText, { note = null, names = [], undoes = [] } = {}) => {
    if (apiUndo && s.kind === 'free' && /^undo with the app pack:/i.test(s.text || '')) return apiUndo(part, app, s, approvedText, note, names, undoes);
    const filled = parseStep(fill(formatStep(s)));
    if (/\{\w+\}/.test(formatStep(filled))) return { ok: false, why: `${formatStep(s)}: the run didn't record what to fill in` };
    if (!allowed(part, approvedText)) return { ok: false, why: `"${approvedText}" isn't in the approved reset` };
    if (filled.kind === 'manual') return { ok: false, why: `${formatStep(filled)}: a person's step, and nobody's there` };
    if (filled.kind === 'free') return { ok: false, why: /^undo with the app pack/i.test(filled.text) ? `${filled.text}: the pack's API undo isn't run by the capture pass yet` : `"${filled.text}" isn't a step it can do on its own` };
    // Going to an app, waiting, scrolling or pointing changes nothing: run as a step, the guard holding as it does.
    const r = /^(app|wait|scroll|hover)$/.test(filled.kind) && walker.act ? await walker.act(app, filled) : await walker.write(app, filled);
    if (r.missing) return { ok: false, missing: true, why: r.why };
    if (r.needsYou) return { ok: false, why: r.why };
    did.push(`${app}: ${formatStep(filled)}`);
    return { ok: true };
  };
  return { step, allowed };
}

// Light or dark by the page's colours, when its markup doesn't say: the first background that isn't transparent, from
// the element at the middle of the window up (Copilot and the admin center paint theirs on an inner element; their
// html and body are transparent). → true (light), false (dark), null.
export const LIGHT_SRC = "return await page.evaluate(() => { let e = document.elementFromPoint(innerWidth / 2, innerHeight / 2); for (; e; e = e.parentElement) { const c = (getComputedStyle(e).backgroundColor.match(/[\\d.]+/g) || []).map(Number); if (c.length >= 3 && (c.length < 4 || c[3] > 0.5)) return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255 > 0.5; } return null; })";
// What a claim is read on: the app's screen now, in the reader's shape (its words, its controls and their states, its
// theme), as its start state was read from the recording; its theme by its colours when its markup doesn't say.
export async function claimScreen(walker, cmd, tab, app) {
  const reads = await walker.reads(app, { n: 1 }).catch(() => []);
  let sc;
  try { sc = readScreen((reads[0] || {}).docs || []); } catch (e) { return { error: e.message }; }
  if (!sc.theme) { const light = await cmd('js', { tab, code: LIGHT_SRC }, 30).catch(() => null); if (light === true || light === false) Object.assign(sc, { theme: light ? 'light' : 'dark', themeBy: 'colours' }); }
  return sc;
}

// One Set first or Set before line ({ what, set, opens }), in the walker's tab for its app: read on its page (Opens:,
// else the app's start), and when it isn't so, its control through its path ("Settings and more › Settings"), each
// click an approved write of `part`. → { ok, already?, why? }
async function setLine({ cmd, walker, tab, step, appOfText, packOf = () => null }, part, s) {
  const a = appOfText(s.what);
  if (!a) return { ok: false, why: `${s.what}: which app?` };
  if (s.opens) await cmd('goto', { tab: tab(a.app), url: s.opens }, 60).catch(() => {}); else await walker.home(a.app);
  await walker.quiet(a.app, 800, 15000);
  const now = checkClaim(a.rest, await claimScreen(walker, cmd, tab(a.app), a.app), { app: a.app, pack: packOf(a.app) });
  if (now.ok) return { ok: true, already: true };
  const [control] = quoted(s.set || '');
  const path = (/\(([^)]+)\)/.exec(s.set || '') || [])[1];
  if (!control) return { ok: false, why: `${s.what}: no control to set it with` };
  for (const p of path ? path.split(/\s*›\s*/) : []) { const r = await step(part, a.app, parseStep(`Click "${p}"`), s.what); if (!r.ok) return r; }
  const r = await step(part, a.app, parseStep(`Click "${control}"`), s.what);
  return r.ok ? { ok: true } : r;
}

// What stops a Set before block from running at all, before anything opens: a line for no app of the demo, one whose
// Set: names no pack write or a write its app pack lacks, one the approval doesn't list. → why, or null.
export function setBeforeProblem(block, { demo, packs = null, approval = null }) {
  const appOfText = appTextOf((demo.cfg.apps || []).map(a => a.id)), allowed = allowedIn(approval);
  const byPack = packs && packs.packsForDemo ? Object.values(packs.packsForDemo(demo.cfg) || {}).filter(Boolean) : [];
  for (const s of block.items || []) {
    if (!appOfText(s.what)) return `${s.what}: which app?`;
    const tag = /·\s*([\w-]+):([\w-]+)\s*$/.exec(s.set || '');
    if (!tag) return `${s.what}: its Set: line names no pack write, so it isn't set`;
    const pack = byPack.find(x => x.id === tag[1]);
    if (!pack || !(pack.writes || []).some(w => w.id === tag[2])) return `${s.what}: the ${tag[1]} pack has no "${tag[2]}" write, so it isn't set`;
    if (!allowed('before', s.what)) return `"${s.what}" isn't in the approved reset`;
  }
  return null;
}

// reset.md's "## Set before beat N, <step>" (parseReset's before: { beat, text, n, items }): just before that step,
// off camera, each line set as Set first sets it, as an approved write (part 'before'), in a tab of its own of the same
// capture browser (capTab, at its Opens: page), then read there again. The recorded tab is never navigated, and no
// screen of it is saved. Fails closed before any tab opens: a line whose app pack lacks the write its Set: names, or
// that the approval doesn't list. walkerFor(tabs): a live walker for those tabs ({ app: mark }), not recording.
// → { ok, did: [...], items: [{ text, already, ok, why? }], why }
export async function setBefore({ demo, cmd, packs = null, approval, block, walkerFor, results = {}, emit = () => {} }) {
  const appIds = (demo.cfg.apps || []).map(a => a.id), appOfText = appTextOf(appIds);
  const did = [], items = [];
  const bad = setBeforeProblem(block, { demo, packs, approval });
  if (bad) return { ok: false, did, items, why: bad };
  const marks = {};
  try {
    for (const s of block.items) {
      const a = appOfText(s.what), app = a.app;
      if (!marks[app]) {
        marks[app] = `set-before:${app}`;
        const url = s.opens || ((demo.cfg.apps || []).find(x => x.id === app) || {}).url;
        await cmd('capTab', { open: url, mark: marks[app] }, 120);
        emit({ event: 'set-before', stage: 'tab', app });
      }
      const walker = walkerFor({ [app]: marks[app] }), tab = () => marks[app];
      const { step } = writeStepper({ walker, approval, results, did });
      const r = await setLine({ cmd, walker, tab, step, appOfText }, 'before', s);
      if (!r.ok) { items.push({ text: s.what, ok: false, why: r.why }); return { ok: false, did, items, why: `${s.what}: ${r.why}` }; }
      await walker.quiet(app, 800, 15000);
      const now = checkClaim(a.rest, await claimScreen(walker, cmd, tab(), app));
      items.push({ text: s.what, already: !!r.already, ok: now.ok, ...(now.ok ? {} : { why: now.why }) });
      if (!now.ok) return { ok: false, did, items, why: `${s.what}: set off camera, then ${now.why}` };
    }
  } finally {
    for (const m of Object.values(marks)) await cmd('capTab', { close: m }, 30).catch(() => {});
  }
  return { ok: true, did, items, why: null };
}

// reset.md's Check lines read live, read-only: each as checkable() says, its screen reached once for every line read
// there (the app's start, the pack's address or steps, or the plan's navigation steps), proven, then read as the reader
// reads it. recorded: the recording's walker (walker.mjs), for the routes and the start screen's rows. shot(app, name):
// a picture of each screen read. → [{ text, from, status: 'pass' | 'wrong' | 'cant', ok, why, picture? }]
// reland: each app loaded again at its start (a real page load) and proven there before its first check (after a run,
// a side path can leave a pane or a route behind that a goto to the same document keeps).
// made: what the run's writes named (their pack's names, { <app>: { skill: [..] } }): a check looks for those too.
export async function checkLines({ demo, cmd, walker, lines, plan, packs = null, recorded = null, shot = null, reland = false, made = {} }) {
  const appIds = (demo.cfg.apps || []).map(a => a.id), appOf = x => (walker.appOf && walker.appOf(x)) || x;
  const index = packIndex(packs, demo.cfg);
  const values = checkValues({ plan, walker: recorded, cfg: demo.cfg, appOf });
  for (const [app, kv] of Object.entries(made || {})) for (const [k, v] of Object.entries(kv)) {
    const o = values[app] = values[app] || {};
    if (o[k] === undefined || Array.isArray(o[k])) o[k] = [...new Set([...(o[k] || []), ...[].concat(v)])];
  }
  const ctx = { plan, index, walker: recorded, values, appIds, appOf };
  const out = [];
  let at = null, seen = null, n = 0;
  const landed = new Set();
  const visit = async (app, route) => {
    let fresh = false;
    if (reland && !landed.has(app)) {
      landed.add(app); fresh = true;
      await walker.home(app, { fresh: true });
      const st = walker.startCheck ? await walker.startCheck(app, plan).catch(e => ({ ok: false, why: e.message })) : { ok: true };
      if (!st.ok) return { why: `loaded again at its start, it isn't there: ${st.why}` };
    }
    if (route.open) await cmd('goto', { tab: appTab(demo, app), url: route.open }, 90).catch(() => {});
    else if (!fresh) await walker.home(app);
    await walker.quiet(app, 800, 20000);
    for (const [i, s] of (route.steps || []).entries()) {
      const r = await walker.step({ app }, s).catch(e => ({ landed: false, why: e.message }));
      const last = i === route.steps.length - 1;
      // On the way, a step the plan gives no proof of goes on (the next one finds its control or doesn't); the last
      // lands on the screen's proof.
      if (r.landed || (r.kind === 'unproven' && (!last || !(s.lands && s.lands.kind)))) continue;
      return { why: `on the way there, ${formatStep(s)}: ${r.why || "it didn't land"}` };
    }
    await walker.quiet(app, 800, 15000);
    // Its page's words, given a little time: a page that draws a count late (Copilot's "Added (3)").
    if (route.lands) {
      let on = false;
      for (const t0 = Date.now(); !(on = norm(await walker.words(app).catch(() => '')).includes(norm(route.lands))) && Date.now() - t0 < 15000;) await sleep(1500);
      if (!on) return { why: `"${route.lands}" isn't on the screen: not the page this check reads` };
    }
    const sc = await claimScreen(walker, cmd, appTab(demo, app), app);
    const picture = shot ? await shot(app, `check-${++n}-${app}`).catch(() => null) : null;
    return { sc, picture };
  };
  for (const line of lines) {
    const text = checkLine(line), from = (line && line.from) || null;
    const c = checkable(line, ctx);
    // plan: it can't be checked with this plan (no way there, no proof of its page); setup: the check itself can't be
    // read (its pack, a value, its words); the others (below) couldn't be read now.
    if (!c.ok) { out.push({ text, from, status: 'cant', ok: false, why: c.why, ...(c.plan ? { plan: true } : { setup: true }) }); continue; }
    const key = routeKey(c.app, c.route);
    if (key !== at) { at = key; seen = await visit(c.app, c.route); }
    if (seen.why) { out.push({ text, from, status: 'cant', ok: false, why: seen.why }); continue; }
    let kept = null;
    if (c.claim.kind === 'rows' && recorded) {
      const start = recorded.start(c.app), sc0 = start ? recorded.screen(start) || recorded.shown(start) : null;
      kept = sc0 ? rowsAfter(sc0, c.claim.label) : null;
    }
    const r = readClaim(c.claim, seen.sc, { app: c.app, pack: index.of(c.app), kept });
    out.push({ text, from, status: r.status, ok: r.status === 'pass', ...(r.why ? { why: r.why } : {}), ...(seen.picture ? { picture: seen.picture } : {}) });
  }
  return out;
}

export async function runReset({ demo, cmd, walker, phase, approval, ran = [], results = {}, emit = () => {}, shot = null }) {
  const P = (demo.cfg && demo.cfg.preflight) || {};
  // The demo's own scripts: the check, then the fix and the check again (preflight's checkReset).
  if (P.reset) {
    const { checkReset } = await import('@stuntdouble/core/lib/preflight.mjs');
    const { send, flowScript } = await import('@stuntdouble/capture/cli.mjs');
    const port = +(process.env.REPLICA_RX_PORT || demo.cfg.receiverPort);
    const run = async (file, tmoS) => { const r = await send(flowScript(join(demo.dir, file), { apps: demo.cfg.apps }), tmoS, port); return r.ok ? r.value : { error: r.error }; };
    const r = await checkReset(P, run, true);
    return { ok: r.status === 'ok' || r.status === 'fixed', how: 'scripts', did: r.status === 'fixed' ? [P.resetFix] : [], checks: [{ text: P.reset, ok: r.status !== 'fail', why: r.detail }], why: r.status === 'fail' ? r.detail : null };
  }
  const f = join(demo.dir, 'reset.md');
  if (!existsSync(f)) return { ok: true, how: 'none', did: [], checks: [], why: null };
  const text = readFileSync(f, 'utf8');
  const { parseReset } = await import('./reset.mjs');
  const parsed = parseReset(text);
  const groups = undoGroups(text);
  const appIds = (demo.cfg.apps || []).map(a => a.id);
  const appOfText = appTextOf(appIds);
  const did = [];
  const home = app => walker.home(app);
  const { walkerPacks } = await import('./live.mjs');
  const packs = await walkerPacks();
  const index = packIndex(packs, demo.cfg);
  const { walkerFromDemo } = await import('./walker.mjs');
  const recorded = (() => { try { return walkerFromDemo(demo); } catch (e) { return null; } })();
  const { readPlan } = await import('./draft.mjs');
  const plan = readPlan(demo);
  const { step, allowed } = writeStepper({ walker, approval, results, did, apiUndo: (...a) => apiUndo(...a) });
  // "Undo with the app pack: <pack>:<write>": the pack's API undo (a private pack's), in the app's own signed-in session,
  // with what the run made; if it can't, the steps its Note gives, each approved and run as a write. Nothing a run
  // recorded (the reset before): the script's own leftovers found by name (the group's Names, as approved, through the
  // pack's find), each undone by its id. Never a name the recording's start screen shows (one the demo may keep).
  const apiUndo = async (part, app, s, approvedText, note, names = [], undoes = []) => {
    if (!allowed(part, approvedText)) return { ok: false, why: `"${approvedText}" isn't in the approved reset` };
    const m = /^undo with the app pack:\s*([\w-]+):([\w-]+)\s*$/i.exec(s.text);
    const fall = async why => {
      const steps = fallbackSteps(note);
      if (!steps.length) return { ok: false, why: `${s.text}: ${why}, and its Note gives no steps for when it can't` };
      for (const t of steps) { const r = await step(part, app, parseStep(t), t); if (!r.ok) return { ...r, why: `${s.text}: ${why}; then ${r.why}` }; }
      return { ok: true, fallback: why };
    };
    if (!m) return fall('it names no pack and write');
    const pack = index.byId(m[1]);
    const pw = pack && (pack.writes || []).find(w => w.id === m[2]);
    const api = pw && pw.undo && pw.undo.api, at = api && pack.apis && pack.apis[api.use];
    if (!api || !at) return fall(`the ${m[1]} pack has no API undo for ${m[2]}`);
    const appCfg = (demo.cfg.apps || []).find(a => a.id === app) || {};
    // found: the id its find picked, over the demo's values too (a value of the same name never stands in for it).
    const call = async (vals, label, found = {}) => {
      const fl = fillApi(api, vals, { ...(appCfg.values || {}), ...found });
      if (fl.left.length) return { ok: false, left: fl.left };
      const r = await cmd('capApi', { tab: appTab(demo, app), open: at.open, host: at.host, hostPattern: at.hostPattern, from: at.from || null, method: api.method, path: fl.path, body: fl.body }, 150).catch(e => ({ ok: false, why: e.message }));
      if (r.ok) did.push(`${app}: ${s.text}${label} (${api.method}, ${r.status})`);
      return r;
    };
    const find = pw.undo.find, fat = find && pack.apis && pack.apis[find.use];
    // A find with a where (only her own skills, never a plugin's): nothing is undone until the find has seen it there,
    // never called on its own.
    const viaFind = !!(find && fat && find.where);
    // The pack's find (a GET of its list), by ids (the one a write recorded, or a ':' part of it) or by names. → the
    // ids it found, or { why } when it didn't answer with a list: a failed find is never "nothing to undo".
    const findIn = async by => {
      const fl = fillApi({ path: find.path }, {}, appCfg.values);
      if (fl.left.length) return { why: `its find needs ${fl.left.join(', ')}` };
      const r = await cmd('capApi', { tab: appTab(demo, app), open: fat.open, host: fat.host, hostPattern: fat.hostPattern, from: fat.from || null, method: 'GET', path: fl.path, find: { list: find.list, name: find.name, id: find.id, ...by, where: find.where || null } }, 150).catch(e => ({ ok: false, why: e.message }));
      if (!r.ok || !(r.status >= 200 && r.status < 300) || !Array.isArray(r.found)) return { why: r.why || (r.status ? `the API answered ${r.status}` : 'no list in its answer') };
      return { found: r.found };
    };
    // After a run: each write this group undoes, with what that write made. Its recorded id first; if the API won't
    // take it, or the run recorded none (the write's request held, or no id in its address), the find: by that id,
    // else by the group's names (exactly, never a name the recording's start screen shows). Nothing found in a list the
    // API answered is nothing to undo; anything else falls to the Note's steps.
    const writes = phase === 'after' ? (undoes || []).map(u => /^beat (\d+), (.+)$/.exec(u)).filter(Boolean).map(m => ran.find(w => w.beat === +m[1] && norm(w.text) === norm(m[2]))).filter(Boolean) : [];
    if (writes.length) {
      for (const w of writes) {
        const vals = { ...results, ...(w.values || {}) }, label = ` (beat ${w.beat})`;
        const r = viaFind ? (fl => fl.left.length ? { ok: false, left: fl.left } : { ok: false, why: 'only through its find' })(fillApi(api, vals, appCfg.values)) : await call(vals, label);
        if (r.ok) continue;
        if (!find || !fat) return fall(r.left ? `the run didn't record ${r.left.join(', ')}` : r.why || `the API answered ${r.status}`);
        const id = r.left ? null : vals[find.as];
        // By name: the group's names, exactly, never one the recording's start screen shows.
        const nameFind = () => {
          if (!names.length) return { why: 'the group names nothing to find' };
          const findText = `Find by name: ${names.map(x => `"${x}"`).join(', ')}`;
          if (!allowed(part, findText)) return { refused: `"${findText}" isn't in the approved reset` };
          const start = recorded && recorded.start(app), sc0 = start ? recorded.screen(start) || recorded.shown(start) : null;
          const { mine, kept } = byName(names, sc0);
          if (kept.length) did.push(`${app}: not found by name, the start screen shows it too: ${kept.map(x => `"${x}"`).join(', ')}`);
          return mine.length ? { by: { names: mine } } : { why: 'each name is one the start screen shows' };
        };
        let f = null, by = null;
        if (id) { by = { ids: [...new Set([String(id), ...String(id).split(':')])].filter(Boolean) }; f = await findIn(by); if (f.why) return fall(`finding beat ${w.beat}'s ${find.as}: ${f.why}`); }
        if (!f || !f.found.length) {
          const n = nameFind();
          if (n.refused) return { ok: false, why: n.refused };
          if (n.by) { const fn = await findIn(n.by); if (fn.why) return fall(`finding beat ${w.beat}'s names: ${fn.why}`); if (fn.found.length || !f) { f = fn; by = n.by; } else by = { ...by, names: n.by.names }; }
          else if (!f) return fall(`the run didn't record ${(r.left || [find.as]).join(', ')}, and ${n.why}`);
        }
        if (!f.found.length) { did.push(`${app}: ${s.text}${label}: nothing to undo (its list answered, with ${id ? `no ${find.as} ${id}` : ''}${id && by.names ? ' and ' : ''}${by.names ? `nothing called ${by.names.map(x => `"${x}"`).join(', ')}` : ''})`); continue; }
        for (const fid of f.found) { const u = await call(vals, `${label}, found by ${by.names ? 'name' : 'id'}`, { [find.as]: fid }); if (!u.ok) return fall(u.why || `the API answered ${u.status}`); }
      }
      return { ok: true };
    }
    const first = viaFind ? { ok: false, why: 'only through its find' } : await call(results, '');
    if (first.ok) return { ok: true };
    // Nothing recorded (the reset before, or a write the run never recorded): its leftovers by name, before or after.
    if ((first.left || viaFind) && find && fat && names.length) {
      const findText = `Find by name: ${names.map(x => `"${x}"`).join(', ')}`;
      if (!allowed(part, findText)) return { ok: false, why: `"${findText}" isn't in the approved reset` };
      const start = recorded && recorded.start(app), sc0 = start ? recorded.screen(start) || recorded.shown(start) : null;
      const { mine, kept } = byName(names, sc0);
      if (kept.length) did.push(`${app}: not found by name, the start screen shows it too: ${kept.map(x => `"${x}"`).join(', ')}`);
      if (!mine.length) return fall('the run didn\'t record what it made, and each name is one the start screen shows');
      const fl = fillApi({ path: find.path }, {}, appCfg.values);
      if (fl.left.length) return fall(`its find needs ${fl.left.join(', ')}`);
      const r = await cmd('capApi', { tab: appTab(demo, app), open: fat.open, host: fat.host, hostPattern: fat.hostPattern, from: fat.from || null, method: 'GET', path: fl.path, find: { list: find.list, name: find.name, id: find.id, names: mine, where: find.where || null } }, 150).catch(e => ({ ok: false, why: e.message }));
      if (!r.ok || !Array.isArray(r.found)) return fall(`finding ${mine.join(', ')} by name: ${r.why || (r.status ? `the API answered ${r.status}` : 'no list in its answer')}`);
      for (const id of r.found) { const u = await call(results, ' (found by name)', { [find.as]: id }); if (!u.ok) return fall(u.why || `the API answered ${u.status}`); }
      if (!r.found.length) did.push(`${app}: ${s.text}: nothing by those names`);
      return { ok: true };
    }
    if (first.left) return fall(`the run didn't record ${first.left.join(', ')}`);
    return fall(first.why || `the API answered ${first.status}`);
  };
  const runGroups = async list => {
    const out = [];
    for (const g of list) {
      await home(g.app);
      for (const [i, s] of g.steps.entries()) {
        const r = await step('undo', g.app, s, formatStep(s), { note: g.note, names: g.names || [], undoes: g.undoes });
        // Nothing to undo there (its first step's control isn't on the screen): a clean tenant.
        if (!r.ok && r.missing && i === 0) { out.push({ group: g.undoes.join('; '), skipped: r.why }); break; }
        if (!r.ok) { out.push({ group: g.undoes.join('; '), failed: r.why }); return { ok: false, why: r.why, out }; }
      }
      out.push({ group: g.undoes.join('; '), done: true });
    }
    return { ok: true, out };
  };
  const setFirst = async () => {
    for (const s of parsed.set) {
      const r = await setLine({ cmd, walker, tab: a => appTab(demo, a), step, appOfText, packOf: index.of }, 'set', s);
      if (!r.ok) return r;
    }
    return { ok: true };
  };
  const made = {};
  if (phase === 'after') for (const w of ran) for (const [k, v] of Object.entries(w.made || {})) { const o = made[w.app] = made[w.app] || {}; o[k] = [...(o[k] || []), v]; }
  // Her own items, for each undo whose pack find has a where (her own skills, never a plugin's): everything it picks,
  // read-only. One the recording's start screen doesn't show is a leftover, from this run or an earlier one under a
  // name no run recorded (Copilot names a skill differently each run): the line is wrong, and points at that undo's
  // group (its Names find it, before a run or after).
  const ownLines = async () => {
    const out = [];
    for (const g of groups) {
      const m = /^undo with the app pack:\s*([\w-]+):([\w-]+)\s*$/i.exec(((g.steps || []).find(x => /^undo with the app pack:/i.test(x.text || '')) || {}).text || '');
      const pack = m && index.byId(m[1]), pw = pack && (pack.writes || []).find(w => w.id === m[2]);
      const find = pw && pw.undo && pw.undo.find, fat = find && pack.apis && pack.apis[find.use];
      if (!find || !fat || !find.where || !Object.keys(find.where).length) continue;
      const beat = (/^(beat \d+),/.exec(g.undoes[0] || '') || [])[1] || '';
      const text = `${g.app}: her own ${find.by || 'item'}s (${Object.entries(find.where).map(([k, v]) => `${k} ${v}`).join(', ')}) are only those the demo starts with`;
      const fl = fillApi({ path: find.path }, {}, ((demo.cfg.apps || []).find(a => a.id === g.app) || {}).values);
      const q = fl.left.length ? { ok: false, why: `its find needs ${fl.left.join(', ')}` }
        : await cmd('capApi', { tab: appTab(demo, g.app), open: fat.open, host: fat.host, hostPattern: fat.hostPattern, from: fat.from || null, method: 'GET', path: fl.path, find: { list: find.list, name: find.name, id: find.id, all: true, where: find.where } }, 150).catch(e => ({ ok: false, why: e.message }));
      if (!q.ok || !(q.status >= 200 && q.status < 300) || !Array.isArray(q.found)) { out.push({ text, from: beat, status: 'cant', ok: false, why: q.why || (q.status ? `the API answered ${q.status}` : 'no list in its answer') }); continue; }
      const start = recorded && recorded.start(g.app), sc0 = start ? recorded.screen(start) || recorded.shown(start) : null;
      const { mine } = byName(q.found, sc0);
      out.push(mine.length ? { text, from: beat, status: 'wrong', ok: false, why: `it also has ${mine.map(x => `"${x}"`).join(', ')} (left by a run: to undo one no run recorded, add it to the Names of "${g.steps[0] ? formatStep(g.steps[0]) : g.title}")` } : { text, from: beat, status: 'pass', ok: true });
    }
    return out;
  };
  const checkAll = async () => [...await checkLines({ demo, cmd, walker, lines: parsed.checks, plan, packs, recorded, shot, reland: phase === 'after', made }), ...await ownLines()];
  // After the reset did something: a line still wrong is read again once, a few seconds later. An app can still be
  // answering the undo's call when its screen reloads to be read (the page went quiet before its server did).
  const checkAfterDoing = async () => { let cs = await checkAll(); if (did.length && cs.some(c => c.status === 'wrong')) { await sleep(4000); cs = await checkAll(); } return cs; };
  // The undo groups a wrong line is about: a write's (From: beat N), a pack effect's (what a run leaves, and the undos
  // of the writes it's what's left of: its leftOf), none for a start state (Set first sets it), every group for a line
  // that says nothing of where it's from.
  const writeAt = new Map();
  ((plan && plan.beats) || []).forEach((b, bi) => b.steps.forEach(x => { const t = / · ([\w-]+:[\w-]+)$/.exec(x.writes || ''); if (t) writeAt.set(norm(`beat ${bi + 1}, ${formatStep(x)}`), t[1]); }));
  const writesOf = g => g.undoes.map(x => writeAt.get(norm(x))).filter(Boolean);
  const groupsFor = wrong => {
    const out = new Set();
    for (const c of wrong) {
      const from = String(c.from || '');
      let m;
      if (/^start\b/.test(from)) continue;
      if ((m = /^beat (\d+)\b/.exec(from))) { for (const g of groups) if (g.undoes.some(u => u.startsWith(`beat ${m[1]},`))) out.add(g); continue; }
      if ((m = /^([\w-]+): ([\w-]+)$/.exec(from))) {
        const e = ((index.byId(m[1]) || {}).effects || []).find(x => x.id === m[2]);
        for (const g of groups) if (e && g.undoes.some(u => norm(u) === norm(`what a run leaves: ${e.what}`))) out.add(g);
        for (const g of groups) if (e && (e.leftOf || []).some(w => writesOf(g).includes(`${m[1]}:${w}`))) out.add(g);
        continue;
      }
      for (const g of groups) out.add(g);
    }
    return groups.filter(g => out.has(g));
  };
  const cantOf = cs => cs.filter(c => c.status === 'cant'), wrongOf = cs => cs.filter(c => c.status === 'wrong');
  const listOf = cs => cs.map(c => `${c.text} (${c.why})`).join('; ');
  emit({ event: 'reset', phase, stage: 'check' });
  if (phase === 'before') {
    let checks = await checkAll();
    // A line it can't read stops it here, as itself: nothing is undone for what it can't see.
    if (cantOf(checks).length) return { ok: false, kind: 'check', how: 'reset.md', did, checks, why: `it can't read ${cantOf(checks).length === 1 ? 'a check' : `${cantOf(checks).length} checks`}: ${listOf(cantOf(checks))}` };
    if (!wrongOf(checks).length) return { ok: true, how: 'reset.md', did, checks, why: null };
    emit({ event: 'reset', phase, stage: 'fix', failing: wrongOf(checks).map(c => c.text) });
    const u = await runGroups(groupsFor(wrongOf(checks)));
    if (!u.ok) return { ok: false, how: 'reset.md', did, checks, undo: u.out, why: `the undo stopped: ${u.why}` };
    const st = await setFirst();
    if (!st.ok) return { ok: false, how: 'reset.md', did, checks, undo: u.out, why: `setting the start: ${st.why}` };
    checks = await checkAfterDoing();
    const bad = [...wrongOf(checks), ...cantOf(checks)];
    return { ok: !bad.length, ...(cantOf(checks).length ? { kind: 'check' } : {}), how: 'reset.md', did, checks, undo: u.out, why: bad.length ? `still not as the demo starts: ${listOf(bad)}` : null };
  }
  // After: the undos of what ran, the start set again, the check; the rest only for lines read and found wrong.
  const mine = groups.filter(g => undoesAny(g, ran));
  const u = await runGroups(mine);
  const st = u.ok ? await setFirst() : { ok: false, why: u.why };
  let checks = await checkAfterDoing();
  let u2 = null;
  if (wrongOf(checks).length) {
    const more = groupsFor(wrongOf(checks)).filter(g => !mine.includes(g));
    if (more.length) { u2 = await runGroups(more); checks = await checkAfterDoing(); }
  }
  const bad = [...wrongOf(checks), ...cantOf(checks)];
  const ok = u.ok && st.ok && !bad.length;
  return { ok, ...(cantOf(checks).length ? { kind: 'check' } : {}), how: 'reset.md', did, checks, undo: [...(u.out || []), ...((u2 && u2.out) || [])], why: ok ? null : [!u.ok && `the undo stopped: ${u.why}`, !st.ok && `setting the start: ${st.why}`, bad.length && `not as the demo starts: ${listOf(bad)}`].filter(Boolean).join('; ') };
}
