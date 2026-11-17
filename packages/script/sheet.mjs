// The two sheets scenecast script writes.
//   sheet.html / sheet.pdf  each line next to the screen it plays over, what backs it highlighted (numbered in focus
//                           order), where each focus point lands, and every gap flagged: a line nothing on screen backs,
//                           or facts it states (numbers, names) the screen doesn't show
//   cues.md / cues.html     the presenter's cue sheet: for each line, what to do to get to its screen (the recorded
//                           steps, or the beat key), then ⌥F for each focus point
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const STATUS = { backed: ['✓ Backed on screen', 'ok'], partial: ['◐ Partly backed', 'warn'], unbacked: ['⚠ Not backed: nothing on this screen supports this line', 'bad'] };
const CSS = `body{margin:0;padding:22px 26px;font-family:-apple-system,"Segoe UI",system-ui,sans-serif;color:#1b1b1b;background:#fff}
h1{font-size:24px;margin:0 0 4px}.sub{color:#555;font-size:13px;margin-bottom:12px}
.sum span{display:inline-block;margin-right:14px;font-weight:600}.sum .ok{color:#0b6b2f}.sum .warn{color:#8a5a00}.sum .bad{color:#b3261e}
.beat{font:700 13px/1 -apple-system,"Segoe UI",sans-serif;text-transform:uppercase;letter-spacing:.05em;color:#555;margin:22px 0 4px;border-bottom:2px solid #222;padding-bottom:6px}
.row{display:flex;gap:20px;border-top:1px solid #d6d9de;padding:14px 0;break-inside:avoid}.txt{width:430px;flex:none}
.id{font:600 12px -apple-system,"Segoe UI",sans-serif;color:#666}.line{font-size:18px;line-height:1.4;margin:4px 0 10px}
.cue{font-size:13px;background:#f2f6fc;border-left:4px solid #3b6fd6;padding:5px 8px;margin-bottom:8px}
.st{font-weight:700;font-size:14px;margin-bottom:4px}.st.ok{color:#0b6b2f}.st.warn{color:#8a5a00}.st.bad{color:#b3261e}
.row.flag{background:#fff6f5}.miss{font-size:13px;color:#8a5a00}.pts{font-size:13px;margin:6px 0 0;padding-left:20px}.pts li{margin:2px 0}
.screen{font-size:12px;color:#666;margin-bottom:4px}.shots{display:flex;flex-direction:column;gap:8px}.main{width:900px;border:1px solid #ccc}
.lands{display:flex;gap:8px;flex-wrap:wrap}.lands figure{margin:0;font-size:11px;color:#555}.lands img{width:290px;border:1px solid #ccc;display:block}`;

const markOf = p => p.mark === 'arrow' ? `arrow (${p.dir || 'sw'})` : 'box';
export function sheetHtml(report, { title }) {
  const s = report.summary;
  const beatTitle = n => { const b = report.beats.find(x => x.n === n); return b ? `Beat ${n} · ${b.title}` : null; };
  let lastBeat = null;
  const rows = report.lines.map(l => {
    const head = l.beat !== lastBeat && beatTitle(l.beat) ? `<div class="beat">${esc(beatTitle(l.beat))}</div>` : '';
    lastBeat = l.beat;
    const [label, cls] = STATUS[l.status];
    const pts = report.points.filter(p => l.points.includes(p.id));
    return `${head}<div class="row${l.status === 'backed' ? '' : ' flag'}" data-line="${esc(l.id)}" data-status="${l.status}"><div class="txt">
      <div class="id">Line ${esc(l.id)}</div><div class="line">${esc(l.text)}</div>
      ${l.cue ? `<div class="cue"><b>Do:</b> ${esc(l.cue)}</div>` : ''}
      <div class="st ${cls}">${label}</div>
      ${l.missing.length ? `<div class="miss">Not on this screen: ${l.missing.map(esc).join(', ')}</div>` : ''}
      ${l.problems.length ? `<div class="miss">${l.problems.map(esc).join('; ')}</div>` : ''}
      ${pts.length ? `<ol class="pts">${pts.map(p => `<li>${esc(p.label)} · ${markOf(p)}${p.landing && !p.landing.error ? ` · zoom ${p.landing.Z}×${p.landing.edge ? ' (at the screen\'s edge)' : ''}` : ' · did not land'} <span style="color:#888">(⌥F, beat ${p.beat})</span></li>`).join('')}</ol>` : ''}
    </div><div class="shots"><div class="screen">${esc(l.app)} · ${esc(l.state)}</div><img class="main" src="${esc(l.shot)}">
      ${pts.some(p => p.landing && p.landing.shot) ? `<div class="lands">${pts.filter(p => p.landing && p.landing.shot).map((p, k) => `<figure><img src="${esc(p.landing.shot)}"><figcaption>${k + 1}. ${esc(p.label.slice(0, 50))}</figcaption></figure>`).join('')}</div>` : ''}
    </div></div>`;
  }).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}: line to screen</title><style>${CSS}</style></head><body>
<h1>${esc(title)}: each line and the screen it plays over</h1>
<div class="sub">${esc(report.script)}${report.title ? ' · ' + esc(report.title) : ''} · matcher: ${esc(report.matcher)} · highlights: what backs the line, numbered in ⌥F order · ${esc(report.at.slice(0, 16).replace('T', ' '))}</div>
<div class="sum"><span>${s.lines} lines</span><span class="ok">${s.backed} backed</span><span class="warn">${s.partial} partly</span><span class="bad">${s.unbacked} not backed</span><span>${s.points} focus points</span></div>
${rows}</body></html>`;
}

export async function writeSheet(report, { out, browser, pdf = true, title }) {
  const file = join(out, 'sheet.html');
  writeFileSync(file, sheetHtml(report, { title }));
  if (!pdf) return { pdf: null };
  const page = await browser.newPage({ viewport: { width: 1420, height: 1000 } });
  await page.goto(pathToFileURL(file).href);
  await page.waitForFunction(() => [...document.images].every(i => i.complete));
  const target = join(out, 'sheet.pdf');
  await page.pdf({ path: target, width: '1420px', height: '1000px', printBackground: true, margin: { top: '12px', bottom: '12px' } });
  await page.close();
  return { pdf: target };
}

// ---- the cue sheet -----------------------------------------------------------------------------------------------
const named = m => {
  if (!m) return '';
  if (m.text) return `“${m.text}”`;
  if (m.label) return `“${m.label}”`;
  const l = /aria-label="([^"]+)"/.exec(m.sel || '') || /placeholder="([^"]+)"/.exec(m.sel || '');
  return l ? `“${l[1]}”` : `\`${m.sel}\``;
};
export function stepText(step, flow) {
  const app = id => (flow.apps.find(a => a.id === id) || { title: id });
  if (step.app && Object.keys(step).length <= 2) { const a = app(step.app); return `Switch to ${a.title || a.id}${a.key ? ` (⌥${a.key.toUpperCase()})` : ''}`; }
  if (step.click) return `Click ${named(step.click)}`;
  if (step.type) return `Type “${step.text}” in ${named(step.type)} (⌥P types it)`;
  if (step.enter) return 'Press Enter';
  if (step.clear) return 'Clear the field';
  if (step.key) return `Press ${step.key}`;
  return JSON.stringify(step);
}
export function cueSheet(report, flow, seq, beatsAt) {
  const md = [`# ${report.title || 'Script'}: cue sheet`, '', `Presenter keys: ⌥ on the Mac, Ctrl+Alt on Windows. ⌥F: next focus point (⌥⇧F back, Esc out). From \`${report.script}\`.`, ''];
  const rows = [];
  let prev = -1, lastBeat = null;
  for (const l of report.lines) {
    const b = report.beats.find(x => x.n === l.beat);
    if (l.beat !== lastBeat && b) { md.push(`## Beat ${b.n} · ${b.title}`, ''); rows.push({ beat: `Beat ${b.n} · ${b.title}` }); }
    lastBeat = l.beat;
    const todo = [];
    if (prev < 0) todo.push('⌥0 (start)');
    for (let k = prev + 1; k <= l.pos && prev >= 0; k++) {
      const key = beatsAt.findIndex((p, i) => i > 0 && p === k);
      const s = seq[k];
      if (s.step !== null && s.step !== undefined && flow.path[s.step]) todo.push(stepText(flow.path[s.step], flow) + (key > 0 ? ` (or ⌥${key})` : ''));
      else if (key > 0) todo.push(`⌥${key}`);
    }
    prev = Math.max(prev, l.pos);
    const pts = report.points.filter(p => l.points.includes(p.id));
    const focus = pts.map(p => `⌥F ${p.label}${p.mark === 'arrow' ? ' (arrow)' : ''}`);
    const flag = l.status === 'unbacked' ? ' ⚠ nothing on screen backs this line' : l.missing.length ? ` ◐ not on screen: ${l.missing.join(', ')}` : '';
    md.push(`**${l.id}** ${l.text}`, '');
    if (l.cue) md.push(`- Script: ${l.cue}`);
    if (todo.length) md.push(`- Do: ${todo.join(' → ')}`);
    md.push(`- Screen: ${l.app} · ${l.state}${flag}`);
    for (const f of focus) md.push(`- ${f}`);
    md.push('');
    rows.push({ l, todo, focus, flag });
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Cue sheet</title><style>body{font-family:-apple-system,"Segoe UI",sans-serif;max-width:900px;margin:24px auto;color:#1b1b1b}h2{font-size:15px;text-transform:uppercase;letter-spacing:.04em;border-bottom:2px solid #222;padding-bottom:4px;margin-top:26px}.l{margin:12px 0;padding:8px 0;border-top:1px solid #ddd}.t{font-size:17px}.do{background:#f2f6fc;border-left:4px solid #3b6fd6;padding:4px 8px;margin:6px 0;font-size:14px}.f{font-size:14px;color:#b3261e}.s{font-size:12px;color:#666}.flag{color:#8a5a00}</style></head><body>
<h1>${esc(report.title || 'Script')}: cue sheet</h1><p class="s">Presenter keys: ⌥ on the Mac, Ctrl+Alt on Windows. ⌥F: next focus point (⌥⇧F back, Esc out).</p>
${rows.map(r => r.beat ? `<h2>${esc(r.beat)}</h2>` : `<div class="l"><div class="t"><b>${esc(r.l.id)}</b> ${esc(r.l.text)}</div>${r.l.cue ? `<div class="s">Script: ${esc(r.l.cue)}</div>` : ''}${r.todo.length ? `<div class="do">${esc(r.todo.join(' → '))}</div>` : ''}${r.focus.map(f => `<div class="f">${esc(f)}</div>`).join('')}<div class="s">${esc(r.l.app)} · ${esc(r.l.state)}<span class="flag">${esc(r.flag)}</span></div></div>`).join('\n')}</body></html>`;
  return { md: md.join('\n') + '\n', html };
}
