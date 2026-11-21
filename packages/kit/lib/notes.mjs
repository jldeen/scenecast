// The presenter guide's notes (presenter/notes.json), from the demo's script (scenecast, from replica-kit 1.6.0): the talk track word for word, the
// clicks (Do lines), the watch-outs, the script's times and parts, the focus points per beat, the pictures, and where
// each beat is on the stage. `scenecast notes` writes it; the presenter guide (⌥G) shows it; `scenecast notes --check`
// (checks/notes-check.mjs) holds the script, the window and the replica to each other.
//
// The script can be Markdown, plain text, or a RunLines file (.sk, JSON). See docs/presenter.md for the formats.
// (packages/script/parse.mjs reads the same files for focus points: lines only. This reads what the guide shows:
// the Say, Do and Watch sections, times, parts and watch-outs.)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename, extname, relative } from 'node:path';
import { scriptFromFlow } from './beats.mjs';

const clean = s => String(s || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();
const SPECIAL = {
  backstage: /^(backstage|before( the talk)?|setup|set ?up|prep)\b/i,
  watch: /^(if something goes wrong|watch[- ]?outs?|troubleshooting|if it goes wrong)\b/i,
  after: /^(after( the talk)?|afterwards|wrap[- ]?up)\b/i,
};
// "1:45–2:45", "1:45-2:45", "(0:40)", "~40s", "40 s", "1 min".
const RANGE = /(\d+:\d\d)\s*[–—-]\s*(\d+:\d\d)/;
const DUR = /~?\s*(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds|m|min|mins|minutes)\b/i;
export const secs = t => { const [m, s] = String(t).split(':').map(Number); return m * 60 + s; };
export const clock = n => `${Math.floor(n / 60)}:${String(Math.round(n % 60)).padStart(2, '0')}`;
const duration = t => { const m = DUR.exec(t || ''); return m ? Math.round(+m[1] * (/^m/i.test(m[2]) ? 60 : 1)) : null; };

// A heading's beat number, title and time: "3. Sentry has it · 1:45–2:45", "Beat 3: Sentry has it (1:45–2:45)".
function beatHead(h) {
  let s = clean(h), n = null, start = null, end = null, dur = null;
  const r = RANGE.exec(s);
  const mss = !r && /[(·|]\s*(\d+:\d\d)\s*\)?\s*$/.exec(s);
  if (r) { start = secs(r[1]); end = secs(r[2]); s = s.replace(r[0], ''); }
  else if (mss) { dur = secs(mss[1]); s = s.slice(0, mss.index); }
  else { const d = /[(·|]\s*(~?\s*\d+(?:\.\d+)?\s*(?:s|sec|secs|seconds|m|min|mins|minutes))\s*\)?\s*$/i.exec(s); if (d) { dur = duration(d[1]); s = s.slice(0, d.index); } }
  const m = /^(?:(?:beat|scene|step)\s+)?(\d+)\s*[.:·)\-–—]?\s+(.*)$/i.exec(s) || /^(?:beat|scene|step)\s+(\d+)\s*$/i.exec(s);
  if (m) { n = +m[1]; s = m[2] || ''; }
  s = s.replace(/[\s·|(–—-]+$/, '').replace(/^[\s·|:–—-]+/, '').replace(/\(\s*\)$/, '').trim();
  return { n, title: s, start, end, dur };
}
const listItem = l => { const m = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/.exec(l); return m ? { level: Math.floor(m[1].replace(/\t/g, '  ').length / 2), text: m[2].trim() } : null; };

// ---- Markdown ------------------------------------------------------------------------------------------------------
//   # Title                                    the talk's title (the first # heading)
//   # Part 1 · The bug finds us · 0:00–5:00    a part; the paragraph under it is its summary
//   ## Backstage …                             the Start step's clicks (list items) and watch-outs
//   ## 1. Title · 0:00–0:45                    a beat (or "## Beat 1: Title (0:45)", or any ## heading)
//     *Screen:* …                              what's on screen
//     **Say** / **Do** / **Watch**             sections (or "### Say"); "**Do:** text" inline; > quotes are said
//     *(If …)* text                            inside the Say quotes: an alternative line
//     **If** …                                 a watch-out for this beat
//   ## If something goes wrong                 watch-outs: "- **Label:** text"; one naming "beat N" goes to that beat
//   ## After the talk                          the End step
function parseMarkdown(text) {
  const src = String(text).replace(/\r/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const rows = src.split('\n');
  const quoted = rows.some(r => /^\s*>\s*\S/.test(r));
  const out = { title: '', parts: [], beats: [], backstage: { do: [], watch: [] }, troubles: [], after: [] };
  let where = null, beat = null, part = null, section = null, para = [], inFence = false;
  const flushSay = () => {
    if (!para.length) return;
    const t = clean(para.join(' ')); para = [];
    if (!t || !beat) return;
    const alt = /^\*\((If [^)]*)\)\*\s*(.*)$/s.exec(t);
    beat.say.push(alt ? { alt: alt[1], text: alt[2].trim() } : { text: t });
  };
  const startBeat = h => {
    flushSay();
    const b = beatHead(h);
    beat = { n: b.n, title: b.title || `Beat ${out.beats.length + 1}`, start: b.start, end: b.end, dur: b.dur, part: part ? part.n : null, screen: '', say: [], do: [], watch: [] };
    out.beats.push(beat); where = 'beat'; section = quoted ? null : 'say';
  };
  for (const raw of rows) {
    if (/^\s*```/.test(raw)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const line = raw.replace(/\s+$/, '');
    const h = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (h && h[1].length <= 2) {
      flushSay();
      const t = clean(h[2].replace(/\*\*/g, ''));
      const pm = /^part\s+(\d+)\s*[·:.\-–—]\s*(.+?)(?:\s*·\s*([^·]+))?$/i.exec(t);
      if (h[1].length === 1 && pm) { part = { n: +pm[1], title: pm[2].trim(), time: (pm[3] || '').trim(), summary: '', from: null }; out.parts.push(part); where = 'part'; beat = null; continue; }
      if (h[1].length === 1) { if (!out.title) out.title = t.replace(/^.*?script:\s*/i, ''); where = null; beat = null; continue; }
      if (SPECIAL.backstage.test(t)) { where = 'backstage'; beat = null; continue; }
      if (SPECIAL.watch.test(t)) { where = 'troubles'; beat = null; continue; }
      if (SPECIAL.after.test(t)) { where = 'after'; beat = null; continue; }
      startBeat(t); continue;
    }
    if (/^---+$/.test(line.trim())) { flushSay(); if (where === 'beat') where = 'gap'; continue; }
    if (where === 'part') { if (line.trim()) part.summary = clean(part.summary + ' ' + line); continue; }
    if (where === 'backstage') { const li = listItem(line); if (li) out.backstage.do.push(li); continue; }
    if (where === 'after') { if (line.trim()) { const li = listItem(line); out.after.push(li ? li : { level: 0, text: clean(line) }); } continue; }
    if (where === 'troubles') {
      const li = listItem(line);
      if (li && li.level === 0) out.troubles.push({ text: li.text, sub: [] });
      else if (li && out.troubles.length) out.troubles[out.troubles.length - 1].sub.push(li.text);
      continue;
    }
    if (where !== 'beat') continue;
    const t = line.trim();
    if (h) { flushSay(); const s = /^(say|do|watch|watch-outs?|clicks)\b/i.exec(clean(h[2])); if (s) section = /^do|clicks/i.test(s[1]) ? 'do' : /^watch/i.test(s[1]) ? 'watch' : 'say'; continue; }
    const scr = /^\*?Screen:?\*?:?\s*(.+)$/i.exec(t);
    if (scr && /^\*?screen/i.test(t)) { beat.screen = clean(scr[1]); continue; }
    const sec = /^\*\*(Say|Do|Watch|Watch-outs|Clicks)\*\*:?\s*$/i.exec(t) || /^(Say|Do|Watch|Clicks):\s*$/i.exec(t);
    if (sec) { flushSay(); section = /^(do|clicks)/i.test(sec[1]) ? 'do' : /^watch/i.test(sec[1]) ? 'watch' : 'say'; continue; }
    const inl = /^\*\*(Do|Say|Watch)(?::\*\*|\*\*:)\s*(.+)$/i.exec(t) || /^(Do|Watch):\s+(.+)$/i.exec(t);
    if (inl) { flushSay(); const k = inl[1].toLowerCase(); if (k === 'say') beat.say.push({ text: clean(inl[2]) }); else beat[k].push(k === 'do' ? { level: 0, text: clean(inl[2]) } : clean(inl[2])); continue; }
    if (/^\*\*If\*\*/.test(t)) { flushSay(); beat.watch.push(clean(t)); continue; }
    const q = /^>\s?(.*)$/.exec(t);
    if (q) { if (clean(q[1])) { if (/^\*\(If /.test(q[1]) && para.length) flushSay(); para.push(q[1]); } else flushSay(); continue; }
    flushSay();
    if (!t) continue;
    const li = listItem(line);
    if (section === 'watch') { beat.watch.push(clean(li ? li.text : t)); continue; }
    if (section === 'do' || (quoted && li)) { if (li) beat.do.push(li); else if (section === 'do') beat.do.push({ level: 0, text: clean(t) }); continue; }
    if (!quoted && section === 'say') { para.push(li ? li.text : t); flushSay(); }
  }
  flushSay();
  return out;
}

// ---- plain text ----------------------------------------------------------------------------------------------------
//   Title: The talk                 (optional)
//   Beat 1: Title (0:45)            a beat; "Beat 1 · Title · 0:00–0:45" too
//   Screen: …   Do: …   Watch: …    its screen, a click, a watch-out
//   any other line                  said, word for word (one paragraph per line)
// Lines before the first beat are the Start step's clicks. With no "Beat" lines, each paragraph is a beat.
function parseText(text) {
  const rows = String(text).replace(/\r/g, '').split('\n');
  const out = { title: '', parts: [], beats: [], backstage: { do: [], watch: [] }, troubles: [], after: [] };
  const hasBeats = rows.some(r => /^\s*(beat|scene|step)\s+\d+\b/i.test(r));
  let beat = null;
  const start = h => { const b = beatHead(h); beat = { n: b.n, title: b.title || `Beat ${out.beats.length + 1}`, start: b.start, end: b.end, dur: b.dur, part: null, screen: '', say: [], do: [], watch: [] }; out.beats.push(beat); };
  for (const raw of rows) {
    const t = clean(raw);
    if (!hasBeats && !t) { beat = null; continue; }
    if (!t) continue;
    const ti = /^title:\s*(.+)$/i.exec(t); if (ti && !out.beats.length) { out.title = ti[1]; continue; }
    if (hasBeats && /^(beat|scene|step)\s+\d+\b/i.test(t)) { start(t); continue; }
    if (!hasBeats && !beat) start(`${out.beats.length + 1}`);
    const kv = /^(screen|do|watch|if something goes wrong|say):\s*(.*)$/i.exec(t);
    const li = listItem(raw);
    if (!beat) { out.backstage.do.push(li || { level: 0, text: t }); continue; }
    if (kv) { const k = kv[1].toLowerCase(); if (k === 'screen') beat.screen = kv[2]; else if (k === 'do') beat.do.push({ level: 0, text: kv[2] }); else if (k === 'say') beat.say.push({ text: kv[2] }); else beat.watch.push(kv[2]); continue; }
    beat.say.push({ text: li ? li.text : t });
  }
  if (!hasBeats) out.beats.forEach(b => { if (/^\d+$/.test(b.title) || /^Beat \d+$/.test(b.title)) b.title = (b.say[0] ? b.say[0].text.split(/\s+/).slice(0, 6).join(' ') : b.title); });
  return out;
}

// ---- RunLines (.sk) ------------------------------------------------------------------------------------------------
//   { title, rows: [{ time: "~40s", narrative, demo_actions }] }: a row is a beat; each line of its narrative is said;
//   its demo actions (split at " · ") are its clicks, a leading "[TAG]" its title.
function parseRunLines(sk) {
  const out = { title: clean(sk.title), parts: [], beats: [], backstage: { do: [], watch: [] }, troubles: [], after: [] };
  for (const row of sk.rows || []) {
    const acts = clean(row.demo_actions);
    const tag = /^\[([^\]]+)\]\s*/.exec(acts);
    const narrative = String(row.narrative || '').split('\n').map(clean).filter(Boolean);
    const title = tag ? tag[1].replace(/^./, c => c.toUpperCase()).replace(/\B[A-Z]+/g, s => s.toLowerCase()) : (narrative[0] || '').split(/\s+/).slice(0, 6).join(' ');
    const doLines = (tag ? acts.slice(tag[0].length) : acts).split(/\s+·\s+/).map(clean).filter(Boolean).map(text => ({ level: 0, text }));
    out.beats.push({ n: null, title: title || `Beat ${out.beats.length + 1}`, start: null, end: null, dur: duration(row.time), part: null, screen: '', say: narrative.map(text => ({ text })), do: doLines, watch: [] });
  }
  return out;
}

export function parseScript(text, name = 'script.md') {
  const ext = extname(name).toLowerCase();
  let s;
  if (ext === '.sk' || /^\s*\{[\s\S]*"rows"\s*:/.test(text)) s = parseRunLines(JSON.parse(text));
  else if (ext === '.md' || ext === '.markdown' || /^#{1,2}\s/m.test(text)) s = parseMarkdown(text);
  else s = parseText(text);
  // Numbers: as written when they run 1, 2, 3 …; otherwise in order.
  const ok = s.beats.every((b, i) => b.n === i + 1);
  s.beats.forEach((b, i) => { b.n = ok ? b.n : i + 1; });
  // Times: ranges as written; durations add up from 0:00.
  let t = 0;
  for (const b of s.beats) {
    if (b.start == null && b.dur != null) { b.start = t; b.end = t + b.dur; }
    if (b.end != null) t = b.end;
    delete b.dur;
  }
  // Parts: each starts at its first beat.
  for (const p of s.parts) { const f = s.beats.find(b => b.part === p.n); p.from = f ? f.n : null; }
  return s;
}

// Watch-outs from the script's "If something goes wrong": an item (or one of its sub-items) that names a beat ("beat
// 8", "beats 10 and 11", "beats 4–7") shows on those beats; the rest on the Start step, read before the talk.
const beatRefs = t => {
  const out = new Set();
  for (const m of String(t).matchAll(/\bbeats?\s+(\d+)(?:\s*(?:[–—-]|to)\s*(\d+))?((?:\s*(?:,|and|&)\s*\d+)*)/gi)) {
    const a = +m[1], b = m[2] ? +m[2] : a;
    for (let i = a; i <= b; i++) out.add(i);
    for (const x of (m[3] || '').match(/\d+/g) || []) out.add(+x);
  }
  return [...out];
};
function troublesFor(s) {
  const per = {};
  const add = (n, t) => { (per[n] = per[n] || []).push(t); };
  for (const it of s.troubles) {
    const label = (/^\*\*(.+?):?\*\*:?/.exec(it.text) || [])[1];
    let placed = false;
    for (const sub of it.sub) { const r = beatRefs(sub); if (r.length) { placed = true; for (const n of r) add(n, label ? `**${label.replace(/:$/, '')}:** ${sub}` : sub); } }
    const r = beatRefs(it.text);
    if (r.length) { placed = true; for (const n of r) add(n, it.text); }
    if (!placed) add(0, it.text + (it.sub.length ? ' ' + it.sub.join(' ') : ''));
  }
  return per;
}

// ---- the stage: where each beat is ---------------------------------------------------------------------------------
// A script beat n is the replica's ⌥n when the flow has that beat; demo.json presenter.beats can say otherwise:
//   "presenter": { "beats": { "10": { "jump": 9, "go": [["backup", "p57-pending"]] } } }
// (a beat key, then screens to go to, each [app, state] or { app, state, morph: true }). A beat with neither shares the
// screen the beat before it ends on: it has no screen of its own (a title slide, a closing line), and → steps the
// window to it while the stage stays.
export function stagePlan(flow, beatCount, cfg = {}) {
  const P = (cfg.presenter || {}).beats || {};
  const fb = flow.beats || [];
  const landing = spec => {
    if (!spec) return null;
    const g = (spec.go || []).map(x => Array.isArray(x) ? { app: x[0], state: x[1] } : x);
    if (g.length) return { app: g[g.length - 1].app, state: g[g.length - 1].state };
    const b = fb[spec.jump];
    return b ? { app: b.active, state: b.states[b.active] } : null;
  };
  const beats = [];
  for (let n = 0; n <= beatCount + 1; n++) {
    let spec = P[n] ? { jump: P[n].jump, go: (P[n].go || []).map(x => Array.isArray(x) ? { app: x[0], state: x[1] } : x) } : n <= beatCount && n < fb.length && n <= 9 ? { jump: n, go: [] } : null;
    let own = !!spec;
    if (!spec) spec = { ...beats[n - 1], own: undefined };
    const lands = landing(spec) || (beats[n - 1] || {}).lands || null;
    beats.push({ n, jump: spec.jump, go: spec.go || [], lands, own });
  }
  // Which beats each screen belongs to: its own landing, and every screen the recorded run-through reaches between
  // one beat's landing and the next's.
  const key = l => l && `${l.app}:${l.state}`;
  const screens = {};
  const put = (k, n) => { if (!k) return; const a = screens[k] = screens[k] || []; if (!a.includes(n)) a.push(n); };
  for (const b of beats) put(key(b.lands), b.n);
  const land = {}; for (const b of beats) if (b.lands) (land[key(b.lands)] = land[key(b.lands)] || []).push(b.n);
  const b0 = fb[0];
  if (b0) {
    const cur = { ...b0.states }; let active = b0.active, beat = 0;
    const visit = () => {
      const k = `${active}:${cur[active]}`;
      const ahead = (land[k] || []).filter(n => n > beat);
      if (ahead.length) beat = Math.min(...ahead);
      put(k, beat);
    };
    for (const s of flow.path || []) {
      if (s.app) active = s.app;
      if (s.checkpoint && flow.states[s.checkpoint]) { const st = flow.states[s.checkpoint]; cur[st.app] = s.checkpoint; active = st.app; }
      visit();
    }
  }
  for (const k of Object.keys(screens)) screens[k].sort((a, b) => a - b);
  const rules = ((cfg.presenter || {}).screens || []).map(([app, re, list]) => [app, re, list]);
  return { beats, screens, rules };
}

// ---- the keys ------------------------------------------------------------------------------------------------------
function keyList(flow) {
  const k = [['**⌥0**', 'Reset: everything back to the start.']];
  const n = Math.min(9, (flow.beats || []).length - 1);
  if (n >= 1) k.push([`**⌥1${n > 1 ? ` … ⌥${n}` : ''}**`, 'Jump to the start of a beat.']);
  for (const a of flow.apps || []) if (a.key) k.push([`**⌥${a.key.toUpperCase()}**`, `Switch to ${a.title || a.id}.`]);
  k.push(['**⌥← ⌥→**', 'Previous or next app.'], ['**⌥P**', 'Types the scripted text into the field you\'re in. Press Enter yourself.'], ['**⌥N**', 'The screen\'s next scripted step.']);
  if ((flow.focus || []).length) k.push(['**⌥F**', 'Zooms to the next focus point and draws its mark. **⌥⇧F** goes back one.'], ['**Esc**, **↑ ↓**', 'While zoomed: Esc zooms out; ↑/↓ or the wheel zoom a step.']);
  k.push(['**⌥G**', 'This window (the presenter guide). Put it on the laptop screen. While it\'s open, → also steps through beats with no screen of their own.']);
  k.push(['**Page Down**, **Page Up**', 'In this window (a clicker): move the stage on or back: the screen\'s next step, then the next beat.'],
    ['**→ ←**, **Space**', 'In this window: read the next or previous beat; the stage stays put. **⌥0–⌥9** show that beat. **Esc** comes back to the stage\'s beat. **Go to this beat on stage** moves the stage there.']);
  return k;
}

// ---- notes.json ----------------------------------------------------------------------------------------------------
export const scriptPath = demo => {
  const p = (demo.cfg.presenter || {}).script;
  if (p) return join(demo.dir, p);
  for (const f of ['presenter/script.md', 'presenter/script.txt', 'presenter/script.sk', 'script.md', 'script.txt', 'script.sk']) if (existsSync(join(demo.dir, f))) return join(demo.dir, f);
  return join(demo.dir, 'script.md');
};
const shotName = (n, app) => `beat-${String(n).padStart(2, '0')}${app ? '-' + app : ''}`;

export function buildNotes(demo, flow, text, name) {
  const s = parseScript(text, name);
  const N = s.beats.length, LAST = N + 1;
  const plan = stagePlan(flow, N, demo.cfg);
  const troubles = troublesFor(s);
  const appTitle = id => ((flow.apps || []).find(a => a.id === id) || {}).title || id;
  const partOf = n => { const p = s.parts.filter(x => x.from != null && x.from <= n).pop(); return p ? `Part ${p.n} · ${p.title}` : ''; };
  // Focus points, per beat, in order: what ⌥F shows on each.
  const focus = {};
  // A point's words: its label (the script's line, or the editor's), else what it finds; scenecast's script points keep
  // the line's number ("1.4") in `line`, not its words.
  const words = p => p.label || (typeof p.line === 'string' && !/^\d+(\.\d+)*$/.test(p.line) ? p.line : '') || (typeof p.find === 'string' ? p.find : '') || p.id;
  for (const p of flow.focus || []) { const n = p.beat || 0; (focus[n] = focus[n] || []).push(words(p)); }
  // Pictures: where each beat lands, and the first screen it shows on each other app (a trace, a preview).
  const shots = [];
  const shotFor = {};
  const addShot = (name, l, beatsOf) => { if (!l) return null; let x = shots.find(q => q.app === l.app && q.state === l.state); if (!x) { x = { name, app: l.app, state: l.state, beats: [] }; shots.push(x); } for (const b of beatsOf) if (!x.beats.includes(b)) x.beats.push(b); return x.name; };
  for (const b of plan.beats) shotFor[b.n] = addShot(shotName(b.n), b.lands, [b.n]);
  const extra = {};
  for (const [k, list] of Object.entries(plan.screens)) {
    const [app, state] = k.split(':');
    for (const n of list) {
      const l = plan.beats[n] && plan.beats[n].lands;
      if (!l || l.app === app || (extra[n] && extra[n][app])) continue;
      (extra[n] = extra[n] || {})[app] = addShot(shotName(n, app), { app, state }, [n]);
    }
  }
  const keyOf = n => { const b = plan.beats[n]; return b && b.own && b.jump === n && n <= 9 && !(b.go || []).length ? `⌥${n}` : null; };
  const beatName = n => n === 0 ? 'Start' : n === LAST ? 'End' : `Beat ${n}`;
  const nextOf = n => {
    if (n === LAST) return ['⌥0', 'Back to the start'];
    const nb = n + 1, b = n + 1 === LAST ? null : s.beats[nb - 1], cur = n > 0 ? s.beats[n - 1] : null;
    const same = plan.beats[nb] && plan.beats[n] && JSON.stringify(plan.beats[nb].lands) === JSON.stringify(plan.beats[n].lands);
    // How the stage gets there: → when it starts on this screen, its beat key, else this beat's last click.
    const last = cur && cur.do.filter(d => !d.level).pop();
    const act = same ? (keyOf(nb) ? `→ (or ${keyOf(nb)})` : '→') : keyOf(nb) || (last ? last.text : 'Go to this beat on stage');
    return [act, nb === LAST ? 'End' : b.title];
  };
  const screenLine = n => { const l = plan.beats[n] && plan.beats[n].lands; return l ? `${appTitle(l.app)}${keyOf(n) ? ` (**${keyOf(n)}**)` : ''}` : ''; };
  const start = { n: 0, label: 'S', title: s.beats[0] && plan.beats[1] && !plan.beats[1].own ? s.beats[0].title : 'Before the talk', time: '', start: 0, end: null, part: 'Backstage', screen: screenLine(0) || 'the start (**⌥0**)',
    say: [], do: s.backstage.do.length ? s.backstage.do : [{ level: 0, text: 'In Scenecast, **Present**: the stage goes full screen on the projector, and this guide opens on your laptop. Press **⌥0**.' }, { level: 0, text: 'Keep this window on the laptop screen (**⌥G** on the stage brings it back). Its dot should read **In sync**.' }],
    watch: troubles[0] || [], focus: focus[0] || [], next: nextOf(0), shot: shotFor[0], shotApp: extra[0] || {} };
  const beats = s.beats.map(b => ({
    n: b.n, label: String(b.n), title: b.title, time: b.start != null && b.end != null ? `${clock(b.start)}–${clock(b.end)}` : '', start: b.start, end: b.end,
    part: partOf(b.n), screen: b.screen || screenLine(b.n), say: b.say, do: b.do, watch: [...(troubles[b.n] || []), ...b.watch],
    focus: focus[b.n] || [], next: nextOf(b.n), shot: shotFor[b.n], shotApp: extra[b.n] || {},
  }));
  const end = { n: LAST, label: 'End', title: s.after.length ? 'After the talk' : 'End', time: '', start: null, end: null, part: 'After the talk', screen: 'the last screen stays up',
    say: [], do: s.after, watch: troubles[LAST] || [], focus: [], next: nextOf(LAST), shot: shotFor[LAST], shotApp: {} };
  const shotLabels = {};
  for (const x of shots) shotLabels[x.name] = /-[a-z]/.test(x.name.slice(8)) ? `the ${appTitle(x.app)}` : '';
  return {
    kit: 1, engine: 'scenecast', title: s.title || demo.cfg.title || demo.name, script: name, channel: `scenecast-presenter:${demo.name}`,
    parts: s.parts.map(p => ({ n: p.n, title: p.title, time: p.time, summary: p.summary, from: p.from })),
    beats: [start, ...beats, end], keys: keyList(flow),
    stage: { beats: plan.beats, screens: plan.screens, rules: plan.rules }, shots, shotLabels,
    names: Object.fromEntries([start, ...beats, end].map(b => [b.n, beatName(b.n)])),
  };
}

export function writeNotes(demo, flow, file = scriptPath(demo)) {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const notes = buildNotes(demo, flow, text, basename(file));
  notes.script = relative(demo.dir, file).split('\\').join('/');
  mkdirSync(join(demo.dir, 'presenter'), { recursive: true });
  writeFileSync(join(demo.dir, 'presenter', 'notes.json'), JSON.stringify(notes, null, 1) + '\n');
  return notes;
}

// Before there's a script: the guide from the recording (each beat's plain name and its clicks and prompts), so the
// presenter can see where a prompt or a click is expected. A script's notes are never replaced.
export function recordingNotes(demo, flow) {
  const notes = buildNotes(demo, flow, scriptFromFlow(flow, demo.cfg.title || demo.name), 'recording.md');
  // Its pictures too (guide-shots makes them after the build): the guide showed an empty black frame without them.
  return Object.assign(notes, { script: null, fromRecording: true });
}
export function writeRecordingNotes(demo, flow) {
  if (existsSync(scriptPath(demo))) return false;
  const out = join(demo.dir, 'presenter', 'notes.json');
  if (existsSync(out)) { try { if (!JSON.parse(readFileSync(out, 'utf8')).fromRecording) return false; } catch (e) { return false; } }
  const notes = recordingNotes(demo, flow);
  mkdirSync(join(demo.dir, 'presenter'), { recursive: true });
  writeFileSync(out, JSON.stringify(notes, null, 1) + '\n');
  return true;
}
