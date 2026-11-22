// A talk track, read for making the demo from it: beats, each line's words (Say), what to do (Do) and what's on screen,
// and the prompts typed on screen. Reads what presenters write:
//   Word (.docx)       converted to Markdown first (docx.mjs)
//   Markdown           beats are the most common level of numbered headings ("## 2. Title · 0:45–1:30", "### 1 · Title
//                      (screen)", "## Beat 2 · TITLE (~40s)"), else ## headings. In a beat: tables with a Say column
//                      (and Do or Screen), > quotes, “quoted” paragraphs, **Do:** after a line (its Do) or before any
//                      (the beat's), **Say** / **Do** sections, *Screen:* and *Stage:* lines. A "Prompts" section lists the
//                      prompts ("1. Ask: “…”").
//   RunLines (.sk)     a row is a beat; each narrative line is said; demo actions are its Do, minus stage cues
//                      ("ARUN: …", <…>, DO NOT CLICK)
//   plain text         "Beat 1: Title", "Say: …", "Do: …", "Screen: …"; other lines are said
// Line ids are "<beat>.<n>", beats numbered from 1 in order (a script's own numbers are kept as `label`).
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { docxToMarkdown } from './docx.mjs';

const clean = s => String(s || '').replace(/\r/g, '').replace(/\s+/g, ' ').trim();
const unmd = s => clean(s).replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1').replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,:;!?]|$)/g, '$1$2').replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\\\|/g, '|');
const QUOTED = /^\s*[“"]([^”"]{8,})[”"]\s*(.*)$/s;
const BEATHEAD = /^(?:(beat|scene|step|part)\s+)?(\d+)\s*(?:[.:·)\-–—]\s*|\s+)(.*)$/i;
const SPECIAL = { prompts: /^(the\s+)?prompts?\b|^prompts typed/i, backstage: /^(backstage|before( the talk)?|set ?up|prep)\b/i, watch: /^(if something goes wrong|watch[- ]?outs?|troubleshooting)\b/i };
const COLS = {
  say: /^(say|says|said|talk ?track|narration|narrative|script|line|lines|what (i|you|to) say|voice ?over|vo|presenter)$/i,
  do: /^(do|action|actions|click|clicks|demo|demo actions?|steps?|what (i|you|to) do|drive)$/i,
  screen: /^(screen|on screen|what'?s on screen|visuals?|shows?|what (the audience|they) sees?)$/i,
  id: /^(#|no\.?|n|line|id)$/i,
};
// Stage cues, not clicks: a speaker's line ("ARUN: …"), <directions>, DO NOT CLICK, CUE.
const STAGE = /^(?:[A-Z][A-Z .'’-]{1,30}:\s|<[^>]+>|do not click\b|cue\b|stage\b)/i;

// A beat heading's number, title, time and the screen it names: "1 · One question (Teams, then Copilot)".
function beatHead(h) {
  let t = unmd(h);
  const out = { label: null, title: '', time: '', screen: '' };
  const m = BEATHEAD.exec(t);
  if (m) { out.label = m[2]; t = m[3]; }
  const range = /\s*[·|]?\s*\(?\s*(~?\s*\d+:\d\d\s*[–—-]\s*\d+:\d\d|~?\s*\d+(?:\.\d+)?\s*(?:s|sec|secs|seconds|m|min|mins|minutes)\b|~?\d+m\d+s)\s*\)?\s*$/i.exec(t);
  if (range) { out.time = range[1].replace(/\s+/g, ''); t = t.slice(0, range.index); }
  const paren = /\s*\(([^()]{4,})\)\s*$/.exec(t);
  if (paren) { out.screen = paren[1]; t = t.slice(0, paren.index); }
  out.title = t.replace(/[\s·|:–—-]+$/, '').trim();
  return out;
}

// Markdown as blocks: headings, tables, quotes (joined), list items and paragraphs.
function blocksOf(text) {
  const rows = String(text).replace(/\r/g, '').replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const out = [];
  let para = null, quote = null, fence = false;
  const flush = () => { if (para) out.push({ kind: 'para', text: clean(para.join(' ')) }); if (quote) out.push({ kind: 'quote', text: clean(quote.join(' ')) }); para = quote = null; };
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i], t = raw.trim();
    if (/^```/.test(t)) { flush(); fence = !fence; continue; }
    if (fence) continue;
    if (!t) { flush(); continue; }
    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(t))) { flush(); out.push({ kind: 'heading', level: m[1].length, text: clean(m[2]) }); continue; }
    if (/^\|.*\|$/.test(t) && /^\|?\s*:?-{3,}/.test((rows[i + 1] || '').trim())) {
      flush();
      const cells = l => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(c => unmd(c));
      const header = cells(t), body = [];
      for (i += 2; i < rows.length && /^\|.*\|$/.test(rows[i].trim()); i++) body.push(cells(rows[i]));
      i--;
      out.push({ kind: 'table', header, rows: body });
      continue;
    }
    if (/^---+$|^\*\*\*+$/.test(t)) { flush(); out.push({ kind: 'rule' }); continue; }
    if ((m = /^>\s?(.*)$/.exec(t))) { if (para) flush(); if (!clean(m[1])) { flush(); continue; } (quote = quote || []).push(m[1]); continue; }
    if ((m = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/.exec(raw))) { flush(); out.push({ kind: 'item', level: Math.floor(m[1].replace(/\t/g, '  ').length / 2), text: clean(m[2]) }); continue; }
    if (quote) flush();
    // A line that starts with a label (Do:, *Screen:*) starts its own paragraph; a hard break ("  ") ends one.
    if (para && /^(?:\*{1,2}|__)?(?:do|say|screen|stage|watch|cue|action)(?:\*{1,2}|__)?\s*:/i.test(t)) flush();
    (para = para || []).push(t);
    if (/ {2,}$|\\$/.test(raw)) flush();
  }
  flush();
  return out;
}

// A prompt: "1. Ask: “…”", "**Payoff:** “…” (no plugin named)", "Prompt 2: …".
function promptOf(t, n) {
  const s = unmd(t);
  const m = /^(?:(\d+)[.)]\s*)?(?:(?:prompt\s*)?([^:“"]{1,30}):\s*)?[“"]([^”"]+)[”"]/i.exec(s);
  if (!m) return null;
  const label = clean(m[2] || '');
  return { n: m[1] ? +m[1] : n, label: /^prompt\s*\d*$/i.test(label) ? '' : label, text: clean(m[3]) };
}

function fromMarkdown(text) {
  const blocks = blocksOf(text);
  const heads = blocks.filter(b => b.kind === 'heading');
  // The beat level: where most headings look like numbered beats (parts don't count).
  const per = {};
  for (const h of heads) { const m = BEATHEAD.exec(unmd(h.text)); if (m && !/^part$/i.test(m[1] || '') && !Object.values(SPECIAL).some(r => r.test(m[3]))) per[h.level] = (per[h.level] || 0) + 1; }
  const best = Object.entries(per).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  const numbered = !!best;
  const level = best ? +best[0] : heads.some(h => h.level === 2) ? 2 : null;
  const track = { title: '', prompts: [], beats: [], backstage: [] };
  const quotedScript = blocks.some(b => b.kind === 'quote' || b.kind === 'table' && b.header.some(c => COLS.say.test(c)) || b.kind === 'para' && QUOTED.test(b.text));
  let beat = null, where = null, section = null, lastLine = null;
  const startBeat = h => {
    const b = beatHead(h);
    beat = { n: track.beats.length + 1, label: b.label, title: b.title || `Beat ${track.beats.length + 1}`, time: b.time, screen: b.screen, stage: [], do: [], lines: [] };
    track.beats.push(beat); where = 'beat'; section = null; lastLine = null;
  };
  const addLine = (say, extra = {}) => { const l = { id: '', say: clean(say), do: [], screen: '', notes: [], ...extra }; beat.lines.push(l); lastLine = l; return l; };
  if (level === null) startBeat('1');
  for (const b of blocks) {
    if (b.kind === 'heading') {
      const t = unmd(b.text);
      if (level !== null && b.level <= level) {
        const special = Object.entries(SPECIAL).find(([, r]) => r.test(t));
        if (special) { where = special[0]; beat = null; continue; }
        if (b.level === level && (!numbered || BEATHEAD.test(t) && !/^part\s/i.test(t))) { startBeat(b.text); continue; }
        if (!track.title && b.level === Math.min(...heads.map(x => x.level))) track.title = t.replace(/^.*?script:\s*/i, '');
        where = null; beat = null; continue;
      }
      if (where === 'beat') { const s = /^(say|do|watch|clicks|screen)\b/i.exec(t); section = s ? s[1].toLowerCase().replace('clicks', 'do') : section; }
      continue;
    }
    if (where === 'prompts') { const p = promptOf(b.text || '', track.prompts.length + 1); if (p) track.prompts.push(p); continue; }
    if (where === 'backstage') { if (b.text) track.backstage.push(unmd(b.text)); continue; }
    if (where !== 'beat') continue;
    if (b.kind === 'rule') { section = null; continue; }
    if (b.kind === 'table') {
      const col = k => b.header.findIndex(c => COLS[k].test(c));
      const [say, dc, sc, ic] = ['say', 'do', 'screen', 'id'].map(col);
      if (say < 0) continue;
      for (const r of b.rows) if (clean(r[say])) addLine(r[say], { do: dc >= 0 && clean(r[dc]) ? [clean(r[dc])] : [], screen: sc >= 0 ? clean(r[sc]) : '', label: ic >= 0 ? clean(r[ic]) : undefined });
      continue;
    }
    if (b.kind === 'quote') { addLine(unmd(b.text)); continue; }
    const t = b.text;
    let m;
    if ((m = /^\*{0,2}(Do|Say|Watch|Screen|Stage|Clicks)\*{0,2}\s*:?\s*\*{0,2}\s*$/i.exec(t))) { section = m[1].toLowerCase().replace('clicks', 'do'); continue; }
    if ((m = /^(?:\*\*|__)?(Do|Action|Cue)(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.+)$/i.exec(t)) || (m = /^(?:\*\*)?(Do|Action|Cue):(?:\*\*)\s*(.+)$/i.exec(t))) {
      const what = unmd(m[2]);
      if (lastLine) lastLine.do.push(what); else beat.do.push(what);
      continue;
    }
    if ((m = /^\*{1,2}(Screen|Stage)\*{0,2}:?\*{0,2}:?\s*(.+)$/i.exec(t)) || (m = /^(Screen|Stage):\s*(.+)$/i.exec(t))) {
      const what = unmd(m[2]);
      if (/^stage$/i.test(m[1])) beat.stage.push(what);
      else if (lastLine) lastLine.notes.push(what);
      else beat.screen = beat.screen ? `${beat.screen}; ${what}` : what;
      continue;
    }
    if (b.kind === 'item') {
      if (section === 'say') { addLine(unmd(t)); continue; }
      if (section === 'watch' || section === 'screen' || section === 'stage') continue;
      if (section === 'do' || !quotedScript || lastLine === null) { beat.do.push({ text: unmd(t), level: b.level }); continue; }
      lastLine.do.push(unmd(t));
      continue;
    }
    // A paragraph: a quoted line (and what's after it: a note, often what's on screen), or words said in a plain script.
    if ((m = QUOTED.exec(t))) { const l = addLine(m[1]); const rest = unmd(m[2]).replace(/^[\s.,;:]+/, ''); if (rest) l.notes.push(rest.replace(/^\((.*)\)$/, '$1')); continue; }
    if (section === 'do') { beat.do.push({ text: unmd(t), level: 0 }); continue; }
    if (section === 'say' || !quotedScript) { addLine(unmd(t)); continue; }
  }
  return track;
}

function fromRunLines(sk) {
  const track = { title: clean(sk.title), prompts: [], beats: [], backstage: [] };
  for (const row of sk.rows || []) {
    const acts = clean(row.demo_actions);
    const tag = /^\[([^\]]+)\]\s*/.exec(acts);
    const parts = (tag ? acts.slice(tag[0].length) : acts).split(/\s+·\s+|(?=<[^>]+>)|(?<=>)\s*/).map(clean).filter(Boolean);
    const stage = parts.filter(p => STAGE.test(p) || /^[A-Z][A-Z .'’-]{1,30}:/.test(p));
    const narrative = String(row.narrative || '').split('\n').map(clean).filter(Boolean);
    const n = track.beats.length + 1;
    track.beats.push({ n, label: String(n), title: tag ? tag[1] : (narrative[0] || '').split(/\s+/).slice(0, 6).join(' '), time: clean(row.time), screen: '', stage, do: parts.filter(p => !stage.includes(p)).map(text => ({ text, level: 0 })), lines: narrative.map(say => ({ id: '', say, do: [], screen: '', notes: [] })) });
  }
  return track;
}

function fromPlain(text) {
  const track = { title: '', prompts: [], beats: [], backstage: [] };
  let beat = null, lastLine = null;
  const start = h => { const b = beatHead(h); beat = { n: track.beats.length + 1, label: b.label, title: b.title || `Beat ${track.beats.length + 1}`, time: b.time, screen: b.screen, stage: [], do: [], lines: [] }; track.beats.push(beat); lastLine = null; };
  for (const raw of String(text).replace(/\r/g, '').split('\n')) {
    const t = clean(raw);
    if (!t) continue;
    let m;
    if ((m = /^title:\s*(.+)$/i.exec(t)) && !track.beats.length) { track.title = m[1]; continue; }
    if ((m = /^(?:beat|scene|step)\s+(\d+\b.*)$/i.exec(t))) { start(m[1]); continue; }
    if (!beat) start('1');
    if ((m = /^(say|do|screen|stage):\s*(.*)$/i.exec(t))) {
      const k = m[1].toLowerCase();
      if (k === 'say') { lastLine = { id: '', say: m[2], do: [], screen: '', notes: [] }; beat.lines.push(lastLine); }
      else if (k === 'do') (lastLine ? lastLine.do : beat.do).push(lastLine ? m[2] : { text: m[2], level: 0 });
      else if (k === 'stage') beat.stage.push(m[2]);
      else if (lastLine) lastLine.screen = m[2]; else beat.screen = m[2];
      continue;
    }
    lastLine = { id: '', say: t.replace(/^(?:[-*+]|\d+[.)])\s+/, ''), do: [], screen: '', notes: [] };
    beat.lines.push(lastLine);
  }
  return track;
}

export function parseTalkTrack(text, name = 'script.md') {
  const ext = extname(name).toLowerCase();
  let track;
  if (ext === '.sk' || /^\s*\{[\s\S]*"rows"\s*:/.test(text)) track = fromRunLines(JSON.parse(text));
  else if (ext === '.md' || ext === '.markdown' || ext === '.docx' || /^#{1,6}\s|^\|.*\|$|^>\s/m.test(text)) track = fromMarkdown(text);
  else track = fromPlain(text);
  track.beats = track.beats.filter(b => b.lines.length || b.do.length);
  track.beats.forEach((b, i) => {
    b.n = i + 1;
    b.do = b.do.map(d => typeof d === 'string' ? { text: d, level: 0 } : d);
    b.lines.forEach((l, k) => { l.id = `${b.n}.${k + 1}`; });
  });
  // Prompts named in Do lines ("type prompt 2", "⌥P (prompt 1)") are filled in from the prompts section.
  return track;
}

// A talk track from a file: Word (.docx), RunLines (.sk), Markdown or plain text.
export function readTalkTrack(file) {
  if (/\.docx$/i.test(file)) return { ...parseTalkTrack(docxToMarkdown(readFileSync(file)), file), markdown: true };
  return parseTalkTrack(readFileSync(file, 'utf8'), file);
}
export function talkTrackText(file) {
  return /\.docx$/i.test(file) ? docxToMarkdown(readFileSync(file)) : readFileSync(file, 'utf8');
}
