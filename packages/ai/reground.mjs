// A plan's proofs, grounded again on the product as it is today (docs/engine/plan-format.md, "Proofs on today's
// product"). A live walk (walk.mjs, in the capture browser, read-only) saves each screen it reaches, read twice once
// the page is quiet, and each app's start screen, as its frames' markup. Each step's proof is chosen again by
// landing.mjs's rules, on those reads and the recording: it holds on the recording and on every read of the step's
// screen today, and on none of the screens before it, the recording's or today's. Where nothing does, a proof on
// today's reads alone, marked: the product changed since the recording. A step the walk didn't reach keeps its
// recorded proof, marked: behind a write it didn't make, or not reached.
//   regroundPlan(plan, { walker, walk, reads }) → { plan, rows }   the plan with its new proofs; a row per step
//   walkReads(dir)                                  a walk's saved screens, read by the recording's reader
//   formatReground(rows)                            the proofs before and after, for whoever adopts them
//   reground(demo, { from, plan, packs })           .out/ai/reground.md and .json, and plan.reground.md
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { readScreen } from '@scenecast/script/html.mjs';
import { chooseProof, holds, proofWords, pageWords, pnorm, changes } from './landing.mjs';
import { formatLands, formatPlan, formatStep, parsePlan } from './plan.mjs';
import { walkerFromDemo, inPlace } from './walker.mjs';
import { aiDir } from './run.mjs';

const PLAN = 'plan.md';
// A walk's steps that ran, so their screens were read (walk.mjs's statuses).
const RAN = new Set(['reached', 'drifted', 'unproven']);

// The screens a walk saved (walk-screens/, as the live walk writes them: unattended.mjs): <beat>-<step>.reads.json.gz
// (both from 1) and start-<app>.reads.json.gz, each gzipped JSON [{ at, docs: [{ key, html }] }, …]: the page read
// twice, about a second apart once quiet, as its documents (its own, key "main", then each frame's, by its host) the
// way the recorder's serializer writes them (serialize.js, without CSS). <beat>-<step>.json beside it holds the walk's
// words and controls, which this doesn't use, and what the guard held while the step ran (held: [{ method, host, path
// }]), when the walk says. → step(beat, step) / start(app): the reads as the reader reads them, or null; at(beat, step)
// / startAt(app): when each read was taken (ms), or null; held(beat, step): the walk's held list, or null; why(beat,
// step): why there are no reads.
export function walkReads(dir) {
  const memo = new Map(), whys = new Map();
  const load = name => {
    if (!memo.has(name)) {
      let got = null, at = null;
      const gz = join(dir, `${name}.reads.json.gz`);
      if (existsSync(gz)) {
        try {
          const rs = JSON.parse(gunzipSync(readFileSync(gz)).toString('utf8')).filter(r => r && Array.isArray(r.docs) && r.docs.some(x => x && x.html));
          got = rs.map(r => readScreen(r.docs));
          at = rs.map(r => Date.parse(r.at)).filter(Number.isFinite);
        } catch (e) { whys.set(name, `the reader couldn't read its screen (${e.message})`); }
      }
      if (!(got && got.length) && !whys.has(name)) whys.set(name, existsSync(join(dir, `${name}.json`)) ? 'the walk saved its screen without the page\u2019s markup' : 'the walk saved no screen for it');
      memo.set(name, got && got.length ? { got, at: at && at.length ? at : null } : null);
    }
    return memo.get(name);
  };
  const heldOf = name => { try { const h = JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')).held; return Array.isArray(h) ? h : null; } catch (e) { return null; } };
  const one = name => (load(name) || {}).got || null, when = name => (load(name) || {}).at || null;
  return { step: (beat, step) => one(`${beat}-${step}`), start: app => one(`start-${app}`), at: (beat, step) => when(`${beat}-${step}`), startAt: app => when(`start-${app}`),
    held: (beat, step) => heldOf(`${beat}-${step}`), why: (beat, step) => whys.get(`${beat}-${step}`) || null };
}

// A request the guard held, as a kind: its method, host and path, with ids as * (POST api.example.com/items/*/query).
const idLike = p => /^(?:\d{3,}|[0-9a-f]{16,})$/i.test(p) || /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(p) || (/%3a|:/i.test(p) && /\d{4}/.test(p));
export const heldKind = h => `${String(h.method || 'GET').toUpperCase()} ${h.host || ''}${String(h.path || '').split('?')[0].split('/').map(p => idLike(p) ? '*' : p).join('/')}`;
// What an app sends whatever it shows, and that shows nothing: telemetry, logs and reports.
const TELEMETRY = /^(?:[\w-]+\.)*(?:events\.data\.microsoft\.com|pipe\.aria\.microsoft\.com|applicationinsights\.azure\.com|dc\.services\.visualstudio\.com)\/|\/(?:onecollector|collector|events|track|telemetry|instrument|logclient|logflight|beacon|metrics|ping|report)(?:\/|$)/i;
export const isTelemetry = kind => TELEMETRY.test(String(kind).slice(String(kind).indexOf(' ') + 1));
// A pack's guard entry (@stuntdouble/apps: a host/path prefix, or a /regex/ over "METHOD host/path") against a held
// request; "… when body /regex/" is checked on the request alone (a held request's body isn't kept).
const reOf = e => typeof e === 'string' && /^\/.+\/[a-z]*$/.test(e) ? new RegExp(e.slice(1, e.lastIndexOf('/')), e.slice(e.lastIndexOf('/') + 1)) : null;
const reviews = (entry, h) => {
  const req = String(entry).split(' when body ')[0], re = reOf(req), at = `${h.host || ''}${String(h.path || '').split('?')[0]}`;
  return re ? re.test(`${String(h.method || 'GET').toUpperCase()} ${at}`) : at.startsWith(req);
};
const hostIs = (h, x) => !!h && !!x && (h === x || h.endsWith('.' + x));
const urlHost = u => { try { return new URL(u).host; } catch (e) { return null; } };
// Each app's hosts (its address, its pack's match and guard hosts) and the requests its pack has reviewed as staying
// held (guard.stayHeld).
function sitesOf(apps = [], packs = null) {
  return apps.map(a => {
    const p = ((packs && packs.forApp) || {})[a.id] || {}, g = p.guard || {};
    return { id: a.id, hosts: [urlHost(a.url), ...(p.match || []).map(m => String(m).split('/')[0]), ...(g.hosts || [])].filter(Boolean), stayHeld: g.stayHeld || [] };
  });
}
// What the guard held once the walk had read its apps' start screens, each { t, h, kind, app }: the app it was for is
// the walk's own (a held request's app, or its frame's host), else the app whose hosts it went to, else the app of the
// step it was held in (from the step's first input, else the step before's last read, to its own last read). A step's
// own held list (walk-screens' <beat>-<step>.json held), when the walk gives one, is that step's.
// → { held, windows: Map '<beat>-<step>' → { from, end } }
function heldDuring(walk, reads, steps, rowOf, appAt, sites) {
  const inputs = ((walk && walk.inputs) || []).map(i => ({ t: Date.parse(i.at), for: i.for })).filter(i => Number.isFinite(i.t));
  const starts = ((walk && walk.starts) || []).flatMap(st => (reads.startAt && reads.startAt(st.app)) || []);
  const begun = starts.length ? Math.max(...starts) : -Infinity;
  const appFor = h => ((h.app && sites.find(a => a.id === h.app)) || sites.find(a => a.hosts.some(x => hostIs(h.frame || h.frameHost, x))) || sites.find(a => a.hosts.some(x => hostIs(h.host, x))) || {}).id || null;
  const windows = new Map(), held = [];
  let last = begun;
  for (const [k, { s, bi, si }] of steps.entries()) {
    const r = rowOf(bi, si), at = r && RAN.has(r.status) && reads.at ? reads.at(bi + 1, si + 1) : null;
    if (!at || !at.length) continue;
    const end = Math.max(...at), text = formatStep(s), mine = inputs.filter(i => i.for === text && i.t > last && i.t <= end).map(i => i.t);
    const w = { from: mine.length ? Math.min(...mine) : last, after: last, end, app: appAt[k], own: reads.held ? reads.held(bi + 1, si + 1) : null };
    windows.set(`${bi + 1}-${si + 1}`, w);
    for (const h of w.own || []) held.push({ t: end, h, kind: heldKind(h), app: appFor(h) || w.app });
    last = end;
  }
  for (const h of (walk && walk.guard && walk.guard.held) || []) {
    const t = Date.parse(h.at);
    if (!Number.isFinite(t) || t <= begun) continue;
    const w = [...windows.values()].find(x => t >= x.from && t > x.after && t <= x.end);
    if (w && w.own) continue;
    const app = appFor(h) || (w && w.app) || null;
    if (app) held.push({ t, h, kind: heldKind(h), app });
  }
  return { held, windows };
}
// An error a page shows: one of these, or anything in an alert.
const ERROR = /\b(?:couldn['’]?t load|could not load|can['’]?t load|check your connection|try again|something went wrong)\b/i;
const short = t => (t = String(t).replace(/\s+/g, ' ').trim()).length > 80 ? `${t.slice(0, 77)}…` : t;
function errorsOn(got, rec) {
  const was = rec ? pageWords(rec) : '', out = [];
  for (const g of got) for (const i of g.items || []) if (!i.shut && i.text && (ERROR.test(i.text) || i.role === 'alert') && !was.includes(pnorm(i.text)) && !out.some(x => pnorm(x) === pnorm(i.text))) out.push(i.text);
  return out.filter(t => !out.some(u => u !== t && pnorm(u).length < pnorm(t).length && pnorm(t).includes(pnorm(u))));
}
// A screen's words a run can count on, as the proofs' (not in a closed dialog, a live region, a time, a message or a
// text area), innermost only (a box holding missing words is missing too).
function soundTexts(sc, keep) {
  const texts = [...new Set((sc.items || []).filter(i => !i.shut && !i.live && !i.time && i.tag !== 'textarea' && i.article === undefined && i.text && keep(i.text, i, sc)).map(i => i.text))];
  return texts.filter(t => !texts.some(u => u !== t && pnorm(u).length < pnorm(t).length && pnorm(t).includes(pnorm(u))));
}
const lostFrom = (was, got, keep) => soundTexts(was, keep).filter(t => t.split(/\s+/).length >= 2 && got.every(g => !pageWords(g).includes(pnorm(t))));
// What a capture of today's product would lose: words and controls the recorded screen has that both of today's reads
// lack.
function missingFrom(rec, got, keep) {
  const names = got.map(g => new Set((g.controls || []).filter(c => !c.shut).map(c => pnorm(c.name))));
  const words = soundTexts(rec, keep).filter(t => got.every(g => !pageWords(g).includes(pnorm(t))));
  const controls = [...new Set((rec.controls || []).filter(c => !c.shut && !c.live && !c.time && c.name && c.name.length < 80 && keep(c.name)).map(c => c.name))].filter(n => names.every(x => !x.has(pnorm(n))));
  // A control's own words count once, as the control.
  return { words: words.filter(t => !controls.some(n => pnorm(n) === pnorm(t))), controls };
}

// Words in a place where the recording's captures differ (a greeting that changes on each visit): what a read today
// shows there instead can't be counted on either. Each read is compared with the recording of the same step only.
const wn = t => String(t || '').toLowerCase().replace(/[^a-z0-9$%]+/g, ' ').trim();
function shakyToday(rec, got, walker, app) {
  const swaps = [];
  if (rec && walker.unstable) for (const g of got) for (const [x, y] of (inPlace(rec, g) || { changed: [] }).changed) {
    const was = x.split(' | ');
    if (was.some(t => walker.unstable(t, app))) swaps.push({ x: was, y: y.split(' | ') });
  }
  return t => {
    const n = wn(t), long = n.split(' ').length >= 3;
    if (!n) return false;
    const has = side => side.includes(n) || (long && side.some(u => ` ${u} `.includes(` ${n} `)));
    return swaps.some(c => has(c.x) !== has(c.y));
  };
}

// walk: walk.json ({ beats: [{ steps: [{ step, text, status, why, needs }] }], guard: { held: [{ method, host, path, at,
// app?, frame? }] }, inputs: [{ at, for }], starts: [{ app }] }, a row per plan step, step from 0); reads: walkReads();
// apps: the demo's ({ id, url }; else the walker's); packs: make.mjs loadPacks()'s, for each app's hosts and the
// requests its pack has reviewed as staying held. Each row: { beat, step, text, screen, status, was, now, basis, why,
// changed, number, held, missing }, missing: what the recorded screen has that today's reads lack ({ words, controls }).
// basis one of
//   both       its proof holds today and in the recording (changed: a new one, why says what was wrong)
//   today      on today's reads only: the product changed since the recording (or the recording typed other words)
//   none       nothing tells today's screen from the one before: a run can't check it (Needs you)
//   suspect    its app's page may be broken today, not by the product: since a request the guard held that isn't
//              telemetry and that no pack has reviewed (held: their kinds), an error the recording doesn't show, or
//              words lost while nothing ran in it. A step that didn't land as planned then, or whose proof would
//              change, keeps its proof (Needs you, with the reason).
//   write      behind a write the walk didn't make (or needs one: a step it missed for one, the steps after that miss,
//              a step whose words may be its doing): the recording's proof stays
//   missed     the walk didn't land it (why says why): the recording's proof stays
//   unreached  the walk didn't get here, or ran it and saved no screen: the recording's proof stays
export function regroundPlan(plan0, { walker, walk, reads, apps = null, packs = null }) {
  const plan = JSON.parse(JSON.stringify(plan0));
  const steps = plan.beats.flatMap((b, bi) => b.steps.map((s, si) => ({ s, bi, si })));
  const rowOf = (bi, si) => ((((walk && walk.beats) || [])[bi] || {}).steps || []).find(r => r.step === si) || null;
  const other = steps.find(({ s, bi, si }) => { const r = rowOf(bi, si); return r && r.text && r.text !== formatStep(s); });
  if (other) throw new Error(`the walk was of another plan (beat ${other.bi + 1}, step ${other.si + 1} was “${rowOf(other.bi, other.si).text}”, now “${formatStep(other.s)}”): walk this plan first`);
  const typedAll = [...(walker.typedTexts ? walker.typedTexts() : []), ...steps.map(({ s }) => s.kind === 'type' ? s.value : null).filter(Boolean)];
  // Each step's app: the one the plan was in.
  const appAt = [];
  { let a = null; for (const { s } of steps) { if (s.kind === 'app') a = s.app; appAt.push(a); } }
  const sites = sitesOf(apps || walker.apps || [], packs);
  // What may have broken an app's page today, from when (the page can't be reloaded, as far as a walk can tell, so to
  // the end of it): a held request that isn't telemetry and that no pack has reviewed as staying held, for the app it
  // was for; an error a read shows that the recording doesn't; words an app lost while nothing ran in it.
  const { held, windows } = heldDuring(walk, reads, steps, rowOf, appAt, sites);
  const reviewed = h => sites.some(a => a.stayHeld.some(e => reviews(e, h)));
  const reasons = held.filter(x => !isTelemetry(x.kind) && !reviewed(x.h)).map(x => ({ app: x.app, t: x.t, held: x.kind, why: `the guard held ${x.kind}` }));
  // When each step was: its last read; one without, before the next step with reads began.
  const when = [];
  { let next = Infinity; for (let k = steps.length - 1; k >= 0; k--) { const w = windows.get(`${steps[k].bi + 1}-${steps[k].si + 1}`); when[k] = w ? w.end : next - 1; if (w) next = w.from; } }
  const keep = app => (t, i, sc) => /[a-z]/i.test(t) && !changes(t) && !(walker.written && walker.written(t)) && !(i && sc && walker.writtenItem && walker.writtenItem(i, sc))
    && !(walker.unstable && walker.unstable(t, app)) && !typedAll.some(v => pnorm(t).length > 3 && pnorm(v).includes(pnorm(t)));
  const lastRead = {};
  const rows = [];
  // Today's screen before a step: the reads after the step before it; before anything ran, its app's start screen
  // (nothing, before a first "Go to"); null when that screen wasn't read (a miss, or nothing saved).
  // A write the walk didn't make, in this app, that a step needs (walk.mjs `needs`, on a missed or drifted step): what
  // isn't there may be that write's doing. The steps after such a miss, in its beat, need it too.
  let cur = null, prev = [], started = false;
  const missNeeds = {};
  for (const [k, { s, bi, si }] of steps.entries()) {
    const r0 = rowOf(bi, si), status = r0 ? r0.status : null;
    const needs = (r0 && r0.needs) || (status === 'after-miss' ? missNeeds[bi] : null) || null;
    if (status === 'missed' && needs) missNeeds[bi] = needs;
    const ran = RAN.has(status), got = ran ? reads.step(bi + 1, si + 1) : null;
    const to = s.lands && s.lands.screen, from = cur;
    const app = appAt[k] || ((walker.flow.states[to] || {}).app || null);
    const before = started ? prev : s.kind !== 'app' && app ? reads.start(app) : [];
    if (ran || status === 'missed') { started = true; prev = got; }
    if (got && app) {
      const at = (reads.at && reads.at(bi + 1, si + 1)) || [], t0 = at.length ? Math.min(...at) : when[k];
      for (const e of errorsOn(got, to ? walker.screen(to) : null)) reasons.push({ app, t: t0, why: `today's screen shows an error the recording doesn't: “${short(e)}”` });
      const was = lastRead[app] || { got: reads.start(app), from: 'its start screen' };
      if (s.kind === 'app' && was.got) {
        const lost = lostFrom(was.got[was.got.length - 1], got, keep(app));
        if (lost.length) reasons.push({ app, t: t0, why: `${app} lost words while nothing ran in it, since ${was.from}: “${short(lost[0])}”${lost.length > 1 ? ` and ${lost.length - 1} more` : ''}` });
      }
      lastRead[app] = { got, from: `step ${bi + 1}-${si + 1}` };
    }
    const active = app ? [...new Map(reasons.filter(x => x.app === app && x.t <= when[k]).map(x => [x.why, x])).values()] : [];
    const suspect = () => ({ basis: 'suspect', held: active.filter(x => x.held).map(x => x.held), why: `${active.map(x => x.why).join('; ')}; check ${active.some(x => x.held) ? 'the pack' : 'the app'} before adopting` });
    if (!to) continue;
    cur = to;
    const was = { ...s.lands };
    const row = { beat: bi + 1, step: si + 1, text: formatStep(s), screen: to, status: status || 'not walked', was: formatLands(was) };
    rows.push(row);
    if (!got) {
      const behind = status === 'write' || status === 'after-write' || (!ran && !!needs);
      Object.assign(row, { now: row.was, changed: false, basis: behind ? 'write' : status === 'missed' ? 'missed' : 'unreached',
        why: ran ? (reads.why && reads.why(bi + 1, si + 1)) || 'the walk saved no screen for it' : status === 'write' ? `a write: ${r0.why}`
          : needs && status !== 'after-write' ? `needs ${needs}${status === 'missed' && r0.why ? ` (the walk: ${r0.why})` : ''}` : (r0 && r0.why) || "the walk didn't get here" });
      if (row.basis === 'missed' && active.length) { const sp = suspect(); Object.assign(row, sp, { why: `${sp.why} (the walk: ${r0.why || 'missed'})` }); }
      continue;
    }
    row.read = true;
    const rec0 = walker.screen(to);
    if (rec0) row.missing = missingFrom(rec0, got, keep(app));
    // A step that didn't land as planned while its app's page may be broken keeps its proof: what's missing may not be
    // the product's doing.
    if (active.length && status !== 'reached') { Object.assign(row, { now: row.was, changed: false }, suspect()); continue; }
    const next = (steps.slice(k + 1).find(({ s: x }) => !/^(wait|scroll)$/.test(x.kind)) || {}).s || null;
    const opts = { typed: typedAll.filter(v => !(s.kind === 'type' && v === s.value)), next };
    const rec = walker.screen(to), unstable = shakyToday(rec, got, walker, app);
    let r = chooseProof(s, from, to, walker, { ...opts, live: { afters: got, befores: before || [], unstable } }), alone = false;
    // Nothing holds on both: today's reads alone, when today's screen before the step was read, unless a write the walk
    // didn't make comes first (then the recording's proof stays).
    if (!r.lands.kind && needs) { Object.assign(row, { now: row.was, changed: false, basis: 'write', why: `needs ${needs}` }); continue; }
    if (!r.lands.kind && before) { const t = chooseProof(s, from, to, walker, { ...opts, live: { afters: got, befores: before, unstable, only: true } }); if (t.lands.kind) { r = t; alone = true; } }
    s.lands = { screen: to, ...r.lands, text: r.lands.kind === 'words' ? r.lands.text : null };
    row.now = formatLands(s.lands);
    row.changed = row.now !== row.was;
    row.basis = !r.lands.kind ? 'none' : alone || !(rec && holds(rec, s.lands) === true) ? 'today' : 'both';
    if (r.number) row.number = true;
    // Landed as planned, but its proof would change while its app's page may be broken: never a new proof from it.
    if (active.length && row.changed) { s.lands = { ...was }; Object.assign(row, { now: row.was, changed: false, number: undefined }, suspect()); continue; }
    const today = was.kind && got.every(g => holds(g, was) === true), early = was.kind && (before || []).some(b => holds(b, was) === true);
    const old = !row.changed ? null : !was.kind ? 'it had no proof' : !today ? `${proofWords(was)} isn't on today's screen`
      : early ? `${proofWords(was)} is on today's screen before it too` : `today, ${proofWords(was)} isn't words a run can count on`;
    row.why = row.basis === 'none' ? [old, r.why].filter(Boolean).join('; ') : row.basis === 'today' && s.kind === 'type' && rec && holds(rec, s.lands) !== true ? [old, 'the recording has other words typed here'].filter(Boolean).join('; ') : old;
  }
  return { plan, rows };
}

const BASIS = {
  both: 'Holds today and in the recording',
  today: "Today's product only: it changed since the recording",
  suspect: "Its app's page may be broken today",
  none: 'Nothing proves it today',
  write: "Behind a write the walk didn't make",
  missed: 'Missed today',
  unreached: 'Not reached today',
};
const cell = t => String(t || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
// The counts reground.md starts with, and reground() returns.
export const regroundCounts = rows => {
  const n = f => rows.filter(f).length;
  return { steps: rows.length, kept: n(r => r.basis === 'both' && !r.changed), changed: n(r => r.basis === 'both' && r.changed), today: n(r => r.basis === 'today'),
    suspect: n(r => r.basis === 'suspect'), none: n(r => r.basis === 'none'), write: n(r => r.basis === 'write'), missed: n(r => r.basis === 'missed'), unreached: n(r => r.basis === 'unreached') };
};
export function formatReground(rows) {
  const c = regroundCounts(rows);
  const read = rows.filter(r => r.read).length;
  const out = ["# Proofs on today's product", '', `${rows.length} steps land on a screen. Today's walk read ${read} of them.`, '', '| | Steps |', '|---|---|',
    `| Kept: it holds today and in the recording | ${c.kept} |`,
    `| New: it holds today and in the recording | ${c.changed} |`,
    `| ${BASIS.today} | ${c.today} |`,
    `| ${BASIS.suspect} (Needs you) | ${c.suspect} |`,
    `| ${BASIS.none} (Needs you) | ${c.none} |`,
    `| ${BASIS.write}: the recording's proof stays | ${c.write} |`,
    `| ${BASIS.missed}: the recording's proof stays | ${c.missed} |`,
    `| ${BASIS.unreached}: the recording's proof stays | ${c.unreached} |`, ''];
  const changed = rows.filter(r => (r.basis === 'both' || r.basis === 'today') && (r.changed || r.basis === 'today'));
  if (changed.length) {
    out.push('## What changed', '', '| Beat | Step | Was | Now | Why |', '|---|---|---|---|---|');
    for (const r of changed) out.push(`| ${r.beat} | ${cell(r.text)} | ${cell(r.was)} | ${cell(r.now)}${r.basis === 'today' ? ' (today only)' : ''}${r.number ? ' (a number)' : ''} | ${cell(r.why)} |`);
    out.push('');
  }
  const guarded = rows.filter(r => r.basis === 'suspect'), unproven = rows.filter(r => r.basis === 'none');
  if (guarded.length || unproven.length) out.push('## Needs you', '');
  if (guarded.length) {
    out.push('These steps\u2019 pages may have been broken today by something other than the product, so their proofs stay as they are: check first.', '', '| Beat | Step | Proof | Why |', '|---|---|---|---|');
    for (const r of guarded) out.push(`| ${r.beat} | ${cell(r.text)} | ${cell(r.now)} | ${cell(r.why)} |`);
    out.push('');
  }
  if (unproven.length) {
    out.push('Nothing on today\u2019s screen tells these steps apart from the one before, so a run can\u2019t check them.', '', '| Beat | Step | Was | Why |', '|---|---|---|---|');
    for (const r of unproven) out.push(`| ${r.beat} | ${cell(r.text)} | ${cell(r.was)} | ${cell(r.why)} |`);
    out.push('');
  }
  // What a capture of today's product would lose, screen by screen.
  const lost = rows.filter(r => r.missing && (r.missing.words.length || r.missing.controls.length));
  if (lost.length) {
    const list = (xs, n) => `${xs.slice(0, n).map(x => `“${cell(short(x))}”`).join(', ')}${xs.length > n ? ` and ${xs.length - n} more` : ''}`;
    out.push('## Missing since the recording', '', 'Words and controls each recorded screen has that both of today\u2019s reads lack.', '', '| Beat | Step | Screen | Words | Controls |', '|---|---|---|---|---|');
    for (const r of lost) out.push(`| ${r.beat} | ${cell(r.text)} | ${r.screen} | ${list(r.missing.words, 8)} | ${list(r.missing.controls, 6)} |`);
    out.push('');
  }
  const kept = rows.filter(r => r.basis === 'write' || r.basis === 'missed' || r.basis === 'unreached');
  if (kept.length) {
    out.push('## Not checked today', '', '| Beat | Step | Proof | Why |', '|---|---|---|---|');
    for (const r of kept) out.push(`| ${r.beat} | ${cell(r.text)} | ${cell(r.now)} | ${cell(r.why)} |`);
    out.push('');
  }
  return out.join('\n');
}

// from: the folder holding walk.json and walk-screens/ (a walk's own: .out/ai). plan: the plan the walk walked, when
// it isn't the demo's plan.md now. plan.md stays as it is: until --adopt (after stage F: plan-format.md, "Approval"),
// adopting plan.reground.md means approving it again.
export function reground(demo, { from = null, plan: planFile = null, packs = null } = {}) {
  const dir = from || aiDir(demo), wf = join(dir, 'walk.json'), pf = planFile || join(demo.dir, PLAN);
  if (!existsSync(pf)) throw new Error(planFile ? `${planFile}: there\u2019s no such file` : 'make the plan first');
  if (!existsSync(wf)) throw new Error("there's no walk to ground the plan on: walk it in the capture browser first");
  const walker = walkerFromDemo(demo);
  if (!walker) throw new Error("there's no recording to compare today's screens with");
  const { plan, rows } = regroundPlan(parsePlan(readFileSync(pf, 'utf8')), { walker, walk: JSON.parse(readFileSync(wf, 'utf8')), reads: walkReads(join(dir, 'walk-screens')), apps: (demo.cfg && demo.cfg.apps) || null, packs });
  walker.save();
  mkdirSync(aiDir(demo), { recursive: true });
  writeFileSync(join(aiDir(demo), 'reground.md'), formatReground(rows));
  writeFileSync(join(aiDir(demo), 'reground.json'), JSON.stringify({ at: new Date().toISOString(), walk: wf, plan: pf, rows }, null, 1) + '\n');
  writeFileSync(join(aiDir(demo), 'plan.reground.md'), formatPlan(plan));
  return { ...regroundCounts(rows), file: 'reground.md', plan: 'plan.reground.md' };
}
