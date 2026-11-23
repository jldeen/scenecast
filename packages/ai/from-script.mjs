// The plan from a talk track (Make it from my script): each Do line becomes steps on the real controls of the screens
// it passes (walker.mjs), with the writes marked, the screen each step lands on, focus targets from the Say lines,
// and where the product isn't what the script says, flagged once. The words become steps by rules here (the same
// every time, and what the tests run); Copilot works out what the rules can't, on screen, when the plan runs.
import { formatStep, risk } from './plan.mjs';
import { findItem, composer, searchBox } from './find.mjs';
import { words, facts, pickItems, sentences } from '@scenecast/script/match.mjs';

const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
const norm = s => clean(s).toLowerCase().replace(/[“”"'’‘]/g, '');
const unq = s => clean(s).replace(/^[“"‘']+|[”"’']+$/g, '').replace(/\*\*/g, '');
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;
const quoted = s => [...String(s).matchAll(/[“"]([^”"]+)[”"]/g)].map(m => m[1]);

// ---- the words: Do text to intents --------------------------------------------------------------------------------
// Sentences, then ";", ", then", " then " and "," before a verb, a key or a prompt (quotes and brackets kept whole).
const VERB = /^(click|open|select|choose|tap|press|hover|type|enter|send|scroll|close|go|switch|search(?:ed)?|add|point|rest|wait|start|new|then|and|use|pick)\b|^⌥|^ctrl\s*\+|^prompt\b/i;
export function clausesOf(text) {
  const out = []; let cur = '', q = null, depth = 0;
  const s = clean(text);
  const push = () => { const c = clean(clean(cur).replace(/^(?:and then|then|and)\b\s*/i, '')); if (c) out.push(c); cur = ''; };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { cur += ch; if (ch === q || (q === '“' && ch === '”')) q = null; continue; }
    if (ch === '"' || ch === '“') { q = ch; cur += ch; continue; }
    if (ch === '(') depth++; else if (ch === ')') depth = Math.max(0, depth - 1);
    if (!depth && (ch === '.' || ch === ';') && (/\s/.test(s[i + 1] || ' ') || i === s.length - 1)) { push(); continue; }
    if (!depth && ch === ',' && VERB.test(s.slice(i + 1).trim())) { push(); continue; }
    cur += ch;
  }
  push();
  return out.flatMap(c => c.split(/,?\s+(?:and then|then)\s+(?=\S)/i)).map(c => clean(clean(c).replace(/^(?:and then|then)\b\s*/i, ''))).filter(Boolean);
}

// Not something to do: where the beat starts, what's already on screen, what not to do.
const NOT_AN_ACTION = /^(start(?:s)? (?:on|in|at)\b|don'?t click|do not click|stay on|after (?:your|the) last line|over the\b|title card|nothing to click|no click|the live answer|the landing\b|the highlight\b|close the step lists|installed for\b|.*\b(?:is|are) (?:on screen|already on)\b)/i;
const WAITS = /\b(streams? in|answer arrives|arrives|saves the skill|saves it|the skill runs|runs\b|comes up)\b/i;
const LIT = /^(.*?)\s+(?:lit|highlighted)\b(.*)$/i;
const COMPOSER_WORDS = /^(?:the\s+)?(?:message|prompt|chat|ask|compose|composer|copilot)?\s*(?:box|field|composer)$/i;
const TITLE_WORDS = /^(?:the\s+)?(?:page\s+)?(?:title|heading)$/i;

// What the presenter's words ask for: { app }, { click }, { hover }, { type, into }, { prompt }, { key }, { wait },
// { scroll }, { close }, { add }, { fillEach }, { hint } (a focus target), { note }. Bare names are clicks in a chain
// ("A › B"), maybe-clicks in Do text (only if the screen has that control) and focus targets in a Screen column.
export function intentsOf(text, ctx, opts = {}) {
  const out = [];
  for (const raw of clausesOf(text)) {
    const add = o => out.push({ ...o, from: o.from || raw });
    // Where the demo starts: its app, nothing to click.
    if (/^start(?:s)? (?:on|in|at)\b/i.test(raw)) { const a = appNamed(raw.replace(/^start(?:s)? (?:on|in|at)\s+/i, ''), ctx); if (a) add({ app: a.app.id }); continue; }
    const parts = splitChain(raw);
    if (parts.length > 1) {
      const chain = parts.filter(p => !p.fillEach).map(p => cleanTarget(p.text));
      parts.forEach((p, i) => {
        if (p.fillEach) return add({ fillEach: true });
        const a = i === 0 ? appNamed(p.text, ctx) : null;
        if (a && !a.rest) return add({ app: a.app.id });
        for (const x of intentsOf(a ? a.rest : p.text, ctx, { ...opts, descriptive: false, bare: opts.descriptive ? 'maybe' : 'click' })) add({ ...x, from: raw, ...(i === 0 && !a && (x.click || x.hover) ? { chain } : {}) });
        if (a && !out.some(x => x.app)) out.splice(out.length - 1, 0, { app: a.app.id, from: raw });
        if (p.desc) for (const x of intentsOf(p.desc, ctx, { descriptive: true })) add({ ...x, from: raw });
      });
      continue;
    }
    let c = raw, m;
    // ⌥ keys (Ctrl+Alt on Windows): an app's key switches to it, ⌥P types the prompt, ⌥F is a focus point.
    const keyRe = /(?:⌥|\b(?:ctrl\s*\+\s*alt|option)\s*\+\s*)([A-Z0-9])(?![a-z])/gi;
    let typedKey = false, typedP = false;
    for (const k of c.matchAll(keyRe)) {
      const key = k[1].toUpperCase();
      const app = ctx.apps.find(a => a.key && a.key.toUpperCase() === key);
      if (key === 'P') {
        typedKey = typedP = true;
        const said = /\btype\s+(.+?)\s*\(\s*$/i.exec(c.slice(0, k.index));
        add(/\bin each (box|field)\b/i.test(c) ? { fillEach: true } : { prompt: promptRef(c, ctx) || (said ? { n: null, label: '', text: unq(clean(said[1])) } : { n: null, label: '', text: null }) });
      }
      else if (key === 'F') { const t = c.slice(k.index + k[0].length).replace(/^\s*:\s*/, ''); if (t) add({ hint: hintFrom(t) }); typedKey = true; }
      else if (app) add({ app: app.id });
      // ⌥0–⌥9 in a script for presenting the replica: where that beat starts (the player's jump, flow.beats[n]).
      else if (/^\d$/.test(key)) add({ beat: +key });
    }
    c = c.replace(keyRe, ' ').replace(/\(\s*(?:prompt\s*\d+|the \w+ prompt|the prompt)\s*\)/ig, '').replace(/\(\s*(?:or\s*)?\)/g, '').replace(/^[\s,:]+|[\s,:.]+$/g, '').trim();
    if (typedP && !/\b(enter|send)\b/i.test(c)) { const tail = /,\s*([^,]+)$/.exec(c); if (tail) for (const x of intentsOf(tail[1], ctx, opts)) add(x); continue; }
    if (typedKey && !/\b(enter|send)\b/i.test(c)) continue;
    if (!c || /^(?:press|or|then|and|and then)$/i.test(c)) continue;
    const named = appNamed(c, ctx);
    if (named) { add({ app: named.app.id }); c = named.rest; if (!c) continue; }
    if (NOT_AN_ACTION.test(c)) { for (const h of namesIn(c)) add({ hint: h }); continue; }
    if (/^(?:press\s+)?(?:enter|return)$/i.test(c) || /^(?:and\s+)?send(?: it)?$/i.test(c) || typedKey) { add({ key: 'Enter' }); continue; }
    if (/^(?:press\s+)?(?:esc|escape)\b/i.test(c)) { add({ key: 'Escape' }); continue; }
    if ((m = /^(?:new task|new chat|start a new (?:task|chat)|new)\b[,:]?\s*(.*)$/i.exec(c))) { add({ click: 'New' }); if (m[1]) for (const x of intentsOf(m[1], ctx, opts)) add(x); continue; }
    if ((m = /^(?:type|enter|ask|send)?\s*(?:prompt\s*(\d+)|the (\w+) prompt)\b(.*)$/i.exec(c))) {
      add({ prompt: promptRef(c, ctx) || { n: +m[1] || null, label: m[2] || '', text: null } });
      const rest = clean(m[3].replace(/^[\s,;:.]+/, ''));
      if (/^(?:and\s+)?(send|enter)\b/i.test(rest)) add({ key: 'Enter' });
      else if (rest && !/^,?\s*with\b/i.test(rest)) for (const x of intentsOf(rest, ctx, opts)) add(x);
      continue;
    }
    if ((m = /^hover(?: over| on)?\s+(.+)$/i.exec(c))) { add({ hover: cleanTarget(m[1]), card: /\b(card|hover text|tooltip)\b|for its\b/i.test(m[1]) }); continue; }
    if ((m = /^type\s+(.+?)(?:\s+(?:in|into)\s+(?:the\s+)?(.+?))?$/i.exec(c))) { add({ type: unq(quoted(m[1])[0] || m[1]), into: m[2] ? cleanTarget(m[2]) : null }); continue; }
    if ((m = /^search(?:ed)?(?: for)?\s+(.+)$/i.exec(c))) { const [what, ...rest] = m[1].split(/:\s*/); add({ type: unq(quoted(what)[0] || what), into: 'search' }); add({ key: 'Enter' }); if (rest.length) for (const h of namesIn(rest.join(': '), true)) add({ hint: h }); continue; }
    if ((m = /^scroll\s*(down|up)?(?:\s+to)?\s*(.*)$/i.exec(c))) {
      add({ scroll: m[1] ? m[1].toLowerCase() : /\btop\b/i.test(m[2]) ? 'up' : 'down' });
      if (m[2] && !/^(the )?(top|bottom|catalog|list|page)\b/i.test(m[2])) for (const t of m[2].split(/\s*,\s*/)) add({ hint: { texts: [cleanTarget(t)], loose: true, weak: true } });
      continue;
    }
    if ((m = /^(?:point(?: at| to)?|rest on)\s+(.+)$/i.exec(c))) { add({ hint: { ...hintFrom(m[1]), ...(/^point/i.test(c) ? { mark: 'arrow' } : {}) } }); continue; }
    if (/^close\s+(it|that|this|the .+)$/i.test(c)) { add({ close: true }); continue; }
    if ((m = /^(?:click|open|select|choose|tap|pick)(?: on)?\s+(.+)$/i.exec(c))) {
      const close = /\s+and close it$/i.test(m[1]);
      let what = m[1].replace(/\s+and close it$/i, '');
      // "Open Supply chain disruption: publisher, connections": the name, then what to look at.
      const desc = /^([^:“"]+?)\s*:\s*(.+)$/.exec(what);
      if (desc) { what = desc[1]; for (const h of namesIn(desc[2], true)) add({ hint: h }); }
      const card = /\bon the (.+?) card\b/i.exec(what);
      // The card a click is on is what the line points at ("Click Approve on the Copy file card").
      if (card) add({ hint: { texts: [card[1]], around: 'card' } });
      const t = timesOf(what);
      if (PRONOUN.test(cleanTarget(t.name))) { add({ unclear: c }); continue; }
      for (let k = 0; k < t.n; k++) add({ click: cleanTarget(t.name), card: card ? card[1] : null, role: roleNoun(t.name) });
      if (close) add({ close: true });
      continue;
    }
    if (opts.bare !== 'click' && (m = /^add\s+(?!to\b|content\b|endorsement\b)(.+)$/i.exec(c))) { add({ add: cleanTarget(m[1]) }); continue; }
    if ((m = LIT.exec(c))) { add({ hint: hintFrom(m[1]) }); const more = /then\s+(.+)/i.exec(m[2] || ''); if (more) add({ hint: hintFrom(more[1]) }); continue; }
    if (WAITS.test(c)) { add({ wait: true }); continue; }
    const d = /^([^:“"]+?)\s*:\s*(.+)$/.exec(c);
    const name = d ? d[1] : c;
    if (opts.bare !== 'click' && /^the\s/i.test(name)) { for (const h of namesIn(d ? d[2] : c, !!d)) add({ hint: h }); continue; }
    const t = timesOf(name);
    if (opts.bare === 'click') for (let k = 0; k < t.n; k++) add({ click: cleanTarget(t.name), role: roleNoun(t.name) });
    else if (opts.bare === 'maybe') { add({ click: cleanTarget(name), role: roleNoun(name), maybe: true }); for (const h of namesIn(name)) add({ hint: h }); }
    else if (opts.descriptive) { for (const h of namesIn(c)) add({ hint: h }); continue; }
    else for (let k = 0; k < t.n; k++) add({ click: cleanTarget(t.name), role: roleNoun(t.name), maybe: true });
    if (d) for (const h of namesIn(d[2], true)) add({ hint: h });
  }
  return out;
}
// "VIP Lounge + twice": the name, and how many times.
const TIMES = { once: 1, twice: 2, 'two times': 2, thrice: 3, 'three times': 3 };
function timesOf(t) {
  const m = /^(.*?)\s+(once|twice|thrice|two times|three times|(\d+)\s*(?:times|x))$/i.exec(clean(t));
  return m ? { name: m[1], n: Math.min(5, TIMES[m[2].toLowerCase()] || +m[3] || 1) } : { name: t, n: 1 };
}
const PRONOUN = /^(?:it|them|this|that|these|those|here|there|one)$/i;
function splitChain(s) {
  return String(s).split(/\s*(?:›|»|\s>\s)\s*/).map(x => clean(x)).filter(Boolean).map(x => {
    if (/in each (box|field)/i.test(x)) return { fillEach: true };
    const d = /^([^:“"]+?)\s*:\s*(.+)$/.exec(x);
    return d ? { text: d[1], desc: d[2] } : { text: x };
  });
}
// A control's name as a script says it: "the Users tab" → "Users", "Approve on the Copy file card" → "Approve",
// "Plugins in the sidebar" → "Plugins", "Add to business plugin (17 → 18)" → "Add to business plugin".
export function cleanTarget(t) {
  t = unq(t).replace(/\s*\([^)]*\)\s*/g, ' ').replace(/[.:]$/, '').trim();
  t = t.replace(/^(?:the\s+)?[▾▼▸⋯…⟳↻]\s+(?:next to|beside|by)\s+/i, '');
  if (/^[⋯…]$/.test(t)) return 'More';
  t = t.replace(/\s+[+−-]$/, '').trim();
  // What the click is for isn't its name: "the open issue, Prevent expiry, to jump to its comment" → "Prevent expiry".
  t = t.replace(/,?\s+to\s+(?:jump|open|show|see|re-request|go|get|start|close|expand|collapse|view|read|reach|check)\b.*$/i, '').replace(/^(?:the\s+)?(?:open|closed)?\s*(?:issue|item|row|link|comment),\s*(.+?),?$/i, '$1').trim();
  // "Show more for Sales": the Show more control (what it shows is what the line is about).
  const more = /^((?:show|see|view) (?:more|all|less))\s+(?:for|to see|to show|of)\b/i.exec(t);
  if (more) return more[1];
  t = t.replace(/\s+(?:in|on|from|under|at)\s+the\s+(?:[\w-]+\s+){0,3}(?:sidebar|pane|panel|card|cards|list|menu|reply|answer|page|header|top|bottom|side panel|review)\b.*$/i, '');
  t = t.replace(/^(?:the|a|an|its|her|his|my|our)\s+(?=\S+\s+\S)/i, '').replace(/^(?:the|a|an)\s+/i, '').replace(/\s+(?:button|tab|link|row|card|chip|menu item|item|option|switch|toggle)$/i, '').trim();
  return t;
}
const roleNoun = t => { const m = /\b(row|tab|link|button|option|item)\s*$/i.exec(clean(String(t).replace(/\s*\([^)]*\)\s*/g, ' '))); return m ? ({ item: 'listitem' }[m[1].toLowerCase()] || m[1].toLowerCase()) : null; };
function hintFrom(t) {
  const q = quoted(t);
  if (q.length) return { texts: q };
  const parts = String(t).replace(/\b(one by one|as named|each lit as named|with the label.*$)/gi, '').split(/\s*(?:,|\band\b|\bthen\b|\+|;)\s*/).map(cleanTarget).filter(x => x && x.split(' ').length <= 8);
  return { texts: parts.length ? parts : [cleanTarget(t)], loose: true };
}
// Names a description mentions, as focus targets to look for: quoted words, and capitalised names.
function namesIn(t, all = false) {
  const q = quoted(t);
  if (q.length) return q.map(x => ({ texts: [x] }));
  // "Our process, Our numbers, Our people": each a name.
  if (all) { const list = String(t).split(/\s*(?:,|;|\band\b)\s*/).map(cleanTarget).filter(x => x && x.split(' ').length <= 6 && /^[A-Z0-9$]/.test(x)); if (list.length > 1) return list.map(x => ({ texts: [x], loose: true })); }
  const names = [...String(t).matchAll(/(?:\$?\d[\d,.]*%?|[A-Z][\w’'&-]*)(?:\s+(?:of|and|&|for|to)?\s*(?:[A-Z][\w’'&-]*|\d[\w,.]*))*/g)].map(m => m[0].trim())
    .filter(n => (all || n.split(/\s+/).length > 1 || /\d/.test(n)) && !/^(The|Then|This|That|Click|Open|Type|Press|Hover|Scroll|Point|Show|Rest|Do|Say|Screen)\b/.test(n));
  return names.map(n => ({ texts: [n], loose: true }));
}
function promptRef(c, ctx) {
  let m;
  const P = ctx.prompts || [];
  if ((m = /prompt\s*(\d+)/i.exec(c))) { const n = +m[1]; const p = P.find(x => x.n === n) || P[n - 1]; return { n, label: p ? p.label : '', text: p ? p.text : null }; }
  if ((m = /the (\w+) prompt/i.exec(c))) { const p = P.find(x => norm(x.label) === norm(m[1])); return { n: p ? p.n : null, label: m[1], text: p ? p.text : null }; }
  const q = quoted(c);
  if (q.length && q[0].length > 12) return { n: null, label: '', text: q[0] };
  return null;
}
// An app named at the start of a clause: its title, the title without "Microsoft (365)", its id, or a pack's names.
function appNamed(c, ctx) {
  for (const a of ctx.apps) {
    const names = [...new Set([a.title, (a.title || '').replace(/^Microsoft (?:365 )?/i, ''), a.id, ...(a.names || [])].filter(x => x && x.length > 2))].sort((x, y) => y.length - x.length);
    for (const n of names) {
      const re = new RegExp(`^(?:then\\s+|back in\\s+|in\\s+|go to\\s+|switch to\\s+)?(?:the\\s+)?${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s+(?:portal|app|tab))?(?:\\s*\\([^)]*\\))?\\s*(?:[:›,]\\s*|$)(.*)$`, 'i');
      const m = re.exec(c);
      if (m) return { app: a, rest: clean(m[1]) };
    }
  }
  return null;
}

// ---- what a step writes ------------------------------------------------------------------------------------------
const WRITE_WORD = /\b(certif\w*|endorse\w*|promote|publish|enable|disable|install|uninstall|assign|share|invite|upload|rename|archive|delete|remove|approve|reject|save|send|submit|post|reply|create|add)\b/i;
export function writeOf(step, el, at = {}) {
  if (step.kind === 'press' && step.key === 'Enter') {
    if (!el || !risk(step, null, el)) return null;
    const p = at.prompt;
    return { kind: 'send', what: `sends ${p && p.n ? `prompt ${p.n}${p.label ? ` (${p.label})` : ''}` : p && p.label ? `the ${p.label} prompt` : p && p.text ? `"${p.text.slice(0, 48)}…"` : 'what was typed'} in ${at.appTitle || 'the app'}` };
  }
  if (step.kind !== 'click') return null;
  const name = (el && el.name) || step.target || '';
  if (el && /^(switch|checkbox|radio)$/.test(el.role)) return { kind: 'setting', what: `turns "${name}" ${el.checked ? 'off' : 'on'}` };
  // Opening something isn't a write: a menu (its control expands), a dialog or picker (Escape closes it).
  const after = at.nextScreen && at.nextScreen.controls.find(c => c.name === name);
  if (after && after.expanded === true || at.next && at.next.esc) return null;
  if (!(risk(step, el) || WRITE_WORD.test(name))) return null;
  const verb = (WRITE_WORD.exec(name) || [, 'change'])[1].toLowerCase();
  const kind = /^(certif|endorse|promote)/.test(verb) ? 'endorse' : /^(save|create|approve)/.test(verb) ? 'save' : /^add/.test(verb) ? 'add' : /^(send|submit|post|reply|publish|share|invite)/.test(verb) ? 'send' : /^(delete|remove|archive|uninstall|reject)/.test(verb) ? 'delete' : 'change';
  const object = /:\s*(.+)$/.exec(name);
  const what = kind === 'endorse' ? `endorses it: "${name}"`
    : kind === 'add' ? `adds ${at.picked ? `"${at.picked}"` : 'it'} ("${name}")`
    : kind === 'save' ? `${verb === 'approve' ? 'approves' : 'saves'} ${object ? `"${object[1]}"` : 'it'} ("${name}")`
    : `${verb}s ("${name}")`;
  return { kind, what };
}

// A pack's write for a step: by the control's name, its visible words (before a ":"), or its test id.
// A step the app's pack says only looks like a change (its safe list: an opener for a picker or a menu): the packs'
// own safeFor() when they have it, by the step's name and the part of it before ":".
export function packSafe(packs, pack, step, field, el) {
  if (!packs || !pack || !(pack.safe || []).length) return null;
  const name = String(step.target || '');
  if (packs.safeFor) { for (const t of [step, { ...step, target: name.split(':')[0].trim() }]) { const s = packs.safeFor(pack, t, field); if (s) return s; } return null; }
  return packs.writeFor ? packWrite(packs.writeFor, { ...pack, writes: pack.safe }, step, field, el) : null;
}
export function packWrite(writeFor, pack, step, field, el) {
  const name = String(step.target || '');
  const tries = [step, { ...step, target: name.split(':')[0].trim() }, { ...step, kind: step.kind === 'click' && el && /^(switch|checkbox)$/.test(el.role) ? 'click' : step.kind }];
  for (const t of tries) { const w = writeFor(pack, t, field); if (w) return w; }
  if (el && el.testid) return (pack.writes || []).find(w => w.on && w.on.sel && w.on.kind === step.kind && new RegExp(`data-testid\\^?="${el.testid.replace(/[-\d]+$/, '')}`).test(w.on.sel)) || null;
  return null;
}

// A recorded move that would change something (send, save, approve, add).
const writes = m => m.steps.some((s, i) => {
  if (s.kind !== 'press') return !!writeOf(s, m.control || null, {});
  // Enter sends what was typed, except in a search box (it only filters).
  const typed = m.steps.slice(0, i).reverse().find(x => x.kind === 'type'), field = (typed && typed.target) || (m.control && m.control.name) || '';
  return s.key === 'Enter' && !/search|filter|find/i.test(field);
});

// ---- the walk: intents to grounded steps, then each line's focus -------------------------------------------------
const APPROVE = /^(approve|save|confirm|allow|ok|yes|continue|submit|done|create)\b/i;
// The button that does what an approval verb says, when the screen words it differently: on the card the script names
// first, buttons before other controls.
function approvalAlt(sc, target, card) {
  if (!sc || !APPROVE.test(target || '')) return null;
  const list = sc.controls.filter(c => APPROVE.test(c.name) && !c.disabled && norm(c.name) !== norm(target));
  const rank = c => (card && norm(c.name).includes(norm(card)) ? 2 : 0) + (c.role === 'button' ? 1 : 0);
  return list.sort((a, b) => rank(b) - rank(a))[0] || null;
}
const PICKED = /^(option|listitem|row|gridcell|treeitem|menuitem)$/;

// open: the plan opens where the demo starts (off for the draft Copilot gets: what her words alone give).
export function planFromTrack(track, { walker = null, apps = [], title, trace = null, packs = null, open = true } = {}) {
  apps = (walker ? walker.apps : apps).map(a => ({ ...a, names: [...(a.names || []), ...(((packs || {}).forApp || {})[a.id] || {}).names || []] }));
  const ctx = { apps, prompts: track.prompts || [] };
  const flags = [], seen = new Set();
  const flag = (kind, text, where = {}) => { if (!seen.has(kind + text)) { seen.add(kind + text); flags.push({ kind, text, ...where }); } };
  const S = { cur: {}, typed: {}, field: {}, picked: null, prompt: null };
  if (walker) for (const a of apps) S.cur[a.id] = walker.start(a.id);
  S.app = walker && (walker.flow.beats || [])[0] ? walker.flow.beats[0].active : (apps[0] || {}).id;
  const at = () => S.cur[S.app];
  const scr = id => walker && id ? walker.screen(id) : null;
  const appTitle = id => (apps.find(a => a.id === id) || {}).title || id;
  const plan = { title: title || track.title || 'Demo', beats: [] };
  const lines = [];
  let started = false, curLine = null;
  // The screens a write of the plan landed on: a way the rules add never does that write again.
  const wrote = new Set();
  const again = m => wrote.has(m.to) && writes(m);

  for (const [bi, tb] of track.beats.entries()) {
    const beat = { title: tb.title, steps: [], say: [], lines: [] };
    plan.beats.push(beat);
    curLine = `${bi + 1}.1`;
    const where = l => ({ beat: tb.n, line: l ? l.id : null, at: curLine });
    const append = (step, from) => {
      if (from && !step.script && norm(from) !== norm(formatStep(step))) step.script = clean(from).slice(0, 160);
      step.text = formatStep(step);
      step.line = curLine;
      beat.steps.push(step);
      started = true;
      return step;
    };
    // One step, on the screen it's on: the product's control, what the recording did around it, where it lands, what
    // it writes, and what differs from the script.
    const promptOf = value => promptFor(track.prompts, value);
    const push = (s, from, line, opts = {}) => {
      const step = { ...s }, nf = flags.length;
      // A step left out: what was said about where it is goes with it.
      const drop = () => { for (let i = flags.length - 1; i >= nf; i--) if (flags[i].kind === 'order') { seen.delete(flags[i].kind + flags[i].text); flags.splice(i, 1); } return null; };
      if (step.kind === 'app') {
        if (step.app === S.app && started) return null;
        S.app = step.app;
        if (walker && at()) step.lands = { screen: at(), text: landText(null, scr(at())) };
        return append(step, from);
      }
      if (!walker || step.kind === 'manual' || step.kind === 'wait' || step.kind === 'scroll') return append(step, from);
      let id = at(), sc = scr(id);
      if ((step.kind === 'click' || step.kind === 'hover') && COMPOSER_WORDS.test(step.target)) { const b = composer(sc.controls); if (b) step.target = b.name; }
      if ((step.kind === 'click' || step.kind === 'hover') && TITLE_WORDS.test(step.target) && sc.headings[0]) { step.target = sc.headings[0]; step.title = true; }
      if (step.kind === 'type' && !step.target && S.field[S.app] && walker.control(sc, S.field[S.app], 'field')) step.target = S.field[S.app];
      // A step that could write isn't done by a walker: offline, the recording says where it went; live, mapping stops.
      const go = (st2) => { const guess = writeOf(st2, null, {}); if (!guess) return walker.step(id, st2, S.typed[S.app] || ''); if (walker.recorded) return walker.recorded(id, st2, S.typed[S.app] || ''); throw Object.assign(new Error('stops before a write'), { code: 'WRITE' }); };
      let r = go({ ...step, strict: true, role: opts.role });
      if ((step.kind === 'click' || step.kind === 'hover') && !r.control && !r.recorded && !step.title) {
        const strong = (sc2, name, min = 50) => { const h = walker.control(sc2, name); return h && h.score >= min; };
        // To a screen with the control by its own name before one with a name like it ("Add to business plugin", once
        // the form is filled, not "Add business plugin" one screen back).
        const b = !opts.maybe ? walker.bridge(id, s2 => strong(s2, step.target, 100), 10, again) || walker.bridge(id, s2 => strong(s2, step.target), 10, again) : null;
        const other = !b && !walker.find(S.app, step.target).length ? apps.find(a => a.id !== S.app && strong(scr(S.cur[a.id]), step.target, 60)) : null;
        if (other) { push({ kind: 'app', app: other.id }, from, line); id = at(); sc = scr(id); r = go(step); }
        else if (b) {
          flag('added', `Before "${step.target}", ${b.steps.length === 1 ? 'a step' : `${b.steps.length} steps`} your script leaves out, as recorded: ${b.steps.map(formatStep).join(' → ')}`, where(line));
          for (const bs of b.steps) push({ kind: bs.kind, target: bs.target, value: bs.value, key: bs.key }, '(not in your script: as recorded)', line);
          id = at(); sc = scr(id); r = go(step);
        }
        if (!r.control && !r.recorded) {
          if (opts.maybe) return null;
          // "Approve" where the product says "Save" (or the other way round): the card's own button, said differently.
          const alt = approvalAlt(sc, step.target, opts.card);
          if (alt) {
            step.differs = `the product shows "${alt.name}" here, not "${step.target}"${opts.card ? ` (your script: the "${opts.card}" card)` : ''}`;
            flag('differs', cap(step.differs), where(line));
            step.target = alt.name;
            r = go(step);
          }
        }
        if (!r.control && !r.recorded && !step.differs) {
          const near = walker.control(sc, step.target);
          if (near && near.score >= 30 && step.kind === 'click') {
            step.differs = `there's no "${step.target}" here; the closest is "${near.el.name}"`;
            flag('differs', `${cap(formatStep(step))}: ${step.differs}`, where(line));
            step.target = near.el.name;
            r = go(step);
          }
        }
        if (!r.control && !r.recorded && !step.differs) {
          const elsewhere = walker.find(S.app, step.target);
          step.differs = elsewhere.length ? `"${step.target}" isn't on this screen; it's on ${elsewhere.slice(0, 2).join(', ')}` : `there's no "${step.target}" in ${appTitle(S.app)}'s captured screens`;
          flag(elsewhere.length ? 'order' : 'differs', `${cap(formatStep(step))}: ${step.differs}`, where(line));
        }
      }
      if ((step.kind === 'click' || step.kind === 'hover') && !r.control && r.recorded) {
        // The recording has it, the product's own screen doesn't (a part composed into the replica).
        const alt = approvalAlt(sc, step.target, opts.card);
        const card = opts.card ? ` (your script: the "${opts.card}" card)` : '';
        step.differs = alt ? `the product shows "${alt.name}" here, not "${step.target}"${card}` : `"${step.target}" isn't on the product's screen (the replica has it)`;
        flag('differs', `${cap(step.differs)}`, where(line));
        if (alt) { step.target = alt.name; r = { ...r, control: alt }; }
      } else if (r.control && r.control.name && norm(r.control.name) !== norm(step.target) && step.kind !== 'type') step.target = r.control.name;
      if (step.kind === 'type') { S.typed[S.app] = step.value; if (r.control) step.target = S.field[S.app] = r.control.name; }
      // The product's own approve button ("Save: Save skill") where the recording clicked the replica's ("Approve"):
      // it goes where that went.
      if (step.kind === 'click' && r.control && (!r.to || r.to === id) && APPROVE.test(step.target)) {
        const ms = walker.moves(id).filter(m => m.steps.length === 1 && m.steps[0].kind === 'click' && APPROVE.test(m.steps[0].target));
        if (ms.length === 1) r = { ...r, to: ms[0].to, recorded: ms[0].recorded || ms[0].steps[0].target };
      }
      const prev = beat.steps[beat.steps.length - 1];
      if (step.kind === 'click' && prev && prev.kind === 'click' && prev.target === step.target && (prev.lands || {}).screen === id && r.to === id) return drop();
      if (step.kind === 'click' && r.control && PICKED.test(r.control.role)) S.picked = titleOf(sc, cleanTarget(s.target).length > 2 ? cleanTarget(s.target) : r.control.name);
      const to = r.to || id;
      const field = step.kind === 'press' ? ((S.field[S.app] && walker.control(sc, S.field[S.app], 'field')) || {}).el || composer(sc.controls) : r.control;
      let w = writeOf(step, field, { next: to !== id ? walker.flow.states[to] : null, nextScreen: to !== id ? scr(to) : null, picked: S.picked, prompt: S.prompt, appTitle: appTitle(S.app) });
      // The app's pack names the write when it knows it (packages/apps writes): its id goes with it, for the reset.
      const pack = ((packs || {}).forApp || {})[S.app];
      const pw = pack && packs.writeFor ? packWrite(packs.writeFor, pack, step, field, r.control) : null;
      // What the pack knows only looks like a change ("Add content to…" opens a picker): no write, no asking.
      const safe = !pw ? packSafe(packs, pack, step, field, r.control) : null;
      if (safe) { step.safe = `${safe.what.replace(/\.$/, '')} · ${pack.id}:${safe.id}`; w = null; }
      if (pw && !w) step.writes = `${pw.what.split(/[;:(]/)[0].trim()} · ${pack.id}:${pw.id}`;
      else if (w) step.writes = pw ? `${w.what} · ${pack.id}:${pw.id}` : w.what;
      if (w || pw) { S.wrote = { kind: w ? w.kind : 'change', picked: S.picked, target: step.target }; if (r.to) wrote.add(r.to); }
      if (to !== id) step.lands = { screen: to, text: landText(sc, scr(to)) || landText(null, scr(to)) };
      // The same write again right after it, going nowhere (a proposal that says it twice): once. "Twice" in her script
      // goes somewhere each time, and stays.
      const last = beat.steps[beat.steps.length - 1];
      if (step.writes && last && last.writes && formatStep(last) === formatStep(step) && to === id) return drop();
      S.cur[S.app] = to;
      const done = append(step, from);
      if (step.kind === 'press' && r.stream) append({ kind: 'wait' }, null);
      return done;
    };
    // A Do text, walked: returns the screens it passed and the focus targets it names.
    const run = (text, line, opts = {}) => {
      const span = [], hints = [], clicked = [];
      const mark = () => { const k = `${S.app}:${at()}`; if (span[span.length - 1] !== k) span.push(k); };
      mark();
      // A line's steps as Copilot proposed them (script-plan.mjs) come already read; her own words are read here.
      for (const it of Array.isArray(text) ? text : intentsOf(text, ctx, opts)) {
        if (opts.only && !opts.only(it)) continue;
        if (it.manual) { push({ kind: 'manual', what: it.manual }, it.from, line); continue; }
        if (it.note) continue;
        if (it.unclear) { flag('unclear', `"${it.unclear}": which control? Name it in your script and the plan follows it`, where(line)); continue; }
        if (it.hint) { hints.push(it.hint.around === 'card' && walker ? { ...it.hint, on: at() } : it.hint); continue; }
        if (it.app) { push({ kind: 'app', app: it.app }, it.from, line); mark(); continue; }
        if (it.beat != null) {
          // The beat's key: its app, on the screen the beat starts on, the recorded way there when it's somewhere else.
          const fb = walker && (walker.flow.beats || [])[it.beat];
          const app2 = fb && fb.active, to = app2 && (fb.states || {})[app2];
          if (!to) continue;
          if (app2 !== S.app || !started) { push({ kind: 'app', app: app2 }, it.from, line); mark(); }
          if (S.cur[app2] !== to) {
            const b = walker.bridge(S.cur[app2], (s2, id2) => id2 === to, 8, again);
            if (b && b.steps.length) {
              flag('added', `Beat key ⌥${it.beat} starts on "${to}": ${b.steps.length === 1 ? 'a step' : `${b.steps.length} steps`} your script leaves out, as recorded: ${b.steps.map(formatStep).join(' → ')}`, where(line));
              for (const bs of b.steps) { push({ kind: bs.kind, target: bs.target, value: bs.value, key: bs.key }, '(not in your script: as recorded)', line); mark(); }
            }
            if (S.cur[app2] !== to) { S.cur[app2] = to; const last = beat.steps[beat.steps.length - 1]; if (last && last.kind === 'app' && last.app === app2) last.lands = { screen: to, text: landText(null, scr(to)) }; mark(); }
          }
          continue;
        }
        if (it.wait) {
          const last = beat.steps[beat.steps.length - 1];
          if (last && last.kind === 'type' && last === S.unsent) { push({ kind: 'press', key: 'Enter' }, it.from, line); S.unsent = null; mark(); }
          const now = beat.steps[beat.steps.length - 1];
          if (now && now.kind !== 'wait' && (now.kind === 'press' || now.writes)) push({ kind: 'wait' }, it.from, line);
          continue;
        }
        if (it.scroll) { push({ kind: 'scroll', dir: it.scroll }, it.from, line); continue; }
        if (it.close) {
          const sc = scr(at());
          const c = sc && sc.controls.find(x => /^close\b/i.test(x.name) && !/workspace|sidebar|navigation/i.test(x.name));
          push(c ? { kind: 'click', target: c.name } : { kind: 'press', key: 'Escape' }, it.from, line);
          mark();
          continue;
        }
        if (it.prompt) {
          const sc = scr(at());
          const box = sc ? composer(sc.controls) || sc.controls.find(c => c.editable) : null;
          const fill = sc && (sc.fills.find(f => box && norm(f.name) === norm(box.name)) || sc.fills[0]);
          const p = it.prompt, text = p.text || (fill && fill.value) || null;
          S.prompt = { ...p, text: text || '' };
          if (!text) { flag('prompt', `I don't have the words of ${p.n ? `prompt ${p.n}` : 'this prompt'}: add a "Prompts" list to your script`, where(line)); push({ kind: 'manual', what: `type ${p.n ? `prompt ${p.n}` : 'the prompt'}` }, it.from, line); continue; }
          if (fill && fill.value && norm(fill.value) !== norm(text)) flag('differs', `${p.n ? `Prompt ${p.n}` : 'This prompt'} isn't what was recorded here ("${fill.value.slice(0, 70)}…"): it plays that answer`, where(line));
          const typedPrompt = push({ kind: 'type', value: text, target: box ? box.name : null }, it.from, line);
          if (typedPrompt) S.unsent = typedPrompt;
          mark();
          continue;
        }
        if (it.fillEach) {
          const sc = scr(at());
          if (sc && sc.fills.length) for (const f of sc.fills) { push({ kind: 'type', value: f.value, target: f.name || null }, it.from, line); mark(); }
          else { flag('words', 'Your script says to type into each box: what goes in them?', where(line)); push({ kind: 'manual', what: 'type into each box' }, it.from, line); }
          continue;
        }
        if (it.type !== undefined) {
          if (it.into && it.into !== 'search' && walker && !walker.control(scr(at()), it.into, 'field')) {
            const other = apps.find(a => a.id !== S.app && walker.control(scr(S.cur[a.id]), it.into, 'field') && walker.control(scr(S.cur[a.id]), it.into, 'field').score >= 60);
            if (other) { push({ kind: 'app', app: other.id }, it.from, line); mark(); }
          }
          const sc = scr(at());
          const box = sc && it.into ? (walker.control(sc, it.into === 'search' ? 'search' : it.into, 'field') || {}).el || (it.into === 'search' ? searchBox(sc.controls) : null) : null;
          // "Type in the field" with no words: what was recorded in it.
          let value = it.type;
          if (value == null && walker) { const ms = walker.moves(at()).filter(m => m.steps[0].kind === 'type'); const m = ms.find(m => box && norm(m.steps[0].target || '') === norm(box.name)) || ms[0]; value = m ? m.steps[0].value : null; }
          if (value == null) { push({ kind: 'manual', what: `type into ${it.into ? `"${it.into}"` : 'the field'}` }, it.from, line); continue; }
          // The words of one of her prompts: that prompt (it's sent, and the plan says which).
          const p = promptOf(value);
          const typed = push({ kind: 'type', value, target: box ? box.name : it.into && it.into !== 'search' ? it.into : null }, it.from, line);
          if (typed) S.prompt = p ? { n: p.n, label: p.label || '', text: p.text } : null;
          if (p && typed) S.unsent = typed;
          mark();
          continue;
        }
        if (it.key) { push({ kind: 'press', key: it.key }, it.from, line); if (it.key === 'Enter') S.unsent = null; mark(); continue; }
        if (it.add && walker) {
          // "Add X": the recording's way to where X gets added (its Add button, a picker, the confirm), on a way that
          // names X. "Add worked examples to the docs" (a title) isn't the "Add one ticket" button.
          const xw = words(it.add);
          const names = st => { const nw = new Set(words(`${st.target || ''} ${st.value || ''}`)); return xw.length && xw.filter(x => nw.has(x)).length / xw.length >= 0.6; };
          const b = walker.bridge(at(), (s2, id2, m, path) => m && m.steps.some(x => x.kind === 'click' && /^add\b/i.test(x.target) && !(walker.flow.states[id2] || {}).esc) && path.steps.some(names), 12);
          if (b) {
            flag('added', `"Add ${it.add}" is ${b.steps.length} steps, as recorded: ${b.steps.map(formatStep).join(' → ')}`, where(line));
            for (const bs of b.steps) { if (bs.kind === 'click' && /^add\b/i.test(bs.target) && b.steps.indexOf(bs) === b.steps.length - 1) S.picked = it.add; S.wrote = null; const done = push({ kind: bs.kind, target: bs.target, value: bs.value, key: bs.key }, it.from, line); mark(); if (done && S.wrote && S.wrote.kind === 'add') hints.push({ texts: [it.add], around: 'row' }); }
          }
          else hints.push({ texts: [it.add], loose: true });
          continue;
        }
        if ((it.click || it.hover) && it.chain && walker) {
          const fits = a => { let id2 = S.cur[a], n = 0; for (const t of it.chain) { const h = walker.control(scr(id2), t, undefined, id2); if (!h || h.score < 50) break; n++; const r2 = walker.recorded(id2, { kind: 'click', target: t, strict: true }); if (r2.to) id2 = r2.to; } return n; };
          const here = fits(S.app), best = apps.map(a => ({ a: a.id, n: fits(a.id) })).sort((x, y) => y.n - x.n)[0];
          if (best && best.a !== S.app && best.n > here) { push({ kind: 'app', app: best.a }, it.from, line); mark(); }
        }
        if (it.click || it.hover) {
          const kind = it.hover ? 'hover' : 'click';
          S.wrote = null;
          const done = push({ kind, target: it.click || it.hover }, it.from, line, { maybe: it.maybe, card: it.card, role: it.role });
          if (done) clicked.push(done.target);
          // "Show more": the line is about what's behind it (the whole catalog), so point at it.
          if (done && kind === 'click' && /^(show|see|view) (more|all)\b|^expand\b/i.test(done.target)) hints.push({ texts: [done.target], mark: 'arrow', dir: 'w', at: true });
          // What a write changed is what the line shows: the row it added, the endorsement it set.
          if (done && S.wrote && S.wrote.kind === 'add' && S.wrote.picked) hints.push({ texts: [S.wrote.picked], around: 'row' });
          if (done && S.wrote && S.wrote.kind === 'endorse') hints.push({ texts: [cleanTarget(it.click || it.hover)] });
          if (done && it.hover && it.card) hints.push({ texts: [done.target], around: 'card', via: { kind: 'hover', target: done.target, text: `Hover over "${done.target}"` } });
          mark();
        }
      }
      // A prompt typed and never sent: in a demo it's sent (the next lines are about its answer).
      if (S.unsent && beat.steps[beat.steps.length - 1] === S.unsent) { push({ kind: 'press', key: 'Enter' }, '(sends the prompt)', line); mark(); }
      S.unsent = null;
      return { span, hints, clicked };
    };

    const beatRun = { span: [], hints: [], clicked: [] };
    // Copilot read this beat (its lines carry the steps it proposed): its words are already in those steps.
    const byModel = tb.lines.some(l => Array.isArray(l.intents));
    // Where the beat starts comes first: its Screen line's app or beat key ("pull request #4 (⌥7)"), then its Do.
    const nav = it => it.app || it.beat != null;
    if (tb.screen && !byModel) beatRun.span.push(...run(tb.screen, null, { descriptive: true, only: nav }).span);
    if (tb.do.length && !byModel) { const r = run(tb.do.filter(d => !d.level).map(d => d.text).join('. '), null); beatRun.span.push(...r.span); beatRun.hints.push(...r.hints); beatRun.clicked = r.clicked; }
    if (tb.screen && !tb.lines.some(l => l.do.length || l.screen)) { const r = run(tb.screen, null, { descriptive: true, only: it => !nav(it) && (!byModel || it.hint) }); beatRun.span.push(...r.span); beatRun.hints.push(...r.hints); }
    const given = assignHints(beatRun.hints, tb.lines);
    tb.lines.forEach((l, k) => {
      curLine = `${bi + 1}.${k + 1}`;
      const mine = Array.isArray(l.intents);
      // Her line names the prompt ("New task, prompt 3"): what Copilot types there is that one, not another of hers. With
      // no words for it in her script (no Prompts list), the one thing typed on the line is that prompt, by its number.
      if (mine && (l.do.length || l.screen)) {
        const said = [...intentsOf(l.do.join('. '), ctx), ...(l.screen ? intentsOf(l.screen, ctx, { descriptive: true }) : [])].filter(x => x.prompt).map(x => x.prompt);
        const named = [...new Map(said.map(p => [p.text ? norm(p.text) : `#${p.n}`, p])).values()];
        const np = named.length === 1 ? named[0] : null;
        const asPrompt = (it, prompt) => { const { type, into, ...rest } = it; return { ...rest, prompt }; };
        const typing = l.intents.filter(it => it.type != null || it.prompt);
        if (np && np.text) l = { ...l, intents: l.intents.map(it => { const p = it.prompt || (it.type != null && promptOf(it.type)); return p && p.text && norm(p.text) !== norm(np.text) ? asPrompt(it, np) : it; }) };
        else if (np && (np.n || np.label) && typing.length === 1 && typing[0].type && !/search/i.test(typing[0].into || '')) l = { ...l, intents: l.intents.map(it => it === typing[0] ? asPrompt(it, { ...np, text: it.type }) : it) };
      }
      const r1 = mine ? run(l.intents, l) : l.do.length ? run(l.do.join('. '), l) : { span: [], hints: [], clicked: [] };
      const r2 = l.screen ? run(l.screen, l, { descriptive: true, ...(mine ? { only: it => it.hint } : {}) }) : { span: [], hints: [], clicked: [] };
      // What Copilot says the line points at: names and headings on its screen, or her own words.
      const pts = (l.points || []).map(p => ({ texts: (Array.isArray(p.texts) ? p.texts : [p.text]).map(clean).filter(Boolean), loose: true, ...(p.screen ? { on: p.screen } : {}) })).filter(h => h.texts.length);
      // What her own Do words point at ("Approve on the Copy file card", "Point at Share") stays, with Copilot's steps.
      const said = mine && l.do.length ? intentsOf(l.do.join('. '), ctx).filter(x => x.hint).map(x => x.hint) : [];
      r1.hints.unshift(...pts, ...said);
      const own = (mine && l.intents.length) || l.do.length || l.screen;
      // A line whose Do starts with switching apps is said on the new app; one that starts on screen ("Seth's post
      // is on screen. Then ⌥C") starts where it is.
      const firstClause = clausesOf([...l.do, l.screen].filter(Boolean).join('. '))[0] || '';
      const switches = mine ? !!(l.intents[0] && l.intents[0].app) : /^(?:⌥|ctrl\s*\+\s*alt\s*\+\s*)[a-z0-9]\b/i.test(firstClause) && intentsOf(firstClause, ctx).some(x => x.app);
      const r1s = switches ? r1.span.slice(1) : r1.span;
      // In order, each screen where the line last is (after "close it", back on the page).
      const all = [...(own ? [] : beatRun.span), ...r1s, ...r2.span, `${S.app}:${at()}`];
      const span = all.filter((k, i) => all.lastIndexOf(k) === i);
      lines.push({ beat, idx: beat.lines.length, say: l.say, span, hints: [...r1.hints, ...r2.hints, ...(given[k] || [])], clicked: [...r1.clicked, ...r2.clicked, ...(own ? [] : beatRun.clicked || [])] });
      beat.lines.push({ text: l.say, focus: [] });
      beat.say.push(l.say);
    });
  }
  // The plan opens where the demo starts (the app its first beat shows) unless its first beat opens on an app of its
  // own: the first beat's lines are said there.
  const b0 = walker && (walker.flow.beats || [])[0];
  const opens = plan.beats[0] && plan.beats[0].steps[0];
  if (open && b0 && b0.active && plan.beats[0] && !(opens && opens.kind === 'app')) {
    const start = walker.start(b0.active);
    plan.beats[0].steps.unshift({ kind: 'app', app: b0.active, text: formatStep({ kind: 'app', app: b0.active }), line: '1.1', ...(start ? { lands: { screen: start, text: landText(null, scr(start)) } } : {}) });
  }

  // Focus: the script's own targets first ("lit", "Point at", a hover card), then what on the line's screens backs its
  // words. A target one step off the plan's path (a tab, a panel) gets `via`: ⌥F takes that step.
  if (walker) {
    const onPath = new Set(lines.flatMap(x => x.span.map(k => k.split(':')[1])));
    const df = new Map(); let N = 0;
    for (const id of walker.states) { const sc = walker.shown(id); if (!sc) continue; for (const it of sc.items) { N++; for (const x of new Set(words(it.text))) df.set(x, (df.get(x) || 0) + 1); } }
    const weight = x => Math.log(1 + N / (df.get(x) || 0.5)) * (/^\d/.test(x) ? 1.5 : 1);
    const typed = new Set(plan.beats.flatMap(b => b.steps).filter(st => st.kind === 'type' && st.value.length > 12).map(st => norm(st.value)));
    for (const x of lines) x.beat.lines[x.idx].focus = focusFor(x, walker, onPath, weight, typed);
    if (trace) for (const x of lines) trace.push({ beat: plan.beats.indexOf(x.beat) + 1, line: x.idx + 1, span: x.span, hints: x.hints });
    walker.save();
  }
  plan.beats = plan.beats.filter(b => b.steps.length || b.say.length);
  return { plan, flags };
}

// Words the new screen shows that the one before didn't: a heading, else a short line of text.
function landText(before, after) {
  if (!after) return null;
  if (!before) { const h = after.headings.find(x => x.split(' ').length >= 2 && x.length < 70) || after.headings[0]; return h || (after.items.find(i => i.text.split(' ').length >= 2 && i.text.length < 70) || {}).text || null; }
  const had = new Set([...(before ? before.headings : []), ...(before ? before.items.map(i => i.text) : [])].map(norm));
  const h = after.headings.find(x => !had.has(norm(x)) && x.split(' ').length >= 2 && x.length < 70);
  if (h) return h;
  const t = after.items.find(i => i.kind === 'text' && !had.has(norm(i.text)) && i.text.split(' ').length >= 2 && i.text.length < 70 && /[a-z]/i.test(i.text));
  return t ? t.text : null;
}

// Beat-level targets (a Do list before the lines) go to the line they share the most words with, keeping their order.
function assignHints(hints, lines) {
  const out = lines.map(() => []);
  let at = 0;
  for (const h of hints) {
    const hw = new Set(h.texts.flatMap(t => words(t)));
    let best = at, bs = -1;
    lines.forEach((l, k) => { if (k < at) return; const s = words(l.say).filter(w => hw.has(w)).length; if (s > bs) { bs = s; best = k; } });
    if (bs <= 0) best = at;
    if (out[best]) out[best].push(h);
    at = best;
  }
  return out;
}

const has = (sc, t) => !!sc && norm(sc.text).includes(norm(t));
// A card picked by all its words ("Supply chain disruption What a supplier delay puts at risk… Plugin"): its title, the
// longest text of its own on the screen that it starts with.
function titleOf(sc, name) {
  const n = norm(name);
  const t = (sc && sc.items || []).filter(x => x.kind === 'text' && x.text && x.text.length > 2 && norm(x.text).length < n.length && n.startsWith(norm(x.text)) && /^\s/.test(n.slice(norm(x.text).length))).sort((a, b) => b.text.length - a.text.length)[0];
  return t ? clean(t.text) : name;
}
function focusFor(x, walker, onPath, weight, typed) {
  const ids = [...new Set(x.span.map(k => k.split(':')[1]))];
  const out = [];
  const dupe = f => out.some(o => o.texts.some(t => f.texts.some(u => norm(u).includes(norm(t)) || norm(t).includes(norm(u)))));
  const place = h => {
    const texts = (h.texts || []).filter(t => t && t.length > 1);
    if (!texts.length) return null;
    if (h.via) return { texts, around: h.around, via: h.via, on: ids[ids.length - 1] };
    // The card a click is on is where it first shows on the line's way: the click comes after it.
    const order = h.around === 'card' ? ids : [...ids].reverse();
    let on = h.on && texts.every(t => has(walker.shown(h.on), t)) ? h.on : order.find(id => texts.every(t => has(walker.shown(id), t))) || null, via = null;
    if (!on) for (const id of ids) {
      const m = walker.moves(id).find(m => m.steps.length === 1 && !onPath.has(m.to) && texts.every(t => has(walker.shown(m.to), t)));
      if (m) { on = m.to; via = { ...m.steps[0], text: formatStep(m.steps[0]) }; break; }
      const o = walker.opened(id);
      if (o && o.label && texts.every(t => has(o.screen, t))) { on = id; via = { kind: 'click', target: o.label, text: `Click "${o.label}"` }; break; }
    }
    if (!on && h.loose) return null;
    return { texts, ...(h.around ? { around: h.around } : {}), ...(h.mark ? { mark: h.mark, dir: h.dir || 'sw' } : {}), ...(via ? { via } : {}), ...(on ? { on } : {}) };
  };
  for (const h of x.hints.filter(h => !h.weak)) { const f = place(h); if (f && !dupe(f)) out.push(f); }
  // What backs the line's words: on each app's screens when the line moves from one app to another.
  const apps = [...new Set(x.span.map(k => k.split(':')[0]))];
  const groups = apps.length > 1 ? apps.map(a => x.span.filter(k => k.startsWith(a + ':')).map(k => k.split(':')[1])) : [ids];
  const backed = [];
  // A point around several items (two rows she names, a step and the steps it goes on to) takes the place of the plain
  // points it holds: she frames them together.
  // The same for the row a name heads ("Fabric IQ · Semantic model"), over a point at the bare name ("Fabric IQ").
  const absorb = f => {
    const bare = o => !o.mark && !o.around && (!o.on || o.on === f.on) && (!o.via || (f.via && o.via.target === f.via.target));
    const plain = f.heads ? o => bare(o) && o.texts.length === 1 && norm(o.texts[0]) === norm(f.heads)
      : o => bare(o) && o.texts.every(t => f.texts.some(u => norm(u).includes(norm(t))));
    if (!f.heads && f.texts.length < 2) return false;
    const k = out.findIndex(plain);
    if (k < 0) return false;
    const { pos, heads, ...rest } = f;
    out[k] = rest;
    for (let i = out.length - 1; i > k; i--) if (plain(out[i])) out.splice(i, 1);
    return true;
  };
  for (const g of groups) for (const f of backing(x.say, g, walker, weight, onPath, typed, groups.length > 1 ? 1 : 3, x.clicked || [])) if (!absorb(f) && !dupe(f) && out.length + backed.length < 4) backed.push(f);
  // ⌥F goes through a line's points in order: in the order she says them.
  out.push(...backed.map((f, i) => ({ f, i })).sort((a, b) => (a.f.pos ?? Infinity) - (b.f.pos ?? Infinity) || a.i - b.i).map(({ f }) => { const { pos, heads, ...rest } = f; return rest; }));
  for (const h of x.hints.filter(h => h.weak)) { const f = place(h); if (f && !dupe(f) && out.length < 2) out.push(f); }
  return out;
}
// An app's frame: what's on nearly all of its screens (the sidebar, the top bar). Not worth pointing at.
const frames = new WeakMap();
function frameTexts(walker, app) {
  let m = frames.get(walker);
  if (!m) frames.set(walker, m = {});
  if (m[app]) return m[app];
  const ids = walker.states.filter(id => (walker.flow.states[id] || {}).app === app), count = {};
  for (const id of ids) for (const t of new Set(((walker.shown(id) || {}).items || []).map(i => norm(i.text)))) count[t] = (count[t] || 0) + 1;
  return (m[app] = new Set(Object.keys(count).filter(t => count[t] > Math.max(1, ids.length * 0.8))));
}
// Rows of one list the line names, two or more, the way she frames them together: by their own words ("Under Added:
// Contoso IQ, … and my Supply chain disruption plugin"), or, for rows that start with the same name, by the words that
// set them apart ("procurement, inventory, production and sales" for "Fabrikam Procurement", "Fabrikam Sales"…). One
// list: the same kind of item, with no heading between them.
const spaced = t => ` ${norm(t).replace(/\.(?!\d)/g, ' ').replace(/[^a-z0-9$%.]+/g, ' ').trim()} `;
const groupBy = (xs, key) => { const g = new Map(); for (const x of xs) { const k = key(x); if (!g.has(k)) g.set(k, []); g.get(k).push(x); } return [...g.values()]; };
export function namedRows(say, sc, frame = new Set()) {
  const ns = spaced(say), lw = new Set(words(say));
  const count = t => t.trim().split(/\s+/).length;
  const rows = sc.items.filter(it => it.role !== 'heading' && it.text.length >= 4 && count(it.text) >= 2 && count(it.text) <= 6 && !frame.has(norm(it.text)));
  const said = rows.filter(it => ns.includes(spaced(it.text)));
  const lead = it => it.text.trim().split(/\s+/)[0];
  const apart = it => { const r = words(it.text.trim().split(/\s+/).slice(1).join(' ')); return r.length > 0 && r.every(w => lw.has(w)); };
  const named = rows.filter(it => !said.includes(it) && !/[.:]$|: /.test(it.text.trim()) && /^[A-Z]/.test(lead(it)) && words(lead(it)).length === 1 && apart(it));
  const heads = sc.items.filter(it => it.role === 'heading').map(it => it.box[0]);
  const out = [];
  for (const set of [said, ...groupBy(named, it => norm(lead(it)))]) for (const g of groupBy(set, it => `${it.tag}|${it.role}|${it.frame || ''}`)) {
    let run = [];
    const flush = () => { const u = run.filter((it, i) => run.findIndex(o => norm(o.text) === norm(it.text)) === i); if (u.length >= 2) out.push(u.slice(0, 5)); run = []; };
    for (const it of g.sort((x, y) => x.box[0] - y.box[0])) { if (run.length && heads.some(h => h > run[run.length - 1].box[0] && h < it.box[0])) flush(); run.push(it); }
    flush();
  }
  return out;
}
// A step the line names, with the steps it goes on to: up to two more, to the next step of its kind ("Reviewed custom
// skill Contoso IQ", then "Retrieve memories"). What's inside a step, one-word labels and lines every step has ("Thought
// process") aren't steps.
export function stepsFrom(steps, head, others = []) {
  const lead = spaced(head.text).trim().split(' ').slice(0, 2).join(' ');
  const seen = {};
  for (const i of steps) seen[norm(i.text)] = (seen[norm(i.text)] || 0) + 1;
  const out = [head];
  for (const i of steps.filter(i => i.box[0] > head.box[0]).sort((a, b) => a.box[0] - b.box[0])) {
    if (out.length >= 3) break;
    if (i.box[0] <= out[out.length - 1].box[2]) continue;
    const n = norm(i.text);
    if (spaced(i.text).trim().startsWith(lead + ' ') || others.some(f => n.includes(f))) break;
    if (i.tag !== head.tag || seen[n] >= 3 || n.split(/\s+/).length < 2) continue;
    out.push(i);
  }
  return out;
}
// What on the line's screens backs its words (the script matcher's picks, packages/script/match.mjs): two words or a
// number in common at least, on the best screen of the line's own, else one step off the path (with `via`). A number
// said in words ("about thirty-five thousand dollars") is the figure on screen near it ("$35,073").
function backing(say, ids, walker, w, onPath, typed = new Set(), limit = 3, clicked = []) {
  const lw = words(say);
  // Where the line says these words (the middle one, so one stray word early on doesn't move it).
  const at = ws => { const i = ws.map(x => lw.indexOf(x)).filter(k => k >= 0).sort((a, b) => a - b); return i.length ? i[(i.length - 1) >> 1] : Infinity; };
  // The names a line says ("Work IQ", "Fabric IQ"): an item that shows one backs it more.
  const named = facts(say).map(f => norm(f.text)).filter(f => f.length > 3);
  const clip = t => t.length > 120 ? t.slice(0, 117).replace(/\s+\S*$/, '') : t;
  const out = [];
  const said = spokenNumbers(say).filter(n => n >= 100 && !String(say).replace(/,/g, '').includes(String(n)));
  const near = x => said.some(n => Math.abs(x - n) / n <= 0.1);
  numbers: for (const id of [...ids].reverse()) {
    for (const it of (walker.shown(id) || { items: [] }).items) {
      if (!(it.text.match(/\$?\d[\d,]*(?:\.\d+)?/g) || []).some(x => near(+x.replace(/[$,]/g, '')))) continue;
      const hit = sentences(it.text).find(t => (t.match(/\$?\d[\d,]*/g) || []).some(x => near(+x.replace(/[$,]/g, '')))) || it.text;
      out.push({ texts: [clip(hit)], on: id, pos: lw.findIndex(x => /\d/.test(x) || x in UNITS || x in SCALES) });
      break numbers;
    }
  }
  // Two or more rows of one list that the line names: one point around them, on the line's latest screen that has them
  // (after the steps the line names, below: those say more).
  const listed = [];
  for (const id of [...ids].reverse()) {
    const sc = walker.shown(id);
    const rows = sc ? namedRows(say, sc, frameTexts(walker, (walker.flow.states[id] || {}).app)) : [];
    for (const g of rows) listed.push({ texts: g.map(it => clip(it.text)), on: id, pos: at(words(g[0].text)) });
    if (rows.length) break;
  }
  const holds = (pts, t) => pts.some(o => o.texts.some(u => norm(u).includes(norm(t)) || norm(t).includes(norm(u))));
  // A name the line says ("from Fabric IQ"), by the row it heads ("Fabric IQ · Semantic model"): the one that shares
  // more of the line's words, else the first.
  const names = facts(say).map(f => clean(f.text)).filter(f => f.split(/\s+/).length >= 2);
  for (const id of [...ids].reverse()) {
    const sc = walker.shown(id);
    if (!sc) continue;
    let found = false;
    for (const name of names) {
      const n = spaced(name), own = new Set(words(name));
      const rows = sc.items.filter(it => it.role !== 'heading' && spaced(it.text).startsWith(n) && spaced(it.text).length > n.length && it.text.split(/\s+/).length <= 8);
      if (!rows.length) continue;
      const share = it => words(it.text).filter(w => !own.has(w) && lw.includes(w)).length;
      const row = rows.slice().sort((a, b) => share(b) - share(a) || a.box[0] - b.box[0])[0];
      if (!holds(out, row.text) && !holds(listed, row.text)) out.push({ texts: [clip(row.text)], on: id, pos: at(words(name)), heads: name });
      found = true;
    }
    if (found) break;
  }
  // The line's later screens weigh more: it's said once its clicks are done. Her own prompt, shown back in the chat,
  // isn't something to point at.
  let best = null;
  const consider = (id, via, k = 0) => considerShown(walker.shown(id), id, via, k);
  const considerShown = (sc, id, via, k = 0, own = false) => {
    if (!sc) return;
    const items = sc.items.filter(it => !(norm(it.text).length >= 30 && [...typed].some(t => t.includes(norm(it.text)))));
    const picks = pickItems(lw, { items }, w).map(p => ({ ...p, score: p.score + (named.some(f => norm(items.find(x => x.i === p.item).text).includes(f)) ? 3 : 0) }))
      .filter((p, i) => (p.words.length >= 2 || p.words.some(x => /\d/.test(x))) && (i > 0 || p.score >= 4));
    const score = picks.reduce((n, p) => n + p.score, 0) * (via && !own ? 0.8 : 1) * (1 + 0.3 * k);
    if (picks.length && (!best || score >= best.score)) best = { id, picks, score, items, via };
  };
  ids.forEach((id, k) => consider(id, null, k));
  for (const id of ids) for (const m of walker.moves(id)) if (m.steps.length === 1 && !onPath.has(m.to)) consider(m.to, { ...m.steps[0], text: formatStep(m.steps[0]) });
  // A screen's step groups, opened ("21 items complete"): what the answer did, step by step.
  ids.forEach((id, k) => {
    const o = walker.opened(id);
    if (!o) return;
    const via = o.label ? { kind: 'click', target: o.label, text: `Click "${o.label}"` } : null;
    // Opened by the line's own clicks: it's the line's screen (⌥F still opens it, via the group's button).
    const own = o.label && clicked.some(c => norm(c).startsWith(norm(o.label)));
    // Only what the open groups add: the steps in them. A step the line names ("starts with Work IQ") comes first.
    const closed = new Set((walker.shown(id) || { items: [] }).items.map(i => norm(i.text)));
    const steps = o.screen.items.filter(i => !closed.has(norm(i.text)));
    if (own) for (const f of named.filter(f => f.includes(' '))) {
      const it = steps.filter(i => norm(i.text).includes(f) && i.text.split(' ').length >= 3).sort((a, b) => a.text.length - b.text.length)[0];
      if (it && !out.some(o2 => o2.texts[0] === it.text)) out.push({ texts: stepsFrom(steps, it, named.filter(g => g !== f)).map(x => clip(x.text)), on: id, ...(via ? { via } : {}), pos: at(words(f)) });
    }
    considerShown({ items: steps }, id, via, own ? ids.length + 1 : k, own);
  });
  // Rows the line's steps already name go with the steps.
  for (const p of listed) if (!p.texts.every(t => out.some(o => o.texts.some(u => norm(u).includes(norm(t)))))) out.push(p);
  const inside = t => holds(out, t);
  if (best) for (const p of best.picks.filter(p => !inside(p.phrase || best.items.find(x => x.i === p.item).text)).slice(0, Math.max(0, limit - out.length))) {
    const it = best.items.find(x => x.i === p.item);
    out.push({ texts: [clip(p.phrase || it.text)], on: best.id, ...(best.via ? { via: best.via } : {}), pos: at(p.words) });
  }
  return out;
}

// Numbers said in words or digits: "about thirty-five thousand dollars" → 35000, "five days" → 5, "350" → 350.
const UNITS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES = { thousand: 1e3, million: 1e6, billion: 1e9 };
// Which of her prompts these words are: the same words, else the one that shares the longest start with them (prompt 4
// is prompt 1 with "and what will it cost us?" added: it's prompt 4).
export function promptFor(prompts, value) {
  const nv = norm(value), P = (prompts || []).filter(p => p.text);
  const same = P.find(p => norm(p.text) === nv);
  if (same || nv.length <= 30) return same || null;
  const shared = t => { let i = 0; while (i < t.length && i < nv.length && t[i] === nv[i]) i++; return i; };
  return P.map(p => ({ p, n: shared(norm(p.text)) })).filter(x => x.n >= 40).sort((a, b) => b.n - a.n)[0]?.p || null;
}

export function spokenNumbers(text) {
  const out = [];
  let cur = null, total = 0;
  const flush = () => { if (cur !== null || total) out.push(total + (cur || 0)); cur = null; total = 0; };
  for (const tok of String(text).toLowerCase().replace(/(\d),(\d)/g, '$1$2').split(/[\s\u2011-]+/)) {
    const t = tok.replace(/[^a-z0-9.]/g, '');
    if (/^\d+(\.\d+)?$/.test(t)) { flush(); out.push(+t); continue; }
    if (t in UNITS) { cur = (cur || 0) + UNITS[t]; continue; }
    if (t === 'hundred' && cur !== null) { cur *= 100; continue; }
    if (t in SCALES && (cur !== null || total)) { total = (total + (cur || 0)) * SCALES[t]; cur = null; continue; }
    if (t === 'and' && (cur !== null || total)) continue;
    flush();
  }
  flush();
  return out;
}
