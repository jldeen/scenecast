// reset.md's Check lines, as a machine reads them: one rule for `ai reset` (what it can write as a check), approve (a
// line it can't check is refused before she's asked), `ai check`, a walk's start and the run's reset.
//   checkable(line, ctx) → { ok: true, app, claim, route, source } | { ok: false, why }
//     line: parseReset's { app, screen, text, from }. A line from a pack check (From: beat N[, pack:write] or
//     pack: effect) is read as the pack says: its open address or steps, the words that prove its page (lands) and its
//     look, the look's values from the plan (what its writes make), the recording (the start screen's rows) and the
//     demo (demo.json apps[].values). Any other line is a claim in one of the forms `ai reset` writes, read on its
//     screen: the app's start, or the plan's own navigation steps from the start to it, ending on that screen's proof.
//   readClaim(claim, screen, { app, pack, kept }) → { status: 'pass' | 'wrong' | 'cant', why }
//     On the reader's screen (readScreen), with the facts the start state was read by (start.mjs factsOf). cant: the
//     screen doesn't say (no such switch, no version, a box's text longer than the read keeps): never a reason to undo.
import { parseStep, formatStep, risk } from './plan.mjs';
import { factsOf } from './start.mjs';
import { norm } from './find.mjs';
import { isBox } from './landing.mjs';
import { BOX_MAX } from '@scenecast/script/html.mjs';

const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
const quoted = s => [...String(s).matchAll(/["“]([^"“”]+)["”]/g)].map(m => m[1]);
const listOf = s => String(s).split(/\s*,\s*|\s+and\s+/).map(clean).filter(Boolean);
const no = why => ({ ok: false, why });
export const FORMS = 'shows "…", no "…", "…" is on/off, "…" is picked, "…" lists …, … is version …, or renders light/dark';

// A line's words as a claim, in the forms `ai reset` writes (reset.mjs startText, inverseOf). null: not one of them.
export function claimOf(text) {
  const t = clean(text);
  let m;
  if ((m = /^shows ["“](.+)["”]$/.exec(t))) return { kind: 'shows', texts: [m[1]] };
  if ((m = /\(["“](.+)["”] shows\)$/.exec(t))) return { kind: 'shows', texts: [m[1]] };
  if ((m = /^["“](.+)["”] is (on|off)$/.exec(t))) return { kind: 'toggle', subject: m[1], value: m[2] };
  if ((m = /^["“](.+)["”] is picked(?: \((.+)\))?$/.exec(t))) return { kind: 'choice', value: m[1], options: m[2] ? m[2].split(/\s*\|\s*/) : null };
  if ((m = /^(.+?) is version v?(\d+(?:\.\d+){1,3})$/i.exec(t))) return { kind: 'version', subject: m[1].replace(/^["“]|["”]$/g, ''), value: m[2] };
  if ((m = /^["“](.+)["”] doesn['’]t list ["“](.+)["”]$/.exec(t))) return { kind: 'absent', texts: [m[2]] };
  if ((m = /^["“](.+)["”] lists (.+)$/.exec(t))) return { kind: 'list', subject: m[1], items: listOf(m[2]) };
  if ((m = /^renders (light|dark)$/.exec(t))) return { kind: 'theme', value: m[1] };
  if (/^no\b/.test(t) && quoted(t).length) return { kind: 'absent', texts: [quoted(t)[0]] };
  return null;
}

// The words after a label in its part of the page (Recent's tasks in the sidebar): every item the reader puts after
// the label's own, in the same region. null when the label isn't there.
export function rowsAfter(sc, label) {
  const items = (sc && sc.items) || [];
  const i = items.findIndex(x => norm(x.text) === norm(label));
  if (i < 0) return null;
  const region = items[i].region;
  return items.slice(i + 1).filter(x => x.region === region).map(x => clean(x.text)).filter(Boolean);
}

const pass = () => ({ status: 'pass' });
const wrong = why => ({ status: 'wrong', why });
const cant = why => ({ status: 'cant', why });
export function readClaim(claim, sc, { app = null, pack = null, kept = null } = {}) {
  if (!sc || sc.error) return cant("the screen couldn't be read");
  const has = t => norm(sc.text).includes(norm(t)) || (sc.controls || []).some(c => norm(c.name) === norm(t));
  const facts = factsOf(sc, { app, pack });
  const ctls = (sc.controls || []).filter(c => !c.left);
  switch (claim.kind) {
    case 'shows': { const miss = claim.texts.filter(t => !has(t)); return miss.length ? wrong(`"${miss[0]}" isn't on the screen`) : pass(); }
    case 'absent': { const there = claim.texts.filter(has); return there.length ? wrong(`"${there[0]}" is still there`) : pass(); }
    case 'toggle': {
      const f = facts.find(x => x.kind === 'toggle' && x.key === norm(claim.subject));
      if (!f) return cant(`no switch for "${claim.subject}" on the screen`);
      return f.value === claim.value ? pass() : wrong(`"${claim.subject}" is ${f.value}`);
    }
    case 'choice': {
      const names = (claim.options || [claim.value]).map(norm);
      const radios = ctls.filter(c => c.role === 'radio' && names.includes(norm(c.name)));
      if (!radios.some(c => norm(c.name) === norm(claim.value))) return cant(`no "${claim.value}" to pick on the screen`);
      if (radios.some(c => typeof c.on !== 'boolean')) return cant(`the screen doesn't say which of ${(claim.options || [claim.value]).join(' | ')} is picked`);
      const on = radios.find(c => c.on);
      return on && norm(on.name) === norm(claim.value) ? pass() : wrong(on ? `"${on.name}" is picked` : 'none is picked');
    }
    case 'version': {
      const vs = facts.filter(x => x.kind === 'version'), s = norm(claim.subject);
      const f = vs.find(x => x.key.startsWith(s) || s.startsWith(x.key)) || (vs.length === 1 && has(claim.subject) ? vs[0] : null);
      if (!f) return cant(`no version of ${claim.subject} on the screen`);
      return f.value === claim.value ? pass() : wrong(`it's version ${f.value}`);
    }
    case 'list': {
      // The count in a list's heading ("Added (4)") changes with what's in it: the list is its items.
      const key = norm(claim.subject.replace(/\s*\(\d+\)$/, ''));
      const f = facts.find(x => x.kind === 'list' && x.key === key);
      if (!f) return cant(`no list "${claim.subject.replace(/\s*\(\d+\)$/, '')}" of switches on the screen`);
      const got = f.value.split(', ').map(norm), want = claim.items.map(norm);
      const missing = claim.items.filter(x => !got.includes(norm(x))), extra = f.value.split(', ').filter(x => !want.includes(norm(x)));
      return missing.length || extra.length ? wrong([missing.length && `it doesn't list ${missing.join(', ')}`, extra.length && `it also lists ${extra.join(', ')}`].filter(Boolean).join('; ')) : pass();
    }
    case 'theme': {
      const f = facts.find(x => x.kind === 'theme');
      if (!f) return cant("couldn't read the page's colours");
      return f.value === claim.value ? pass() : wrong(`it renders ${f.value}`);
    }
    case 'equals': {
      const box = ctls.find(c => isBox(c) && norm(c.name).includes(norm(claim.field)));
      if (!box) return cant(`no box for ${claim.field} on the screen`);
      // Its text past what the read keeps: an exact match can't be decided.
      if (box.cut) return cant(`its text is longer than a read keeps (${BOX_MAX} characters)`);
      const a = clean(box.value), b = clean(claim.text);
      return a === b ? pass() : wrong(`its text isn't the demo's (${a.length} characters, the demo's ${b.length})`);
    }
    case 'rows': {
      const rows = rowsAfter(sc, claim.label);
      if (!rows) return cant(`no "${claim.label}" on the screen`);
      if (!kept) return cant(`the recording's start screen has no "${claim.label}" to compare with`);
      // Each row the recording didn't have (as many times as it had it): something a run left.
      const left = [...kept], extra = [];
      for (const r of rows) { const i = left.findIndex(k => norm(k) === norm(r)); if (i >= 0) left.splice(i, 1); else extra.push(r); }
      return extra.length ? wrong(`${claim.label} also has ${extra.map(x => `"${x}"`).join(', ')}`) : pass();
    }
  }
  return cant(`can't read a "${claim.kind}" claim`);
}

// Can the check take this step on its own way to a screen: navigation (a click, a hover, a scroll, a wait), or a search
// (typing in a box whose Enter isn't a send). → null, or why not.
function notNavigation(s, prev) {
  if (s.writes) return 'writes';
  if (/^(click|hover)$/.test(s.kind)) return risk(s, null, null) ? 'could write' : null;
  if (/^(scroll|wait)$/.test(s.kind)) return null;
  if (s.kind === 'type') return risk({ kind: 'press', key: 'Enter' }, null, { name: s.target || '' }) ? 'types in a message box' : null;
  if (s.kind === 'press') return s.key === 'Enter' && prev && prev.kind === 'type' && !risk(s, null, { name: prev.target || '' }) ? null : 'presses a key a check can\'t';
  return 'isn\'t a step a check can take';
}
const proven = s => !!(s && s.lands && s.lands.kind);
const onScreen = (controls, target) => (controls || []).some(c => { const a = norm(c.name), b = norm(target); return a && b && (a === b || a.startsWith(b)); });

// A read-only way to a screen of an app: the app's start (walker.home), then the plan's own steps that land there, all
// navigation, the first of them a control the recorded start screen has, the last proving the screen.
// → { route: { home: true, steps } } | { why }
export function routeTo(plan, app, screen, { walker = null, appOf = x => x } = {}) {
  let on = null;
  const mine = [];
  for (const s of ((plan && plan.beats) || []).flatMap(b => b.steps)) { if (s.kind === 'app') on = appOf(s.app) || s.app; if (on === app) mine.push(s); }
  const goTo = mine.find(s => s.kind === 'app');
  const start = (goTo && goTo.lands && goTo.lands.screen) || (walker && walker.start ? walker.start(app) : null);
  if (!screen || screen === start) return { route: { home: true, steps: [] } };
  const x = mine.findIndex(s => s.kind !== 'app' && s.lands && s.lands.screen === screen);
  if (x < 0) return { why: `the plan never lands on ${screen}` };
  if (!proven(mine[x])) return { why: `the plan gives no proof of ${screen}` };
  // The start screen as recorded: the plan's name for it, else the recording's own start of the app.
  const rec = id => id && walker ? walker.screen(id) || (walker.shown && walker.shown(id)) : null;
  const startScreen = walker ? rec(start) || rec(walker.start && walker.start(app)) : null;
  const steps = k => mine.slice(k, x + 1).filter(s => s.kind !== 'app');
  for (let k = x; k >= 0; k--) {
    const s = mine[k];
    // Going back to the app carries on where it was; its first Go to is its start.
    if (s.kind === 'app') { if (s === goTo) return { route: { home: true, steps: steps(k + 1) } }; continue; }
    const bad = notNavigation(s, mine[k - 1]);
    if (bad) return { why: `the way to ${screen} passes ${formatStep(s)}, which ${bad}` };
    if (startScreen && s.target && onScreen(startScreen.controls, s.target)) return { route: { home: true, steps: steps(k) } };
  }
  return { why: `no read-only way from ${app}'s start to ${screen}` };
}

// The app packs by app and by id, from either shape (make.mjs loadPacks' forApp, live.mjs walkerPacks' packsForDemo).
export function packIndex(packs, cfg) {
  const forApp = (packs && (packs.forApp || (packs.packsForDemo && packs.packsForDemo(cfg)))) || {};
  const all = Object.values(forApp).filter(Boolean);
  return { of: app => forApp[app] || null, byId: id => all.find(p => p.id === id) || null };
}
const checkOf = (pack, id) => {
  const w = pack && (pack.writes || []).find(x => x.id === id);
  if (!w || !w.check) return null;
  return w.check.same ? ((pack.writes || []).find(y => y.id === w.check.same) || {}).check || null : w.check;
};
// The pack check a line came from: From "beat N, pack:write" (or "beat N" and the plan's writes in that beat whose
// check reads as the line does), or "pack: effect".
export function sourceOf(line, { plan, index }) {
  const from = clean(line.from);
  let m;
  if ((m = /^beat (\d+)(?:, ([\w-]+):([\w-]+))?$/.exec(from))) {
    if (m[2]) { const pack = index.byId(m[2]), check = checkOf(pack, m[3]); return check ? { pack, check, write: m[3] } : null; }
    const tags = ((plan.beats[+m[1] - 1] || {}).steps || []).map(s => / · ([\w-]+):([\w-]+)$/.exec(s.writes || '')).filter(Boolean);
    const cands = tags.map(t => { const pack = index.byId(t[1]); return { pack, check: checkOf(pack, t[2]), write: t[2] }; }).filter(c => c.check);
    const said = c => norm(String(c.check.expect || '').replace(/\.$/, ''));
    return cands.find(c => said(c) === norm(line.text)) || (cands.length === 1 && !claimOf(line.text) ? cands[0] : null);
  }
  if ((m = /^([\w-]+): ([\w-]+)$/.exec(from))) {
    const pack = index.byId(m[1]), e = pack && (pack.effects || []).find(x => x.id === m[2]);
    return e && e.check ? { pack, check: e.check, effect: m[2] } : null;
  }
  return null;
}

// A pack check's look as a claim, its {values} filled: absent (none of them on the page), text (shown), rows (a
// label's rows only those the recorded start screen has), box + equals (a box holds exactly the demo's text).
function lookClaim(look, values) {
  const fill = t => {
    const keys = (String(t).match(/\{(\w+)\}/g) || []).map(k => k.slice(1, -1));
    for (const k of keys) { const v = values[k]; if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return { why: `nothing gives {${k}}: the recording (what the plan's writes make) or the demo (demo.json apps[].values.${k})` }; }
    if (keys.length === 1 && String(t) === `{${keys[0]}}`) return { texts: [].concat(values[keys[0]]).map(String) };
    return { texts: [String(t).replace(/\{(\w+)\}/g, (x, k) => [].concat(values[k])[0])] };
  };
  if (look.absent) { const f = fill(look.absent); return f.why ? f : { claim: { kind: 'absent', texts: f.texts } }; }
  if (look.text) { const f = fill(look.text); return f.why ? f : { claim: { kind: 'shows', texts: f.texts } }; }
  if (look.rows) return { claim: { kind: 'rows', label: look.rows } };
  if (look.box && look.equals) { const f = fill(look.equals); return f.why ? f : { claim: { kind: 'equals', field: look.box, text: f.texts[0] } }; }
  return { why: "the pack's look isn't one a check reads (absent, text, rows, or box with equals)" };
}

// What a check's {placeholders} are, per app: what the plan's writes make, by name, as the recording shows it (a sent
// prompt's task title, a saved skill's name, what was typed before an Enter), then the demo's own values (demo.json
// apps[].values: the custom instructions' text, which list), which win. → { <app>: { task: [..], skill: [..], typed:
// [..], <value>: .. } }
export function checkValues({ plan, walker = null, cfg = {}, appOf = x => x } = {}) {
  const out = {};
  const put = (app, k, v) => { if (!v) return; const o = out[app] = out[app] || {}; o[k] = [...new Set([...(o[k] || []), v])]; };
  let app = null, typed = null;
  for (const s of ((plan && plan.beats) || []).flatMap(b => b.steps)) {
    if (s.kind === 'app') { app = appOf(s.app) || s.app; continue; }
    if (s.kind === 'type' && s.value) typed = s.value;
    if (!s.writes || !app) continue;
    if (s.kind === 'press' && typed) put(app, 'typed', typed);
    const to = s.lands && s.lands.screen, after = walker && to ? walker.shown(to) || walker.screen(to) : null;
    if (/^sends\b/.test(s.writes) && after && after.title && after.title !== to) put(app, 'task', clean(after.title));
    if (/^saves\b/.test(s.writes) && after) put(app, 'skill', (/saved as ([\w.-]+)/i.exec(after.text || '') || [])[1]);
  }
  for (const a of (cfg && cfg.apps) || []) for (const [k, v] of Object.entries(a.values || {})) (out[a.id] = out[a.id] || {})[k] = v;
  return out;
}

// ctx: { plan, packs, walker (the recording's, or null), values: { <app>: { … } }, appIds, appOf }.
export function checkable(line, ctx) {
  const { plan, walker = null, values = {}, appIds = null, appOf = x => x } = ctx;
  const index = ctx.index || packIndex(ctx.packs, ctx.cfg);
  if (!line || !line.app || (appIds && !appIds.includes(line.app))) return no('which app?');
  const app = line.app;
  const src = sourceOf(line, { plan, index });
  if (src) {
    const c = src.check;
    const lc = c.look ? lookClaim(c.look, values[app] || {}) : { why: `the ${src.pack.id} pack's check is only words ("${clean(c.expect)}"): it gives no look a check reads` };
    if (lc.why) return no(lc.why);
    // Its page: the pack's address or steps, proven by the words the pack says it shows; a look that finds nothing
    // (absent) needs them, or nothing tells an empty page from the right one.
    const steps = (c.steps || []).map(t => parseStep(t));
    const bad = steps.map((s, i) => notNavigation(s, steps[i - 1])).find(Boolean);
    if (bad) return no(`the ${src.pack.id} pack's way to its check ${bad}`);
    if (!c.open && !steps.length && line.screen) { const r = routeTo(plan, app, line.screen, { walker, appOf }); if (r.why) return no(r.why); return { ok: true, app, claim: lc.claim, route: r.route, source: src }; }
    if (lc.claim.kind === 'absent' && !c.lands) return no(`the ${src.pack.id} pack's check says nothing that proves its page (lands), so an empty page would pass`);
    return { ok: true, app, claim: lc.claim, route: { ...(c.open ? { open: c.open } : { home: true }), steps, ...(c.lands ? { lands: c.lands } : {}) }, source: src };
  }
  const claim = claimOf(line.text);
  if (!claim) return no(`can't check "${clean(line.text)}" on its own: say it as ${FORMS}`);
  const r = routeTo(plan, app, line.screen, { walker, appOf });
  if (r.why) return no(r.why);
  return { ok: true, app, claim, route: r.route, source: null };
}
// The names a reset may find and undo by name: the script's own, never one the recording's start screen shows (it
// may be something the demo keeps under the same name). → { mine, kept }
export function byName(names, startScreen) {
  const shows = t => !!startScreen && (norm(startScreen.text).includes(norm(t)) || ((startScreen.items || []).some(i => norm(i.text) === norm(t))));
  return { mine: (names || []).filter(x => !shows(x)), kept: (names || []).filter(shows) };
}
// A route's key: lines with the same one are read on one visit.
export const routeKey = (app, route) => JSON.stringify([app, route.open || null, (route.steps || []).map(formatStep), route.lands || null]);
