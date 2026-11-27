// The state a demo starts in, as its first screens show it: what's switched on or off, which mode is picked, versions,
// what a list of switches holds, and the theme. Read from the product's own captures (walker.screen), in the order
// the plan reaches them. The reset sets it before a run and checks it (reset.mjs). A state that changes from one
// screen to a later one with no step of the plan in between can't happen in a run of the plan: it's said, with
// the step that would make it.
const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
const norm = s => clean(s).toLowerCase().replace(/[“”"'’‘]/g, '');

// "Enable Sync" → Sync; a card's "Sync, turned off" → Sync, off.
export function toggleOf(c) {
  const m = /^(.+?),\s*turned (on|off)$/i.exec(c.name || '');
  if (m) return { subject: clean(m[1]), on: m[2].toLowerCase() === 'on', control: null };
  if (!/^(switch|checkbox)$/.test(c.role) || typeof c.on !== 'boolean' || !c.name) return null;
  return { subject: clean(String(c.name).replace(/^(?:enable|disable|turn (?:on|off)|toggle)\s+/i, '')), on: c.on, control: c.name };
}

// What one screen says about the start state. Not what she leaves out of the replica (left): the capture won't show it.
export function factsOf(sc, { app, pack = null } = {}) {
  if (!sc) return [];
  const out = [], ctls = (sc.controls || []).filter(c => !c.left);
  const toggles = ctls.map(toggleOf).filter(Boolean);
  for (const t of toggles) out.push({ app, kind: 'toggle', key: norm(t.subject), subject: t.subject, value: t.on ? 'on' : 'off', control: t.control });
  // A group of radios (Chat | Cowork): the one that's picked.
  const radios = ctls.filter(c => c.role === 'radio' && typeof c.on === 'boolean' && c.name);
  const picked = radios.find(c => c.on);
  if (picked && radios.length > 1) out.push({ app, kind: 'choice', key: radios.map(c => norm(c.name)).sort().join('|'), subject: radios.map(c => c.name).join(' | '), value: picked.name, control: picked.name });
  // "Version 1.4.9" on a page about one thing: that thing's version.
  const v = /\bversion\s*:?\s*v?(\d+(?:\.\d+){1,3})\b/i.exec(String(sc.text || '').replace(/\s+/g, ' '));
  const about = (sc.headings || []).find(h => !/^version$/i.test(h));
  if (v && about) out.push({ app, kind: 'version', key: norm(about), subject: about, value: v[1] });
  // A list of switches (Plugins › Added): what it holds.
  const named = [...new Set(toggles.filter(t => t.control).map(t => t.subject))];
  if (named.length > 1) { const h = (sc.headings || [])[0] || 'The list'; out.push({ app, kind: 'list', key: norm(h.replace(/\s*\(\d+\)$/, '')), subject: h, value: named.join(', ') }); }
  // Light or dark: the page's own marks, or an app that has no dark theme (its pack).
  const theme = sc.theme || (pack && pack.theme && pack.theme.follows === 'none' && !(pack.theme.themes || {}).dark ? 'light' : null);
  if (theme) out.push({ app, kind: 'theme', key: 'theme', subject: 'theme', value: theme });
  return out;
}

// Every screen the plan reaches, in order, with the steps before it.
function visits(plan, walker) {
  const out = [];
  let app = (walker.flow.beats || [])[0] ? walker.flow.beats[0].active : null, n = 0;
  if (app) out.push({ beat: 1, step: -1, app, screen: walker.start(app) });
  plan.beats.forEach((b, bi) => b.steps.forEach(s => {
    n++;
    if (s.kind === 'app') app = s.app;
    if (app && s.lands && s.lands.screen) out.push({ beat: bi + 1, step: n, app, screen: s.lands.screen });
  }));
  return out;
}

// { facts: the first state of each thing, changes: a later state no step explains }.
export function startState(plan, { walker, packs = null } = {}) {
  if (!walker) return { facts: [], changes: [] };
  const steps = plan.beats.flatMap((b, bi) => b.steps.map(s => ({ ...s, beat: bi + 1 })));
  const packOf = app => ((packs || {}).forApp || {})[app] || null;
  const seen = new Map(), facts = [], changes = [], read = new Set();
  for (const v of visits(plan, walker)) {
    if (read.has(v.screen)) continue;
    read.add(v.screen);
    const sc = walker.screen(v.screen) || walker.shown(v.screen);
    for (const f of factsOf(sc, { app: v.app, pack: packOf(v.app) })) {
      // A version said again on another page, under a longer heading ("Sync Plugin Available"):
      // the same thing's version.
      if (f.kind === 'version') { const same = facts.find(x => x.kind === 'version' && norm(f.subject).startsWith(x.key)); if (same) { f.key = same.key; f.subject = same.subject; } }
      const k = `${f.app}|${f.kind}|${f.key}`, at = { beat: v.beat, step: v.step, screen: v.screen };
      const was = seen.get(k);
      if (!was) { const fact = { ...f, seen: at }; seen.set(k, { fact, last: { value: f.value, ...at } }); facts.push(fact); continue; }
      if (f.control && !was.fact.control) was.fact.control = f.control;
      if (f.value !== was.last.value && (f.kind === 'toggle' || f.kind === 'choice')) {
        // Explained by a step between the two screens that acts on it (its switch, its name, the option picked).
        const between = steps.slice(Math.max(0, was.last.step), Math.max(0, v.step));
        const acts = between.some(s => (s.kind === 'click' || s.kind === 'hover' || s.kind === 'manual') && [f.subject, f.control, f.value].filter(Boolean).some(t => norm(s.target || s.what || '').includes(norm(t))));
        if (!acts) changes.push({ app: f.app, kind: f.kind, key: f.key, subject: f.subject, control: f.control || was.fact.control, from: was.last.value, to: f.value, before: { beat: was.last.beat, screen: was.last.screen }, after: at });
      }
      was.last = { value: f.value, ...at };
    }
  }
  return { facts, changes };
}

// How to set a fact, from the app's pack: the write that changes it (a switch, a mode, the theme setting).
export function setterOf(f, pack, writeFor) {
  if (!pack || !writeFor) return null;
  const target = f.kind === 'toggle' ? f.control : f.kind === 'choice' ? f.value : f.kind === 'theme' && pack.theme && pack.theme.follows === 'setting' ? cap(f.value) : null;
  if (!target) return null;
  const w = writeFor(pack, { kind: 'click', target });
  if (!w) return null;
  const open = (w.undo && w.undo.open) || (w.check && w.check.open) || null;
  const path = !open && w.check && w.check.steps ? w.check.steps.map(s => (/"([^"]+)"/.exec(s) || [])[1]).filter(Boolean).join(' › ') : null;
  return { control: target, pack: pack.id, write: w.id, open, path };
}
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;
