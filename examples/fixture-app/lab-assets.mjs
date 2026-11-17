// Generated assets for the lab app (lab.mjs), made here so the fixture needs no font or image files:
//   labFont()  a TrueType font, "Lab Blocks": every printable ASCII glyph a pattern of blocks, so text drawn with any
//              fallback font differs from it on every glyph
//   png(w, h, paint)  a PNG from a paint(x, y) → [r, g, b] function
import { deflateSync } from 'node:zlib';

const u16 = v => { const b = Buffer.alloc(2); b.writeUInt16BE(v & 0xffff); return b; };
const i16 = v => { const b = Buffer.alloc(2); b.writeInt16BE(v); return b; };
const u32 = v => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
const cat = parts => Buffer.concat(parts);
const pad4 = b => b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - b.length % 4)]) : b;
const sum32 = b => { const p = pad4(b); let s = 0; for (let i = 0; i < p.length; i += 4) s = (s + p.readUInt32BE(i)) >>> 0; return s; };

const UPEM = 1000, ADV = 600, ASC = 800, DESC = 200, FIRST = 32, LAST = 126;
// A 3×5 grid of blocks per glyph, chosen from the character code (never empty, never the same as its neighbour).
function blocks(code) {
  if (code === 32) return [];
  let bits = ((code * 2654435761) >>> 0) % 32767 | (1 << (code % 15));
  const out = [];
  for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) {
    if (!(bits & (1 << (r * 3 + c)))) continue;
    const x0 = 60 + c * 165, y0 = r * 140;
    out.push([x0, y0, x0 + 145, y0 + 120]);
  }
  return out;
}
function glyph(rects) {
  if (!rects.length) return Buffer.alloc(0);
  const xs = rects.flatMap(r => [r[0], r[2]]), ys = rects.flatMap(r => [r[1], r[3]]);
  const pts = rects.flatMap(([x0, y0, x1, y1]) => [[x0, y0], [x0, y1], [x1, y1], [x1, y0]]);
  const ends = rects.map((_, i) => i * 4 + 3);
  let px = 0, py = 0;
  const dx = [], dy = [];
  for (const [x, y] of pts) { dx.push(i16(x - px)); dy.push(i16(y - py)); px = x; py = y; }
  return pad4(cat([i16(rects.length), i16(Math.min(...xs)), i16(Math.min(...ys)), i16(Math.max(...xs)), i16(Math.max(...ys)),
    ...ends.map(u16), u16(0), Buffer.alloc(pts.length, 1), ...dx, ...dy]));
}
function nameTable(family) {
  const recs = [[1, family], [2, 'Regular'], [4, family + ' Regular'], [6, family.replace(/\s+/g, '') + '-Regular']];
  const strs = recs.map(([, s]) => Buffer.from(s, 'utf16le').swap16());
  let off = 0;
  const rows = recs.map(([id], i) => { const r = cat([u16(3), u16(1), u16(0x409), u16(id), u16(strs[i].length), u16(off)]); off += strs[i].length; return r; });
  return cat([u16(0), u16(recs.length), u16(6 + recs.length * 12), ...rows, ...strs]);
}

export function labFont(family = 'Lab Blocks') {
  const codes = []; for (let c = FIRST; c <= LAST; c++) codes.push(c);
  const glyphs = [glyph([[50, 0, 550, 700]]), ...codes.map(c => glyph(blocks(c)))];
  const n = glyphs.length;
  const loca = []; let off = 0; for (const g of glyphs) { loca.push(u32(off)); off += g.length; } loca.push(u32(off));
  const maxPts = Math.max(...codes.map(c => blocks(c).length * 4), 4), maxCont = Math.max(...codes.map(c => blocks(c).length), 1);
  const tables = {
    'OS/2': cat([u16(4), i16(ADV), u16(400), u16(5), u16(0), ...[500, 500, 0, 75, 500, 500, 0, 350].map(i16), i16(50), i16(250), i16(0),
      Buffer.alloc(10), u32(1), u32(0), u32(0), u32(0), Buffer.from('SCST'), u16(0x40), u16(FIRST), u16(LAST),
      i16(ASC), i16(-DESC), i16(0), u16(ASC), u16(DESC), u32(1), u32(0), i16(500), i16(700), u16(0), u16(32), u16(0)]),
    cmap: cat([u16(0), u16(1), u16(3), u16(1), u32(12),
      u16(4), u16(32), u16(0), u16(4), u16(4), u16(1), u16(0), u16(LAST), u16(0xffff), u16(0), u16(FIRST), u16(0xffff), i16(1 - FIRST), i16(1), u16(0), u16(0)]),
    glyf: cat(glyphs),
    head: cat([u32(0x00010000), u32(0x00010000), u32(0), u32(0x5f0f3cf5), u16(0x000b), u16(UPEM), Buffer.alloc(16),
      i16(0), i16(0), i16(ADV), i16(ASC), u16(0), u16(8), i16(2), i16(1), i16(0)]),
    hhea: cat([u32(0x00010000), i16(ASC), i16(-DESC), i16(0), u16(ADV), i16(0), i16(0), i16(ADV), i16(1), i16(0), i16(0), Buffer.alloc(8), i16(0), u16(n)]),
    hmtx: cat(glyphs.map((g, i) => cat([u16(ADV), i16(g.length ? (i === 0 ? 50 : Math.min(...blocks(codes[i - 1]).map(r => r[0]))) : 0)]))),
    loca: cat(loca),
    maxp: cat([u32(0x00010000), u16(n), u16(maxPts), u16(maxCont), u16(0), u16(0), u16(2), ...Array(8).fill(u16(0))]),
    name: nameTable(family),
    post: cat([u32(0x00030000), u32(0), i16(-100), i16(50), u32(1), u32(0), u32(0), u32(0), u32(0)]),
  };
  const tags = Object.keys(tables).sort();
  const nt = tags.length, es = Math.floor(Math.log2(nt)), sr = 16 * 2 ** es;
  let offset = 12 + 16 * nt;
  const dir = [], body = [];
  for (const t of tags) {
    const data = tables[t];
    dir.push(cat([Buffer.from(t.padEnd(4)), u32(sum32(data)), u32(offset), u32(data.length)]));
    body.push(pad4(data)); offset += pad4(data).length;
  }
  const font = cat([u32(0x00010000), u16(nt), u16(sr), u16(es), u16(nt * 16 - sr), ...dir, ...body]);
  const headAt = 12 + 16 * nt + tags.slice(0, tags.indexOf('head')).reduce((s, t) => s + pad4(tables[t]).length, 0);
  font.writeUInt32BE((0xb1b0afba - sum32(font)) >>> 0, headAt + 8);
  return font;
}

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = b => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const t = Buffer.from(type); return cat([u32(data.length), t, data, u32(crc(cat([t, data])))]); };
export function png(w, h, paint) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = paint(x, y); const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  return cat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', cat([u32(w), u32(h), Buffer.from([8, 2, 0, 0, 0])])), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
