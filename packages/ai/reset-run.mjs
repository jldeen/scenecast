// The demo's reset, run by an unattended capture pass before and after it (stage D): the tenant as the demo starts
// before anything is recorded, and as it was found after. Fail closed: when the check before still fails after the
// fix, nothing is recorded.
//   The demo's own scripts (demo.json preflight.reset / resetFix), else reset.md (reset.mjs: Undo, then Set first,
//   then Check). reset.md's undo and set-first steps change the tenant, so each one runs only as approved (the
//   approval lists them: make.mjs resetSteps), with the guard open for that one step, the control matched again.
//   runReset({ demo, cmd, walker, phase: 'before' | 'after', approval, ran, results, shots }) →
//     { ok, how, did: [...], checks: [{ text, ok, why }], why }
// ran: the writes the run made ({ beat (1-based), text }); after it, only their undos run (then the rest, if the check
// still fails). results: what they made ({ task, skill, item, … } from run.json), for the undo's {placeholders}.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStep, formatStep } from './plan.mjs';
import { appTab, sleep } from './run.mjs';
import { norm } from './find.mjs';

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
export function fallbackSteps(note) {
  const m = /if it can['’]t:\s*(.+)$/i.exec(String(note || ''));
  return m ? m[1].split(/\s*›\s*/).map(x => x.trim()).filter(Boolean) : [];
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
      const step = /^- (.+)$/.exec(raw), undoes = /^\s+Undoes:\s*(.+)$/.exec(raw), note = /^\s+Note:\s*(.+)$/.exec(raw);
      if (step) {
        const s = parseStep(step[1]);
        if (s.kind === 'app') { app = s.app; continue; }
        group = { app, title: m[1].trim(), steps: [s], undoes: [], note: null };
        out.push(group);
      } else if (undoes && group) group.undoes = undoes[1].split(/;\s*/).map(x => x.trim());
      else if (note && group) group.note = note[1].trim();
    }
  }
  // A step with no Undoes line of its own belongs to the group before it (the rest of that undo).
  const merged = [];
  for (const g of out) { const last = merged[merged.length - 1]; if (!g.undoes.length && last && last.app === g.app) last.steps.push(...g.steps); else merged.push(g); }
  return merged;
}
// "beat 7, Press Enter": does it undo one of these writes?
const undoesAny = (g, ran) => g.undoes.some(u => { const m = /^beat (\d+), (.+)$/.exec(u); return m && ran.some(w => w.beat === +m[1] && norm(w.text) === norm(m[2])); });

// One check line ("iq: shows \"17 curated here\"") read on the app's screen: { ok, why }. A line it can't read fails:
// a reset it can't verify isn't one.
export function checkClaim(claim, { words = '', items = [], light = null } = {}) {
  const has = t => norm(words).includes(norm(t));
  let m;
  if ((m = /^shows ["“](.+)["”]$/.exec(claim))) return has(m[1]) ? { ok: true } : { ok: false, why: `"${m[1]}" isn't on the screen` };
  if ((m = /\(["“](.+)["”] shows\)/.exec(claim))) return has(m[1]) ? { ok: true } : { ok: false, why: `"${m[1]}" isn't on the screen` };
  if ((m = /^["“](.+)["”] is (on|off)$/.exec(claim))) {
    const it = items.find(i => /switch|checkbox|button/.test(i.role) && i.checked !== undefined && i.checked !== null && norm(i.name).includes(norm(m[1])));
    if (!it) return { ok: false, why: `no switch for "${m[1]}" on the screen` };
    const on = it.checked === true || it.checked === 'true';
    return on === (m[2] === 'on') ? { ok: true } : { ok: false, why: `"${m[1]}" is ${on ? 'on' : 'off'}` };
  }
  if ((m = /^["“](.+)["”] is picked\b/.exec(claim))) {
    const it = items.find(i => norm(i.name) === norm(m[1]));
    if (!it) return { ok: false, why: `no "${m[1]}" on the screen` };
    return it.checked === true || it.checked === 'true' ? { ok: true } : { ok: false, why: `"${m[1]}" isn't picked` };
  }
  if ((m = /^renders (light|dark)$/.exec(claim))) {
    if (light === null) return { ok: false, why: "couldn't read the page's colours" };
    return (light ? 'light' : 'dark') === m[1] ? { ok: true } : { ok: false, why: `it renders ${light ? 'light' : 'dark'}` };
  }
  if (/^no\b/.test(claim) && quoted(claim).length) { const t = quoted(claim)[0]; return has(t) ? { ok: false, why: `"${t}" is still there` } : { ok: true }; }
  return { ok: false, why: `can't check "${claim}" on its own: say it as shows "…", no "…", "…" is on/off or "…" is picked` };
}

export async function runReset({ demo, cmd, walker, phase, approval, ran = [], results = {}, emit = () => {} }) {
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
  const allowed = (part, t) => ((approval && approval.reset) || []).some(x => x.part === part && norm(x.text) === norm(t));
  const appIds = (demo.cfg.apps || []).map(a => a.id);
  const appOfText = t => { const m = /^([\w-]+)\s*:\s*(.*)$/.exec(t); return m && appIds.includes(m[1]) ? { app: m[1], rest: m[2] } : null; };
  const did = [];
  const home = app => walker.home(app);
  const fill = t => String(t).replace(/\{(\w+)\}/g, (m, k) => results[k] || m);
  // One reset step that changes something: approved, its placeholders filled, run as a write.
  const step = async (part, app, s, approvedText, { note = null } = {}) => {
    if (s.kind === 'free' && /^undo with the app pack:/i.test(s.text || '')) return apiUndo(part, app, s, approvedText, note);
    const filled = parseStep(fill(formatStep(s)));
    if (/\{\w+\}/.test(formatStep(filled))) return { ok: false, why: `${formatStep(s)}: the run didn't record what to fill in` };
    if (!allowed(part, approvedText)) return { ok: false, why: `"${approvedText}" isn't in the approved reset` };
    if (filled.kind === 'manual') return { ok: false, why: `${formatStep(filled)}: a person's step, and nobody's there` };
    if (filled.kind === 'free') return { ok: false, why: /^undo with the app pack/i.test(filled.text) ? `${filled.text}: the pack's API undo isn't run by the capture pass yet` : `"${filled.text}" isn't a step it can do on its own` };
    const r = await walker.write(app, filled);
    if (r.missing) return { ok: false, missing: true, why: r.why };
    if (r.needsYou) return { ok: false, why: r.why };
    did.push(`${app}: ${formatStep(filled)}`);
    return { ok: true };
  };
  // "Undo with the app pack: <pack>:<write>": the pack's API undo (a private pack's), in the app's own signed-in session,
  // with what the run made; if it can't, the steps its Note gives, each approved and run as a write.
  const apiUndo = async (part, app, s, approvedText, note) => {
    if (!allowed(part, approvedText)) return { ok: false, why: `"${approvedText}" isn't in the approved reset` };
    const m = /^undo with the app pack:\s*([\w-]+):([\w-]+)\s*$/i.exec(s.text);
    const fall = async why => {
      const steps = fallbackSteps(note);
      if (!steps.length) return { ok: false, why: `${s.text}: ${why}, and its Note gives no steps for when it can't` };
      for (const t of steps) { const r = await step(part, app, parseStep(t), t); if (!r.ok) return { ...r, why: `${s.text}: ${why}; then ${r.why}` }; }
      return { ok: true, fallback: why };
    };
    if (!m) return fall('it names no pack and write');
    const { walkerPacks } = await import('./live.mjs');
    const packs = await walkerPacks();
    const pack = packs && packs.packsForDemo ? Object.values(packs.packsForDemo(demo.cfg) || {}).find(p => p && p.id === m[1]) : null;
    const pw = pack && (pack.writes || []).find(w => w.id === m[2]);
    const api = pw && pw.undo && pw.undo.api, at = api && pack.apis && pack.apis[api.use];
    if (!api || !at) return fall(`the ${m[1]} pack has no API undo for ${m[2]}`);
    const path = fill(api.path || ''), body = api.body ? JSON.parse(fill(JSON.stringify(api.body))) : null;
    const left = `${path} ${body ? JSON.stringify(body) : ''}`.match(/\{\w+\}/g);
    if (left) return fall(`the run didn't record ${[...new Set(left)].join(', ')}`);
    const r = await cmd('capApi', { tab: appTab(demo, app), open: at.open, host: at.host, hostPattern: at.hostPattern, method: api.method, path, body }, 150).catch(e => ({ ok: false, why: e.message }));
    if (!r.ok) return fall(r.why || `the API answered ${r.status}`);
    did.push(`${app}: ${s.text} (${api.method}, ${r.status})`);
    return { ok: true };
  };
  const runGroups = async list => {
    const out = [];
    for (const g of list) {
      await home(g.app);
      for (const [i, s] of g.steps.entries()) {
        const r = await step('undo', g.app, s, formatStep(s), { note: g.note });
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
      const a = appOfText(s.what);
      if (!a) return { ok: false, why: `${s.what}: which app?` };
      if (s.opens) await cmd('goto', { tab: appTab(demo, a.app), url: s.opens }, 60).catch(() => {}); else await home(a.app);
      await walker.quiet(a.app, 800, 15000);
      const now = checkClaim(a.rest, await readScreen(a.app));
      if (now.ok) continue;
      // Its control, through its path ("Settings and more › Settings › Appearance"), as approved.
      const [control] = quoted(s.set || '');
      const path = (/\(([^)]+)\)/.exec(s.set || '') || [])[1];
      if (!control) return { ok: false, why: `${s.what}: no control to set it with` };
      for (const p of path ? path.split(/\s*›\s*/) : []) { const r = await step('set', a.app, parseStep(`Click "${p}"`), s.what); if (!r.ok) return r; }
      const r = await step('set', a.app, parseStep(`Click "${control}"`), s.what);
      if (!r.ok) return r;
    }
    return { ok: true };
  };
  const readScreen = async app => {
    const o = await walker.controls(app);
    const words = await walker.words(app);
    const light = await cmd('js', { tab: appTab(demo, app), code: "return await page.evaluate(() => { const c = getComputedStyle(document.body).backgroundColor.match(/\\d+(\\.\\d+)?/g); if (!c) return null; const [r, g, b, a] = c.map(Number); if (a === 0) return null; return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5; })" }, 30).catch(() => null);
    return { words, items: o.items || [], light };
  };
  // Each check on its app's start screen, or (a check that names one) on the screen it names, reached by the plan's own
  // read-only steps under the guard, before any of the reset's writes.
  let plan;
  const checkAll = async () => {
    const out = [];
    for (const c of parsed.checks) {
      const line = typeof c === 'string' ? c : c.text, screen = c && typeof c === 'object' ? c.screen || null : null;
      const a = appOfText(line);
      if (!a) { out.push({ text: line, ok: false, why: 'which app?' }); continue; }
      await home(a.app);
      if (screen) {
        if (plan === undefined) { const { readPlan } = await import('./draft.mjs'); plan = readPlan(demo); }
        const path = pathTo(plan, a.app, screen, x => (walker.appOf && walker.appOf(x)) || x);
        if (!path) { out.push({ text: line, ok: false, why: `the plan reaches ${screen} only after a write, or never: no read-only way there` }); continue; }
        let at = { app: a.app }, bad = null;
        for (const s of path) {
          const r = await walker.step(at, s).catch(e => ({ landed: false, why: e.message }));
          if (!r.landed && r.kind !== 'unproven') { bad = `${formatStep(s)}: ${r.why}`; break; }
          at = r.screen || at;
        }
        if (bad) { out.push({ text: line, ok: false, why: `on the way to ${screen}: ${bad}` }); continue; }
      }
      out.push({ text: line, ...(screen ? { screen } : {}), ...checkClaim(a.rest, await readScreen(a.app)) });
    }
    return out;
  };
  const failing = cs => cs.filter(c => !c.ok);
  emit({ event: 'reset', phase, stage: 'check' });
  if (phase === 'before') {
    let checks = await checkAll();
    if (!failing(checks).length) return { ok: true, how: 'reset.md', did, checks, why: null };
    emit({ event: 'reset', phase, stage: 'fix', failing: failing(checks).map(c => c.text) });
    const u = await runGroups(groups);
    if (!u.ok) return { ok: false, how: 'reset.md', did, checks, undo: u.out, why: `the undo stopped: ${u.why}` };
    const st = await setFirst();
    if (!st.ok) return { ok: false, how: 'reset.md', did, checks, why: `setting the start: ${st.why}` };
    checks = await checkAll();
    return { ok: !failing(checks).length, how: 'reset.md', did, checks, undo: u.out, why: failing(checks).length ? `still not as the demo starts: ${failing(checks).map(c => `${c.text} (${c.why})`).join('; ')}` : null };
  }
  // After: the undos of what ran, the start set again, the check; the rest only if the check still fails.
  const mine = groups.filter(g => undoesAny(g, ran));
  const u = await runGroups(mine);
  const st = u.ok ? await setFirst() : { ok: false, why: u.why };
  let checks = await checkAll();
  let u2 = null;
  if (failing(checks).length) {
    u2 = await runGroups(groups.filter(g => !mine.includes(g)));
    checks = await checkAll();
  }
  const ok = u.ok && st.ok && !failing(checks).length;
  return { ok, how: 'reset.md', did, checks, undo: [...(u.out || []), ...((u2 && u2.out) || [])], why: ok ? null : [!u.ok && `the undo stopped: ${u.why}`, !st.ok && `setting the start: ${st.why}`, failing(checks).length && `not as the demo starts: ${failing(checks).map(c => `${c.text} (${c.why})`).join('; ')}`].filter(Boolean).join('; ') };
}
