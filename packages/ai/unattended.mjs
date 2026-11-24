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
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatStep, stepCount } from './plan.mjs';
import { recordOpts } from '@stuntdouble/core/lib/demo.mjs';
import { rx, settled, aiDir, appTab } from './run.mjs';
import { readPlan, readGoal } from './draft.mjs';
import { approval as approvalOf } from './make.mjs';
import { liveWalker, walkerPacks } from './live.mjs';
import { runReset } from './reset-run.mjs';

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost)(:\d+)?$/i;

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
  const out = aiDir(demo), stops = join(out, 'stops');
  mkdirSync(out, { recursive: true });
  const log = text => emit({ event: 'note', text });
  const run = { at: new Date().toISOString(), unattended: true, title: plan.title, goal: readGoal(demo).goal || '', approved: { at: ap.at, list256: ap.list256 }, beats: [], steps: [], writes: [], unprovable: [], starts: [], stopped: null, reset: {}, guard: {}, events: [] };
  const save = () => writeFileSync(join(out, 'run.json'), JSON.stringify(run, null, 1));
  const shot = async (app, name) => { const file = join(stops, `${name}.png`); try { await cmd('capShot', { tab: appTab(demo, app), file }, 60); return file; } catch (e) { return null; } };
  const stopWith = async (app, at, kind, why) => { run.stopped = { kind, why, at, app, picture: await shot(app, `${at.beat + 1}-${at.step + 1}-${kind}`) }; emit({ event: 'stopped', ...run.stopped }); };

  // The guard, from the first request to the last.
  const g = await guardOn(demo, cmd, packs);
  run.guard = { hosts: g.hosts, allow: g.allow.length };
  let recording = false, wRun = null;
  const ran = [], results = {};
  try { main: {
    // Before: the tenant as the demo starts, or nothing is recorded.
    emit({ event: 'stage', name: 'reset-before', label: 'Checking the demo starts as it should' });
    run.reset.before = await runReset({ demo, cmd, walker: liveWalker({ demo, cmd, packs, log }), phase: 'before', approval: ap, emit });
    if (!run.reset.before.ok) { run.stopped = { kind: 'reset', why: run.reset.before.why }; emit({ event: 'stopped', ...run.stopped }); break main; }

    emit({ event: 'stage', name: 'start', label: 'Starting the recording' });
    const appIds = demo.cfg.apps.map(a => a.id);
    // Every app on its start screen, as the recording begins: its start steps (navigation only), then its recorded
    // start screen checked. One that isn't stops the run before anything is recorded.
    { const h = liveWalker({ demo, cmd, packs, log });
      for (const id of appIds) {
        const did = await h.home(id);
        const bad = did.find(d => d.why);
        const sc = bad ? { ok: false, why: `its start step "${bad.step}": ${bad.why}` } : await h.startCheck(id, plan);
        run.starts.push({ app: id, did, ...sc });
        if (!sc.ok) { run.stopped = { kind: 'start', why: `${id}: ${sc.why}`, app: id, picture: await shot(id, `start-${id}`) }; emit({ event: 'stopped', ...run.stopped }); break main; }
      } }
    const w = wRun = liveWalker({ demo, cmd, packs, recording: true, log });
    const first = plan.beats.flatMap(b => b.steps)[0];
    let app = first && first.kind === 'app' && w.appOf(first.app) || appIds[0];
    await cmd('recordStart', { apps: demo.cfg.apps.map(a => ({ id: a.id, match: a.match })), record: recordOpts(demo.cfg), parallel: true, zooms: demo.cfg.zooms, first: app }, 300);
    recording = true;
    await settled(cmd, { maxS: 900, on: s => emit({ event: 'record', status: s }) });
    await w.start(app);

    // One step: null when it's done and landed where the plan says, else why the run stops ({ kind, why }).
    // A failed check stops it. A step it can't prove (the plan gives no proof, or its words were on the screen before)
    // goes in run.unprovable, and then the next step goes on only if its control is the one (exactly one, by its exact
    // name, of its kind), and never if it's a write: the step before every write has a proven landing.
    const lastDid = {};
    let doubt = null;
    const doStep = async (bi, si, step, at, prev) => {
      const pre = await w.landsBefore(app, step, prev);
      // Would it write? Read the screen as the step will find it.
      let wr = null;
      if (step.kind === 'click' || step.kind === 'press') {
        const o = await w.controls(app);
        const el = step.kind === 'click' ? (await w.locate(app, step.target)).el : null;
        wr = w.writeOf(step, el, step.kind === 'press' ? w.focusedField(o) : null, o.url);
      } else if (step.writes) wr = w.writeOf(step, null, null, null);
      if (doubt) {
        const before = `the step before it (${doubt.text}) couldn't be proven (${doubt.why})`;
        if (wr) return { kind: 'unprovable', why: `${before}, and a write never follows a step it couldn't prove` };
        if (step.kind !== 'app') { const u = await w.uniqueControl(app, step); if (!u.ok) return { kind: 'unprovable', why: `${before}, and ${u.why}` }; }
      }
      let r;
      if (wr) {
        if (!ap.writes.some(x => x.beat === bi && x.step === si && x.text === at.text)) return { kind: 'unapproved', why: `${wr.why}, and the approved plan doesn't list it as a write` };
        // Its app's pack knows it (the plan names the pack's write; the pack's own match finds it on this page).
        const known = await packKnows(packs, w, app, step, wr);
        if (!known.ok) return { kind: 'unknown-write', why: known.why };
        r = await w.write(app, step);
        if (r.wrote) {
          const rec = { beat: bi + 1, step: si, text: at.text, writes: step.writes || wr.why, pack: known.pack, write: known.write, undo: step.undo || known.undo || null, result: r.result };
          run.writes.push(rec); ran.push({ beat: bi + 1, text: at.text });
          Object.assign(results, namesOf(known.write, r.result));
          emit({ event: 'wrote', ...rec });
        }
      } else r = await w.act(app, step);
      if (r.missing || r.needsYou) return { kind: r.missing ? 'missing' : 'needs-you', why: r.why };
      const c = await w.check(app, step);
      if (!c.ok) return { kind: c.kind, why: c.why };
      const why = pre || (w.proofOf(step) ? null : 'the plan gives it no proof of where it lands');
      if (why) { doubt = { text: at.text, why }; run.unprovable.push({ beat: bi + 1, step: si, text: at.text, why }); emit({ event: 'unprovable', beat: bi, step: si, why }); }
      else doubt = null;
      Object.assign(lastDid, { did: r.did, screen: c.screen });
      return null;
    };
    const total = stepCount(plan);
    let n = 0;
    outer: for (const [bi, beat] of plan.beats.entries()) {
      const tb = Date.now();
      emit({ event: 'beat', beat: bi, title: beat.title });
      for (const [si, step] of beat.steps.entries()) {
        const at = { beat: bi, step: si, text: formatStep(step) };
        emit({ event: 'step', beat: bi, step: si, n: ++n, of: total, text: at.text });
        const prev = app;
        if (step.kind === 'app') app = w.appOf(step.app) || app;
        const ts = Date.now();
        const stop = await doStep(bi, si, step, at, prev).catch(e => ({ kind: 'error', why: e.message }));
        if (stop) { await stopWith(app, at, stop.kind, `${at.text}: ${stop.why}`); break outer; }
        run.steps.push({ ...at, app, did: lastDid.did, secs: +((Date.now() - ts) / 1000).toFixed(1), screen: lastDid.screen });
        emit({ event: 'step-done', beat: bi, step: si, did: lastDid.did });
      }
      run.beats.push({ beat: bi + 1, title: beat.title, secs: +((Date.now() - tb) / 1000).toFixed(1) });
    }
  } } finally {
    if (recording) {
      emit({ event: 'stage', name: 'stop', label: 'Saving the recording' });
      try { run.summary = await cmd('recordStop', {}, 900); } catch (e) { run.summary = { error: e.message }; }
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
    Object.assign(run.guard, await guardOff(cmd, g.hosts));
    if (wRun) run.inputs = wRun.inputs();
    try { run.events = (await cmd('capEvents', {}, 30)).events.filter(e => e.kind !== 'navigated'); } catch (e) {}
    save();
  }
  return finish();
  function finish() {
    save();
    return { stopped: run.stopped, steps: run.steps.length, writes: run.writes.length, held: (run.guard.held || []).filter(h => h.held).length, resetBefore: run.reset.before && run.reset.before.ok, resetAfter: run.reset.after ? run.reset.after.ok : null, summary: run.summary };
  }
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
  const g = packs && packs.guardFor ? packs.guardFor(demo.cfg) : { hosts: demo.cfg.apps.map(a => { try { return new URL(a.url).host; } catch (e) { return null; } }).filter(Boolean), allow: [] };
  await cmd('capGuard', { hosts: null, allow: g.allow, mode: 'hold', local: g.hosts.some(h => LOOPBACK.test(h)) }, 30);
  return g;
}
// What the guard held, and every host the browser reached that isn't one of the apps' own.
async function guardOff(cmd, hosts) {
  const out = {};
  try {
    const l = await cmd('capLog', {}, 30);
    out.held = l.held; out.counts = l.counts; out.passed = l.passed || [];
    const own = h => hosts.some(x => h === x || h.replace(/:\d+$/, '') === x || h.replace(/:\d+$/, '').endsWith('.' + x));
    const away = {};
    for (const [k, n] of Object.entries(l.counts || {})) { const host = k.split(' ').pop(); if (host && host !== '?' && !own(host)) away[k] = n; }
    out.away = away;
  } catch (e) {}
  await cmd('capGuardOff', {}, 30).catch(() => {});
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
  const { walkPlan } = await import('./walk.mjs');
  const g = await guardOn(demo, cmd, packs);
  const t0 = Date.now();
  const w = liveWalker({ demo, cmd, packs, log: text => emit({ event: 'note', text }) });
  const shots = join(aiDir(demo), 'walk');
  const seenAt = {};
  let walk;
  try {
    const starts = [];
    for (const a of demo.cfg.apps) { const did = await w.home(a.id); const bad = did.find(d => d.why); starts.push({ app: a.id, did, ...(bad ? { ok: false, why: `its start step "${bad.step}": ${bad.why}` } : await w.startCheck(a.id, plan)) }); }
    seenAt.starts = starts;
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
    for (const b of (walk && walk.beats) || []) for (const s of b.steps) if (seenAt[`${b.beat}-${s.step}`]) s.seen = seenAt[`${b.beat}-${s.step}`];
    if (walk) walk.starts = seenAt.starts || [];
    walk = { ...(walk || {}), secs: +((Date.now() - t0) / 1000).toFixed(1), inputs: w.inputs(), guard: { hosts: g.hosts, allow: g.allow.length, ...(await guardOff(cmd, g.hosts)) } };
    try { walk.events = (await cmd('capEvents', {}, 30)).events; } catch (e) {}
    mkdirSync(aiDir(demo), { recursive: true });
    writeFileSync(join(aiDir(demo), 'walk.json'), JSON.stringify(walk, null, 1));
  }
  return walk;
}
