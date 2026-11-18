// docs/guide.md → docs/guide.pdf, the printable one-page guide (A4/Letter-friendly, its screenshots included).
// Headless Chrome prints it; the Markdown is the small subset the guide uses (headings, paragraphs, lists, tables,
// images, links, bold, italics, code).
//   node scripts/guide-pdf.mjs [docs/guide.md] [docs/guide.pdf]
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const src = resolve(process.argv[2] || 'docs/guide.md');
const out = resolve(process.argv[3] || src.replace(/\.md$/, '.pdf'));
const base = dirname(src);
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = s => esc(s)
  .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, p) => `<img alt="${alt}" src="${pathToFileURL(join(base, p)).href}">`)
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>');

export function markdown(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const html = [];
  let i = 0;
  const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(l);
    if (h) { html.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^\s*!\[/.test(l) && /\)\s*$/.test(l)) { html.push(`<figure>${inline(l.trim())}</figure>`); i++; continue; }
    if (l.trim().startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(lines[i++]);
      const head = cells(rows[0]), body = rows.slice(2).map(cells);
      html.push(`<table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (/^\s*(\d+\.|[-*])\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const items = [];
      while (i < lines.length && (/^\s*(\d+\.|[-*])\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length) || (!lines[i].trim() && /^\s{2,}\S/.test(lines[i + 1] || '')))) {
        const m = /^\s*(\d+\.|[-*])\s+(.*)$/.exec(lines[i]);
        if (m && !/^\s{2,}/.test(lines[i])) items.push([m[2]]);
        else if (lines[i].trim()) items[items.length - 1].push(lines[i].trim());
        else items[items.length - 1].push('');
        i++;
      }
      const item = parts => parts.join('\n').split(/\n\n+/).map(p => /^!\[/.test(p.trim()) ? `<figure>${inline(p.trim())}</figure>` : inline(p.replace(/\n/g, ' '))).join('');
      html.push(`<${ordered ? 'ol' : 'ul'}>${items.map(p => `<li>${item(p)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#|\||\s*(\d+\.|[-*])\s)/.test(lines[i])) para.push(lines[i++]);
    html.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return html.join('\n');
}

const CSS = `@page { size: Letter; margin: 14mm 14mm 16mm; }
body { font: 10.5pt/1.45 "Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif; color: #1b1f24; }
h1 { font-size: 20pt; margin: 0 0 6pt; } h2 { font-size: 13.5pt; margin: 16pt 0 6pt; border-bottom: 1px solid #d0d7de; padding-bottom: 3pt; break-after: avoid; }
p, li { margin: 4pt 0; } ol, ul { padding-left: 18pt; } a { color: #0969da; text-decoration: none; }
code { font: 9pt ui-monospace, Menlo, Consolas, monospace; background: #f3f4f6; padding: 0 3pt; border-radius: 3pt; }
table { border-collapse: collapse; width: 100%; margin: 6pt 0; font-size: 9.5pt; break-inside: auto; } tr { break-inside: avoid; }
th, td { border: 1px solid #d0d7de; padding: 4pt 6pt; vertical-align: top; text-align: left; } th { background: #f6f8fa; }
figure { margin: 6pt 0; break-inside: avoid; } img { max-width: 58%; max-height: 175pt; border: 1px solid #d0d7de; border-radius: 4pt; }`;

if (process.argv[1] && process.argv[1].endsWith('guide-pdf.mjs')) {
  const tmp = mkdtempSync(join(tmpdir(), 'scenecast-guide-'));
  const page = join(base, '.guide-print.html');
  writeFileSync(page, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Scenecast: the one-page guide</title><style>${CSS}</style></head><body>${markdown(readFileSync(src, 'utf8'))}</body></html>`);
  const b = await chromium.launch({ channel: process.env.REPLICA_CHROME_CHANNEL || 'chrome', headless: true });
  try {
    const p = await b.newPage();
    await p.goto(pathToFileURL(page).href, { waitUntil: 'load' });
    await p.evaluate(() => Promise.all([...document.images].map(i => i.complete ? null : new Promise(r => { i.onload = i.onerror = r; }))));
    const bad = await p.evaluate(() => [...document.images].filter(i => !i.naturalWidth).map(i => i.getAttribute('src')));
    if (bad.length) throw new Error(`pictures missing: ${bad.join(', ')}`);
    writeFileSync(out, await p.pdf({ format: 'Letter', printBackground: true, margin: { top: '14mm', bottom: '16mm', left: '14mm', right: '14mm' }, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: '<div style="font:8pt sans-serif;color:#57606a;width:100%;text-align:center">Scenecast · the one-page guide · <span class="pageNumber"></span>/<span class="totalPages"></span></div>' }));
    console.log(`${out}`);
  } finally { await b.close(); rmSync(page, { force: true }); rmSync(tmp, { recursive: true, force: true }); }
}
