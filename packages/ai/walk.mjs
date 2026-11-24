// A read-only walk of a plan: where each step lands, by either walker (walker.mjs's interface: start(app) → screen,
// step(screen, step) → { screen, landed }). Offline it's the recording's screens (walkerFromDemo); live it's the
// product itself, in the capture browser (live.mjs), with the guard holding anything that isn't a read.
// A walker never writes: at a write the walk doesn't run it, skips the rest of that beat and carries on with the next
// one. Each step comes out as one of:
//   reached       it ran, and it landed where the plan says
//   write         a write: not run
//   after-write   later in a beat whose write didn't run (its screens need that write)
//   drifted       it ran and is on the screen it should be, but the words the plan says it lands on aren't there
//                 (the product said it differently since; walker.soft: a walk notes it and goes on, a run stops)
//   unproven      it ran, but nothing proves where it landed: the plan gives it no proof, or its words were there
//                 before the step too (walker.soft: a walk notes it and goes on; a run goes on only by its next
//                 control, and never into a write)
//   missed        it didn't run, or didn't land where the plan says (why says which)
//   after-miss    later in a beat after a miss
import { formatStep } from './plan.mjs';
import { norm } from './find.mjs';


// walker: { start(app), step(at, s), writeOf?(s, at) → why it writes | null, landed?(at, s) → { ok, why } }
export async function walkPlan(plan, walker, { emit = () => {} } = {}) {
  const out = { beats: [] };
  let at = null, app = null, typed = '';
  // Each app's place: "Go to X" goes back to where X was left (live, its window is still there: walker.live).
  const where = {};
  const unrun = [];
  for (const [bi, beat] of plan.beats.entries()) {
    const tb = Date.now(), steps = [];
    let after = null;
    for (const [si, s] of beat.steps.entries()) {
      const row = { step: si, text: formatStep(s), want: (s.lands && s.lands.screen) || null, status: null, screen: null, why: null };
      steps.push(row);
      if (after) { row.status = after.kind; row.why = after.why; continue; }
      const t0 = Date.now();
      try {
        const w = s.writes || (walker.writeOf ? await walker.writeOf(s, at, app) : null);
        if (w) {
          row.status = 'write'; row.why = s.writes ? s.writes.replace(/ · [\w-]+:[\w-]+$/, '') : w;
          unrun.push({ beat: bi + 1, step: si, text: row.text, app });
          after = { kind: 'after-write', why: `needs beat ${bi + 1}'s write: ${row.text}` };
          // The beat stops here: what it typed for this write goes (no draft left behind).
          if (walker.stopBeat) row.cleared = await walker.stopBeat(app);
          continue;
        }
        // Offline, "Go to X" goes back to where X was left; live, it's a step like any other, so its landing is checked
        // (against the screen the plan was on, the other app's).
        if (s.kind === 'app' && !walker.live) { app = s.app; at = where[app] || await walker.start(s.app); row.screen = sigOf(at); }
        else {
          if (s.kind === 'app') app = s.app;
          const r = await walker.step(at, s, typed);
          if (s.kind === 'type') typed = s.value || '';
          if (r.screen) at = r.screen;
          if (r.hit) row.hit = r.hit;
          if (r.trouble) row.trouble = r.trouble;
          row.screen = sigOf(at);
          if (!r.landed) { row.status = walker.soft && r.kind === 'elsewhere' ? 'drifted' : walker.soft && r.kind === 'unproven' ? 'unproven' : 'missed'; row.why = r.why || r.kind || 'not here'; }
        }
        if (!row.status) {
          const l = walker.landed ? await walker.landed(at, s) : landedBySig(at, s);
          row.status = l.ok ? 'reached' : 'missed';
          if (!l.ok) row.why = l.why;
        }
      } catch (e) {
        if (e.code === 'WRITE') { row.status = 'write'; row.why = e.message; unrun.push({ beat: bi + 1, step: si, text: row.text, app }); after = { kind: 'after-write', why: `needs beat ${bi + 1}'s write: ${row.text}` }; if (walker.stopBeat) row.cleared = await walker.stopBeat(app); continue; }
        row.status = 'missed'; row.why = e.message;
      }
      if (app && at) where[app] = at;
      row.secs = +((Date.now() - t0) / 1000).toFixed(1);
      // Words that aren't there, behind a write that didn't run in this app: maybe that write's result.
      if (row.status === 'drifted') { const w = [...unrun].reverse().find(u => u.app === app); if (w) row.needs = `beat ${w.beat}'s write: ${w.text}`; }
      if (row.status === 'missed') {
        // Behind a write that didn't run, in this app: most likely it's the write's screen that isn't there.
        const w = [...unrun].reverse().find(u => u.app === app);
        if (w) row.needs = `beat ${w.beat}'s write: ${w.text}`;
        after = { kind: 'after-miss', why: `after the miss at step ${si + 1}` };
      }
      if (after && walker.stopBeat) row.cleared = await walker.stopBeat(app);
      await emit({ event: 'walk', beat: bi + 1, step: si, status: row.status, screen: row.screen, app });
    }
    out.beats.push({ beat: bi + 1, title: beat.title, secs: +((Date.now() - tb) / 1000).toFixed(1), steps });
  }
  out.writes = unrun;
  return out;
}
const sigOf = x => typeof x === 'string' ? x : x && (x.sig || x.id || x.url) || null;
// Offline: the screen the recording reached is the one the plan names.
function landedBySig(at, s) {
  const want = s.lands && s.lands.screen;
  if (!want) return { ok: true };
  return sigOf(at) === want ? { ok: true } : { ok: false, why: `on ${sigOf(at)}, not ${want}` };
}

// Offline and live, side by side: each screen the plan names, per beat. A read-only step the offline walk reaches and
// the live walk misses is a live walker bug.
export function compareWalks(plan, offline, live) {
  const rows = [];
  for (const [bi, b] of plan.beats.entries()) {
    const o = offline.beats[bi], l = live.beats[bi];
    for (const [si] of b.steps.entries()) {
      const os = o.steps[si], ls = l.steps[si];
      rows.push({ beat: bi + 1, step: si + 1, text: os.text, want: os.want, offline: os.status, live: ls.status, liveWhy: ls.why, offlineWhy: os.why, needs: ls.needs || os.needs || null, bug: os.status === 'reached' && !['reached', 'drifted', 'unproven'].includes(ls.status) });
    }
  }
  return rows;
}

export function walkTable(plan, offline, live) {
  const rows = compareWalks(plan, offline, live);
  const mark = { reached: 'reached', drifted: 'reached, words differ', unproven: 'ran, unproven', write: 'write (not run)', 'after-write': 'needs the write', missed: 'missed', 'after-miss': 'after a miss' };
  const lines = [];
  for (const [bi, b] of plan.beats.entries()) {
    lines.push(`\n### Beat ${bi + 1} · ${b.title} (live ${live.beats[bi].secs} s)\n`, '| # | Step | Screen | Offline | Live | Why (live) |', '|---|---|---|---|---|---|');
    for (const r of rows.filter(r => r.beat === bi + 1)) lines.push(`| ${r.step} | ${r.text.replace(/\|/g, '\\|').slice(0, 70)} | ${r.want || ''} | ${mark[r.offline]} | ${mark[r.live]}${r.bug ? ' **(walker)**' : ''} | ${String(r.liveWhy || r.needs || '').replace(/\|/g, '\\|').slice(0, 90)} |`);
  }
  const count = (w, k) => w.beats.flatMap(b => b.steps).filter(s => s.status === k).length;
  const screens = w => w.beats.flatMap(b => b.steps).filter(s => s.want);
  const sum = w => ({ reached: count(w, 'reached'), drifted: count(w, 'drifted'), unproven: count(w, 'unproven'), write: count(w, 'write'), afterWrite: count(w, 'after-write'), missed: count(w, 'missed'), afterMiss: count(w, 'after-miss'), screens: screens(w).length, screensReached: screens(w).filter(s => s.status === 'reached' || s.status === 'drifted').length });
  return { rows, text: lines.join('\n'), offline: sum(offline), live: sum(live), bugs: rows.filter(r => r.bug) };
}

// Rule 2 made visible: what the read-only guard held that only came while a landing drifted or missed (a read the app
// needed, held, can make a page the product doesn't show). A drifted or missed landing's stretch: the steps of its
// beat since the previous drifted or missed one there (or the beat's start), through it. A kind (method, host, path)
// counts when it was held in a stretch, in no step outside every stretch, and isn't telemetry. walk: walk.json, each
// step with held ([{ method, host, path, n }], from its first input to its last read).
// → [{ kind, n, steps: ['<beat>-<step>' (from 1), …] }]
const TELEMETRY = /applicationinsights|telemetry|collector|logclient|logflight|\/v2\/track$|\/events$|events\.data\.microsoft|aria\.microsoft|\/ping$/i;
export function heldWhileDrifted(walk) {
  const stretch = new Set();
  for (const b of (walk && walk.beats) || []) {
    let open = [];
    for (const s of b.steps || []) { open.push(s); if (s.status === 'drifted' || s.status === 'missed') { open.forEach(x => stretch.add(x)); open = []; } }
  }
  const kinds = new Map();
  for (const b of (walk && walk.beats) || []) for (const s of b.steps || []) for (const h of s.held || []) {
    if (TELEMETRY.test(`${h.host}${h.path}`)) continue;
    const kind = `${h.method} ${h.host}${h.path}`, k = kinds.get(kind) || { kind, n: 0, steps: [], outside: false };
    k.n += h.n || 1;
    if (stretch.has(s)) { const at = `${b.beat}-${s.step + 1}`; if (!k.steps.includes(at)) k.steps.push(at); } else k.outside = true;
    kinds.set(kind, k);
  }
  return [...kinds.values()].filter(k => !k.outside && k.steps.length).map(({ kind, n, steps }) => ({ kind, n, steps }));
}

// Each step's failed requests and answers of 400 or more: from its first input to the next step's first input (the
// last step's to the walk's end), so what comes after a step's last read is still its own. A step keeps its own app's
// and ones no app can be named for. steps: in walk order, each { from (ISO), app }; net: every one the walk saw
// ({ at, app, … }). → a list per step.
export function stepNets(steps, net, end) {
  const t = x => Date.parse(x);
  return steps.map((s, i) => {
    const from = t(s.from), to = i + 1 < steps.length ? t(steps[i + 1].from) : t(end);
    return (net || []).filter(n => { const at = t(n.at); return at >= from && at < to && (!n.app || !s.app || n.app === s.app); });
  });
}
