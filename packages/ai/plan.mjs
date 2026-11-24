// A plan: the demo's beats, and for each the steps to take in the browser and the lines to say, in plain words the
// presenter can read and edit (plan.md in the demo folder):
//
//   # Supplier delay
//   ## Beat 1 · The question
//   - Go to chat
//   - Click "Message"
//   - Type "Summarize the supplier delay on PO-450101"
//   - Press Enter
//   - Wait for the answer
//   > Kestrel moved the ship date by six days.
//
// Steps (one per "- " line; quotes may be "…" or “…”):
//   Go to <app>                      bring that app's tab to the front
//   Click "<name>"                   a button, link, tab, row… by what it says or its label
//   Hover over "<name>"              rest the pointer on it
//   Type "<text>" [in "<field>"]     into the field (clicked first) or where the cursor is
//   Press <key>                      Enter, Escape, Tab, ArrowDown…
//   Wait for the answer              until the screen has settled (an AI answer streamed in)
//   Scroll down | Scroll up
//   You: <what to do>                the presenter does it by hand; the recorder captures it
// Anything else is read by the AI at that point ("Open the first tool in the list").
// "> " lines are what to say. Steps that could send, post, approve, buy, delete or change a setting are marked
// "ask first": they never run without the presenter's go-ahead in the app (risk()).
//
// Version 2 (docs/engine/plan-format.md) adds details: indented "Key: value" lines under a step (Writes, Safe, Undo,
// Lands on, Script, Differs) or a line (Focus). A version 1 reader skips them, so v2 plans run anywhere v1 plans do.

// A quoted name or text, its quotes paired: "Kestrel's ship date" keeps its apostrophe (three groups: "…", “…”, '…').
const Q = String.raw`(?:"([^"]*)"|“([^”]*)”|'([^']*)')`;
const q = (m, i) => m[i] ?? m[i + 1] ?? m[i + 2];
const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
const STEP_DETAILS = [['script', 'Script'], ['differs', 'Differs'], ['writes', 'Writes'], ['safe', 'Safe'], ['undo', 'Undo']];
const DETAIL = /^(writes|safe|undo|lands on|script|differs|focus)\s*:\s*(.*)$/i;
const DIRS = /^(n|s|e|w|ne|nw|se|sw)$/i;

// " · " outside quotes: a Focus detail's target, then its options.
function splitDots(s) {
  const out = []; let cur = '', q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { cur += ch; if (ch === q || (q === '“' && ch === '”')) q = null; continue; }
    if (ch === '"' || ch === '“') { q = ch; cur += ch; continue; }
    if (ch === '·' && /\s/.test(s[i - 1] || '') && /\s/.test(s[i + 1] || '')) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}
const quotes = s => [...String(s).matchAll(/["“]([^"“”]+)["”]/g)].map(m => m[1]);

// A Focus detail: '"words"', '"a", "b"' or 'the card around "words"', then " · arrow sw", " · via Click "x"",
// " · on <screen>".
export function parseFocus(spec) {
  const [head = '', ...opts] = splitDots(clean(spec));
  const around = /^(?:the\s+)?([a-z]+)\s+around\s+["“]/i.exec(head);
  const texts = quotes(head);
  const f = { texts, ...(around ? { around: around[1].toLowerCase() } : {}) };
  if (!texts.length) f.what = head;
  for (const o of opts) {
    let m;
    if ((m = /^arrow(?:\s+(\w+))?$/i.exec(o))) { f.mark = 'arrow'; if (m[1] && DIRS.test(m[1])) f.dir = m[1].toLowerCase(); }
    else if ((m = /^via\s+(.+)$/i.exec(o))) f.via = parseStep(m[1]);
    else if ((m = /^on\s+(.+)$/i.exec(o))) f.on = m[1];
  }
  return f;
}
export function formatFocus(f) {
  const list = (f.texts || []).map(t => `"${t}"`).join(', ');
  let s = f.around && list ? `the ${f.around} around ${list}` : list || f.what || '';
  if (f.mark === 'arrow') s += ` · arrow${f.dir ? ' ' + f.dir : ''}`;
  if (f.via) s += ` · via ${formatStep(f.via)}`;
  if (f.on) s += ` · on ${f.on}`;
  return s;
}
// "Lands on": the screen a step lands on, then what proves it ran there (docs/engine/plan-format.md). Either part may
// be left out. Parsed, as step.lands:
//   "words"                                  { screen, kind: 'words', text }
//   control "Name"                           { screen, kind: 'control', text: null, control, state: null }
//   control "Name" selected|open|on|off      { screen, kind: 'control', text: null, control, state }
//   box "Name" says "text"                   { screen, kind: 'box', text: null, box, says }
//   gone "words", still "words"              { screen, kind: 'gone', text: null, gone, still }
//   (nothing)                                { screen, kind: null, text: null }
// `text` is only ever the words a run looks for in the page's text.
const PROOF = {
  words: new RegExp(`^${Q}$`),
  control: new RegExp(`^control\\s+${Q}(?:\\s+(selected|open|on|off))?$`, 'i'),
  box: new RegExp(`^box\\s+${Q}\\s+says\\s+${Q}$`, 'i'),
  gone: new RegExp(`^gone\\s+${Q}(?:\\s*,\\s*still\\s+${Q})?$`, 'i'),
};
const isProof = t => Object.values(PROOF).some(re => re.test(t));
export function parseLands(v) {
  const parts = splitDots(clean(v));
  const screen = parts.length && !isProof(parts[0]) && !/^["“]/.test(parts[0]) ? parts.shift() : null;
  const p = parts[0] || '';
  let m;
  if ((m = PROOF.words.exec(p))) return { screen, kind: 'words', text: q(m, 1) };
  if ((m = PROOF.control.exec(p))) return { screen, kind: 'control', text: null, control: q(m, 1), state: m[4] ? m[4].toLowerCase() : null };
  if ((m = PROOF.box.exec(p))) return { screen, kind: 'box', text: null, box: q(m, 1), says: q(m, 4) };
  if ((m = PROOF.gone.exec(p))) return { screen, kind: 'gone', text: null, gone: q(m, 1), still: q(m, 4) ?? null };
  // Anything else with words in quotes: those words.
  const t = quotes(parts.join(' '))[0] || null;
  return { screen, kind: t ? 'words' : null, text: t };
}
// A value in quotes: “…” when it has a straight quote in it.
const qt = t => /"/.test(t) && !/[“”]/.test(t) ? `“${t}”` : `"${t}"`;
export function formatLands(l) {
  const kind = l.kind || (l.text ? 'words' : null);
  const proof = kind === 'words' && l.text ? qt(l.text)
    : kind === 'control' && l.control ? `control ${qt(l.control)}${l.state ? ` ${l.state}` : ''}`
    : kind === 'box' && l.box ? `box ${qt(l.box)} says ${qt(l.says || '')}`
    : kind === 'gone' && l.gone ? `gone ${qt(l.gone)}${l.still ? `, still ${qt(l.still)}` : ''}` : null;
  return [l.screen, proof].filter(Boolean).join(' · ');
}
function addDetail(at, key, value) {
  if (at.kind) {
    if (key === 'lands on') at.lands = parseLands(value);
    else if (key !== 'focus' && value) at[key] = value;
  } else if (key === 'focus' && value) at.focus.push(parseFocus(value));
}

export function parseStep(text) {
  const t = clean(text).replace(/\s*[—-]\s*ask (me )?first\.?$/i, '');
  let m;
  if ((m = new RegExp(`^(?:go|switch) to (?:the )?(.+?)(?: app| tab)?$`, 'i').exec(t)) && !/["“”]/.test(t)) return { kind: 'app', app: clean(m[1]).toLowerCase(), text: t };
  if ((m = new RegExp(`^(?:click|open|select|choose|tap)(?: on)? ${Q}`, 'i').exec(t))) return { kind: 'click', target: q(m, 1), text: t };
  if ((m = new RegExp(`^hover(?: over| on)? ${Q}`, 'i').exec(t))) return { kind: 'hover', target: q(m, 1), text: t };
  if ((m = new RegExp(`^type ${Q}(?: (?:in|into) ${Q})?`, 'i').exec(t))) return { kind: 'type', value: q(m, 1), target: q(m, 4) || null, text: t };
  if ((m = /^press (?:the )?([a-z0-9+]+)(?: key)?\.?$/i.exec(t))) return { kind: 'press', key: normKey(m[1]), text: t };
  if (/^wait\b/i.test(t)) return { kind: 'wait', text: t };
  if ((m = /^scroll (down|up)\b/i.exec(t))) return { kind: 'scroll', dir: m[1].toLowerCase(), text: t };
  if ((m = /^(?:you|presenter|by hand|manual)\s*:\s*(.+)$/i.exec(t))) return { kind: 'manual', what: m[1], text: t };
  return { kind: 'free', text: t };
}
const KEYS = { enter: 'Enter', return: 'Enter', esc: 'Escape', escape: 'Escape', tab: 'Tab', space: 'Space', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', backspace: 'Backspace', delete: 'Delete', pagedown: 'PageDown', pageup: 'PageUp', home: 'Home', end: 'End' };
const normKey = k => KEYS[k.toLowerCase()] || (/^arrow/i.test(k) ? 'Arrow' + k.slice(5, 6).toUpperCase() + k.slice(6).toLowerCase() : k.length === 1 ? k : k[0].toUpperCase() + k.slice(1));

export function formatStep(s) {
  switch (s.kind) {
    case 'app': return `Go to ${s.app}`;
    case 'click': return `Click "${s.target}"`;
    case 'hover': return `Hover over "${s.target}"`;
    case 'type': return `Type "${s.value}"${s.target ? ` in "${s.target}"` : ''}`;
    case 'press': return `Press ${s.key}`;
    case 'wait': return 'Wait for the answer';
    case 'scroll': return `Scroll ${s.dir}`;
    case 'manual': return `You: ${s.what}`;
    default: return s.text;
  }
}

export function parsePlan(text) {
  const plan = { title: '', beats: [] };
  let beat = null, last = null;
  const ensure = () => { if (!beat) { beat = { title: 'Beat 1', steps: [], say: [], lines: [] }; plan.beats.push(beat); } return beat; };
  for (const raw of String(text || '').replace(/\r/g, '').split('\n')) {
    const r = raw.trim();
    if (!r) continue;
    let m;
    if ((m = /^#\s+(.+)$/.exec(r)) && !plan.title && !plan.beats.length) { plan.title = clean(m[1]); last = null; continue; }
    if ((m = /^#{2,6}\s+(.+)$/.exec(r))) { beat = { title: clean(m[1].replace(/^(?:beat|scene|part)\s+\d+\s*[:·.\-–—]?\s*/i, '')) || `Beat ${plan.beats.length + 1}`, steps: [], say: [], lines: [] }; plan.beats.push(beat); last = null; continue; }
    if ((m = /^>\s?(.*)$/.exec(r))) { if (clean(m[1])) { const b = ensure(); b.say.push(clean(m[1])); b.lines.push(last = { text: clean(m[1]), focus: [] }); } continue; }
    if ((m = /^(?:[-*+]|\d+[.)])\s+(.+)$/.exec(r))) { ensure().steps.push(last = parseStep(m[1])); continue; }
    if ((m = DETAIL.exec(r)) && last) addDetail(last, m[1].toLowerCase(), clean(m[2]));
  }
  plan.beats = plan.beats.filter(b => b.steps.length || b.say.length);
  return plan;
}

// A step's details, as written under it.
function stepDetails(s) {
  const out = STEP_DETAILS.filter(([k]) => s[k]).map(([k, label]) => `${label}: ${clean(s[k])}`);
  if (s.lands && formatLands(s.lands)) out.push(`Lands on: ${formatLands(s.lands)}`);
  return out;
}

export function formatPlan(plan) {
  const out = [`# ${plan.title || 'Demo'}`, ''];
  plan.beats.forEach((b, i) => {
    out.push(`## Beat ${i + 1} · ${b.title || `Beat ${i + 1}`}`, '');
    let field = null;
    for (const s of b.steps) {
      // Safe: an app pack knows it only looks like a change (it opens a picker, Enter only filters).
      out.push(`- ${formatStep(s)}${s.writes || (!s.safe && risk(s, null, s.kind === 'press' ? field : undefined)) ? ' — ask first' : ''}`);
      for (const d of stepDetails(s)) out.push(`  ${d}`);
      if (s.kind === 'type') field = s.target ? { name: s.target } : null;
      else if (s.kind !== 'press') field = null;
    }
    const lines = b.lines && b.lines.length ? b.lines : (b.say || []).map(text => ({ text, focus: [] }));
    if (b.steps.length && lines.length) out.push('');
    for (const l of lines) {
      out.push(`> ${l.text}`);
      for (const f of l.focus || []) out.push(`  Focus: ${formatFocus(f)}`);
    }
    out.push('');
  });
  return out.join('\n');
}

// The steps approving the plan approves: each with what it writes and how it's undone.
export function writesOf(plan) {
  return plan.beats.flatMap((b, bi) => b.steps.map((s, si) => ({ s, bi, si })).filter(x => x.s.writes)
    .map(({ s, bi, si }) => ({ beat: bi, step: si, text: formatStep(s), writes: s.writes, undo: s.undo || null, lands: s.lands || null })));
}

// Would this step send, post, approve, buy, delete or change something? Then the presenter says go first.
const RISKY = /\b(send|submit|post|publish|reply|forward|share|invite|approve|reject|accept|decline|confirm|save|apply|add|create|new (?:item|record|user|team|channel)|delete|remove|archive|discard|clear|reset|move|assign|transfer|buy|purchase|order|checkout|check out|pay|book|schedule|upload|install|uninstall|enable|disable|turn (?:on|off)|grant|revoke|sign out|log out|deploy|merge|close (?:issue|ticket|case|account)|cancel (?:order|subscription|meeting))\b/i;
const SAFE_FIELD = /\b(search|filter|find|look ?up|query)\b/i;
const COMPOSER = /\b(message|reply|comment|post|chat|ask|compose|prompt|write|note)\b/i;

// step: a parsed step; el (optional): the element it acts on, from the page outline ({ role, name, editable,
// multiline }); field: the field a key press goes to.
export function risk(step, el, field) {
  if (!step) return null;
  if (step.kind === 'click') {
    const name = (el && el.name) || step.target || '';
    if (el && /^(switch|checkbox|radio)$/.test(el.role)) return `"${name}" changes a setting`;
    if (RISKY.test(name)) return `"${name}" could send, save or change something`;
    return null;
  }
  if (step.kind === 'press' && step.key === 'Enter') {
    const f = field || el;
    const label = f ? f.name || '' : '';
    if (f && SAFE_FIELD.test(label) && !COMPOSER.test(label)) return null;
    if (!f) return 'Enter could send what was typed';
    if (f.multiline || f.role === 'textbox' && f.editable === 'content' || COMPOSER.test(label)) return `Enter in "${label || 'the message box'}" sends it`;
    return null;
  }
  if (step.kind === 'free' && RISKY.test(step.text)) return 'this step could send, save or change something';
  return null;
}

export function stepCount(plan) { return plan.beats.reduce((n, b) => n + b.steps.length, 0); }
