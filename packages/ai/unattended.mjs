// Record for me, unattended (stage D): the approved plan run in the capture browser (the installed Chrome, its own
// profile, off the screen), while the recorder records, with nobody there.
//   - Approved, all of it: the plan word for word, and its write list (make.mjs approval().full). A write runs only
//     when it's on that list by beat and step, its app's pack knows it, and exactly one control on the fresh screen
//     has its name; then the guard opens for that one step on the app's own hosts. A write that isn't approved stops
//     the run before it, with a picture (nobody is there to do it by hand). Enter in a message box is a write.
//   - The read-only guard holds every other request that isn't a read, the whole run long (the packs' guard.allow
//     lets what the apps send while looked at through). What it held goes in run.json.
//   - Anything the plan didn't ask for stops it, with a picture: a window or a native dialog (dismissed), leaving the
//     app's hosts, a sign-in page (never signed in here: Sign in again), what a step lands on not showing, a control
//     that isn't there, a step only a person can do.
//   - The demo's reset before (fail closed: nothing is recorded when the tenant isn't as the demo starts) and after.
//   - run.json: every step, each write and what it made (for the undos), the reset, the guard, the stop.
// The recording is the recorder's own, the same as the extension path's (build, checks and Review work unchanged);
// its start-screen sweeps run side by side, an app per window.
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { formatStep, formatLands, stepCount } from './plan.mjs';
import { recordOpts } from '@stuntdouble/core/lib/demo.mjs';
import { rx, settled, aiDir, appTab } from './run.mjs';
import { readPlan, readGoal } from './draft.mjs';
import { approval as approvalOf } from './make.mjs';
import { liveWalker, walkerPacks } from './live.mjs';
import { runReset, fillApi, setBefore, setBeforeProblem, claimScreen, checkClaim, checkLines } from './reset-run.mjs';
import { leaveOutOf, leaveOn, leaveLog, leftFor, leaveApps, leaveFailure } from './leave-run.mjs';
import { liveProof, writeGate, proofWords } from './landing.mjs';
import { forgetLastTake } from './finish.mjs';
import { keepLastTake, endTake } from './take.mjs';
import { walkerFromDemo } from './walker.mjs';
import { GROUP_LABEL, groupOpenAfter } from './find.mjs';
import { regroundPlan, walkReads } from './reground.mjs';
import { readScreen } from '@scenecast/script/html.mjs';
import { cardMatch, cardNorm, defCard } from '@stuntdouble/capture/hover-card.mjs';

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost)(:\d+)?$/i;
const sleepMs = ms => new Promise(r => setTimeout(r, ms));

// Her own status (Teams' avatar: Available, Away), for each app the plan goes to whose pack names its control
// (ownStatus). What a save may show: what the recording's start screen of that app shows, else the pack's expect.
// recorded: the demo's walker (walkerFromDemo), or null for none. → [{ app, label, name, role, expect, waitS, from }]
export function ownStatusApps(demo, packs, inPlan, recorded) {
  const list = (packs && packs.ownStatusFor ? packs.ownStatusFor(demo.cfg) : []).filter(x => inPlan.has(x.app));
  if (!list.length) return [];
  const w = recorded !== undefined ? recorded : (() => { try { return walkerFromDemo(demo); } catch (e) { return null; } })();
  return list.map(x => { const r = recordedStatus(w, x); return { ...x, ...(r ? { expect: [r], from: 'recording' } : { from: 'pack' }) }; });
}
// The status a recorded start screen shows: the first control of the pack's role whose name its pattern matches.
export function recordedStatus(w, o) {
  const m = /^\/(.+)\/([a-z]*)$/.exec(String(o.name || ''));
  const id = w && m ? w.start(o.app) : null;
  if (!id) return null;
  let sc = null; try { sc = w.screen(id); } catch (e) { return null; }
  const rx = new RegExp(m[1], m[2].replace(/g/g, ''));
  for (const c of (sc && sc.controls) || []) {
    if (o.role && c.role !== o.role) continue;
    const h = rx.exec(c.name || '');
    if (h) return String(h[1] === undefined ? h[0] : h[1]).trim();
  }
  return null;
}
// Notices a replica never keeps, for each app the plan goes to whose pack names them (noticesFor).
// → [{ app, label, notices: [{ words, close, waitS }] }]
export const noticeApps = (demo, packs, inPlan) => (packs && packs.noticesFor ? packs.noticesFor(demo.cfg) : []).filter(x => inPlan.has(x.app));
// What she reads when a save stopped on one.
export const noticeSay = st => `${st.label} showed "${st.notice}…" for ${st.waitedS} s${st.closed ? ' and kept it after its close button' : ''}, and a replica can't keep it. Start again once ${st.label} has finished loading.`;
const computerWord = () => process.platform === 'darwin' ? 'Mac' : process.platform === 'win32' ? 'PC' : 'computer';
// What she reads when a save stopped on her status.
export const ownStatusSay = (label, status) => `${label} showed you as ${status}. Start again while you're using your ${computerWord()}, with ${label} open.`;
// The demo's recorded hovers (its build's data/snaps/hovers-<app>.json), for the apps the plan goes to: each hover
// once, by where the replica finds it (its anchor, and its scope from there), where it was on the screen (rect), and
// its card's words, with the screens it was recorded on. → [{ app, id, anchor, scope, rect, card, text, pages }]
export function recordedHovers(demo, apps) {
  const out = new Map();
  for (const app of apps) {
    let d = null;
    try { d = JSON.parse(readFileSync(join(demo.dir, 'data', 'snaps', `hovers-${app}.json`), 'utf8')); } catch (e) { continue; }
    for (const h of Object.values((d && d.defs) || {})) {
      const a = h && h.anchor;
      if (!a || !a.sel) continue;
      const anchor = Object.fromEntries(['sel', 'in', 'text', 'textStarts'].filter(k => a[k] !== undefined).map(k => [k, a[k]]));
      const scope = Array.isArray(h.scope) ? h.scope : [], card = defCard(h), id = JSON.stringify([anchor.sel, anchor.in || '', anchor.text ?? anchor.textStarts ?? '', scope, cardNorm(card)]);
      const r = h.anchorRect && typeof h.anchorRect.x === 'number' ? { x: h.anchorRect.x, y: h.anchorRect.y, w: h.anchorRect.w, h: h.anchorRect.h } : null;
      if (!out.has(`${app}\n${id}`)) out.set(`${app}\n${id}`, { app, id, anchor, scope, ...(r ? { rect: r } : {}), card, text: String(a.text || a.textStarts || '').slice(0, 60), pages: [] });
      const e = out.get(`${app}\n${id}`);
      if (h.page && !e.pages.includes(h.page)) e.pages.push(h.page);
    }
  }
  return [...out.values()];
}
// The demo's recorded menus (data/snaps/hovers-<app>.json clicks: what the recording's click audit opened), for the
// apps the plan goes to: by where the replica finds the control, where it was, how it closes, and its screen.
// → [{ app, id, name, page, ctl, ctlRect, restore, frame }]
export function recordedClicks(demo, apps) {
  const out = [];
  for (const app of apps) {
    let d = null;
    try { d = JSON.parse(readFileSync(join(demo.dir, 'data', 'snaps', `hovers-${app}.json`), 'utf8')); } catch (e) { continue; }
    for (const c of Object.values((d && d.clicks) || {})) {
      if (!c || !c.ctl || !c.ctl.sel || !c.name) continue;
      const ctl = { sel: c.ctl.sel, ...(c.ctl.text !== undefined ? { text: c.ctl.text } : {}), ...(c.ctl.in ? { in: c.ctl.in } : {}) };
      out.push({ app, id: `${app}:${c.id}`, name: String(c.name), page: c.page || null, ctl, ...(c.ctlRect ? { ctlRect: c.ctlRect } : {}), restore: c.restore || null, frame: c.frame || null });
    }
  }
  return out;
}
// The recorded screens a run reached: each app's start, then where the recording went with each step the run took
// (steps: run.steps). → { reached, known } (sets of the recording's screens), or null without a recording to say.
export function reachedPages(demo, plan, steps, apps) {
  let w = null;
  try { w = walkerFromDemo(demo); } catch (e) { return null; }
  if (!w) return null;
  const reached = new Set(), cur = {};
  for (const app of apps) { try { const s0 = w.start(app), id = typeof s0 === 'string' ? s0 : s0 && s0.sig; if (id) { cur[app] = id; reached.add(id); } } catch (e) {} }
  for (const st of steps || []) {
    const step = (((plan.beats || [])[st.beat] || {}).steps || [])[st.step], app = st.app;
    if (!step || !app || !cur[app] || step.kind === 'app') continue;
    try { const r = w.recorded(cur[app], step); if (r && r.screen && r.screen.sig && r.landed !== false) { cur[app] = r.screen; reached.add(r.screen.sig); } } catch (e) {}
  }
  // A hover or click page is its screen's (the flow's hoverPages and clickPages: a page's base is a snapshot, the
  // state whose snapshot it is): "cop-task" → cop-payoff-1 → cop-payoff.
  const flow = w.flow || {}, bySnap = {};
  for (const [id, st] of Object.entries(flow.states || {})) bySnap[(st && st.snap) || id] = id;
  const state = {};
  for (const hp of [...(flow.hoverPages || []), ...(flow.clickPages || [])]) if (hp && hp.page) state[hp.page] = bySnap[hp.base] || hp.base;
  return { reached, known: new Set(w.states || []), state };
}
const pageBase = p => String(p || '').replace(/-(frame\d+|again)$/, '');
const pageState = (p, reach) => { const b = pageBase(p); return (reach.state && reach.state[b]) || b; };
// Recorded only on screens the recording knows and the run never reached.
const unreached = (pages, reach) => !!reach && pages.length > 0 && pages.every(p => reach.known.has(pageState(p, reach)) && !reach.reached.has(pageState(p, reach)));
// The controls the recording's screens name with a count or status after a comma, starting with a number or "status"
// ("Notifications, 1 unread items", "Your profile, status Available"; not a post's "…, Thursday, November 5"), per app: what a page's first save waits for (capCounts). → { <app>: [{ base, name }] }
export function countedControls(demo, apps, w = undefined) {
  if (w === undefined) { try { w = walkerFromDemo(demo); } catch (e) { w = null; } }
  if (!w) return {};
  const states = (w.flow && w.flow.states) || {}, out = {};
  for (const id of w.states || []) {
    const app = (states[id] || {}).app;
    if (!apps.includes(app)) continue;
    let sc = null; try { sc = w.screen(id); } catch (e) { continue; }
    for (const c of (sc && sc.controls) || []) {
      const m = /^([^,]{2,60}),\s*(.+)$/.exec(String(c.name || '').trim());
      if (!m || !/^(\d|status\b)/i.test(m[2])) continue;
      const l = out[app] = out[app] || [];
      if (!l.some(x => x.base === m[1])) l.push({ base: m[1], name: c.name.trim() });
    }
  }
  return out;
}
// The clicks the demo's build dropped, per app (its flow's clickPages drop: a click that goes elsewhere, as Teams'
// " Bot Available"). → { <app>: [name] }
export function droppedClicks(demo, apps) {
  let flow = null;
  try { flow = JSON.parse(readFileSync(join(demo.dir, 'flow.json'), 'utf8')); } catch (e) { return {}; }
  const out = {};
  for (const cp of (flow && flow.clickPages) || []) if (cp && apps.includes(cp.app)) for (const n of [].concat(cp.drop || [])) if (typeof n === 'string' && n && !(out[cp.app] = out[cp.app] || []).includes(n)) out[cp.app].push(n);
  return out;
}
// Each recorded menu after a run, from its app's click audits (capHoverFloor's clickLog): captured (a sweep opened it),
// missed (it was on a screen and nothing opened, or it couldn't be clicked), not reached (its screen never was), or
// gone (on no screen the run swept). → [{ app, id, name, page, status, found?, why?, picture?, screen? }]
export function menuOutcomes(recorded, sweeps, reach = null) {
  return recorded.map(m => {
    const mine = (sweeps || []).filter(e => e.app === m.app && e.floor && e.floor[m.id]).map(e => ({ state: e.state, r: e.floor[m.id] }));
    const shown = mine.find(e => e.r.shown), found = mine.find(e => e.r.found);
    const status = shown ? 'captured' : unreached([m.page].filter(Boolean), reach) ? 'not reached' : found ? 'missed' : 'gone';
    const out = { app: m.app, id: m.id, name: m.name, page: m.page, status, ...(found ? { found: found.r.found } : {}) };
    if (status !== 'missed') return out;
    const pic = mine.find(e => e.r.picture) || found;
    const why = pic.r.why === 'nothing opened' ? 'it was on the screen and nothing opened when it was clicked' : `it was on the screen, and ${pic.r.why || "it couldn't be clicked"}`;
    return { ...out, why, picture: pic.r.picture || null, screen: pic.state || null };
  });
}
// Each recorded hover after a run, from its app's sweeps (capHoverFloor's log, one entry per sweep): captured (a hover
// captured in its app shows its card: the same words, numbers aside; for a card with no words, a control of its
// showed), missed (its anchor was on a screen and its card wasn't captured), or gone (its anchor was on no screen the
// run swept). found: how its anchor was found (place, or words when its place had moved).
// → [{ app, id, sel, text, pages, status, found?, why?, picture?, screen? }]
export function hoverOutcomes(recorded, sweeps, reach = null) {
  return recorded.map(h => {
    const mine = (sweeps || []).filter(e => e.app === h.app);
    const captured = h.card ? mine.some(e => (e.cards || []).some(x => (x.cards || []).some(t => cardMatch(h.card, t)))) : mine.some(e => e.floor && e.floor[h.id] && e.floor[h.id].shown);
    const at = mine.filter(e => e.found && e.found[h.id]), found = at.some(e => e.found[h.id] === 'place') ? 'place' : at.length ? 'words' : null;
    // Recorded only on screens the run never reached: not reached, though a control like it was found elsewhere
    // (Copilot's task-screen Start dictation shows another card on its home screen).
    const status = captured ? 'captured' : unreached(h.pages, reach) ? 'not reached' : found ? 'missed' : 'gone';
    const out = { app: h.app, id: h.id, sel: h.anchor.sel, text: h.text, pages: h.pages, status, ...(found ? { found } : {}) };
    if (status !== 'missed') return out;
    const tries = mine.flatMap(e => (e.tries || []).filter(t => (t.ids || []).includes(h.id)).map(t => ({ ...t, state: e.state })));
    const res = t => (t.results && t.results[h.id]) || t.result;
    const is = r => t => res(t) === r;
    const other = tries.find(is('other card')), twice = tries.find(t => res(t) === 'nothing' && t.retried), odd = tries.find(is('unreadable'));
    const capped = tries.find(is('capped')), left = tries.find(is('left')), unpointed = tries.find(is('unpointed')), once = tries.find(is('nothing'));
    const why = other ? 'it was on the screen and showed another card'
      : twice ? 'it was on the screen and showed nothing, hovered twice (the second time for 2.5 s, after the screen\'s other side states)'
      : odd ? "it was on the screen and what it showed couldn't be read"
      : capped ? 'it was on the screen and showed nothing the first time; its second try didn\'t fit in the time for second tries'
      : left ? 'it was on the screen, and its control had gone from it when it was hovered (again)'
      : unpointed ? 'it was on the screen, and none of its controls could be pointed at (twice)'
      : once ? 'it was on the screen and showed nothing (hovered once)'
      : "it was on the screen and wasn't hovered (out of time, or none of its controls could be pointed at)";
    const pic = tries.find(t => t.picture);
    return { ...out, why, picture: pic ? pic.picture : null, screen: (pic || tries[0] || at[0] || {}).state || null };
  });
}

// The statuses a list of reads (capOwnStatus) saw for an app, in order, each once; a screen without the control: "not shown".
export const ownSeen = (reads, app) => { const s = [...new Set((reads || []).filter(r => r.app === app).map(r => r.found === false ? 'not shown' : r.status))]; return s.length ? s.join(', ') : null; };

// A pack-named service's answers (capNet, tagged service), the latest one judged: 2xx is up; anything else (500, a
// call with no answer: a network error, or CORS when its preflight failed) means try later. A call the page itself
// called off (net::ERR_ABORTED: a reload) isn't an answer. → null (no answer yet) | { ok, status, why }
const aborted = n => /ERR_ABORTED/.test(n.failed || '');
export function serviceAnswer(answers, name) {
  const mine = (answers || []).filter(n => n.service === name && !aborted(n));
  if (!mine.length) return null;
  const last = mine[mine.length - 1], status = last.status || last.failed || 'no answer';
  const ok = typeof last.status === 'number' && last.status >= 200 && last.status < 300;
  return { ok, status, at: last.at, entry: last, why: ok ? null : typeof last.status === 'number' ? `${name} is failing (${status}). Try again later.` : `${name} didn't answer (${status}). Try again later.` };
}
// The apps a plan goes to: each "Go to", and the demo's first app when the plan starts without one. A service or a
// Leave out line of any other app (one in demo.json the plan never visits) is none of the run's business.
export function planApps(plan, appIds) {
  const appOf = name => appIds.find(a => a === name) || appIds.find(a => a.startsWith(name) || name.startsWith(a)) || null;
  const steps = (plan.beats || []).flatMap(b => b.steps), out = new Set();
  if (steps.length && steps[0].kind !== 'app' && appIds[0]) out.add(appIds[0]);
  for (const st of steps) if (st.kind === 'app') { const a = appOf(st.app); if (a) out.add(a); }
  return out;
}
// The rows of a service's list the plan clicks (its pack's cards.steps over each click step's words, in the service's
// app): the plan's own words, so the approval binds them. → [text]
const reOf = s => { const m = /^\/(.+)\/([a-z]*)$/.exec(String(s || '')); try { return m ? new RegExp(m[1], m[2]) : null; } catch (e) { return null; } };
export function cardSteps(plan, sv, appIds) {
  const re = sv && sv.cards && reOf(sv.cards.steps);
  if (!re) return [];
  const appOf = name => appIds.find(a => a === name) || appIds.find(a => a.startsWith(name) || name.startsWith(a)) || null;
  const out = [];
  let app = null;
  for (const st of (plan.beats || []).flatMap(b => b.steps)) {
    if (st.kind === 'app') { app = appOf(st.app) || app; continue; }
    if (app === sv.app && st.kind === 'click' && typeof st.target === 'string' && re.test(st.target) && !out.includes(st.target)) out.push(st.target);
  }
  return out;
}
// A 2xx answer judged for the plan's rows (capNet's cards): → null when each is in its list, else why not, and what it
// showed. The row's name for the message: the pack's cards.name group, else its words.
export function cardsVerdict(sv, texts, entry) {
  if (!texts.length || !entry) return null;
  const list = (sv.cards && sv.cards.list) || sv.name, nameRe = reOf(sv.cards && sv.cards.name);
  const nameOf = t => { const m = nameRe && nameRe.exec(t); return (m && m[1]) || t; };
  if (entry.unread) return { why: `${list}: ${entry.unread}. Try again later.`, missing: texts.map(nameOf), shown: null };
  const missing = texts.filter(t => !(entry.cards && entry.cards[t])).map(nameOf);
  if (!missing.length) return null;
  const shown = entry.shown || [];
  return { why: `${list} doesn't show ${missing.join(', ')} today. Try again later.`, missing, shown };
}
const serviceFailing = n => !!n.service && !aborted(n) && (n.failed || (typeof n.status === 'number' && n.status >= 500));
// How a failing call went, for a beat's stop: "answered 500", or "didn't answer (net::ERR_FAILED)".
const serviceWent = n => typeof n.status === 'number' ? `answered ${n.status}` : `didn't answer (${n.failed || 'no answer'})`;

// The capture browser, holding every request that isn't a read from its first one (capture.guard "hold"): what the
// apps send while they load, before a run turns its own guard on, is held too.
async function captureBrowser(cmd, what) {
  let info;
  try { info = await cmd('capInfo', {}, 20); } catch (e) { throw new Error(`${what} needs the capture browser: "recorder": "capture" in demo.json, then preflight`); }
  if (!info.guarded) throw new Error(`${what} needs the capture browser started with its guard on: "capture": { "guard": "hold" } in demo.json, then preflight again`);
  return info;
}

export async function recordUnattended({ demo, emit = () => {}, cmd: viaCmd, packs }) {
  const cmd = viaCmd || rx(demo);
  await captureBrowser(cmd, 'an unattended run');
  const plan = readPlan(demo);
  if (!plan || !stepCount(plan)) throw new Error('make and approve the plan first');
  const ap = approvalOf(demo);
  if (!ap.full) throw new Error(`approve the plan first: ${ap.why || 'it isn\'t approved'}`);
  const status0 = await cmd('recordStatus', {}, 30);
  if (status0.recording) throw new Error('the recorder is already recording: stop that recording first');
  packs = packs === undefined ? await walkerPacks() : packs;
  // reset.md's Set before blocks, each at its plan step (beat, the step's words, its number when the beat has them
  // twice). One the plan has no step for, or that can't run (setBeforeProblem), stops the run before anything runs.
  const setBeforeAt = new Map();
  { const rf = join(demo.dir, 'reset.md');
    if (existsSync(rf)) { const { parseReset } = await import('./reset.mjs'); for (const b of parseReset(readFileSync(rf, 'utf8')).before || []) {
      const steps = (plan.beats[b.beat - 1] || {}).steps || [], si = steps.findIndex((x, i) => formatStep(x) === b.text && (!b.n || i + 1 === b.n));
      if (si < 0) throw new Error(`reset.md sets something before beat ${b.beat}, ${b.text}, and the plan has no such step`);
      const bad = setBeforeProblem(b, { demo, packs, approval: ap });
      if (bad) throw new Error(`reset.md's Set before beat ${b.beat}, ${b.text}: ${bad}`);
      setBeforeAt.set(`${b.beat - 1}-${si}`, b);
    } } }
  // reset.md's Leave out: each line's filter, its app pack's, for the apps the plan goes to. One no pack of the demo has
  // stops the run before anything runs.
  const inPlan = planApps(plan, demo.cfg.apps.map(a => a.id));
  const lo = leaveOutOf({ demo, packs, apps: inPlan });
  if (lo.problems.length) throw new Error(`reset.md's Leave out: ${lo.problems[0]}`);
  const ownApps = ownStatusApps(demo, packs, inPlan);
  const notApps = noticeApps(demo, packs, inPlan);
  const recHovers = recordedHovers(demo, [...inPlan]), recClicks = recordedClicks(demo, [...inPlan]);
  const out = aiDir(demo), stops = join(out, 'stops');
  mkdirSync(out, { recursive: true });
  const log = text => emit({ event: 'note', text });
  const run = { at: new Date().toISOString(), unattended: true, title: plan.title, goal: readGoal(demo).goal || '', approved: { at: ap.at, list256: ap.list256 }, beats: [], steps: [], landings: [], writes: [], unprovable: [], marked: [], needsYou: [], starts: [], stopped: null, reset: {}, guard: {}, events: [], setBefore: [], ...(lo.rules.length || lo.skipped.length ? { leaveOut: { lines: lo.lines.map(l => ({ app: l.app, what: l.what, from: l.from, shows: l.shows })), ...(lo.skipped.length ? { skipped: lo.skipped } : {}) } } : {}), apps: [...inPlan] };
  const save = () => writeFileSync(join(out, 'run.json'), JSON.stringify(run, null, 1));
  // Leave out's record (per rule: the requests it filtered and what it took out; the checks before each save; a leak).
  const leakWhy = leak => `left out of the replica, and ${leak.why}: nothing after it was saved`;
  const leakStop = leak => { run.stopped = { kind: 'leave-out', why: leakWhy(leak), app: leak.app, saving: leak.what, picture: leak.picture || null, ...(leak.hits ? { where: leak.hits } : {}) }; run.needsYou.push({ text: leak.what, why: run.stopped.why }); emit({ event: 'stopped', ...run.stopped }); };
  const leaveNow = async () => { if (!lo.rules.length) return null; const l = await leaveLog(cmd); Object.assign(run.leaveOut, { rules: l.rules || [], dom: l.dom || [], checks: l.checks || null, leak: l.leak || null }); return l; };
  const shot = async (app, name) => { const file = join(stops, `${name}.png`); try { await cmd('capShot', { tab: appTab(demo, app), file }, 60); return file; } catch (e) { return null; } };
  const stopWith = async (app, at, kind, why) => { run.stopped = { kind, why, at, app, picture: await shot(app, `${at.beat + 1}-${at.step + 1}-${kind}`) }; emit({ event: 'stopped', ...run.stopped }); };
  // Her own status (capOwnStatus): what it read before each save of those apps, and its stop. What Teams' start
  // screen (with its start sweeps) and beat 1 showed go in the summary.
  if (ownApps.length) run.ownStatus = { apps: ownApps.map(o => ({ app: o.app, expect: o.expect, from: o.from })), start: {}, beat1: {} };
  const ownNow = async () => ownApps.length ? cmd('capOwnStatus', {}, 30).catch(() => null) : null;
  const ownStopped = async () => { const r = ownApps.length ? await cmd('capOwnStatus', { since: 1e9 }, 30).catch(() => null) : null; return r && r.stopped ? r.stopped : null; };
  const ownStopRun = (st, at = null) => {
    const say = ownStatusSay(st.label, st.status);
    run.stopped = { kind: 'own-status', why: say, app: st.app, saving: st.what, status: st.status, expect: st.expect, waitedS: st.waitedS, picture: st.picture || null, ...(at ? { at } : {}) };
    run.needsYou.push({ text: st.label, why: say });
    emit({ event: 'stopped', ...run.stopped });
  };
  let ownMark = 0;
  // A screen its side states left changed and a reload didn't put back (the recorder's put-back): nothing more saved.
  const unrestored = async () => { const r = await cmd('recordStatus', {}, 30).catch(() => null); return r && r.unrestored ? r.unrestored : null; };
  const restoreStopRun = (u, at = null) => {
    const say = `${u.state}: after its ${u.after}, the screen wasn't as saved (${u.found}), and a reload didn't put it back (${u.left}). Check that app's tab, then start again.`;
    run.stopped = { kind: 'put-back', why: say, app: u.app || null, saving: null, picture: u.pictureAfter || u.picture || null, ...(at ? { at } : {}) };
    run.needsYou.push({ text: `${u.app || 'An app'}: a screen its side paths changed`, why: say, picture: run.stopped.picture });
    emit({ event: 'stopped', ...run.stopped });
  };
  // Notices (capNotices): a save that waits for one, closes it, or stops before it's kept.
  const noticeStopped = async () => { const r = notApps.length ? await cmd('capNotices', { since: 1e9 }, 30).catch(() => null) : null; return r && r.stopped ? r.stopped : null; };
  const noticeStopRun = (st, at = null) => {
    const say = noticeSay(st);
    run.stopped = { kind: 'notice', why: say, app: st.app, saving: st.what, notice: st.notice, waitedS: st.waitedS, closed: st.closed, picture: st.picture || null, ...(at ? { at } : {}) };
    run.needsYou.push({ text: st.label, why: say });
    emit({ event: 'stopped', ...run.stopped });
  };
  const ownSummary = async key => { const r = await ownNow(); if (!r) return; const reads = (r.reads || []).slice(ownMark); ownMark = r.total || 0; for (const o of ownApps) run.ownStatus[key][o.app] = ownSeen(reads, o.app) || 'no screen saved'; };

  // The guard, from the first request to the last.
  const g = await guardOn(demo, cmd, packs);
  run.guard = { hosts: g.hosts, allow: g.allow.length };
  // The apps' pack-named services, every answer watched (run.services): one failing at the start means no capture;
  // during a beat, the run stops before that beat's next write. Only the apps the plan goes to.
  const svcs = (packs && packs.servicesFor ? packs.servicesFor(demo.cfg) : []).filter(x => inPlan.has(x.app));
  // A service whose list the plan clicks a row of: each 2xx answer read for those rows.
  const cardsOf = Object.fromEntries(svcs.map(sv => [sv.name, cardSteps(plan, sv, demo.cfg.apps.map(a => a.id))]));
  await cmd('capNet', { on: true, watch: svcs.map(({ name, match, cards }) => ({ name, match, ...(cardsOf[name].length ? { cards: { texts: cardsOf[name], suffix: cards.suffix || '' } } : {}) })) }, 30).catch(() => {});
  run.services = [];
  let netSeen = ((await cmd('capNet', {}, 30).catch(() => ({}))).total) || 0;
  const serviceNews = async () => {
    const r = await cmd('capNet', { since: netSeen }, 30).catch(() => null);
    if (!r) return [];
    netSeen = r.total;
    const got = (r.net || []).filter(n => n.service).map(n => ({ app: (svcs.find(s => s.name === n.service) || {}).app, ...n }));
    run.services.push(...got);
    return got;
  };
  const homeAt = {};
  // Each start service: the page's own call to it, after its app's start (at: when, and how many answers before),
  // must answer 2xx (waitS for it to come). → null, or the stop.
  const startServices = async (at, stage) => {
    for (const sv of svcs.filter(x => x.start && at[x.app])) {
      let v = null;
      for (;;) {
        await serviceNews();
        v = serviceAnswer(run.services.slice(at[sv.app].n), sv.name);
        if (v || Date.now() - at[sv.app].t > sv.waitS * 1000) break;
        await sleepMs(1000);
      }
      if (!v) v = { ok: false, why: `${sv.name} didn't answer in ${sv.waitS} s. Try again later.` };
      if (!v.ok) return { kind: 'service', why: v.why, service: sv.name, status: v.status || null, app: sv.app, stage, picture: await shot(sv.app, `${stage}-${sv.app}-service`) };
      // Answered, and the rows the plan clicks are in its list (or the run stops here, listed for her).
      const cv = cardsVerdict(sv, cardsOf[sv.name], v.entry);
      if (cv) { run.needsYou.push({ text: cv.missing.join(', '), why: cv.why }); return { kind: 'not-ready', why: cv.why, service: sv.name, app: sv.app, stage, missing: cv.missing, shown: cv.shown, picture: await shot(sv.app, `${stage}-${sv.app}-not-ready`) }; }
    }
    return null;
  };
  let recording = false, wRun = null, lastTake = null, ranAll = false;
  const ran = [], results = {};
  try { main: {
    // Leave out, from the start: the apps that have a line opened again, so what they show comes filtered. Before the
    // reset, so nothing reads them unfiltered.
    if (lo.rules.length) {
      emit({ event: 'stage', name: 'leave-out', label: 'Leaving out what the demo leaves out' });
      const r = await leaveOn(cmd, lo, { shots: stops }).catch(e => ({ on: false, refused: e.message }));
      if (!r.on) { run.stopped = { kind: 'leave-out', why: `Leave out couldn't start: ${r.refused || 'the capture browser said no'}` }; emit({ event: 'stopped', ...run.stopped }); break main; }
    }
    // Her own presence as the recording shows it, before the apps open again (the reset, the start screens).
    { const pr = await presenceOn({ demo, cmd, packs, inPlan }); if (pr) run.presence = { on: !!pr.on, ...(pr.rules ? { rules: pr.rules } : {}), ...(pr.who ? { who: pr.who } : {}), ...(pr.error ? { error: pr.error } : {}) }; }
    // The apps that need it opened first, before anything runs: each with a Leave out line (what it shows comes
    // filtered from here on, and its filters work) and each with a start service (it answers). Either failing stops
    // the run here: the tenant untouched, nothing to put back.
    { const ids = demo.cfg.apps.map(a => a.id), need = new Set([...leaveApps(lo), ...svcs.filter(x => x.start).map(x => x.app)]);
      const early = ids.filter(id => need.has(id)), at = {};
      if (early.length) {
        emit({ event: 'stage', name: 'services', label: 'Checking the apps are working' });
        const h = liveWalker({ demo, cmd, packs, log });
        for (const id of early) {
          await serviceNews();
          at[id] = { t: Date.now(), n: run.services.length };
          await h.home(id);
          const lf = lo.rules.length ? leaveFailure(await leaveNow(), id) : null;
          if (lf) { run.stopped = { kind: 'leave-out', why: `${id}: Leave out: ${lf}`, app: id, stage: 'before-reset', picture: await shot(id, `before-reset-${id}`) }; emit({ event: 'stopped', ...run.stopped }); break main; }
        }
        const down = await startServices(at, 'before-reset');
        if (down) { run.stopped = down; emit({ event: 'stopped', ...run.stopped }); break main; }
      } }
    // Before: the tenant as the demo starts, or nothing is recorded.
    emit({ event: 'stage', name: 'reset-before', label: 'Checking the demo starts as it should' });
    run.reset.before = await runReset({ demo, cmd, walker: liveWalker({ demo, cmd, packs, log }), phase: 'before', approval: ap, emit, shot });
    if (!run.reset.before.ok) {
      // A check it can't read stops it as itself (nothing was undone for it), with the picture of where it looked.
      const c = run.reset.before.kind === 'check' ? (run.reset.before.checks || []).find(x => x.status === 'cant') : null;
      run.stopped = { kind: run.reset.before.kind || 'reset', stage: 'reset-before', why: run.reset.before.why, ...(c && c.picture ? { picture: c.picture } : {}) };
      if (c) run.needsYou.push({ text: c.text, why: c.why });
      emit({ event: 'stopped', ...run.stopped }); break main;
    }

    emit({ event: 'stage', name: 'start', label: 'Starting the recording' });
    const appIds = demo.cfg.apps.map(a => a.id);
    // Every app on its start screen, as the recording begins: its start steps (navigation only), then its recorded
    // start screen checked. One that isn't stops the run before anything is recorded.
    { const h = liveWalker({ demo, cmd, packs, log });
      for (const id of appIds) {
        await serviceNews();
        homeAt[id] = { t: Date.now(), n: run.services.length };
        const did = await h.home(id);
        const bad = did.find(d => d.why);
        const sc = bad ? { ok: false, why: `its start step "${bad.step}": ${bad.why}` } : await h.startCheck(id, plan);
        // A filter of this app whose response couldn't be read, or had lost its list: its screens wait.
        if (sc.ok && lo.rules.length) { const lf = leaveFailure(await leaveNow(), id); if (lf) Object.assign(sc, { ok: false, why: `Leave out: ${lf}`, leaveOut: true }); }
        run.starts.push({ app: id, did, ...sc });
        if (!sc.ok) { run.stopped = { kind: sc.leaveOut ? 'leave-out' : 'start', why: `${id}: ${sc.why}`, app: id, picture: await shot(id, `start-${id}`) }; emit({ event: 'stopped', ...run.stopped }); break main; }
      }
      // And again as the recording begins (the reset before opened the apps again).
      const down = await startServices(homeAt, 'start');
      if (down) { run.stopped = down; emit({ event: 'stopped', ...run.stopped }); break main; }
    }
    // Her own status, before any screen of those apps is saved: the gate on, or nothing is recorded.
    if (ownApps.length) {
      const on = await cmd('capOwnStatus', { apps: Object.fromEntries(ownApps.map(o => [o.app, o])), shots: stops }, 30).catch(e => ({ on: false, why: e.message }));
      if (!on.on) { run.stopped = { kind: 'own-status', why: `couldn't watch your status in ${ownApps.map(o => o.label).join(', ')}: ${on.why || 'the capture browser said no'}` }; emit({ event: 'stopped', ...run.stopped }); break main; }
    }
    // Notices a replica never keeps (Teams' "Loading latest updates"), before any screen of those apps is saved.
    if (notApps.length) {
      const on = await cmd('capNotices', { apps: Object.fromEntries(notApps.map(n => [n.app, { label: n.label, notices: n.notices }])), shots: stops }, 30).catch(e => ({ on: false, why: e.message }));
      if (!on.on) { run.stopped = { kind: 'notice', why: `couldn't watch for ${notApps.map(n => n.label).join(', ')}'s notices: ${on.why || 'the capture browser said no'}` }; emit({ event: 'stopped', ...run.stopped }); break main; }
    }
    // The recording's hovers as a floor: never skipped by what the sweep learns, each tried twice.
    // And its menus: clicked whatever the cap or the time, put back their recorded way.
    // Counts a page loads after itself: its first save waits for them (admin's bell).
    const counted = countedControls(demo, [...inPlan]);
    if (Object.keys(counted).length) { const on = await cmd('capCounts', { apps: counted, waitS: ((demo.cfg.record || {}).countWaitS) }, 30).catch(() => ({ on: false })); if (on.on) run.counts = { apps: Object.fromEntries(Object.entries(counted).map(([a, l]) => [a, l.map(x => x.base)])) }; }
    const drops = droppedClicks(demo, [...inPlan]);
    if (recHovers.length || recClicks.length || Object.keys(drops).length) {
      const byApp = {}, menus = {};
      for (const h of recHovers) (byApp[h.app] = byApp[h.app] || []).push({ id: h.id, anchor: h.anchor, scope: h.scope, rect: h.rect, card: h.card });
      for (const m of recClicks) (menus[m.app] = menus[m.app] || []).push(m);
      const on = await cmd('capHoverFloor', { apps: byApp, clicks: menus, drop: drops, shots: stops }, 30).catch(() => ({ on: false }));
      if (on.on && recHovers.length) run.hovers = { recorded: recHovers.length };
      if (on.on && recClicks.length) run.menus = { recorded: recClicks.length };
    }
    const w = wRun = liveWalker({ demo, cmd, packs, recording: true, log });
    const first = plan.beats.flatMap(b => b.steps)[0];
    let app = first && first.kind === 'app' && w.appOf(first.app) || appIds[0];
    // Leave out can refuse a start screen's save (what she leaves out was on it): the take ends before it begins, and so
    // does the run.
    lastTake = keepLastTake(demo.raw);
    try { await cmd('recordStart', { apps: demo.cfg.apps.map(a => ({ id: a.id, match: a.match })), record: recordOpts(demo.cfg), parallel: true, zooms: demo.cfg.zooms, first: app }, 300); }
    catch (e) {
      const os = await ownStopped();
      if (os) { ownStopRun(os); break main; }
      const ns = await noticeStopped();
      if (ns) { noticeStopRun(ns); break main; }
      const l = await leaveNow().catch(() => null);
      if (!(l && l.leak)) throw e;
      leakStop(l.leak);
      break main;
    }
    recording = true;
    await settled(cmd, { maxS: 900, on: s => emit({ event: 'record', status: s }) });
    if (ownApps.length) await ownSummary('start');
    await w.start(app);

    // One step: null when it's done and landed where the plan says, else why the run stops ({ kind, why }).
    // A failed check stops it. A step it can't prove (the plan gives no proof, or its words were on the screen before)
    // goes in run.unprovable, and then the next step goes on only if its control is the one (exactly one, by its exact
    // name, of its kind), and never if it's a write: the step before every write has a proven landing.
    // Each landing proven on the live page (landing.mjs liveProof): the page read before the step and twice after it,
    // in the reader's shape. strong, weak or none goes in run.landings; after a write, its pack's read-only check
    // passing is strong. A write goes on only as writeGate says: the landings in its app since its last write all
    // strong. The run never asks: where it would, it stops before the write, keeps a picture and both reads, runs the
    // reset after, and lists the step in run.needsYou.
    const recWalker = (() => { try { return walkerFromDemo(demo); } catch (e) { return null; } })();
    const flat = plan.beats.flatMap((b, bi) => b.steps.map((s, si) => ({ bi, si, s })));
    const nextActing = (bi, si) => { const i = flat.findIndex(x => x.bi === bi && x.si === si); return ((flat.slice(i + 1).find(x => x.s.target && /^(click|type|press|hover)$/.test(x.s.kind))) || {}).s || null; };
    // Each read in the reader's shape, what she leaves out of the replica marked left (never a proof).
    const screensOf = (reads, id) => (reads || []).map(r => { try { return leftFor(lo, id, readScreen(r.docs)); } catch (e) { return null; } }).filter(Boolean);
    const typedSoFar = [], lastReads = {};
    const packWrite = known => {
      const p = packs && packs.packsForDemo ? Object.values(packs.packsForDemo(demo.cfg) || {}).find(x => x && x.id === known.pack) : null;
      return { p, pw: p && (p.writes || []).find(x => x.id === known.write) };
    };
    const packCheck = known => {
      const { p, pw } = packWrite(known);
      const api = pw && pw.check && pw.check.api, at2 = api && p.apis && p.apis[api.use];
      return api && at2 && api.made !== undefined && /^(GET|HEAD)$/i.test(api.method || 'GET') ? { api, at: at2 } : null;
    };
    // The pack's check of what the write made (check.api.made: a status, or the number and true/false fields it
    // names), in the app's own session as the write's own calls carried it, the page left where it is. vals: that
    // write's own values, never an earlier write's.
    const runPackCheck = async (pc, id, vals) => {
      const f = fillApi(pc.api, vals, ((demo.cfg.apps || []).find(a => a.id === id) || {}).values);
      if (f.left.length) { await cmd('capAuthWatch', { off: true }, 30).catch(() => {}); return { ok: false, why: `it needs ${f.left.join(', ')}` }; }
      const made = pc.api.made, pick = made && typeof made === 'object' ? Object.keys(made) : null;
      const r = await cmd('capApi', { tab: appTab(demo, id), armed: true, host: pc.at.host, hostPattern: pc.at.hostPattern, from: pc.at.from || null, method: pc.api.method || 'GET', path: f.path, pick, waitS: 20 }, 90).catch(e => ({ ok: false, why: e.message }));
      if (!r.status) return { ok: false, why: r.why || 'no answer' };
      const ok = pick ? pick.every(k => [].concat(made[k]).includes(r.picked && r.picked[k])) : String(r.status) === String(made);
      return { ok, status: r.status, ...(r.picked ? { picked: r.picked } : {}) };
    };
    const lastDid = {};
    let doubt = null;
    const failingIn = {};
    // A save Leave out refused (what she leaves out was on the screen, or a filter couldn't do its work): the take
    // stopped saving there, so the run stops at its next step.
    const leaked = async () => { const l = await leaveNow(); return l && l.leak ? { kind: 'leave-out', why: leakWhy(l.leak), leak: l.leak, beforeWrite: true } : null; };
    const doStep = async (bi, si, step, at, prev) => {
      { const os = await ownStopped(); if (os) return { kind: 'own-status', own: os }; }
      { const ns = await noticeStopped(); if (ns) return { kind: 'notice', notice: ns }; }
      { const u = await unrestored(); if (u) return { kind: 'put-back', unrestored: u }; }
      { const lk = await leaked(); if (lk) return lk; }
      for (const n of await serviceNews()) if (serviceFailing(n) && !failingIn[bi]) failingIn[bi] = n;
      // Set before: what her script has already set when she gets here, set off camera just before the step, in a tab
      // of its own, as approved writes under the write gate (reset-run.mjs setBefore). The step's screen must show it.
      const sb = setBeforeAt.get(`${bi}-${si}`);
      let sbRec = null;
      if (sb) {
        if (doubt) return { kind: 'unprovable', why: `the step before it (${doubt.text}) couldn't be proven (${doubt.why}), and what's set off camera before it is a write`, beforeWrite: true };
        const down = failingIn[bi];
        if (down) return { kind: 'service', why: `${down.service} ${serviceWent(down)} during this beat: what's set off camera waits until the service works. Try again later.`, beforeWrite: true };
        for (const id of new Set(sb.items.map(x => (/^([\w-]+)\s*:/.exec(x.what) || [])[1]).filter(Boolean))) {
          const gate = writeGate(run.landings, id);
          if (!gate.ok) return { kind: 'gate', why: `${gate.why}: what's set off camera is a write, and runs only after strong landings in its app`, beforeWrite: true };
        }
        emit({ event: 'stage', name: 'set-before', label: 'Setting things up off camera' });
        const from = new Date().toISOString();
        const r = await setBefore({ demo, cmd, packs, approval: ap, block: sb, walkerFor: tabs => liveWalker({ demo, cmd, packs, tabs, log }), results, emit });
        sbRec = { beat: bi + 1, step: si, text: at.text, from, to: new Date().toISOString(), ok: r.ok, did: r.did, items: r.items, seen: [], ...(r.why ? { why: r.why } : {}) };
        run.setBefore.push(sbRec);
        if (!r.ok) return { kind: 'set-before', why: r.why, beforeWrite: true };
      }
      const pre = await w.landsBefore(app, step, prev);
      // The page before it: for a Go to, the screen before it in plan order (the app it leaves); none before the first.
      const before = bi === 0 && si === 0 ? [] : await w.reads(step.kind === 'app' ? prev : app, { n: 1 }).catch(() => []);
      // Would it write? Read the screen as the step will find it.
      let wr = null;
      if (step.kind === 'click' || step.kind === 'press') {
        const o = await w.controls(app);
        const el = step.kind === 'click' ? (await w.locate(app, step.target)).el : null;
        wr = w.writeOf(step, el, step.kind === 'press' ? w.focusedField(o) : null, o.url);
      } else if (step.writes) wr = w.writeOf(step, null, null, null);
      // A step group's click (Copilot's "N items complete, using …"): the plan's index-th group label in this beat, so
      // it finds today's group by its place when the count or plugins changed.
      if (step.kind === 'click' && GROUP_LABEL.test(step.target || '') && !wr) {
        const labels = [...new Set(plan.beats[bi].steps.filter(x => x.kind === 'click' && GROUP_LABEL.test(x.target || '')).map(x => x.target))];
        step.groupIndex = labels.indexOf(step.target);
        step.groupOpen = groupOpenAfter(plan.beats[bi].steps, si);
      }
      let byControl = false;
      if (doubt) {
        const before = `the step before it (${doubt.text}) couldn't be proven (${doubt.why})`;
        if (wr) return { kind: 'unprovable', why: `${before}, and a write never follows a step it couldn't prove`, beforeWrite: true };
        // A step with a control goes on by that control only (exactly one, by its exact name); a scroll or a wait has
        // none, and can't write, so it goes on.
        if (step.kind !== 'app' && step.target) { const u = await w.uniqueControl(app, step); if (!u.ok) return { kind: 'unprovable', why: `${before}, and ${u.why}` }; byControl = true; }
      }
      let r, checked = null;
      if (wr) {
        if (!ap.writes.some(x => x.beat === bi && x.step === si && x.text === at.text)) return { kind: 'unapproved', why: `${wr.why}, and the approved plan doesn't list it as a write`, beforeWrite: true };
        // Its app's pack knows it (the plan names the pack's write; the pack's own match finds it on this page).
        const known = await packKnows(packs, w, app, step, wr);
        if (!known.ok) return { kind: 'unknown-write', why: known.why, beforeWrite: true };
        for (const n of await serviceNews()) if (serviceFailing(n) && !failingIn[bi]) failingIn[bi] = n;
        const down = failingIn[bi];
        if (down) return { kind: 'service', why: `${down.service} ${serviceWent(down)} during this beat: its write waits until the service works. Try again later.`, beforeWrite: true };
        const gate = writeGate(run.landings, app);
        if (!gate.ok) return { kind: 'gate', why: `${gate.why}: a write runs on its own only after strong landings in its app`, beforeWrite: true };
        // What it makes, by name, from the screen just before it (its pack's names: Copilot names a skill differently
        // each run): its undo finds it by that name. A write whose name the screen doesn't give doesn't run.
        const { pw } = packWrite(known);
        const named = pw && pw.names && packs.writeNames ? packs.writeNames(pw, screensOf(before, app).map(x => x.text).join(' ')) : { values: {}, missing: [] };
        if (named.missing.length) return { kind: 'unnamed', why: `${at.text}: the screen doesn't name the ${named.missing.join(', ')} it would make (the ${known.pack} pack's names), so its undo couldn't find it`, beforeWrite: true };
        const pc = packCheck(known);
        if (pc) await cmd('capAuthWatch', { host: pc.at.host, hostPattern: pc.at.hostPattern, from: pc.at.from || null }, 30).catch(() => {});
        r = await w.write(app, step);
        const vals = { ...namesOf(known.write, r.result), ...named.values };
        if (pc) checked = r.wrote ? await runPackCheck(pc, app, vals) : (await cmd('capAuthWatch', { off: true }, 30).catch(() => {}), null);
        if (r.wrote) {
          const rec = { beat: bi + 1, step: si, text: at.text, writes: step.writes || wr.why, pack: known.pack, write: known.write, undo: step.undo || known.undo || null, result: r.result, ...(Object.keys(named.values).length ? { made: named.values } : {}) };
          run.writes.push(rec); ran.push({ beat: bi + 1, text: at.text, app, values: vals, made: named.values });
          Object.assign(results, vals);
          emit({ event: 'wrote', ...rec });
        }
        // Its control was used and then the step failed: recorded above (the reset after undoes it), then the run stops.
        if (r.error) return { kind: 'error', why: `${at.text}: ${r.error}` };
      } else r = await w.act(app, step);
      if (r.missing || r.needsYou) return { kind: r.missing ? 'missing' : 'needs-you', why: r.why, ...(wr ? { write: true } : {}) };
      const c = await w.check(app, step);
      const afters = await w.reads(app).catch(() => []);
      lastReads[app] = afters;
      if (!c.ok) return { kind: c.kind, why: c.why, ...(wr ? { write: true } : {}) };
      const lp = liveProof(step, { before: screensOf(before, step.kind === 'app' ? prev : app), afters: screensOf(afters, app), next: nextActing(bi, si), typed: typedSoFar.filter(t => t !== step.value), walker: recWalker });
      const byCheck = !!(checked && checked.ok);
      // A wait, a hover, a scroll or a step group's expand moves nothing: after a proven step, or one its own exact
      // control proved, the screen is still the proven one ("carried": writeGate counts it as proven).
      const carried = (['wait', 'hover', 'scroll'].includes(step.kind) || Number.isInteger(step.groupIndex)) && (!doubt || byControl);
      const strength = byCheck ? 'strong' : lp.strength === 'strong' || !carried ? lp.strength : 'carried';
      const url = (await w.controls(app).catch(() => ({}))).url || null;
      run.landings.push({ beat: bi + 1, index: si, app, step: at.text, expected: step.lands ? formatLands(step.lands) : null, got: { screen: c.screen || null, url, text: byCheck ? `the pack's check: ${checked.status}${checked.picked ? ` ${JSON.stringify(checked.picked)}` : ''}` : proofWords(lp.lands) }, ok: true, strength, basis: byCheck ? 'pack check' : 'live', ...(strength === 'strong' ? {} : { why: lp.why }), ...(r.wrote ? { wrote: true } : {}), ...(checked ? { check: checked } : {}) });
      if (step.kind === 'type' && step.value) typedSoFar.push(step.value);
      const why = strength === 'strong' || carried ? null : pre || (w.proofOf(step) ? null : 'the plan gives it no proof of where it lands');
      if (why) {
        doubt = { text: at.text, why }; run.unprovable.push({ beat: bi + 1, step: si, text: at.text, why, strength }); emit({ event: 'unprovable', beat: bi, step: si, why });
        // A step that ran and isn't a write, but couldn't be proven: the beat is marked for Review, as a doubt that
        // stopped nothing is.
        if (!wr) { const mark = { beat: bi + 1, step: si, text: at.text, app, kind: 'unprovable', why, picture: await shot(app, `${bi + 1}-${si + 1}-mark-unprovable`) }; run.marked.push(mark); emit({ event: 'marked', ...mark }); }
      }
      else doubt = null;
      Object.assign(lastDid, { did: r.did, screen: c.screen });
      // What was set off camera, on the screen the step lands on (its Seen:), as drawn once the page is quiet. A page
      // that still shows it the old way (a cached list) stops the run here, before the beat's next write.
      if (sbRec) {
        await w.quiet(app, 800, 15000);
        for (const x of sb.items) {
          const m = /^([\w-]+)\s*:\s*(.*)$/.exec(x.what);
          if (!m) continue;
          const seen = checkClaim(m[2], await claimScreen(w, cmd, appTab(demo, m[1]), m[1]));
          sbRec.seen.push({ text: x.what, ok: seen.ok, ...(seen.ok ? {} : { why: seen.why }) });
          if (!seen.ok) return { kind: 'set-before', why: `${x.what} was set off camera, but after this step ${seen.why}`, beforeWrite: true };
        }
      }
      return null;
    };
    const total = stepCount(plan);
    // Stop (the app's button): the app clears an old one when this job starts, so one pressed while it got ready counts.
    const stopFile = join(aiDir(demo), 'stop');
    let n = 0;
    outer: for (const [bi, beat] of plan.beats.entries()) {
      const tb = Date.now();
      emit({ event: 'beat', beat: bi, title: beat.title });
      for (const [si, step] of beat.steps.entries()) {
        const at = { beat: bi, step: si, text: formatStep(step) };
        // Stop (the app's button): between two steps, never between a write and its record; the reset after runs.
        if (existsSync(stopFile)) { rmSync(stopFile, { force: true }); run.stopped = { kind: 'asked', why: 'You stopped it', at }; emit({ event: 'stopped', ...run.stopped }); break outer; }
        emit({ event: 'step', beat: bi, step: si, n: ++n, of: total, text: at.text });
        const prev = app;
        if (step.kind === 'app') app = w.appOf(step.app) || app;
        const ts = Date.now();
        let stop = await doStep(bi, si, step, at, prev).catch(e => ({ kind: 'error', why: e.message }));
        // A save her status stopped during the step: that's why, whatever the step met after it.
        if (stop && !stop.own && !stop.leak) { const os = await ownStopped(); if (os) stop = { kind: 'own-status', own: os }; }
        if (stop && !stop.own && !stop.leak && !stop.notice) { const ns = await noticeStopped(); if (ns) stop = { kind: 'notice', notice: ns }; }
        if (stop && stop.own) { ownStopRun(stop.own, at); break outer; }
        if (stop && stop.notice) { noticeStopRun(stop.notice, at); break outer; }
        if (stop && !stop.own && !stop.leak && !stop.notice && !stop.unrestored) { const u = await unrestored(); if (u) stop = { kind: 'put-back', unrestored: u }; }
        if (stop && stop.unrestored) { restoreStopRun(stop.unrestored, at); break outer; }
        // A doubt no write follows (a step it couldn't prove, words that aren't there, a control that isn't), on a
        // step that isn't a write itself: the run keeps the screen as it is, marks the beat for Review, and goes on. A
        // write never follows it (the doubt stops that write), and anything else still stops the run.
        if (stop && /^(unprovable|elsewhere|missing)$/.test(stop.kind) && !stop.beforeWrite && !stop.write) {
          const mark = { beat: bi + 1, step: si, text: at.text, app, kind: stop.kind, why: stop.why, picture: await shot(app, `${bi + 1}-${si + 1}-mark-${stop.kind}`) };
          run.marked.push(mark);
          emit({ event: 'marked', ...mark });
          doubt = { text: at.text, why: stop.why };
          run.steps.push({ ...at, app, did: 'marked', secs: +((Date.now() - ts) / 1000).toFixed(1), screen: null });
          emit({ event: 'step-done', beat: bi, step: si, did: 'marked' });
          continue;
        }
        if (stop) {
          await stopWith(app, at, stop.kind, `${at.text}: ${stop.why}`);
          // Leave out's own picture, taken as it refused the save, and where on the screen it was.
          if (stop.leak) Object.assign(run.stopped, { app: stop.leak.app, saving: stop.leak.what, ...(stop.leak.picture ? { picture: stop.leak.picture } : {}), ...(stop.leak.hits ? { where: stop.leak.hits } : {}) });
          // Before a write: both reads of the page as it was, and the step for her (the reset after still runs).
          if (stop.beforeWrite) {
            const reads = lastReads[app];
            if (reads && reads.length) { mkdirSync(stops, { recursive: true }); run.stopped.reads = join(stops, `${bi + 1}-${si + 1}-${stop.kind}.reads.json.gz`); writeFileSync(run.stopped.reads, gzipSync(JSON.stringify(reads))); }
            run.needsYou.push({ beat: bi + 1, step: si, text: at.text, why: stop.why });
          }
          break outer;
        }
        run.steps.push({ ...at, app, did: lastDid.did, secs: +((Date.now() - ts) / 1000).toFixed(1), screen: lastDid.screen });
        emit({ event: 'step-done', beat: bi, step: si, did: lastDid.did });
      }
      run.beats.push({ beat: bi + 1, title: beat.title, secs: +((Date.now() - tb) / 1000).toFixed(1) });
      if (bi === 0 && ownApps.length) { await settled(cmd, { maxS: 300 }).catch(() => {}); await ownSummary('beat1'); }
    }
    ranAll = !run.stopped;
  } } finally {
    if (recording) {
      emit({ event: 'stage', name: 'stop', label: 'Saving the recording' });
      try { run.summary = await cmd('recordStop', {}, 900); } catch (e) { run.summary = { error: e.message }; }
      // A save it refused after the last step: the take ends there, and she sees why.
      const os = await ownStopped();
      if (os && !run.stopped) ownStopRun(os);
      const ns = await noticeStopped();
      if (ns && !run.stopped) noticeStopRun(ns);
      const u = await unrestored();
      if (u && !run.stopped) restoreStopRun(u);
      const l = await leaveNow().catch(() => null);
      if (l && l.leak && !run.stopped) leakStop(l.leak);
    }
    // Only a take that ran every step and saved replaces the last one (its raw recording, beat keys and focus points):
    // one that stopped part way, failed or didn't save leaves them, and the replica made from them, as they were. A
    // first take that stopped is kept (there's nothing to put back). A focus.json she broke by hand stays as it is.
    const whole = ranAll && !run.stopped && !!run.summary && !run.summary.error;
    if (recording && whole && run.summary.states > 0) try { forgetLastTake(demo.dir); } catch (e) { log(`the last take's beat keys and focus points stay: ${e.message}`); }
    try { endTake(demo.raw, lastTake, { restore: !whole }); } catch (e) { log(`the last take's recording wasn't put back: ${e.message}`); }
    // Each recorded hover and menu: captured, missed, not reached or gone; a missed one is listed for her, with its
    // picture.
    if (run.hovers || run.menus) {
      const fl = await cmd('capHoverFloor', {}, 30).catch(() => null);
      if (fl && fl.on) {
        const reach = reachedPages(demo, plan, run.steps, [...inPlan]);
        const list = hoverOutcomes(recHovers, fl.log, reach), mlist = menuOutcomes(recClicks, fl.clickLog || [], reach);
        const count = l => { const n = k => l.filter(x => x.status === k).length; return { captured: n('captured'), gone: n('gone'), missed: n('missed'), ...(n('not reached') ? { notReached: n('not reached') } : {}) }; };
        // A picture is kept only for a hover or menu that's missed (a control can show nothing while another of its
        // anchor's shows its card; a menu can open on another screen).
        const keep = new Set([...list, ...mlist].map(x => x.picture).filter(Boolean));
        for (const t of fl.log.flatMap(e => e.tries || [])) if (t.picture && !keep.has(t.picture)) rmSync(t.picture, { force: true });
        for (const r of (fl.clickLog || []).flatMap(e => Object.values(e.floor || {}))) if (r && r.picture && !keep.has(r.picture)) rmSync(r.picture, { force: true });
        if (run.hovers) {
          Object.assign(run.hovers, { ...count(list), list, ...(run.stopped ? { partial: true } : {}) });
          for (const x of list.filter(x => x.status === 'missed')) run.needsYou.push({ text: `Hover over "${x.text || x.sel}" (${x.app})`, why: `${x.why}. The replica won't show its hover.`, picture: x.picture });
        }
        if (run.menus) {
          Object.assign(run.menus, { ...count(mlist), list: mlist, ...(run.stopped ? { partial: true } : {}) });
          for (const x of mlist.filter(x => x.status === 'missed')) run.needsYou.push({ text: `Open "${x.name}" (${x.app})`, why: `${x.why}. The replica won't open it.`, picture: x.picture });
        }
      }
      await cmd('capHoverFloor', { apps: {} }, 30).catch(() => {});
    }
    if (ownApps.length) {
      const r = await ownNow();
      if (r && r.on && run.ownStatus) {
        run.ownStatus.reads = r.reads || [];
        if (r.stopped) run.ownStatus.stopped = r.stopped;
        const started = Object.keys(run.ownStatus.start).length > 0;
        // Stopped at the start screens: what they showed.
        if (!started) for (const o of ownApps) run.ownStatus.start[o.app] = ownSeen(run.ownStatus.reads, o.app) || 'no screen saved';
        // Stopped in beat 1: what it showed until then.
        if (started && !run.beats.length) for (const o of ownApps) { const v = ownSeen(run.ownStatus.reads.slice(ownMark), o.app); if (v) run.ownStatus.beat1[o.app] = v; }
      }
      if (run.ownStatus && !Object.keys(run.ownStatus.beat1).length) delete run.ownStatus.beat1;
      await cmd('capOwnStatus', { apps: {} }, 30).catch(() => {});
    }
    if (run.presence) { const l = await presenceOff(cmd); if (l) run.presence.log = l; }
    if (run.counts) {
      const r = await cmd('capCounts', {}, 30).catch(() => null);
      if (r && r.on) run.counts.waits = r.log || [];
      await cmd('capCounts', { apps: {} }, 30).catch(() => {});
    }
    if (notApps.length) {
      const r = await cmd('capNotices', {}, 30).catch(() => null);
      if (r && r.on) run.notices = { apps: notApps.map(n => ({ app: n.app, words: n.notices.map(x => x.words) })), seen: r.seen || [], ...(r.stopped ? { stopped: r.stopped } : {}) };
      await cmd('capNotices', { apps: {} }, 30).catch(() => {});
    }
    // Off the app (another site): back to it, out of the recording, before the reset needs it.
    if (run.stopped && run.stopped.kind === 'offplan') await liveWalker({ demo, cmd, packs, log }).goBack(run.stopped.app).catch(() => {});
    // A run that stopped before its Enter leaves nothing typed behind (out of the recording too).
    if (wRun) for (const id of Object.keys(wRun.typed())) run.cleared = [...(run.cleared || []), { app: id, ...(await wRun.clearTyped(id).catch(e => ({ cleared: false, why: e.message }))) }];
    // After: the undos of what ran, the start set again, the check (when the reset before let anything run).
    if (run.reset.before && run.reset.before.ok) {
      emit({ event: 'stage', name: 'reset-after', label: 'Putting the demo back as it started' });
      try { run.reset.after = await runReset({ demo, cmd, walker: liveWalker({ demo, cmd, packs, log }), phase: 'after', approval: ap, ran, results, emit }); } catch (e) { run.reset.after = { ok: false, why: e.message }; }
    }
    if (lo.rules.length) { await leaveNow().catch(() => {}); await cmd('capLeaveOut', { rules: [] }, 60).catch(() => {}); }
    { const off = await guardOff(cmd, g.hosts, senderApps(demo.cfg, packs)); keepBodiesOut(demo, off.bodies); keepBodiesOut(demo, off.writeBodies, 'write-bodies.json'); Object.assign(run.guard, off); }
    if (wRun) run.inputs = wRun.inputs();
    try { const appOf = senderApps(demo.cfg, packs); run.events = (await cmd('capEvents', {}, 30)).events.filter(e => e.kind !== 'navigated').map(e => ({ ...e, app: appOf({ tab: e.host }) })); } catch (e) {}
    save();
  }
  return finish();
  function finish() {
    save();
    return { stopped: run.stopped, steps: run.steps.length, writes: run.writes.length, ...(run.marked.length ? { marked: run.marked.map(m => ({ beat: m.beat, text: m.text, why: m.why, picture: m.picture })) } : {}), held: (run.guard.held || []).filter(h => h.held).length, resetBefore: run.reset.before && run.reset.before.ok, resetAfter: run.reset.after ? run.reset.after.ok : null, summary: run.summary, ...(run.ownStatus ? { ownStatus: { start: run.ownStatus.start, ...(run.ownStatus.beat1 ? { beat1: run.ownStatus.beat1 } : {}) } } : {}), ...(run.hovers && run.hovers.list ? { hovers: { recorded: run.hovers.recorded, captured: run.hovers.captured, gone: run.hovers.gone, missed: run.hovers.missed, ...(run.hovers.notReached ? { notReached: run.hovers.notReached } : {}) } } : {}), ...(run.menus && run.menus.list ? { menus: { recorded: run.menus.recorded, captured: run.menus.captured, gone: run.menus.gone, missed: run.menus.missed, ...(run.menus.notReached ? { notReached: run.menus.notReached } : {}) } } : {}) };
  }
}

// Ready? Look-only, in the capture browser, the run's own first check: the guard and Leave out as a run has them, each
// app with a start service opened, its call answered 2xx, and the rows the plan clicks in its list. Nothing is written.
// keep: a local folder for every answer's body (a person's look, never the repo). → { ready, line, services }
export async function readyCheck({ demo, cmd: viaCmd, packs, plan: viaPlan = null, keep = null }) {
  const cmd = viaCmd || rx(demo);
  await captureBrowser(cmd, 'a readiness check');
  const plan = viaPlan || readPlan(demo);
  if (!plan || !stepCount(plan)) throw new Error('make the plan first');
  packs = packs === undefined ? await walkerPacks() : packs;
  const inPlan = planApps(plan, demo.cfg.apps.map(a => a.id));
  const lo = leaveOutOf({ demo, packs, apps: inPlan });
  if (lo.problems.length) throw new Error(`reset.md's Leave out: ${lo.problems[0]}`);
  const svcs = (packs && packs.servicesFor ? packs.servicesFor(demo.cfg) : []).filter(x => x.start && inPlan.has(x.app));
  const ids = demo.cfg.apps.map(a => a.id), cardsOf = Object.fromEntries(svcs.map(sv => [sv.name, cardSteps(plan, sv, ids)]));
  const g = await guardOn(demo, cmd, packs);
  const out = [];
  try {
    if (lo.rules.length) { const r = await leaveOn(cmd, lo).catch(e => ({ on: false, refused: e.message })); if (!r.on) throw new Error(`Leave out couldn't start: ${r.refused}`); }
    await cmd('capNet', { on: true, watch: svcs.map(({ name, match, cards }) => ({ name, match, ...(cardsOf[name].length ? { cards: { texts: cardsOf[name], suffix: cards.suffix || '' } } : {}), ...(keep ? { keep } : {}) })) }, 30);
    const w = liveWalker({ demo, cmd, packs });
    for (const id of ids.filter(id => svcs.some(x => x.app === id))) {
      const since = (await cmd('capNet', {}, 30)).total || 0, t = Date.now();
      await w.home(id);
      for (const sv of svcs.filter(x => x.app === id)) {
        let v = null;
        for (;;) {
          const got = ((await cmd('capNet', { since }, 30)).net || []).filter(n => n.service);
          v = serviceAnswer(got, sv.name);
          if (v || Date.now() - t > sv.waitS * 1000) break;
          await sleepMs(1000);
        }
        if (!v) v = { ok: false, why: `${sv.name} didn't answer in ${sv.waitS} s. Try again later.` };
        const cv = v.ok ? cardsVerdict(sv, cardsOf[sv.name], v.entry) : null;
        const owner = String((sv.cards && sv.cards.list) || sv.name).replace(/'s .*$/, '');
        const names = v.ok && !cv ? cardsOf[sv.name].map(t => (v.entry && v.entry.cards && v.entry.cards[t]) || t) : [];
        out.push({ service: sv.name, app: id, ok: v.ok && !cv, status: v.status, why: !v.ok ? v.why : cv ? cv.why : null, ...(cv ? { shown: cv.shown } : {}), ...(names.length ? { shows: names } : {}), owner });
      }
    }
  } finally {
    if (lo.rules.length) await cmd('capLeaveOut', { rules: [] }, 60).catch(() => {});
    await guardOff(cmd, g.hosts);
  }
  const bad = out.find(x => !x.ok);
  const line = bad ? `not ready: ${bad.why.replace(/\.? Try again later\.$/, '')}${bad.shown ? ` (it showed: ${bad.shown.length ? bad.shown.slice(0, 12).join(', ') + (bad.shown.length > 12 ? `, and ${bad.shown.length - 12} more` : '') : 'nothing'})` : ''}`
    : `ready: ${out.map(x => x.shows ? `${x.owner} shows ${x.shows.join(', ')}` : `${x.service} answered ${x.status}`).join('; ') || 'no service to check'}`;
  return { ready: !bad, line, services: out };
}

// The app's pack knows the write: the plan's tag names a write the pack has, or the pack's own rules find it.
async function packKnows(packs, w, app, step, wr) {
  if (!packs || !packs.packFor) return { ok: false, why: 'no app packs to say what this write is and how it\'s undone' };
  const o = await w.controls(app);
  const pack = packs.packFor(o.url);
  if (!pack) return { ok: false, why: `no app pack for ${new URL(o.url).host}: it can't say what this write is or how it's undone` };
  if (wr.pack && wr.pack !== pack.id) return { ok: false, why: `the plan names ${wr.pack}'s write, and this page is ${pack.id}'s` };
  const byTag = wr.write ? (pack.writes || []).find(x => x.id === wr.write) : null;
  const byRule = packs.writeFor(pack, step, step.kind === 'press' ? w.focusedField(o) : null);
  const pw = byTag || byRule;
  if (!pw) return { ok: false, why: `the ${pack.id} pack doesn't list this write` };
  return { ok: true, pack: pack.id, write: pw.id, undo: pw.undo || null };
}
// What a write made, by the names the undos use ({task}, {skill}, …): its page title, what was typed, ids.
function namesOf(write, r) {
  const out = {};
  if (!r) return out;
  if (/task|send|post|message/.test(write || '')) { if (r.typed) out.typed = r.typed; if (r.title) out.task = r.title; }
  if (r.ids && r.ids.length) out.taskId = r.ids[r.ids.length - 1];
  return out;
}

// The read-only guard on every web host (the apps' and any other: a write mustn't leave by a side door), with the
// packs' allow-lists for what the apps send while only looked at. A planned write opens the app's own hosts.
async function guardOn(demo, cmd, packs) {
  const g = packs && packs.guardFor ? packs.guardFor(demo.cfg) : { hosts: demo.cfg.apps.map(a => { try { return new URL(a.url).host; } catch (e) { return null; } }).filter(Boolean), allow: [], stayHeld: [] };
  // A demo's capture.keepBodies (its local demo.json): the held requests whose bodies a person wants to review.
  const keepBodies = (demo.cfg.capture && demo.cfg.capture.keepBodies) || [];
  await cmd('capGuard', { hosts: null, allow: g.allow, stayHeld: g.stayHeld || [], keepBodies, mode: 'hold', local: g.hosts.some(h => LOOPBACK.test(h)) }, 30);
  return g;
}
// What the guard held, and every host the browser reached that isn't one of the apps' own.
// The held requests' bodies a demo asked to keep (capture.keepBodies), in .out/ai/held-bodies.json, and every body a
// planned write let through, in .out/ai/write-bodies.json: local only, for a person reviewing an allow entry or what a
// write sent. None: no file.
// The steps whose app's page may have been broken today, not by the product: the re-ground's suspect rule
// (reground.mjs), on this walk and its screens. It compares with the recording, so a demo without one says why.
// → { steps: [{ step: '<beat>-<step>', text, status, held: [kinds], why }] } or { none: why }
export function suspectSteps({ demo, plan, walk, screensDir, packs = null }) {
  const walker = walkerFromDemo(demo);
  if (!walker) return { none: "there's no recording to compare today's screens with" };
  try {
    const forApp = packs && packs.packsForDemo ? packs.packsForDemo(demo.cfg) : null;
    const { rows } = regroundPlan(plan, { walker, walk, reads: walkReads(screensDir), apps: (demo.cfg && demo.cfg.apps) || null, packs: forApp ? { forApp } : null });
    return { steps: rows.filter(r => r.basis === 'suspect').map(r => ({ step: `${r.beat}-${r.step}`, text: r.text, status: r.status, held: r.held || [], why: r.why })) };
  } catch (e) { return { none: e.message }; }
}
function keepBodiesOut(demo, bodies, name = 'held-bodies.json') {
  const f = join(aiDir(demo), name);
  if (bodies && bodies.length) { mkdirSync(aiDir(demo), { recursive: true }); writeFileSync(f, JSON.stringify(bodies, null, 1)); }
  else rmSync(f, { force: true });
}
// Each app's hosts (its address and match, its pack's match, guard hosts and frames), to name the app a request came
// from by its tab, else its frame: never by when it came (a background tab sends during another app's step).
export function senderApps(cfg, packs) {
  const byApp = packs && packs.packsForDemo ? packs.packsForDemo(cfg) || {} : {};
  const hostOf = x => { try { return new URL(/^[a-z]+:\/\//i.test(x) ? x : `https://${x}`).host; } catch (e) { return null; } };
  const list = ((cfg && cfg.apps) || []).map(a => {
    const p = byApp[a.id] || {}, hs = new Set([hostOf(a.url), hostOf(a.match)].filter(Boolean));
    for (const m of [...(p.match || []), ...(((p.guard || {}).hosts) || []), ...(((p.frames || {}).match) || [])]) { const h = hostOf(m); if (h && !h.includes('*')) hs.add(h); }
    return { id: a.id, hosts: [...hs] };
  });
  const is = (host, h) => { if (!host) return false; const bare = host.replace(/:\d+$/, ''); return host === h || bare === h || bare.endsWith('.' + h); };
  return e => { for (const k of ['tab', 'frame']) { const a = list.find(x => x.hosts.some(h => is(e && e[k], h))); if (a) return a.id; } return null; };
}

async function guardOff(cmd, hosts, appOf = () => null) {
  const out = {};
  try {
    const l = await cmd('capLog', {}, 30);
    const named = list => (list || []).map(h => ({ ...h, app: appOf(h) }));
    out.held = named(l.held); out.counts = l.counts; out.passed = named(l.passed);
    // Kept bodies go in a file of their own (keepBodiesOut), never in run.json or walk.json.
    if (l.bodies && l.bodies.length) Object.defineProperty(out, 'bodies', { value: l.bodies, enumerable: false });
    if (l.writeBodies && l.writeBodies.length) Object.defineProperty(out, 'writeBodies', { value: l.writeBodies, enumerable: false });
    const own = h => hosts.some(x => h === x || h.replace(/:\d+$/, '') === x || h.replace(/:\d+$/, '').endsWith('.' + x));
    const away = {};
    for (const [k, n] of Object.entries(l.counts || {})) { const host = k.split(' ').pop(); if (host && host !== '?' && !own(host)) away[k] = n; }
    out.away = away;
  } catch (e) {}
  await cmd('capGuardOff', {}, 30).catch(() => {});
  return out;
}

// Her own presence (capPresence), for the plan's apps whose pack names where it comes from: her entry in those answers
// reads as the status the recording shows, so nobody needs to be at the computer. The own-status gate stays the
// backstop. → capPresence's answer, or null when no app has it
export async function presenceOn({ demo, cmd, packs, inPlan, recorded }) {
  const list = (packs && packs.presenceFor ? packs.presenceFor(demo.cfg) : []).filter(x => inPlan.has(x.app));
  if (!list.length) return null;
  const own = ownStatusApps(demo, packs, inPlan, recorded), apps = {};
  for (const x of list) { const o = own.find(y => y.app === x.app), status = o && o.expect[0]; if (status) apps[x.app] = { tab: appTab(demo, x.app), status, rules: x.rules }; }
  if (!Object.keys(apps).length) return null;
  return cmd('capPresence', { apps }, 30).catch(e => ({ on: false, error: e.message }));
}
export const presenceOff = async cmd => { const r = await cmd('capPresence', {}, 30).catch(() => null); await cmd('capPresence', { apps: {} }, 30).catch(() => {}); return r && r.on ? r.log : null; };
// Her own status on each app's tab now, for the plan's apps whose pack names its control: noted (a walk, a check),
// never a stop. → [{ app, status, expect, ok }]
export async function ownStatusNote({ demo, cmd, packs, plan, recorded }) {
  const out = [];
  for (const o of ownStatusApps(demo, packs, planApps(plan, demo.cfg.apps.map(a => a.id)), recorded)) {
    const r = await cmd('capOwnStatus', { read: { tab: appTab(demo, o.app), name: o.name, role: o.role } }, 30).catch(e => ({ found: false, error: e.message }));
    out.push({ app: o.app, status: r.found ? r.status : 'not shown', expect: o.expect, ok: !!r.found && o.expect.includes(r.status), ...(r.error ? { error: r.error } : {}) });
  }
  return out;
}

// Notices showing on each app's tab now, for the plan's apps whose pack names them: noted (a walk, a check), never a
// stop. → [{ app, showing: [words] }], only the apps showing one
export async function noticeNote({ demo, cmd, packs, plan }) {
  const out = [];
  for (const n of noticeApps(demo, packs, planApps(plan, demo.cfg.apps.map(a => a.id)))) {
    const r = await cmd('capNotices', { read: { tab: appTab(demo, n.app), notices: n.notices } }, 30).catch(e => ({ showing: [], error: e.message }));
    if ((r.showing || []).length || r.error) out.push({ app: n.app, showing: r.showing || [], ...(r.error ? { error: r.error } : {}) });
  }
  return out;
}

// reset.md's Check, live and read-only, in a live walker's tabs (Leave out and the guard as the caller has them):
// each line pass, wrong or can't, with a picture of the screen it was read on (shots). → { pass, wrong, cant, lines }
async function liveCheck({ demo, cmd, w, packs, plan, shots }) {
  const rf = join(demo.dir, 'reset.md');
  if (!existsSync(rf)) return null;
  const { parseReset } = await import('./reset.mjs');
  const lines = parseReset(readFileSync(rf, 'utf8')).checks;
  if (!lines.length) return null;
  mkdirSync(shots, { recursive: true });
  const shot = async (app, name) => { const file = join(shots, `${name}.png`); try { await cmd('capShot', { tab: appTab(demo, app), file }, 60); return file; } catch (e) { return null; } };
  const recorded = (() => { try { return walkerFromDemo(demo); } catch (e) { return null; } })();
  const out = await checkLines({ demo, cmd, walker: w, lines, plan, packs, recorded, shot });
  const n = k => out.filter(x => x.status === k).length;
  return { pass: n('pass'), wrong: n('wrong'), cant: n('cant'), lines: out };
}
// ai check: reset.md's Check read live in the capture browser, read-only (the guard holding every write, Leave out on
// for the plan's apps, nothing undone or set). .out/ai/check.json, pictures in .out/ai/check/.
export async function checkLive({ demo, emit = () => {}, cmd: viaCmd, packs }) {
  const cmd = viaCmd || rx(demo);
  await captureBrowser(cmd, 'a live check');
  const plan = readPlan(demo);
  if (!plan || !stepCount(plan)) throw new Error('make the plan first');
  packs = packs === undefined ? await walkerPacks() : packs;
  const lo = leaveOutOf({ demo, packs, apps: planApps(plan, demo.cfg.apps.map(a => a.id)) });
  if (lo.problems.length) throw new Error(`reset.md's Leave out: ${lo.problems[0]}`);
  const g = await guardOn(demo, cmd, packs);
  const t0 = Date.now(), shots = join(aiDir(demo), 'check');
  rmSync(shots, { recursive: true, force: true });
  let out = null, presence = null;
  try {
    if (lo.rules.length) { const r = await leaveOn(cmd, lo, { shots }).catch(e => ({ on: false, refused: e.message })); if (!r.on) throw new Error(`Leave out couldn't start: ${r.refused || 'the capture browser said no'}`); }
    // Her own presence as a run has it: the check reads her status as a run would see it.
    presence = await presenceOn({ demo, cmd, packs, inPlan: planApps(plan, demo.cfg.apps.map(a => a.id)) });
    emit({ event: 'stage', name: 'check', label: 'Checking the demo starts as it should' });
    const w = liveWalker({ demo, cmd, packs, log: text => emit({ event: 'note', text }) });
    out = (await liveCheck({ demo, cmd, w, packs, plan, shots })) || { pass: 0, wrong: 0, cant: 0, lines: [] };
    const own = await ownStatusNote({ demo, cmd, packs, plan });
    if (own.length) out.ownStatus = own;
    const nt = await noticeNote({ demo, cmd, packs, plan }).catch(e => [{ error: e.message }]);
    if (nt.length) out.notices = nt;
    out.inputs = w.inputs();
  } finally {
    if (presence) { const l = await presenceOff(cmd); out = { ...(out || {}), presence: { on: !!presence.on, ...(presence.who ? { who: presence.who } : {}), ...(l ? { log: l } : {}) } }; }
    if (lo.rules.length) await cmd('capLeaveOut', { rules: [] }, 60).catch(() => {});
    const off = await guardOff(cmd, g.hosts, senderApps(demo.cfg, packs));
    out = { ...(out || {}), secs: +((Date.now() - t0) / 1000).toFixed(1), guard: { held: (off.held || []).length, passed: (off.passed || []).length } };
    mkdirSync(aiDir(demo), { recursive: true });
    writeFileSync(join(aiDir(demo), 'check.json'), JSON.stringify(out, null, 1));
  }
  return out;
}

// A read-only walk of the plan in the capture browser: the live walker, no recording, nothing written (at a write it
// skips the rest of that beat). walk.json: each step reached, a write, after a write or missed; the time per beat;
// what the guard held; what left the apps' hosts; what the pages did that the plan didn't ask for.
export async function walkLive({ demo, emit = () => {}, cmd: viaCmd, packs, plan: viaPlan }) {
  const cmd = viaCmd || rx(demo);
  await captureBrowser(cmd, 'a live walk');
  const plan = viaPlan || readPlan(demo);
  if (!plan || !stepCount(plan)) throw new Error('make the plan first');
  packs = packs === undefined ? await walkerPacks() : packs;
  const { walkPlan, stepNets } = await import('./walk.mjs');
  // Leave out as a run has it, so a look-only walk shows what the capture will (and checks each screen it keeps).
  const inPlan = planApps(plan, demo.cfg.apps.map(a => a.id));
  const lo = leaveOutOf({ demo, packs, apps: inPlan });
  if (lo.problems.length) throw new Error(`reset.md's Leave out: ${lo.problems[0]}`);
  const g = await guardOn(demo, cmd, packs);
  const t0 = Date.now();
  const w = liveWalker({ demo, cmd, packs, log: text => emit({ event: 'note', text }) });
  const shots = join(aiDir(demo), 'walk');
  if (lo.rules.length) {
    const r = await leaveOn(cmd, lo, { shots }).catch(e => ({ on: false, refused: e.message }));
    if (!r.on) { await guardOff(cmd, g.hosts); throw new Error(`Leave out couldn't start: ${r.refused || 'the capture browser said no'}`); }
  }
  // Her own presence as a run has it.
  const presence = await presenceOn({ demo, cmd, packs, inPlan });
  const leaveChecks = [];
  const { leaveHits } = lo.rules.length ? await import('./leave-check.mjs') : {};
  // Every screen it lands on, and each app's start screen, as it is today (local only, under .out): for re-grounding a
  // plan on the product now. <beat>-<step>.json and start-<app>.json: its app, address, title, words and controls;
  // <name>.reads.json.gz: the screen in the reader's shape, read twice about a second apart
  // ([{ at, docs: [{ key, html }] }, …]).
  const screensDir = join(aiDir(demo), 'walk-screens');
  rmSync(screensDir, { recursive: true, force: true });
  mkdirSync(screensDir, { recursive: true });
  // The plan it walks, by its exact text: a re-ground refuses a walk of another plan.
  const planFile = join(demo.dir, 'plan.md');
  const planSha = !viaPlan && existsSync(planFile) ? createHash('sha256').update(readFileSync(planFile)).digest('hex') : null;
  const keepReads = async (name, app) => {
    const r = await w.reads(app).catch(() => null);
    if (r) writeFileSync(join(screensDir, `${name}.reads.json.gz`), gzipSync(JSON.stringify(r)));
    // The negative check a run makes before it saves a screen: her words, and what the filters took out so far.
    const id = w.appOf(app) || app;
    if (r && lo.rules.length) {
      const l = await leaveLog(cmd), words = lo.words[id] || [];
      const exact = [...new Set(((l && l.rules) || []).filter(x => x.app === id).flatMap(x => x.removed.map(y => y.shows)).filter(Boolean))];
      if (words.length || exact.length) {
        const hits = [];
        for (const x of r) { try { hits.push(...leaveHits(x.docs, { words, exact })); } catch (e) { hits.push({ by: 'error', value: e.message }); } }
        leaveChecks.push({ screen: name, app: id, ok: !hits.length, ...(hits.length ? { hits: hits.slice(0, 6) } : {}) });
      }
    }
  };
  // Each step's window, from its first input to its last read, and what the guard held in it (Rule 2: a held read
  // can change what a page shows).
  const stepAt = {};
  let lastEnd = Date.now(), heldSince = 0;
  const appOfSender = senderApps(demo.cfg, packs);
  await cmd('capNet', { on: true, watch: (packs && packs.servicesFor ? packs.servicesFor(demo.cfg) : []).filter(x => inPlan.has(x.app)).map(({ name, match }) => ({ name, match })) }, 30).catch(() => {});
  let netSince = ((await cmd('capNet', {}, 30).catch(() => ({}))).total) || 0;
  const netAll = [];
  // Failed requests (not the guard's) and answers ≥ 400 so far, each with its app; given to the steps at the end
  // (stepNets: from a step's first input to the next one's).
  const netMore = async () => {
    const r = await cmd('capNet', { since: netSince }, 30).catch(() => null);
    if (!r) return;
    netSince = r.total;
    netAll.push(...(r.net || []).map(x => ({ ...x, app: appOfSender(x) })));
  };
  const heldIn = async (from, to, app) => {
    const l = await cmd('capLog', { since: heldSince }, 30).catch(() => null);
    if (!l) return [];
    const list = l.held || [], upTo = list.findIndex(h => Date.parse(h.at) > to);
    heldSince += upTo < 0 ? list.length : upTo;
    const by = new Map();
    for (const h of list) {
      const t = Date.parse(h.at), sent = appOfSender(h);
      // The step's own app's (another tab's calls in its window aren't its), and ones no app can be named for.
      if (t < from || t > to || (sent && app && sent !== app)) continue;
      const k = `${h.method} ${h.host}${h.path}`, x = by.get(k) || { method: h.method, host: h.host, path: h.path, ...(h.frame ? { frame: h.frame } : {}), app: sent, n: 0 };
      x.n++; by.set(k, x);
    }
    return [...by.values()];
  };
  const seenAt = {};
  let walk, checked = null, ownNote = null, noticeNoteW = null;
  try {
    // reset.md's Check first, as the run reads it before anything (its plan's, not one given to walk instead).
    if (!viaPlan) { emit({ event: 'stage', name: 'check', label: 'Checking the demo starts as it should' }); checked = await liveCheck({ demo, cmd, w, packs, plan, shots: join(aiDir(demo), 'check') }).catch(e => ({ error: e.message })); }
    ownNote = await ownStatusNote({ demo, cmd, packs, plan }).catch(e => [{ error: e.message }]);
    noticeNoteW = await noticeNote({ demo, cmd, packs, plan }).catch(e => [{ error: e.message }]);
    const starts = [];
    for (const a of demo.cfg.apps) {
      const did = await w.home(a.id); const bad = did.find(d => d.why);
      const sc = bad ? { ok: false, why: `its start step "${bad.step}": ${bad.why}` } : await w.startCheck(a.id, plan);
      starts.push({ app: a.id, did, ...sc });
      const sn = await w.screenNow(a.id).catch(err => ({ error: err.message }));
      writeFileSync(join(screensDir, `start-${a.id}.json`), JSON.stringify({ start: a.id, status: sc.ok === false ? 'failed' : 'reached', ...(sc.why ? { why: sc.why } : {}), ...sn }, null, 1));
      await keepReads(`start-${a.id}`, a.id);
    }
    seenAt.starts = starts;
    lastEnd = Date.now();
    walk = await walkPlan(plan, {
      live: true,
      // A walk only measures: words that changed are noted and it goes on (a run stops there).
      soft: true,
      start: app => w.start(app),
      step: (at, s) => w.step(at, s),
      // The plan's own Writes lines, then what the live screen says: its control, the field Enter is pressed in.
      writeOf: async (s, at, app) => {
        if (!at || !(s.kind === 'click' || s.kind === 'press')) return null;
        const id = w.appOf(app) || at.app;
        const o = await w.controls(id);
        const el = s.kind === 'click' ? (await w.locate(id, s.target)).el : null;
        const r = w.writeOf(s, el, s.kind === 'press' ? w.focusedField(o) : null, o.url);
        return r ? r.why : null;
      },
      landed: () => ({ ok: true }),
      stopBeat: app => w.clearTyped(app),
    }, { emit: async e => {
      emit(e);
      if (e.event === 'walk') {
        const mine = w.inputs().filter(i => Date.parse(i.at) >= lastEnd);
        const from = mine.length ? Date.parse(mine[0].at) : lastEnd;
        let sn = null;
        if (['reached', 'drifted', 'unproven'].includes(e.status) && e.app) {
          sn = await w.screenNow(e.app).catch(err => ({ error: err.message }));
          await keepReads(`${e.beat}-${e.step + 1}`, e.app);
        }
        const stepApp = e.app ? w.appOf(e.app) || e.app : null;
        const to = Date.now(), held = await heldIn(from, to, stepApp);
        await netMore();
        stepAt[`${e.beat}-${e.step}`] = { from: new Date(from).toISOString(), to: new Date(to).toISOString(), held, app: stepApp };
        if (sn) writeFileSync(join(screensDir, `${e.beat}-${e.step + 1}.json`), JSON.stringify({ beat: e.beat, step: e.step + 1, status: e.status, screen: e.screen, ...sn, held }, null, 1));
        lastEnd = to;
      }
      // A picture of each miss and each drifted landing, for whoever reads walk.json; for a drifted one, what the
      // screen says instead (its title, headings and first lines), so a plan's landing words can follow the product.
      if ((e.status === 'missed' || e.status === 'drifted' || e.status === 'unproven') && e.app) {
        const id = w.appOf(e.app) || e.app;
        await cmd('capShot', { tab: appTab(demo, id), file: join(shots, `${e.beat}-${e.step + 1}.png`) }, 60).catch(() => {});
        if (e.status === 'drifted') {
          const o = await w.controls(id).catch(() => ({}));
          seenAt[`${e.beat}-${e.step}`] = { title: o.title || null, headings: (o.headings || []).slice(0, 6), lines: String(o.text || '').split('\n').map(s => s.trim()).filter(Boolean).slice(0, 12) };
        }
      }
    } });
  } finally {
    await netMore().catch(() => {});
    const walked = [];
    for (const b of (walk && walk.beats) || []) for (const s of b.steps) {
      if (seenAt[`${b.beat}-${s.step}`]) s.seen = seenAt[`${b.beat}-${s.step}`];
      const at = stepAt[`${b.beat}-${s.step}`];
      if (at) { Object.assign(s, { app: at.app, window: { from: at.from, to: at.to }, held: at.held }); walked.push(s); }
    }
    const nets = stepNets(walked.map(s => ({ from: s.window.from, app: s.app })), netAll, new Date().toISOString());
    walked.forEach((s, i) => { if (nets[i].length) s.net = nets[i]; });
    if (walk) walk.starts = seenAt.starts || [];
    if (presence) await presenceOff(cmd);
    let leaveOut;
    if (lo.rules.length) {
      const l = await leaveLog(cmd);
      leaveOut = { lines: lo.lines.map(x => ({ app: x.app, what: x.what, from: x.from, shows: x.shows })), rules: l.rules || [], dom: l.dom || [], screens: leaveChecks };
      await cmd('capLeaveOut', { rules: [] }, 60).catch(() => {});
    }
    const off = await guardOff(cmd, g.hosts, appOfSender);
    keepBodiesOut(demo, off.bodies);
    walk = { ...(walk || {}), ...(checked ? { check: checked } : {}), ...(ownNote && ownNote.length ? { ownStatus: ownNote } : {}), ...(noticeNoteW && noticeNoteW.length ? { notices: noticeNoteW } : {}), ...(leaveOut ? { leaveOut } : {}), ...(planSha ? { plan: { file: 'plan.md', sha256: planSha } } : {}), net: netAll, secs: +((Date.now() - t0) / 1000).toFixed(1), inputs: w.inputs(), guard: { hosts: g.hosts, allow: g.allow.length, ...off } };
    try { walk.events = (await cmd('capEvents', {}, 30)).events.map(e => ({ ...e, app: appOfSender({ tab: e.host }) })); } catch (e) {}
    walk.suspect = suspectSteps({ demo, plan, walk, screensDir, packs });
    mkdirSync(aiDir(demo), { recursive: true });
    writeFileSync(join(aiDir(demo), 'walk.json'), JSON.stringify(walk, null, 1));
  }
  return walk;
}
