// A presenter's script, as lines: plain text, Markdown, or a RunLines file (.sk, JSON). Beats are optional.
//   Markdown  ## headings (or "Beat 2: …" lines) start beats; when the file has > quotes, the quotes are the spoken lines
//             and everything else is notes; "**Do:** …" after a line is its cue (what to do while saying it).
//   Plain     each non-empty line is a spoken line ("- " and "1. " list markers dropped); "Beat N" lines start beats.
//   RunLines  { title, rows: [{ narrative, demo_actions }] }: a row is a beat, each line of its narrative a line.
// Every line gets an id: "<beat>.<n>" with beats, else "<n>".
const clean = s => String(s || '').replace(/\r/g, '').replace(/\s+/g, ' ').trim();
const unmd = s => clean(s).replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1').replace(/(^|\W)\*([^*]+)\*(?=\W|$)/g, '$1$2').replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
const BEAT = /^(?:beat|scene|part)\s+(\d+)\b\s*[:·.\-–—]?\s*(.*)$/i;
const CUE = /^\s*(?:\*\*|__)?(?:do|cue|action)(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.*)$/i;

export function parseScript(text, name = 'script.md') {
  if (/\.sk$/i.test(name) || /^\s*\{[\s\S]*"rows"\s*:/.test(text)) return fromRunLines(JSON.parse(text));
  const src = String(text).replace(/\r/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/^```[\s\S]*?^```/gm, '');
  const rows = src.split('\n');
  const quoted = rows.some(r => /^\s*>\s*\S/.test(r));
  const beats = [], lines = [];
  let title = '', beat = null, para = null;
  const startBeat = t => { beat = { n: beats.length + 1, title: unmd(t), cue: '' }; beats.push(beat); };
  const flush = () => { if (para && clean(para)) lines.push({ beat: beat ? beat.n : 0, text: unmd(para), cue: '' }); para = null; };
  for (const raw of rows) {
    const r = raw.trimEnd();
    const h = /^(#{1,6})\s+(.*)$/.exec(r.trim());
    if (h) {
      flush();
      if (h[1].length === 1 && !title && !beats.length && !lines.length) title = unmd(h[2]);
      else startBeat(h[2].replace(/^(?:beat|scene|part)\s+\d+\s*[:·.\-–—]?\s*/i, ''));
      continue;
    }
    const b = BEAT.exec(r.trim());
    if (b && !quoted) { flush(); startBeat(b[2] || `Beat ${b[1]}`); continue; }
    const cue = CUE.exec(r);
    if (cue) {
      flush();
      const last = lines[lines.length - 1];
      if (last && last.beat === (beat ? beat.n : 0)) last.cue = clean([last.cue, unmd(cue[1])].filter(Boolean).join(' '));
      else if (beat) beat.cue = unmd(cue[1]);
      continue;
    }
    if (quoted) {
      const q = /^\s*>\s?(.*)$/.exec(r);
      if (q && clean(q[1])) para = para ? para + ' ' + q[1] : q[1];
      else flush();
      continue;
    }
    // Plain text: one line per line of the file.
    flush();
    if (r.trim()) { para = r.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''); flush(); }
  }
  flush();
  return finish({ title, beats, lines });
}

function fromRunLines(sk) {
  const beats = [], lines = [];
  (sk.rows || []).forEach((row, i) => {
    const n = i + 1;
    beats.push({ n, title: clean(String(row.demo_actions || '').replace(/^\[([^\]]*)\][\s\S]*$/, '$1')) || `Beat ${n}`, cue: clean(row.demo_actions) });
    for (const l of String(row.narrative || '').split('\n')) if (clean(l)) lines.push({ beat: n, text: clean(l), cue: '' });
  });
  return finish({ title: clean(sk.title), beats, lines });
}

function finish(s) {
  const per = {};
  s.lines.forEach((l, i) => { l.index = i; per[l.beat] = (per[l.beat] || 0) + 1; l.id = s.beats.length ? `${l.beat}.${per[l.beat]}` : String(i + 1); });
  return s;
}
