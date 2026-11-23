// A Word document (.docx) as Markdown, so a talk track written in Word reads like one written in Markdown:
// headings (#), paragraphs, lists (- ), quotes (> ), bold (**) and tables (| a | b |), in order. Text only: no
// pictures, comments, deleted text or field codes. No dependencies: a .docx is a zip of XML parts, read with node:zlib.
import { inflateRawSync } from 'node:zlib';

// The files in a zip: { names, read(name) → Buffer | null }. Stored and deflated entries (what Word writes).
export function unzip(buf) {
  let e = buf.length - 22;
  const stop = Math.max(0, buf.length - 22 - 65535);
  while (e >= stop && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < stop) throw new Error('not a zip file');
  const count = buf.readUInt16LE(e + 10);
  const files = new Map();
  for (let i = 0, p = buf.readUInt32LE(e + 16); i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('a damaged zip file');
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    files.set(buf.toString('utf8', p + 46, p + 46 + nameLen), { method: buf.readUInt16LE(p + 10), size: buf.readUInt32LE(p + 20), at: buf.readUInt32LE(p + 42) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    names: [...files.keys()],
    read(name) {
      const f = files.get(name);
      if (!f) return null;
      if (buf.readUInt32LE(f.at) !== 0x04034b50) throw new Error(`a damaged zip file (${name})`);
      const start = f.at + 30 + buf.readUInt16LE(f.at + 26) + buf.readUInt16LE(f.at + 28);
      const data = buf.subarray(start, start + f.size);
      if (f.method === 0) return Buffer.from(data);
      if (f.method === 8) return inflateRawSync(data);
      throw new Error(`${name}: compression ${f.method} isn't supported`);
    },
  };
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] ?? m);
const attr = (a, name) => { const m = new RegExp(`\\b${name}="([^"]*)"`).exec(a); return m ? decode(m[1]) : null; };
const on = a => { const v = attr(a, 'w:val'); return v === null || !/^(0|false|off|none)$/i.test(v); };

// Paragraph styles: heading levels (from the style's name or outline level, through what it's based on), titles and
// quotes, so a Word file in any language reads the same.
function styleInfo(xml) {
  const raw = {};
  for (const m of String(xml || '').matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    const id = attr(m[1], 'w:styleId');
    if (!id) continue;
    const name = (/<w:name w:val="([^"]*)"/.exec(m[2]) || [])[1] || '';
    const outline = /<w:outlineLvl w:val="(\d)"/.exec(m[2]);
    raw[id] = { name: name.toLowerCase(), outline: outline ? +outline[1] : null, based: (/<w:basedOn w:val="([^"]*)"/.exec(m[2]) || [])[1] || null };
  }
  const kind = (id, depth = 0) => {
    const s = raw[id];
    const n = (s ? s.name : '') || String(id).toLowerCase();
    let m;
    if (/^title$/.test(n)) return { title: true };
    if ((m = /^heading\s*(\d)$/.exec(n))) return { heading: +m[1] };
    if (/quote/.test(n)) return { quote: true };
    if (s && s.outline !== null && s.outline < 9) return { heading: s.outline + 1 };
    return s && s.based && depth < 8 ? kind(s.based, depth + 1) : {};
  };
  return id => kind(id);
}

// The body's paragraphs and tables, in order: { p: { text, title, heading, quote, list } } or { table: [[cell]] }.
// Text boxes, pictures, deleted text, field codes and fallbacks are skipped with everything in them.
const SKIP = /^(w:(del|instrText|delText|drawing|pict|object|txbxContent|commentReference|footnoteReference|endnoteReference)|mc:Fallback)$/;
export function blocksOf(xml, styleOf = () => ({})) {
  const body = (/<w:body>([\s\S]*)<\/w:body>/.exec(xml) || [, xml])[1];
  const out = [], tables = [];
  let para = null, run = null, skip = 0;
  const cellOf = () => { const t = tables[tables.length - 1]; return t.cell || (t.cell = []); };
  const addText = t => {
    const last = para.runs[para.runs.length - 1];
    if (last && last.bold === run.bold) last.text += t; else para.runs.push({ bold: run.bold, text: t });
  };
  const tagRe = /<(\/?)([\w:]+)([^>]*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = tagRe.exec(body))) {
    if (m[5] !== undefined) { if (!skip && para && run && run.inText) addText(decode(m[5])); continue; }
    const [, close, tag, a, self] = m;
    if (SKIP.test(tag)) { if (!self) skip = Math.max(0, skip + (close ? -1 : 1)); continue; }
    if (skip) continue;
    if (tag === 'w:tbl') {
      if (!close) { tables.push({ rows: [], cell: null }); continue; }
      const t = tables.pop();
      if (!t) continue;
      if (tables.length) cellOf().push(t.rows.map(r => r.filter(Boolean).join(' · ')).filter(Boolean).join(' / '));
      else out.push({ table: t.rows });
      continue;
    }
    if (tag === 'w:tr' && tables.length) { if (!close) tables[tables.length - 1].rows.push([]); continue; }
    if (tag === 'w:tc' && tables.length) {
      const t = tables[tables.length - 1];
      if (!t.rows.length) t.rows.push([]);
      const row = t.rows[t.rows.length - 1];
      if (!close) { row.push(''); t.cell = []; } else { row[row.length - 1] = (t.cell || []).filter(Boolean).join(' / '); t.cell = null; }
      continue;
    }
    if (tag === 'w:p') {
      if (!close && !self) { para = { runs: [], style: null, list: null, outline: null }; continue; }
      if (close && para) {
        const text = mdRuns(para.runs);
        const k = para.style ? styleOf(para.style) : {};
        const heading = para.outline !== null && para.outline < 9 ? para.outline + 1 : k.heading;
        if (tables.length) cellOf().push(text);
        else if (text) out.push({ p: { text, title: !!k.title, heading: heading || null, quote: !!k.quote, list: para.list } });
        para = null;
      }
      continue;
    }
    if (!para) continue;
    if (tag === 'w:pStyle') para.style = attr(a, 'w:val');
    else if (tag === 'w:outlineLvl') para.outline = +attr(a, 'w:val');
    else if (tag === 'w:numPr' && !close) para.list = para.list ?? 0;
    else if (tag === 'w:ilvl') para.list = +attr(a, 'w:val') || 0;
    else if (tag === 'w:r') run = close ? null : { bold: false, inText: false };
    else if (!run) continue;
    else if (tag === 'w:b' && self) run.bold = on(a);
    else if (tag === 'w:t') run.inText = !close && !self;
    else if ((tag === 'w:tab' || tag === 'w:ptab') && self) addText(' ');
    else if ((tag === 'w:br' || tag === 'w:cr') && self) addText('\n');
    else if (tag === 'w:noBreakHyphen') addText('-');
  }
  return out;
}

// Runs as Markdown: bold runs in **, spaces kept outside the stars.
function mdRuns(runs) {
  return runs.map(r => {
    const t = r.text.replace(/[ \t]+/g, ' ');
    if (!r.bold || !t.trim()) return t;
    const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(t);
    return `${lead}**${core}**${trail}`;
  }).join('').replace(/\*\*\*\*/g, '').split('\n').map(l => l.trim()).join('\n').trim();
}

const cell = s => String(s || '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' / ');
export function blocksToMarkdown(blocks) {
  const hasTitle = blocks.some(b => b.p && b.p.title);
  const md = [];
  let inList = false;
  for (const b of blocks) {
    const isList = !!(b.p && b.p.list !== null && !b.p.title && !b.p.heading);
    if (inList && !isList) md.push('');
    inList = isList;
    if (b.table) {
      const rows = b.table.filter(r => r.some(c => c.trim()));
      if (!rows.length) continue;
      const w = Math.max(...rows.map(r => r.length));
      const line = r => `| ${Array.from({ length: w }, (_, i) => cell(r[i])).join(' | ')} |`;
      md.push(line(rows[0]), `|${' --- |'.repeat(w)}`, ...rows.slice(1).map(line), '');
      continue;
    }
    const p = b.p;
    if (p.title) md.push(`# ${p.text.replace(/\n/g, ' ')}`, '');
    else if (p.heading) md.push(`${'#'.repeat(Math.min(6, p.heading + (hasTitle ? 1 : 0)))} ${p.text.replace(/\n/g, ' ')}`, '');
    else if (p.list !== null) md.push(`${'  '.repeat(p.list)}- ${p.text.replace(/\n/g, ' ')}`);
    else if (p.quote) md.push(...p.text.split('\n').map(l => `> ${l}`), '');
    else md.push(p.text.replace(/\n/g, '  \n'), '');
  }
  return md.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export function docxToMarkdown(buf) {
  const zip = unzip(buf);
  const doc = zip.read('word/document.xml');
  if (!doc) throw new Error('not a Word document: it has no word/document.xml');
  return blocksToMarkdown(blocksOf(doc.toString('utf8'), styleInfo(zip.read('word/styles.xml'))));
}
