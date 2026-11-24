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
// words and controls, which this doesn't use. → step(beat, step) / start(app): the reads as the reader reads them, or
// null; why(beat, step): why there are none.
export function walkReads(dir) {
  const memo = new Map(), whys = new Map();
  const load = name => {
    if (!memo.has(name)) {
      let got = null;
      const gz = join(dir, `${name}.reads.json.gz`);
      if (existsSync(gz)) {
        try { got = JSON.parse(gunzipSync(readFileSync(gz)).toString('utf8')).map(r => r && r.docs).filter(d => Array.isArray(d) && d.some(x => x && x.html)).map(d => readScreen(d)); }
        catch (e) { whys.set(name, `the reader couldn't read its screen (${e.message})`); }
      }
      if (!(got && got.length) && !whys.has(name)) whys.set(name, existsSync(join(dir, `${name}.json`)) ? 'the walk saved its screen without the page\u2019s markup' : 'the walk saved no screen for it');
      memo.set(name, got && got.length ? got : null);
    }
    return memo.get(name);
  };
  return { step: (beat, step) => load(`${beat}-${step}`), start: app => load(`start-${app}`), why: (beat, step) => whys.get(`${beat}-${step}`) || null };
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

// walk: walk.json ({ beats: [{ steps: [{ step, text, status, why }] }] }, a row per plan step, step from 0); reads:
// walkReads(). Each row: { beat, step, text, screen, status, was, now, basis, why, changed, number }, basis one of
//   both       its proof holds today and in the recording (changed: a new one, why says what was wrong)
//   today      on today's reads only: the product changed since the recording (or the recording typed other words)
//   none       nothing tells today's screen from the one before: a run can't check it (Needs you)
//   write      behind a write the walk didn't make: the recording's proof stays
//   unreached  the walk didn't get here (why says why), or ran it and saved no screen: the recording's proof stays
export function regroundPlan(plan0, { walker, walk, reads }) {
  const plan = JSON.parse(JSON.stringify(plan0));
  const steps = plan.beats.flatMap((b, bi) => b.steps.map((s, si) => ({ s, bi, si })));
  const rowOf = (bi, si) => ((((walk && walk.beats) || [])[bi] || {}).steps || []).find(r => r.step === si) || null;
  const other = steps.find(({ s, bi, si }) => { const r = rowOf(bi, si); return r && r.text && r.text !== formatStep(s); });
  if (other) throw new Error(`the walk was of another plan (beat ${other.bi + 1}, step ${other.si + 1} was “${rowOf(other.bi, other.si).text}”, now “${formatStep(other.s)}”): walk this plan first`);
  const typedAll = [...(walker.typedTexts ? walker.typedTexts() : []), ...steps.map(({ s }) => s.kind === 'type' ? s.value : null).filter(Boolean)];
  const rows = [];
  // Today's screen before a step: the reads after the step before it; before anything ran, its app's start screen
  // (nothing, before a first "Go to"); null when that screen wasn't read (a miss, or nothing saved).
  let cur = null, prev = [], started = false;
  for (const [k, { s, bi, si }] of steps.entries()) {
    const r0 = rowOf(bi, si), status = r0 ? r0.status : null;
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
      Object.assign(row, { now: row.was, changed: false, basis: status === 'write' || status === 'after-write' ? 'write' : 'unreached',
        why: ran ? (reads.why && reads.why(bi + 1, si + 1)) || 'the walk saved no screen for it' : status === 'write' ? `a write: ${r0.why}` : (r0 && r0.why) || "the walk didn't get here" });
      continue;
    }
    const next = (steps.slice(k + 1).find(({ s: x }) => !/^(wait|scroll)$/.test(x.kind)) || {}).s || null;
    const opts = { typed: typedAll.filter(v => !(s.kind === 'type' && v === s.value)), next };
    const rec = walker.screen(to), unstable = shakyToday(rec, got, walker, app);
    let r = chooseProof(s, from, to, walker, { ...opts, live: { afters: got, befores: before || [], unstable } }), alone = false;
    // Nothing holds on both: today's reads alone, when today's screen before the step was read.
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
  none: 'Nothing proves it today',
  write: "Behind a write the walk didn't make",
  unreached: 'Not reached today',
};
const cell = t => String(t || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
export function formatReground(rows) {
  const n = f => rows.filter(f).length;
  const read = n(r => ['both', 'today', 'none'].includes(r.basis));
  const out = ["# Proofs on today's product", '', `${rows.length} steps land on a screen. Today's walk read ${read} of them.`, '', '| | Steps |', '|---|---|',
    `| Kept: it holds today and in the recording | ${n(r => r.basis === 'both' && !r.changed)} |`,
    `| New: it holds today and in the recording | ${n(r => r.basis === 'both' && r.changed)} |`,
    `| ${BASIS.today} | ${n(r => r.basis === 'today')} |`,
    `| ${BASIS.none} (Needs you) | ${n(r => r.basis === 'none')} |`,
    `| ${BASIS.write}: the recording's proof stays | ${n(r => r.basis === 'write')} |`,
    `| ${BASIS.unreached}: the recording's proof stays | ${n(r => r.basis === 'unreached')} |`, ''];
  const changed = rows.filter(r => r.basis !== 'none' && (r.changed || r.basis === 'today'));
  if (changed.length) {
    out.push('## What changed', '', '| Beat | Step | Was | Now | Why |', '|---|---|---|---|---|');
    for (const r of changed) out.push(`| ${r.beat} | ${cell(r.text)} | ${cell(r.was)} | ${cell(r.now)}${r.basis === 'today' ? ' (today only)' : ''}${r.number ? ' (a number)' : ''} | ${cell(r.why)} |`);
    out.push('');
  }
  const unproven = rows.filter(r => r.basis === 'none');
  if (unproven.length) {
    out.push('## Needs you', '', 'Nothing on today\u2019s screen tells these steps apart from the one before, so a run can\u2019t check them.', '', '| Beat | Step | Was | Why |', '|---|---|---|---|');
    for (const r of unproven) out.push(`| ${r.beat} | ${cell(r.text)} | ${cell(r.was)} | ${cell(r.why)} |`);
    out.push('');
  }
  const kept = rows.filter(r => r.basis === 'write' || r.basis === 'unreached');
  if (kept.length) {
    out.push('## Not checked today', '', '| Beat | Step | Proof | Why |', '|---|---|---|---|');
    for (const r of kept) out.push(`| ${r.beat} | ${cell(r.text)} | ${cell(r.now)} | ${cell(r.why)} |`);
    out.push('');
  }
  return out.join('\n');
}

// from: the folder holding walk.json and walk-screens/ (a walk's own: .out/ai). plan: the plan the walk walked, when
// it isn't the demo's plan.md now. plan.md stays as it is: its approval is its exact text, so adopting
// plan.reground.md means approving it again.
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
  const n = f => rows.filter(f).length;
  return { steps: rows.length, kept: n(r => r.basis === 'both' && !r.changed), changed: n(r => r.basis === 'both' && r.changed), today: n(r => r.basis === 'today'),
    none: n(r => r.basis === 'none'), write: n(r => r.basis === 'write'), unreached: n(r => r.basis === 'unreached'), file: 'reground.md', plan: 'plan.reground.md' };
}
