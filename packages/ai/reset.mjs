// The demo's reset, made from its plan: each write the plan approves, undone (in reverse order), and a read-only
// checklist that says the tenant is back where the demo starts. The capture pass runs it before and after (a demo is
// captured from a known state, and leaves the tenant as it found it). reset.md, in the plan's own words:
//
//   # Reset: Supplier delay
//   ## Undo · Microsoft IQ
//   - Go to iq
//   - Remove the endorsement ("Certified")
//     Undoes: beat 6, Click "Certified"
//   ## Check
//   - iq shows "17 curated here"
//   - iq: no endorsement ("Add endorsement" shows)
//
// Undo steps are plan steps (Record for me runs them the same way, read on screen; a step it can't place, it asks
// about). An app pack's `writes` (packages/apps, when it lands) can give a write its exact undo; without one, the undo
// is the plain opposite, in words. Writes that can't be undone (a deletion, a sent message to someone else) are listed
// under "Needs you".
import { formatStep, parsePlan } from './plan.mjs';

const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
const norm = s => clean(s).toLowerCase().replace(/[“”"'’‘]/g, '');
const quoted = s => [...String(s).matchAll(/"([^"]+)"/g)].map(m => m[1]);

// What one write changed, and its opposite: { app, undo: [step text], check: [text], needs }.
export function inverseOf(w, ctx = {}) {
  const t = w.writes || '', app = w.app, [first, second] = quoted(t);
  const title = ctx.titleAfter || null;
  if (/^sends\b/.test(t)) return {
    app, kind: 'send',
    undo: [`Delete the ${ctx.chatWord || 'task'} it made${title ? ` ("${title}")` : ''}`],
    check: [`no ${ctx.chatWord || 'task'}${title ? ` "${title}"` : ''} from this run in Recent`],
    note: title ? null : 'its title is the one the capture pass records when it sends it',
  };
  if (/^saves\b/.test(t)) {
    const name = ctx.savedName || first || 'it';
    return { app, kind: 'save', undo: [`Delete "${name}"`], check: [`no "${name}"`] };
  }
  if (/^approves\b/.test(t)) return { app, kind: 'approve', undo: [], check: [], needs: `"${w.text}" approves something: undo it by hand, or approve it in a throwaway run` };
  if (/^adds\b/.test(t)) {
    const item = first || 'it', where = ctx.addedTo || null;
    return { app, kind: 'add', undo: [`Remove "${item}"${where ? ` from "${where}"` : ''}`], check: [`${where ? `"${where}" doesn't list` : 'no'} "${item}"`] };
  }
  if (/^endorses\b/.test(t)) return { app, kind: 'endorse', undo: [`Remove the endorsement ("${first || 'it'}")`], check: [`no endorsement${ctx.endorseControl ? ` ("${ctx.endorseControl}" shows)` : ''}`] };
  if (/^turns\b/.test(t)) {
    const on = /\bon$/.test(t);
    return { app, kind: 'setting', undo: [`Turn "${first}" ${on ? 'off' : 'on'}`], check: [`"${first}" is ${on ? 'off' : 'on'}`] };
  }
  if (/^(deletes|removes|archives|uninstalls|rejects)\b/.test(t)) return { app, kind: 'delete', undo: [], check: [], needs: `${w.text} ${t}: that can't be undone here. Use a throwaway copy, or put it back by hand after each run` };
  return { app, kind: 'change', undo: [`Undo ${t.replace(/^\w+s\b/, m => m.slice(0, -1))}`], check: [] };
}

// The reset for a plan: walked with the plan's own screens (walker.mjs) when there is one, to name what was made
// (the saved skill, the section it was added to) and what the start screens show that the writes change.
export function resetFor(plan, { walker = null, packs = null } = {}) {
  const S = walker ? walker.flow.states || {} : {};
  const cur = {};
  if (walker) for (const a of walker.apps) cur[a.id] = walker.start(a.id);
  const writes = [];
  let app = walker && (walker.flow.beats || [])[0] ? walker.flow.beats[0].active : null;
  let lastAddTo = null;
  const open = {};
  plan.beats.forEach((b, bi) => b.steps.forEach((s, si) => {
    if (s.kind === 'app') { app = s.app; return; }
    // A prompt sent into a task that's already open is a new turn in it, not a new task: the task's undo covers it.
    if (s.kind === 'click' && /^new\b/i.test(s.target || '')) open[app] = false;
    if (s.writes && /^sends\b/.test(s.writes)) { if (open[app]) { if (s.lands && s.lands.screen) cur[app] = s.lands.screen; return; } open[app] = true; }
    const from = app ? cur[app] : null;
    if (s.kind === 'click' && /^add content to\b|^add to\b/i.test(s.target || '')) lastAddTo = (/^add (?:content )?to\s+(.+)$/i.exec(s.target) || [])[1] || lastAddTo;
    if (s.writes) { const tag = / · ([\w-]+):([\w-]+)$/.exec(s.writes); writes.push({ beat: bi + 1, step: si, text: formatStep(s), writes: s.writes.replace(/ · [\w-]+:[\w-]+$/, ''), pack: tag ? tag[1] : null, write: tag ? tag[2] : null, app, from, to: s.lands && s.lands.screen, addTo: lastAddTo, target: s.target }); }
    if (app && s.lands && s.lands.screen) cur[app] = s.lands.screen;
  }));
  const out = { title: plan.title, undo: [], checks: [], needs: [], writes: writes.length };
  const appTitle = id => ((walker && walker.apps.find(a => a.id === id)) || {}).title || id;
  // What each write made, from the screen it landed on (a title, a name in the words).
  for (const w of writes.reverse()) {
    const after = walker && w.to ? walker.shown(w.to) || walker.screen(w.to) : null;
    const before = walker && w.from ? walker.shown(w.from) || walker.screen(w.from) : null;
    const ctx = {
      titleAfter: after && /^sends\b/.test(w.writes) && after.title && after.title !== w.to ? after.title : null,
      savedName: after ? ((/saved as ([\w.-]+)/i.exec(after.text) || [])[1] || null) : null,
      addedTo: w.addTo,
      endorseControl: before && before.controls.find(c => /endorse/i.test(c.name) && !/:/.test(c.name)) ? before.controls.find(c => /endorse/i.test(c.name) && !/:/.test(c.name)).name : null,
    };
    const inv = fromPack(w, ctx, packs) || inverseOf(w, ctx);
    if (inv.needs) out.needs.push({ beat: w.beat, text: inv.needs });
    if (inv.undo.length) out.undo.push({ app: w.app, steps: inv.undo, undoes: `beat ${w.beat}, ${w.text}`, note: inv.note || null });
    for (const c of inv.check) out.checks.push({ app: w.app, text: c, from: `beat ${w.beat}` });
  }
  // What a run leaves besides its writes (the app's pack: tasks in Recent, saved memories), with their checks.
  const switches = writes.some(w => /^turns\b/.test(w.writes) || /switch/.test(w.write || ''));
  for (const a of [...new Set(writes.map(w => w.app))]) {
    const pack = ((packs || {}).forApp || {})[a];
    for (const e of (pack && pack.effects) || []) {
      if (/switch/i.test(`${e.id} ${e.what}`) && !switches) continue;
      if (e.undo && e.undo.steps) out.undo.push({ app: a, steps: e.undo.steps, undoes: `what a run leaves: ${e.what}`, note: e.check ? 'only when its check finds something' : null, manual: e.undo.steps.some(x => /^You:/i.test(x)) });
      if (e.check && e.check.expect) out.checks.push({ app: a, text: e.check.expect.replace(/\.$/, ''), from: `${pack.id}: ${e.id}` });
    }
  }
  // What the start screens show that the writes change ("17 curated here" before the add, "18" after): the reset
  // brings it back, so the checklist looks for it.
  if (walker) {
    const apps = [...new Set(writes.map(w => w.app))];
    for (const a of apps) {
      const start = walker.shown(walker.start(a)) || walker.screen(walker.start(a));
      if (!start) continue;
      const later = writes.filter(w => w.app === a && w.to).map(w => walker.shown(w.to) || walker.screen(w.to)).filter(Boolean);
      const gone = start.items.map(i => clean(i.text)).filter(t => t.length > 3 && t.length < 50 && t.split(' ').length <= 6 && /\d|[A-Z]/.test(t))
        .filter(t => later.some(sc => !norm(sc.text).includes(norm(t))) && later.some(sc => numberSwap(t, sc.text)));
      for (const t of [...new Set(gone)].slice(0, 3)) out.checks.push({ app: a, text: `shows "${t}"`, from: 'its start screen' });
    }
  }
  // One of each: the same check twice (two prompts in one task), a pack's check over the plain one for the same thing,
  // and a pack's count check with the number the start screen shows.
  const seen = new Set();
  out.checks = out.checks.filter(c => { const k = `${c.app}|${norm(c.text)}`; if (seen.has(k)) return false; seen.add(k); return true; });
  for (const a of new Set(out.checks.map(c => c.app))) {
    const mine = out.checks.filter(c => c.app === a);
    if (mine.some(c => /recent/i.test(c.text) && !/^no task/.test(c.text))) out.checks = out.checks.filter(c => !(c.app === a && /^no task\b.*\bin Recent$/.test(c.text)));
    const shown = mine.filter(c => /^shows "/.test(c.text));
    out.checks = out.checks.filter(c => !(c.app === a && /^the count the demo starts with$/i.test(c.text) && shown.length));
  }
  // The same undo for two writes (two new tasks the captures title the same) is one group, done once for each.
  const undone = new Map();
  out.undo = out.undo.filter(u => {
    const k = `${u.app}|${u.steps.join('|')}`, was = undone.get(k);
    if (!was) { undone.set(k, u); return true; }
    was.undoes += `; ${u.undoes}`; was.times = (was.times || 1) + 1;
    return false;
  });
  out.appTitle = appTitle;
  return out;
}
// A write the app's pack knows (packages/apps writes): its undo steps and its check, with what the run made filled in.
function fromPack(w, ctx, packs) {
  const pack = w.pack && packs && (Object.values(packs.forApp || {}).find(p => p.id === w.pack));
  const pw = pack && (pack.writes || []).find(x => x.id === w.write);
  if (!pw) return null;
  const resolve = k => { const x = (pw[k] && pw[k].same) ? ((pack.writes || []).find(y => y.id === pw[k].same) || {})[k] : pw[k]; return x || null; };
  const undo = resolve('undo'), check = resolve('check');
  const known = { skill: ctx.savedName, task: ctx.titleAfter, item: w.picked || (/"([^"]+)"/.exec(w.writes) || [])[1], section: ctx.addedTo, endorsement: w.target, message: null, plugin: (/^Enable (.+)$/.exec(w.target || '') || [])[1], before: null };
  // What the run made, by name where the captures show it; else in words (the capture pass records the real one).
  const words = { task: 'the task this run made', skill: 'the skill this run saved', message: 'the message this run posted', before: 'what it was before', item: 'the item this run added', section: 'its section' };
  const fill = t => String(t).replace(/\{(\w+)\}/g, (m, k) => known[k] || words[k] || m).replace(/"(the (?:task|skill|message|item) this run (?:made|saved|posted|added))"/g, '$1');
  const out = { app: w.app, kind: pw.makes || pw.id, undo: undo && undo.steps ? undo.steps.map(fill) : [], check: check ? [fill(check.expect || (check.look && (check.look.absent ? `no "${check.look.absent}"` : check.look.text)) || '').replace(/\.$/, '')].filter(Boolean) : [], note: [undo && undo.open ? `opens ${undo.open}` : null, undo && undo.note].filter(Boolean).join('; ') || null };
  // A private pack's API undo: named here, not written out (its host and IDs stay in the pack). The capture pass
  // calls it in its own signed-in session, with what its run made; the steps by hand are what's left if it can't.
  if (undo && undo.api) {
    const from = [...new Set((JSON.stringify(undo.api).match(/\{(\w+)\}/g) || []).map(x => x.slice(1, -1)))];
    const byHand = out.undo.length ? `if it can't: ${out.undo.join(' › ')}` : null;
    out.undo = [`Undo with the app pack: ${pack.id}:${pw.id}`];
    out.note = [`an API call in the capture browser's own signed-in session${from.length ? `, with ${from.map(x => `{${x}}`).join(', ')} from the run` : ''}`, byHand].filter(Boolean).join('; ');
    if (pw.verified === false) out.needs = `${w.text}: its undo (${pack.id}: ${pw.id}) hasn't been tried yet`;
    return out;
  }
  if (!undo || pw.irreversible) out.needs = `${w.text} ${w.writes}: ${pw.note || 'the app pack has no undo for it'}`;
  else if (pw.verified === false) out.needs = `${w.text}: its undo (${pack.id}: ${pw.id}) hasn't been tried yet`;
  else if (out.undo.some(x => /^You:/i.test(x))) out.needs = `${w.text}: part of its undo is by hand (${out.undo.filter(x => /^You:/i.test(x)).map(x => x.slice(4).trim()).join('; ')})`;
  return out;
}

// "17 curated here" on the start screen, "18 curated here" after: the same words with another number.
function numberSwap(t, text) {
  if (!/\d/.test(t)) return false;
  const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\d+/g, '\\d+'), 'i');
  return re.test(text);
}

export function formatReset(r) {
  const out = [`# Reset: ${r.title || 'Demo'}`, '', `<!-- Made by Scenecast from plan.md (${r.writes} write${r.writes === 1 ? '' : 's'}). The capture pass runs Undo, then Check, before and after it. -->`, ''];
  const byApp = [];
  for (const u of r.undo) { let g = byApp.find(x => x.app === u.app); if (!g) byApp.push(g = { app: u.app, items: [] }); g.items.push(u); }
  for (const g of byApp) {
    out.push(`## Undo · ${r.appTitle ? r.appTitle(g.app) : g.app}`, '', `- Go to ${g.app}`);
    for (const u of g.items) u.steps.forEach((s, i) => {
      out.push(`- ${s}`);
      if (i) return;
      out.push(`  Undoes: ${u.undoes}`);
      const note = [u.times > 1 ? `do these steps ${u.times} times, once for each` : null, u.note].filter(Boolean).join('; ');
      if (note) out.push(`  Note: ${note}`);
    });
    out.push('');
  }
  if (r.checks.length) {
    out.push('## Check', '', '<!-- Read-only: each line is something the screen shows. -->', '');
    for (const c of r.checks) out.push(`- ${c.app}: ${c.text}`, `  From: ${c.from}`);
    out.push('');
  }
  if (r.needs.length) {
    out.push('## Needs you', '');
    for (const n of r.needs) out.push(`- Beat ${n.beat}: ${n.text}`);
    out.push('');
  }
  return out.join('\n');
}

// reset.md read back: its Undo steps as a plan the capture pass runs, and its checks.
export function parseReset(text) {
  const undo = parsePlan(String(text).split(/^## Check\b/m)[0].replace(/^## Undo · /gm, '## '));
  const checks = [...String(text).split(/^## Check\b/m)[1] || ''].length ? (String(text).split(/^## Check\b/m)[1].split(/^## /m)[0].match(/^- .+$/gm) || []).map(l => l.slice(2)) : [];
  return { undo, checks };
}
