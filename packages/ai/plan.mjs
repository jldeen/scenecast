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

const Q = String.raw`["“”']([^"“”']*)["“”']`;
const clean = s => String(s || '').replace(/\s+/g, ' ').trim();

export function parseStep(text) {
  const t = clean(text).replace(/\s*[—-]\s*ask (me )?first\.?$/i, '');
  let m;
  if ((m = new RegExp(`^(?:go|switch) to (?:the )?(.+?)(?: app| tab)?$`, 'i').exec(t)) && !/["“”]/.test(t)) return { kind: 'app', app: clean(m[1]).toLowerCase(), text: t };
  if ((m = new RegExp(`^(?:click|open|select|choose|tap)(?: on)? ${Q}`, 'i').exec(t))) return { kind: 'click', target: m[1], text: t };
  if ((m = new RegExp(`^hover(?: over| on)? ${Q}`, 'i').exec(t))) return { kind: 'hover', target: m[1], text: t };
  if ((m = new RegExp(`^type ${Q}(?: (?:in|into) ${Q})?`, 'i').exec(t))) return { kind: 'type', value: m[1], target: m[2] || null, text: t };
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
  let beat = null;
  const ensure = () => { if (!beat) { beat = { title: 'Beat 1', steps: [], say: [] }; plan.beats.push(beat); } return beat; };
  for (const raw of String(text || '').replace(/\r/g, '').split('\n')) {
    const r = raw.trim();
    if (!r) continue;
    let m;
    if ((m = /^#\s+(.+)$/.exec(r)) && !plan.title && !plan.beats.length) { plan.title = clean(m[1]); continue; }
    if ((m = /^#{2,6}\s+(.+)$/.exec(r))) { beat = { title: clean(m[1].replace(/^(?:beat|scene|part)\s+\d+\s*[:·.\-–—]?\s*/i, '')) || `Beat ${plan.beats.length + 1}`, steps: [], say: [] }; plan.beats.push(beat); continue; }
    if ((m = /^>\s?(.*)$/.exec(r))) { if (clean(m[1])) ensure().say.push(clean(m[1])); continue; }
    if ((m = /^(?:[-*+]|\d+[.)])\s+(.+)$/.exec(r))) { ensure().steps.push(parseStep(m[1])); continue; }
  }
  plan.beats = plan.beats.filter(b => b.steps.length || b.say.length);
  return plan;
}

export function formatPlan(plan) {
  const out = [`# ${plan.title || 'Demo'}`, ''];
  plan.beats.forEach((b, i) => {
    out.push(`## Beat ${i + 1} · ${b.title || `Beat ${i + 1}`}`, '');
    let field = null;
    for (const s of b.steps) {
      out.push(`- ${formatStep(s)}${risk(s, null, s.kind === 'press' ? field : undefined) ? ' — ask first' : ''}`);
      if (s.kind === 'type') field = s.target ? { name: s.target } : null;
      else if (s.kind !== 'press') field = null;
    }
    if (b.steps.length && b.say.length) out.push('');
    for (const l of b.say) out.push(`> ${l}`);
    out.push('');
  });
  return out.join('\n');
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
