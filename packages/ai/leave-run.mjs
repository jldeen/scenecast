// reset.md's Leave out, for a run or a walk in the capture browser: each line's filter (its app pack's, by its From:),
// the rules the capture host applies (host-ops capLeaveOut), and the words each app's screens must not show.
//   leaveOutOf({ demo, packs, text?, apps? }) → { lines, rules, words: { app: [..] }, problems: [why], skipped }
//     problems: a line whose filter no pack of the demo has, or that's another app's, or that names nothing: the run
//     refuses to start (nothing has run)
//     apps: the apps the plan goes to (planApps); a line for any other app is skipped, never applied (skipped: those)
//   leaveOn(cmd, lo, { shots }) → capLeaveOut's answer; leaveLog(cmd) → capLeaveLog's
//   leftFor(lo, app, sc): the screen with her words for that app marked left (landing.mjs leftOut)
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ruleOf } from '@stuntdouble/capture/leave-out.mjs';
import { parseReset } from './reset.mjs';
import { leftOut } from './landing.mjs';

// The negative check the capture host loads, by package name (leave-check.mjs).
export const LEAVE_CHECK = '@scenecast/ai/leave-check.mjs';

export function leaveOutOf({ demo, packs, text = null, apps = null }) {
  const rf = join(demo.dir, 'reset.md');
  const t = text !== null ? text : existsSync(rf) ? readFileSync(rf, 'utf8') : '';
  const lines = parseReset(t).leaveOut || [];
  const out = { lines, rules: [], words: {}, problems: [], skipped: [] };
  if (!lines.length) return out;
  const filters = packs && packs.filtersFor ? packs.filtersFor(demo.cfg) : {};
  const by = new Map();
  for (const l of lines) {
    const f = l.from && filters[l.from];
    if (!l.from) { out.problems.push(`"${l.what}" names no filter (its From: line, "<pack>:<filter>")`); continue; }
    if (!f) { out.problems.push(`"${l.what}" is left out by ${l.from}, and no app pack of this demo has that filter`); continue; }
    if (l.app && l.app !== f.app) { out.problems.push(`"${l.what}" is for ${l.app}, and ${l.from} is ${f.app}'s`); continue; }
    if (apps && !apps.has(f.app)) { out.skipped.push({ app: f.app, what: l.what, from: l.from, why: `the plan never goes to ${f.app}` }); continue; }
    if (!l.values.length) { out.problems.push(`"${l.what}" names nothing to leave out (its words in quotes)`); continue; }
    const r = by.get(l.from) || by.set(l.from, ruleOf(f, [], { id: l.from, app: f.app, hosts: f.hosts })).get(l.from);
    for (const v of l.values) if (!r.values.includes(v)) r.values.push(v);
    const w = out.words[f.app] || (out.words[f.app] = []);
    for (const s of l.shows || l.values) if (!w.includes(s)) w.push(s);
  }
  out.rules = [...by.values()];
  return out;
}

export const leaveOn = (cmd, lo, { shots = null } = {}) => cmd('capLeaveOut', { rules: lo.rules, words: lo.words, check: LEAVE_CHECK, shots }, 60);
export const leaveLog = cmd => cmd('capLeaveLog', {}, 60).catch(e => ({ on: false, error: e.message }));
export const leftFor = (lo, app, sc) => { const w = (lo && lo.words[app]) || []; return w.length && sc ? leftOut(sc, w) : sc; };
// The apps with a line, each opened again at its start once Leave out is on (what they loaded before came unfiltered).
export const leaveApps = lo => [...new Set(lo.rules.map(r => r.app).filter(Boolean))];
// A rule of this app whose response couldn't be read, or had lost its list: that app's screens wait.
export function leaveFailure(log, app) {
  const r = ((log && log.rules) || []).find(x => x.app === app && x.failures && x.failures.length);
  return r ? `${r.id}: ${r.failures[0].why} (${r.failures[0].method} ${r.failures[0].host}${r.failures[0].path})` : null;
}
