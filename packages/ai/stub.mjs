// The deterministic stand-in for Copilot: the same tasks (model.mjs), answered by rules from the same inputs, so every
// test runs the three modes end to end with no network and no account. It reads a goal like
//   Ask "Summarize the supplier delay on PO-450101", then close the workspace, then open Plugins. In admin, search
//   "alpha" and open alpha-6.
// clause by clause: a quoted question goes in the assistant's message box and is sent; "search"/"find" with a quote
// goes in the search box; open/click/show/select names a control; close/dismiss is Escape (or a "Close …" control);
// "in <app>"/"go to <app>" switches apps. Its talk track quotes the screens' own words.
import { parsePlan, formatStep } from './plan.mjs';
import { findItem, composer, searchBox } from './find.mjs';

export function itemsOf(outline) {
  if (!outline) return [];
  if (outline.items) return outline.items;
  return (outline.controls || []).map(c => {
    const m = /^\[(\d+)\] (\S+) "(.*)"(.*)$/.exec(c);
    if (!m) return null;
    const flags = m[4];
    return { i: +m[1], role: m[2], name: m[3], editable: /field\)/.test(flags) ? 'field' : undefined, multiline: /\(multi-line field\)/.test(flags) || undefined, disabled: /\(disabled\)/.test(flags) || undefined };
  }).filter(Boolean);
}

// Splits on , ; . "then" "and then" outside quotes.
function clauses(goal) {
  const out = []; let cur = '', q = null;
  const s = String(goal || '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { cur += ch; if (ch === q || (q === '“' && ch === '”')) q = null; continue; }
    if (ch === '"' || ch === '“') { q = ch; cur += ch; continue; }
    if (/[,;.]/.test(ch) && !/\d/.test(s[i + 1] || '') ) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.flatMap(c => c.split(/\b(?:and then|then|and)\b(?=\s+(?:ask|open|click|show|select|choose|close|dismiss|search|find|go|switch|type|press|start|in)\b)/i)).map(c => c.trim()).filter(Boolean);
}
const quoted = c => { const m = /["“]([^"”]+)["”]/.exec(c); return m ? m[1] : null; };
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;

function goalPlan(goal, apps) {
  const beats = [];
  let app = apps[0] ? apps[0].id : null;
  let beat = null;
  const items = () => itemsOf((apps.find(a => a.id === app) || {}).outline);
  // A new beat, unless the one going has nothing of its own yet (only an app switch, or a "New").
  const start = title => {
    if (beat && beat.steps.every(s => /^Go to |^Click "New"$/.test(s)) && !beat.asked) { beat.title = cap(title).slice(0, 60); return; }
    beat = { title: cap(title).slice(0, 60), steps: [], say: [] }; beats.push(beat);
  };
  const add = s => { if (!beat) start('Getting started'); beat.steps.push(s); };
  const appIn = c => apps.find(a => new RegExp(`\\b(?:in|to|open|on) (?:the )?${a.id}\\b`, 'i').test(c) || new RegExp(`^(?:go|switch) to (?:the )?${a.id}\\b`, 'i').test(c));
  for (const raw of clauses(goal)) {
    let c = raw;
    const to = appIn(c);
    if (to && to.id !== app) { app = to.id; start(`The ${to.id} app`); add(`Go to ${app}`); }
    if (to) c = c.replace(new RegExp(`\\b(?:in|to|on|open) (?:the )?${to.id}( app)?\\b`, 'i'), '').replace(/^(?:go|switch)\s*/i, '').trim();
    if (!c) continue;
    const q = quoted(c);
    if (q && /\b(search|find|filter|look up)\b/i.test(c)) {
      const f = searchBox(items());
      add(`Type "${q}"${f ? ` in "${f.name}"` : ''}`); add('Press Enter');
      continue;
    }
    if (q && /\b(ask|type|say|prompt|question|send)\b/i.test(c) || q && !/\b(open|click|select|show|choose)\b/i.test(c)) {
      start(q.length > 50 ? q.slice(0, 47) + '…' : q);
      const f = composer(items());
      add(`Type "${q}"${f ? ` in "${f.name}"` : ''}`);
      add(/\bsend button|click send|with send\b/i.test(c) ? 'Click "Send"' : 'Press Enter');
      add('Wait for the answer');
      beat.asked = true;
      continue;
    }
    let m;
    if ((m = /\b(?:close|dismiss|hide)\s+(?:the\s+)?(.+)$/i.exec(c))) {
      const hit = findItem(items(), `Close ${m[1]}`);
      add(hit && /close/i.test(hit.name) ? `Click "${hit.name}"` : 'Press Escape');
      continue;
    }
    if (/\b(?:close|dismiss)\b/i.test(c)) { add('Press Escape'); continue; }
    if (/\b(?:start (?:a )?new|new chat|start over)\b/i.test(c)) { const hit = findItem(items(), 'New'); start('A new question'); add(`Click "${hit ? hit.name : 'New'}"`); continue; }
    if ((m = /\b(?:open|click(?: on)?|show|select|choose|go to|look at|reopen)\s+(?:the\s+)?(.+)$/i.exec(c))) {
      const what = (q || m[1]).replace(/\s+(?:page|tab|button|pane|row|link|details)$/i, '').trim();
      const hit = findItem(items(), what);
      if (!beat || /plugin|page|settings|admin/i.test(what)) start(cap(what));
      add(`Click "${hit ? hit.name : what}"`);
      continue;
    }
    add(`You: ${c}`);
  }
  return { title: null, beats: beats.map(b => ({ title: b.title, steps: b.steps, say: b.say })) };
}

function plan({ goal, source, apps = [], title }) {
  const fromSource = source ? parsePlan(source) : null;
  if (fromSource && fromSource.beats.some(b => b.steps.some(s => s.kind !== 'free'))) {
    return { title: fromSource.title || 'Demo', beats: fromSource.beats.map(b => ({ title: b.title, steps: b.steps.map(formatStep), say: b.say })) };
  }
  const p = goalPlan(goal || source || '', apps);
  p.title = title || 'Demo';
  // Lines from the source's > quotes, beat by beat, when it has them.
  if (fromSource) fromSource.beats.forEach((b, i) => { if (p.beats[i] && b.say.length) p.beats[i].say = b.say; });
  return p;
}

function adapt({ step, outline }) {
  const items = itemsOf(outline);
  const t = String(step || '');
  const q = quoted(t) || t.replace(/^\w+\s+/, '');
  const hit = findItem(items, q);
  if (hit) return { do: /^type\b/i.test(t) ? `Type "${quoted(t) || ''}" in "${hit.name}"` : `Click "${hit.name}"` };
  return { ask: `I can't find "${q}" on this screen. Click it yourself and press Done, or skip it.` };
}

function next() { return { step: null, say: null }; }

// The talk track quotes the screens: the answer that streamed in (its first and last sentences), the question as
// typed, what a click opened (a dialog's title, a page's heading).
const sentencesIn = t => (String(t || '').match(/[^.!?]+[.!?]/g) || []).map(x => x.trim()).filter(x => x.split(' ').length >= 5);
function script({ title, beats = [] }) {
  const out = { title: title || 'Demo', beats: [] };
  beats.forEach((b, i) => {
    const lines = [];
    const st = b.starts || {};
    if (st.answer) { const ss = sentencesIn(st.answer); if (ss.length) lines.push(ss[0]); if (ss.length > 1) lines.push(ss[ss.length - 1]); }
    let heading = (st.headings || [])[0];
    for (const t of b.then || []) {
      const typed = /^Type "(.*?)" in "(.*?)"/.exec(t.after || '');
      if (typed) lines.push(/search|find|filter/i.test(typed[2]) ? `I search for ${typed[1]}.` : `I ask: ${typed[1]}`);
      else if (t.dialog) lines.push(`Here is ${t.dialog}.`);
      else if (/^Click/.test(t.after || '') && (t.headings || [])[0] && t.headings[0] !== heading && !/[?!]$/.test(t.headings[0])) lines.push(`This is ${t.headings[0]}.`);
      heading = (t.headings || [])[0] || heading;
    }
    if (!lines.length) lines.push(st.how === 'switch' ? `Here's the ${b.app} app.` : `Here's where we start.`);
    const acts = b.actions || [];
    const typed = acts.map(a => /^Type "(.*?)"/.exec(a)).find(Boolean);
    const clicked = acts.map(a => /^Click "(.*?)"/.exec(a)).find(Boolean);
    const name = st.how === 'answer' ? 'The answer' : typed ? typed[1] : clicked ? clicked[1] : st.how === 'switch' ? `The ${b.app} app` : 'The start';
    out.beats.push({ title: cap(name.length > 60 ? name.slice(0, 57) + '…' : name), do: acts.join(', '), lines: lines.slice(0, 3) });
  });
  return out;
}

export async function ask(task, input) {
  switch (task) {
    case 'plan': return plan(input);
    case 'adapt': return adapt(input);
    case 'next': return next(input);
    case 'script': return script(input);
    // No stand-in for reading a talk track: the rules alone make that plan (from-script.mjs).
    case 'script-plan': return { beats: null };
    default: throw new Error('unknown task ' + task);
  }
}
