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
//   reground(demo, { from, plan })                  .out/ai/reground.md and .json, and plan.reground.md
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { readScreen } from '@scenecast/script/html.mjs';
import { chooseProof, holds, proofWords } from './landing.mjs';
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

// A request the guard held, as a kind: its method, host and path, with ids as * (GET api.example.com/items/*).
const ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{3,}|[0-9a-f]{16,})$/i;
export const heldKind = h => `${String(h.method || 'GET').toUpperCase()} ${h.host || ''}${String(h.path || '').split('?')[0].split('/').map(p => ID.test(p) ? '*' : p).join('/')}`;
// What the guard held while each step that ran was running: the walk's own list for the step (walk-screens'
// <beat>-<step>.json held), else the held requests from the step's first input (the walk's inputs, by the step they
// were for; else from the step before's last read; before any, from the last start screen's) to its own last read.
// → Map '<beat>-<step>' → [kind]
function heldBySteps(walk, reads, steps, rowOf) {
  const out = new Map();
  const held = ((walk && walk.guard && walk.guard.held) || []).map(h => ({ t: Date.parse(h.at), kind: heldKind(h) })).filter(h => Number.isFinite(h.t));
  const inputs = ((walk && walk.inputs) || []).map(i => ({ t: Date.parse(i.at), for: i.for })).filter(i => Number.isFinite(i.t));
  const starts = ((walk && walk.starts) || []).flatMap(st => (reads.startAt && reads.startAt(st.app)) || []);
  let last = starts.length ? Math.max(...starts) : -Infinity;
  for (const { s, bi, si } of steps) {
    const r = rowOf(bi, si);
    if (!r || !RAN.has(r.status)) continue;
    const own = reads.held && reads.held(bi + 1, si + 1), at = reads.at && reads.at(bi + 1, si + 1);
    const end = at ? Math.max(...at) : null;
    if (own) out.set(`${bi + 1}-${si + 1}`, [...new Set(own.map(heldKind))]);
    else if (end !== null) {
      const text = formatStep(s), mine = inputs.filter(i => i.for === text && i.t > last && i.t <= end).map(i => i.t);
      const from = mine.length ? Math.min(...mine) : last;
      out.set(`${bi + 1}-${si + 1}`, [...new Set(held.filter(h => h.t >= from && h.t <= end && h.t > last).map(h => h.kind))]);
    }
    if (end !== null) last = end;
  }
  return out;
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

// walk: walk.json ({ beats: [{ steps: [{ step, text, status, why }] }], guard: { held: [{ method, host, path, at }] },
// inputs: [{ at, for }] }, a row per plan step, step from 0); reads: walkReads(). Each row: { beat, step, text, screen,
// status, was, now, basis, why, changed, number, held }, basis one of
//   both       its proof holds today and in the recording (changed: a new one, why says what was wrong)
//   today      on today's reads only: the product changed since the recording (or the recording typed other words)
//   none       nothing tells today's screen from the one before: a run can't check it (Needs you)
//   suspect    the guard held a request while it ran that it held only while steps didn't land as planned: what's
//              missing today may be the guard's doing, not the product's, so its proof stays (Needs you: check the
//              app pack first). held: those requests' kinds.
//   write      behind a write the walk didn't make (or needs one: a step it missed for one, the steps after that miss,
//              a step whose words may be its doing): the recording's proof stays
//   missed     the walk didn't land it (why says why): the recording's proof stays
//   unreached  the walk didn't get here, or ran it and saved no screen: the recording's proof stays
export function regroundPlan(plan0, { walker, walk, reads }) {
  const plan = JSON.parse(JSON.stringify(plan0));
  const steps = plan.beats.flatMap((b, bi) => b.steps.map((s, si) => ({ s, bi, si })));
  const rowOf = (bi, si) => ((((walk && walk.beats) || [])[bi] || {}).steps || []).find(r => r.step === si) || null;
  const other = steps.find(({ s, bi, si }) => { const r = rowOf(bi, si); return r && r.text && r.text !== formatStep(s); });
  if (other) throw new Error(`the walk was of another plan (beat ${other.bi + 1}, step ${other.si + 1} was “${rowOf(other.bi, other.si).text}”, now “${formatStep(other.s)}”): walk this plan first`);
  const typedAll = [...(walker.typedTexts ? walker.typedTexts() : []), ...steps.map(({ s }) => s.kind === 'type' ? s.value : null).filter(Boolean)];
  // A kind the guard also held while a step landed as its plan says is the app's background (telemetry, a poll).
  const heldAt = heldBySteps(walk, reads, steps, rowOf);
  const background = new Set(steps.filter(({ bi, si }) => (rowOf(bi, si) || {}).status === 'reached').flatMap(({ bi, si }) => heldAt.get(`${bi + 1}-${si + 1}`) || []));
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
    const app = s.kind === 'app' ? s.app : ((walker.flow.states[to] || {}).app || null);
    const before = started ? prev : s.kind !== 'app' && app ? reads.start(app) : [];
    if (ran || status === 'missed') { started = true; prev = got; }
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
      continue;
    }
    const suspects = (heldAt.get(`${bi + 1}-${si + 1}`) || []).filter(x => !background.has(x));
    if (suspects.length) {
      Object.assign(row, { now: row.was, changed: false, basis: 'suspect', held: suspects, why: `the guard held ${suspects.join(', ')}; check the pack before adopting` });
      continue;
    }
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
  suspect: "The guard held a request while it ran",
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
  const read = c.kept + c.changed + c.today + c.suspect + c.none;
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
    out.push('The guard held a request while these steps ran, and it held it only while steps didn\u2019t land as planned, so what\u2019s missing may be the guard\u2019s doing. Their proofs stay as they are: check the app pack first.', '', '| Beat | Step | Proof | Why |', '|---|---|---|---|');
    for (const r of guarded) out.push(`| ${r.beat} | ${cell(r.text)} | ${cell(r.now)} | ${cell(r.why)} |`);
    out.push('');
  }
  if (unproven.length) {
    out.push('Nothing on today\u2019s screen tells these steps apart from the one before, so a run can\u2019t check them.', '', '| Beat | Step | Was | Why |', '|---|---|---|---|');
    for (const r of unproven) out.push(`| ${r.beat} | ${cell(r.text)} | ${cell(r.was)} | ${cell(r.why)} |`);
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
export function reground(demo, { from = null, plan: planFile = null } = {}) {
  const dir = from || aiDir(demo), wf = join(dir, 'walk.json'), pf = planFile || join(demo.dir, PLAN);
  if (!existsSync(pf)) throw new Error(planFile ? `${planFile}: there\u2019s no such file` : 'make the plan first');
  if (!existsSync(wf)) throw new Error("there's no walk to ground the plan on: walk it in the capture browser first");
  const walker = walkerFromDemo(demo);
  if (!walker) throw new Error("there's no recording to compare today's screens with");
  const { plan, rows } = regroundPlan(parsePlan(readFileSync(pf, 'utf8')), { walker, walk: JSON.parse(readFileSync(wf, 'utf8')), reads: walkReads(join(dir, 'walk-screens')) });
  walker.save();
  mkdirSync(aiDir(demo), { recursive: true });
  writeFileSync(join(aiDir(demo), 'reground.md'), formatReground(rows));
  writeFileSync(join(aiDir(demo), 'reground.json'), JSON.stringify({ at: new Date().toISOString(), walk: wf, plan: pf, rows }, null, 1) + '\n');
  writeFileSync(join(aiDir(demo), 'plan.reground.md'), formatPlan(plan));
  return { ...regroundCounts(rows), file: 'reground.md', plan: 'plan.reground.md' };
}
