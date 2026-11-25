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
import { runReset, fillApi, setBefore, setBeforeProblem, claimScreen, checkClaim } from './reset-run.mjs';
import { leaveOutOf, leaveOn, leaveLog, leftFor, leaveApps, leaveFailure } from './leave-run.mjs';
import { liveProof, writeGate, proofWords } from './landing.mjs';
import { walkerFromDemo } from './walker.mjs';
import { regroundPlan, walkReads } from './reground.mjs';
import { readScreen } from '@scenecast/script/html.mjs';

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost)(:\d+)?$/i;
const sleepMs = ms => new Promise(r => setTimeout(r, ms));

// A pack-named service's answers (capNet, tagged service), the latest one judged: 2xx is up; anything else (500, a
// failed request) means try later. → null (no answer yet) | { ok, status, why }
export function serviceAnswer(answers, name) {
  const mine = (answers || []).filter(n => n.service === name);
  if (!mine.length) return null;
  const last = mine[mine.length - 1], status = last.status || last.failed || 'no answer';
  const ok = typeof last.status === 'number' && last.status >= 200 && last.status < 300;
  return { ok, status, at: last.at, why: ok ? null : `${name} is failing (${status}). Try again later.` };
}
const serviceFailing = n => !!n.service && (n.failed || (typeof n.status === 'number' && n.status >= 500));

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
  // reset.md's Leave out: each line's filter, its app pack's. One no pack of the demo has stops the run before anything
  // runs.
  const lo = leaveOutOf({ demo, packs });
  if (lo.problems.length) throw new Error(`reset.md's Leave out: ${lo.problems[0]}`);
  const out = aiDir(demo), stops = join(out, 'stops');
  mkdirSync(out, { recursive: true });
  const log = text => emit({ event: 'note', text });
  const run = { at: new Date().toISOString(), unattended: true, title: plan.title, goal: readGoal(demo).goal || '', approved: { at: ap.at, list256: ap.list256 }, beats: [], steps: [], landings: [], writes: [], unprovable: [], needsYou: [], starts: [], stopped: null, reset: {}, guard: {}, events: [], setBefore: [], ...(lo.rules.length ? { leaveOut: { lines: lo.lines.map(l => ({ app: l.app, what: l.what, from: l.from, shows: l.shows })) } } : {}) };
  const save = () => writeFileSync(join(out, 'run.json'), JSON.stringify(run, null, 1));
  // Leave out's record (per rule: the requests it filtered and what it took out; the checks before each save; a leak).
  const leakWhy = leak => `left out of the replica, and ${leak.why}: nothing after it was saved`;
  const leakStop = leak => { run.stopped = { kind: 'leave-out', why: leakWhy(leak), app: leak.app, saving: leak.what, picture: leak.picture || null, ...(leak.hits ? { where: leak.hits } : {}) }; run.needsYou.push({ text: leak.what, why: run.stopped.why }); emit({ event: 'stopped', ...run.stopped }); };
  const leaveNow = async () => { if (!lo.rules.length) return null; const l = await leaveLog(cmd); Object.assign(run.leaveOut, { rules: l.rules || [], dom: l.dom || [], checks: l.checks || null, leak: l.leak || null }); return l; };
  const shot = async (app, name) => { const file = join(stops, `${name}.png`); try { await cmd('capShot', { tab: appTab(demo, app), file }, 60); return file; } catch (e) { return null; } };
  const stopWith = async (app, at, kind, why) => { run.stopped = { kind, why, at, app, picture: await shot(app, `${at.beat + 1}-${at.step + 1}-${kind}`) }; emit({ event: 'stopped', ...run.stopped }); };

  // The guard, from the first request to the last.
  const g = await guardOn(demo, cmd, packs);
  run.guard = { hosts: g.hosts, allow: g.allow.length };
  // The apps' pack-named services, every answer watched (run.services): one failing at the start means no capture;
  // during a beat, the run stops before that beat's next write.
  const svcs = packs && packs.servicesFor ? packs.servicesFor(demo.cfg) : [];
  await cmd('capNet', { on: true, watch: svcs.map(({ name, match }) => ({ name, match })) }, 30).catch(() => {});
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
  let recording = false, wRun = null;
  const ran = [], results = {};
  try { main: {
    // Leave out, from the start: the apps that have a line opened again, so what they show comes filtered. Before the
    // reset, so nothing reads them unfiltered.
    if (lo.rules.length) {
      emit({ event: 'stage', name: 'leave-out', label: 'Leaving out what the demo leaves out' });
      const r = await leaveOn(cmd, lo, { shots: stops }).catch(e => ({ on: false, refused: e.message }));
      if (!r.on) { run.stopped = { kind: 'leave-out', why: `Leave out couldn't start: ${r.refused || 'the capture browser said no'}` }; emit({ event: 'stopped', ...run.stopped }); break main; }
      const h = liveWalker({ demo, cmd, packs, log });
      for (const id of leaveApps(lo)) await h.home(id);
    }
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
      // Each start service: the page's own call to it, after its app's start, must answer 2xx (waitS for it to come).
      for (const sv of svcs.filter(x => x.start && homeAt[x.app])) {
        let v = null;
        for (;;) {
          await serviceNews();
          v = serviceAnswer(run.services.slice(homeAt[sv.app].n), sv.name);
          if (v || Date.now() - homeAt[sv.app].t > sv.waitS * 1000) break;
          await sleepMs(1000);
        }
        if (!v) v = { ok: false, why: `${sv.name} didn't answer in ${sv.waitS} s. Try again later.` };
        if (!v.ok) { run.stopped = { kind: 'service', why: v.why, service: sv.name, status: v.status || null, app: sv.app, picture: await shot(sv.app, `start-${sv.app}-service`) }; emit({ event: 'stopped', ...run.stopped }); break main; }
      } }
    const w = wRun = liveWalker({ demo, cmd, packs, recording: true, log });
    const first = plan.beats.flatMap(b => b.steps)[0];
    let app = first && first.kind === 'app' && w.appOf(first.app) || appIds[0];
    // Leave out can refuse a start screen's save (what she leaves out was on it): the take ends before it begins, and so
    // does the run.
    try { await cmd('recordStart', { apps: demo.cfg.apps.map(a => ({ id: a.id, match: a.match })), record: recordOpts(demo.cfg), parallel: true, zooms: demo.cfg.zooms, first: app }, 300); }
    catch (e) {
      const l = await leaveNow().catch(() => null);
      if (!(l && l.leak)) throw e;
      leakStop(l.leak);
      break main;
    }
    recording = true;
    await settled(cmd, { maxS: 900, on: s => emit({ event: 'record', status: s }) });
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
    const packCheck = known => {
      const p = packs && packs.packsForDemo ? Object.values(packs.packsForDemo(demo.cfg) || {}).find(x => x && x.id === known.pack) : null;
      const pw = p && (p.writes || []).find(x => x.id === known.write);
      const api = pw && pw.check && pw.check.api, at2 = api && p.apis && p.apis[api.use];
      return api && at2 && api.made !== undefined && /^(GET|HEAD)$/i.test(api.method || 'GET') ? { api, at: at2 } : null;
    };
    // The pack's check of what the write made (check.api.made: a status, or the number and true/false fields it
    // names), in the app's own session as the write's own calls carried it, the page left where it is.
    const runPackCheck = async (pc, id) => {
      const f = fillApi(pc.api, results, ((demo.cfg.apps || []).find(a => a.id === id) || {}).values);
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
      { const lk = await leaked(); if (lk) return lk; }
      for (const n of await serviceNews()) if (serviceFailing(n) && !failingIn[bi]) failingIn[bi] = n;
      // Set before: what her script has already set when she gets here, set off camera just before the step, in a tab
      // of its own, as approved writes under the write gate (reset-run.mjs setBefore). The step's screen must show it.
      const sb = setBeforeAt.get(`${bi}-${si}`);
      let sbRec = null;
      if (sb) {
        if (doubt) return { kind: 'unprovable', why: `the step before it (${doubt.text}) couldn't be proven (${doubt.why}), and what's set off camera before it is a write`, beforeWrite: true };
        const down = failingIn[bi];
        if (down) return { kind: 'service', why: `${down.service} answered ${down.status || down.failed} during this beat: what's set off camera waits until the service works. Try again later.`, beforeWrite: true };
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
      if (doubt) {
        const before = `the step before it (${doubt.text}) couldn't be proven (${doubt.why})`;
        if (wr) return { kind: 'unprovable', why: `${before}, and a write never follows a step it couldn't prove`, beforeWrite: true };
        if (step.kind !== 'app') { const u = await w.uniqueControl(app, step); if (!u.ok) return { kind: 'unprovable', why: `${before}, and ${u.why}` }; }
      }
      let r, checked = null;
      if (wr) {
        if (!ap.writes.some(x => x.beat === bi && x.step === si && x.text === at.text)) return { kind: 'unapproved', why: `${wr.why}, and the approved plan doesn't list it as a write`, beforeWrite: true };
        // Its app's pack knows it (the plan names the pack's write; the pack's own match finds it on this page).
        const known = await packKnows(packs, w, app, step, wr);
        if (!known.ok) return { kind: 'unknown-write', why: known.why, beforeWrite: true };
        for (const n of await serviceNews()) if (serviceFailing(n) && !failingIn[bi]) failingIn[bi] = n;
        const down = failingIn[bi];
        if (down) return { kind: 'service', why: `${down.service} answered ${down.status || down.failed} during this beat: its write waits until the service works. Try again later.`, beforeWrite: true };
        const gate = writeGate(run.landings, app);
        if (!gate.ok) return { kind: 'gate', why: `${gate.why}: a write runs on its own only after strong landings in its app`, beforeWrite: true };
        const pc = packCheck(known);
        if (pc) await cmd('capAuthWatch', { host: pc.at.host, hostPattern: pc.at.hostPattern, from: pc.at.from || null }, 30).catch(() => {});
        r = await w.write(app, step);
        if (pc) checked = r.wrote ? await runPackCheck(pc, app) : (await cmd('capAuthWatch', { off: true }, 30).catch(() => {}), null);
        if (r.wrote) {
          const rec = { beat: bi + 1, step: si, text: at.text, writes: step.writes || wr.why, pack: known.pack, write: known.write, undo: step.undo || known.undo || null, result: r.result };
          run.writes.push(rec); ran.push({ beat: bi + 1, text: at.text });
          Object.assign(results, namesOf(known.write, r.result));
          emit({ event: 'wrote', ...rec });
        }
      } else r = await w.act(app, step);
      if (r.missing || r.needsYou) return { kind: r.missing ? 'missing' : 'needs-you', why: r.why };
      const c = await w.check(app, step);
      const afters = await w.reads(app).catch(() => []);
      lastReads[app] = afters;
      if (!c.ok) return { kind: c.kind, why: c.why };
      const lp = liveProof(step, { before: screensOf(before, step.kind === 'app' ? prev : app), afters: screensOf(afters, app), next: nextActing(bi, si), typed: typedSoFar.filter(t => t !== step.value), walker: recWalker });
      const byCheck = !!(checked && checked.ok);
      const strength = byCheck ? 'strong' : lp.strength;
      const url = (await w.controls(app).catch(() => ({}))).url || null;
      run.landings.push({ beat: bi + 1, index: si, app, step: at.text, expected: step.lands ? formatLands(step.lands) : null, got: { screen: c.screen || null, url, text: byCheck ? `the pack's check: ${checked.status}${checked.picked ? ` ${JSON.stringify(checked.picked)}` : ''}` : proofWords(lp.lands) }, ok: true, strength, basis: byCheck ? 'pack check' : 'live', ...(strength === 'strong' ? {} : { why: lp.why }), ...(r.wrote ? { wrote: true } : {}), ...(checked ? { check: checked } : {}) });
      if (step.kind === 'type' && step.value) typedSoFar.push(step.value);
      const why = strength === 'strong' ? null : pre || (w.proofOf(step) ? null : 'the plan gives it no proof of where it lands');
      if (why) { doubt = { text: at.text, why }; run.unprovable.push({ beat: bi + 1, step: si, text: at.text, why, strength }); emit({ event: 'unprovable', beat: bi, step: si, why }); }
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
    }
  } } finally {
    if (recording) {
      emit({ event: 'stage', name: 'stop', label: 'Saving the recording' });
      try { run.summary = await cmd('recordStop', {}, 900); } catch (e) { run.summary = { error: e.message }; }
      // A save it refused after the last step: the take ends there, and she sees why.
      const l = await leaveNow().catch(() => null);
      if (l && l.leak && !run.stopped) leakStop(l.leak);
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
    { const off = await guardOff(cmd, g.hosts, senderApps(demo.cfg, packs)); keepBodiesOut(demo, off.bodies); Object.assign(run.guard, off); }
    if (wRun) run.inputs = wRun.inputs();
    try { const appOf = senderApps(demo.cfg, packs); run.events = (await cmd('capEvents', {}, 30)).events.filter(e => e.kind !== 'navigated').map(e => ({ ...e, app: appOf({ tab: e.host }) })); } catch (e) {}
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
  const g = packs && packs.guardFor ? packs.guardFor(demo.cfg) : { hosts: demo.cfg.apps.map(a => { try { return new URL(a.url).host; } catch (e) { return null; } }).filter(Boolean), allow: [], stayHeld: [] };
  // A demo's capture.keepBodies (its local demo.json): the held requests whose bodies a person wants to review.
  const keepBodies = (demo.cfg.capture && demo.cfg.capture.keepBodies) || [];
  await cmd('capGuard', { hosts: null, allow: g.allow, stayHeld: g.stayHeld || [], keepBodies, mode: 'hold', local: g.hosts.some(h => LOOPBACK.test(h)) }, 30);
  return g;
}
// What the guard held, and every host the browser reached that isn't one of the apps' own.
// The held requests' bodies a demo asked to keep (capture.keepBodies), in .out/ai/held-bodies.json: local only, for a
// person reviewing an allow entry. None: no file.
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
function keepBodiesOut(demo, bodies) {
  const f = join(aiDir(demo), 'held-bodies.json');
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
  const { walkPlan, stepNets } = await import('./walk.mjs');
  // Leave out as a run has it, so a look-only walk shows what the capture will (and checks each screen it keeps).
  const lo = leaveOutOf({ demo, packs });
  if (lo.problems.length) throw new Error(`reset.md's Leave out: ${lo.problems[0]}`);
  const g = await guardOn(demo, cmd, packs);
  const t0 = Date.now();
  const w = liveWalker({ demo, cmd, packs, log: text => emit({ event: 'note', text }) });
  const shots = join(aiDir(demo), 'walk');
  if (lo.rules.length) {
    const r = await leaveOn(cmd, lo, { shots }).catch(e => ({ on: false, refused: e.message }));
    if (!r.on) { await guardOff(cmd, g.hosts); throw new Error(`Leave out couldn't start: ${r.refused || 'the capture browser said no'}`); }
  }
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
  await cmd('capNet', { on: true, watch: (packs && packs.servicesFor ? packs.servicesFor(demo.cfg) : []).map(({ name, match }) => ({ name, match })) }, 30).catch(() => {});
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
  let walk;
  try {
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
    let leaveOut;
    if (lo.rules.length) {
      const l = await leaveLog(cmd);
      leaveOut = { lines: lo.lines.map(x => ({ app: x.app, what: x.what, from: x.from, shows: x.shows })), rules: l.rules || [], dom: l.dom || [], screens: leaveChecks };
      await cmd('capLeaveOut', { rules: [] }, 60).catch(() => {});
    }
    const off = await guardOff(cmd, g.hosts, appOfSender);
    keepBodiesOut(demo, off.bodies);
    walk = { ...(walk || {}), ...(leaveOut ? { leaveOut } : {}), ...(planSha ? { plan: { file: 'plan.md', sha256: planSha } } : {}), net: netAll, secs: +((Date.now() - t0) / 1000).toFixed(1), inputs: w.inputs(), guard: { hosts: g.hosts, allow: g.allow.length, ...off } };
    try { walk.events = (await cmd('capEvents', {}, 30)).events.map(e => ({ ...e, app: appOfSender({ tab: e.host }) })); } catch (e) {}
    walk.suspect = suspectSteps({ demo, plan, walk, screensDir, packs });
    mkdirSync(aiDir(demo), { recursive: true });
    writeFileSync(join(aiDir(demo), 'walk.json'), JSON.stringify(walk, null, 1));
  }
  return walk;
}
