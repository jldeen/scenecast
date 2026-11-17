// The fidelity loop's report for the presenter: what's still different between the real pages and the replica, where
// and how much, what was fixed (and why), and the fonts. Reads the loop's rounds (<out>/round-N/compare/compare.json and
// <out>/round-N/diagnoses.json) and writes <out>/report.json and <out>/report.html.
//   node checks/fidelity-report.mjs --demo <dir> [--out <dir>] [--fallback-before N]
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadDemo, arg } from '../kit/lib/demo.mjs';
import { readFixes } from '../fixer/patches.mjs';

const args = process.argv.slice(2);
const demo = loadDemo(args);
const OUT = arg(args, '--out', join(demo.out, 'fidelity'));
const fallbackBefore = arg(args, '--fallback-before', null);
const read = f => existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
const rounds = readdirSync(OUT).filter(d => /^round-\d+$/.test(d)).map(d => +d.slice(6)).sort((a, b) => a - b)
  .map(n => ({ n, compare: read(join(OUT, `round-${n}`, 'compare', 'compare.json')), diagnoses: read(join(OUT, `round-${n}`, 'diagnoses.json')) }))
  .filter(r => r.compare);
if (!rounds.length) { console.log(`no rounds in ${OUT}: run scenecast fidelity`); process.exit(1); }
const first = rounds[0].compare, last = rounds[rounds.length - 1].compare;
const fixes = readFixes(demo.dir).patches;
const rel = f => f ? relative(OUT, f).split('\\').join('/') : null;
// The latest diagnosis of each finding (by id), from the last round that looked at it.
const causes = {};
for (const r of rounds) for (const d of (r.diagnoses || {}).diagnoses || []) (causes[d.finding] = causes[d.finding] || {})[r.n] = (causes[d.finding][r.n] || []).concat(d);
const lastRound = rounds[rounds.length - 1].n;
const now = id => ((causes[id] || {})[lastRound]) || [];
const earlier = id => Object.entries(causes[id] || {}).filter(([n]) => +n !== lastRound).flatMap(([, d]) => d);
const items = last.items.map(it => {
  const was = first.items.find(x => x.id === it.id);
  return {
    id: it.id, kind: it.kind, state: it.state, z: it.z, click: it.click, pass: it.pass, pct: it.pct, firstPct: was ? was.pct : null,
    regions: (it.regions || []).slice(0, 8), size: it.size, error: it.error, note: it.note,
    sideBySide: rel(it.sideBySide), diff: rel(it.diff), replica: rel(it.replica),
    causes: Object.values(causes[it.id] || {}).flat().map(d => ({ cause: d.cause, summary: d.summary, patch: d.patch ? d.patch.kind : null, patchStatus: d.patchStatus || null })),
  };
});
// Residual: what still differs at all (any region), worst first, with what was found about it.
const residual = items.filter(i => i.pct > 0 || !i.pass).sort((a, b) => (b.pct || 0) - (a.pct || 0)).map(i => ({
  id: i.id, pct: i.pct, pass: i.pass, where: i.regions.slice(0, 4).map(g => ({ x: g.x, y: g.y, w: g.w, h: g.h, pixels: g.px })),
  why: now(i.id).length ? now(i.id).map(d => d.summary) : [i.pass ? 'within the threshold: small differences (anti-aliasing, a shadow, a caret)' : 'not diagnosed (compare only, or the round limit)'],
  fixed: [...new Set(earlier(i.id).filter(d => d.patch).map(d => d.cause))],
}));
const fallbackNow = last.fallback || [];
const report = {
  demo: demo.name, title: demo.cfg.title || demo.name, at: new Date().toISOString(), threshold: last.threshold, viewport: last.viewport,
  pass: !!last.pass && !(fallbackBefore !== null && fallbackNow.length > +fallbackBefore),
  rounds: rounds.map(r => ({ round: r.n, pass: r.compare.pass, worst: r.compare.worst, over: r.compare.items.filter(x => !x.pass).map(x => x.id), fonts: (r.compare.fonts || []).filter(f => f.status !== 'match').map(f => `${f.name || f.family}: ${f.status}`), added: ((r.diagnoses || {}).added || []).map(p => `${p.kind}: ${p.finding}`) })),
  summary: { compared: items.filter(i => i.pct !== null).length, within: items.filter(i => i.pass).length, worst: last.worst, fixes: fixes.length, fallback: fallbackNow.length, fallbackAdded: fallbackBefore === null ? null : Math.max(0, fallbackNow.length - +fallbackBefore) },
  items, residual, fonts: last.fonts || [], fixes: fixes.map(p => ({ kind: p.kind, cause: p.cause, finding: p.finding, round: p.round, why: p.why })), fallback: fallbackNow,
};
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 1));

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const badge = ok => `<span class="b ${ok ? 'ok' : 'no'}">${ok ? 'within' : 'over'}</span>`;
const fontBadge = s => `<span class="b ${s === 'match' ? 'ok' : s === 'unverified' ? 'warn' : 'no'}">${esc(s)}</span>`;
const pct = v => v === null || v === undefined ? '—' : `${v}%`;
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>${esc(report.title)} · fidelity</title>
<style>body{font:15px/1.45 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;margin:28px;color:#1b1b1b;background:#fff;max-width:1500px}
h1{font-size:26px;margin:0 0 6px}h2{font-size:19px;margin:28px 0 8px}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid #e6e8eb;vertical-align:top}
th{font-weight:600;color:#555;font-size:13px}.b{display:inline-block;border-radius:10px;padding:0 8px;font-size:12px;font-weight:600}.ok{background:#e3f6ea;color:#16683a}.no{background:#fde7e7;color:#a11}.warn{background:#fff3d6;color:#7a5200}
.verdict{font-size:17px;margin:10px 0 18px}.muted{color:#666}.card{margin:18px 0 26px}.card img{max-width:100%;border:1px solid #ddd}code{font-size:13px;background:#f4f5f7;padding:1px 4px;border-radius:4px}</style>
<h1>${esc(report.title)} · real vs replica</h1>
<div class="verdict">${report.pass ? '✅' : '❌'} <b>${report.summary.within} of ${report.summary.compared}</b> captured states within ${report.threshold}% of pixels${report.summary.worst ? ` · worst ${esc(report.summary.worst.id)} ${report.summary.worst.pct}%` : ''} · fonts ${report.fonts.every(f => f.status === 'match' || f.status === 'unverified') ? 'match' : 'differ'} · ${report.fixes.length} fix(es) in flow.fixes.json · ${report.fallback.length ? `<b>${report.fallback.length} fallback scene(s)</b>: ${report.fallback.map(f => esc(f.id + ' (' + f.kind + ')')).join(', ')}` : 'no fallback scenes'}</div>
<p class="muted">${esc(demo.name)} · ${report.viewport.width}×${report.viewport.height} @${report.viewport.dpr}x · ${report.rounds.length} round(s) · ${esc(report.at)}. Every state is rendered in the replica the way its real screenshot was taken (zoom states at their zoom, menus and panes right after the click) and compared pixel by pixel.</p>
<h2>Rounds</h2><table><tr><th>Round</th><th>Over ${report.threshold}%</th><th>Fonts</th><th>Fixes added</th></tr>${report.rounds.map(r => `<tr><td>${r.round}</td><td>${r.over.length ? esc(r.over.join(', ')) : 'none'}</td><td>${r.fonts.length ? esc(r.fonts.join(', ')) : 'match'}</td><td>${r.added.length ? esc(r.added.join(', ')) : '—'}</td></tr>`).join('')}</table>
<h2>Still different</h2>${report.residual.length ? `<table><tr><th>State</th><th>Pixels</th><th>Where (x, y, w×h)</th><th>Why</th></tr>${report.residual.map(r => `<tr><td>${esc(r.id)} ${badge(r.pass)}</td><td>${pct(r.pct)}</td><td>${r.where.map(g => `${g.x}, ${g.y}, ${g.w}×${g.h}`).join('<br>') || '—'}</td><td>${r.why.map(esc).join('<br>')}${r.fixed.length ? `<div class="muted">fixed before: ${esc(r.fixed.join(', '))}</div>` : ''}</td></tr>`).join('')}</table>` : '<p>Nothing: every state is pixel for pixel the real page.</p>'}
<h2>Fonts</h2>${report.fonts.length ? `<table><tr><th>Family</th><th>Weight / style</th><th>Status</th><th>Real file (SHA-256)</th><th>Replica file (SHA-256)</th></tr>${report.fonts.map(f => `<tr><td>${esc(f.name || f.family)}</td><td>${esc(f.weight)} ${esc(f.style)}</td><td>${fontBadge(f.status)}${f.why ? `<div class="muted">${esc(f.why)}</div>` : ''}</td><td>${(f.real || []).map(x => `<code>${esc(x.sha256.slice(0, 16))}</code> <span class="muted">${esc(x.url)}</span>`).join('<br>') || '—'}</td><td>${(f.replica || []).map(x => `<code>${esc(x.slice(0, 16))}</code>`).join('<br>') || '—'}</td></tr>`).join('')}</table>` : '<p class="muted">The real pages loaded no web fonts.</p>'}
<h2>Fixes (flow.fixes.json)</h2>${report.fixes.length ? `<table><tr><th>Kind</th><th>Cause</th><th>Found on</th><th>Why</th></tr>${report.fixes.map(p => `<tr><td><code>${esc(p.kind)}</code></td><td>${esc(p.cause)}</td><td>${esc(p.finding)} (round ${p.round})</td><td>${esc(p.why)}</td></tr>`).join('')}</table>` : '<p class="muted">None needed.</p>'}
<h2>Every state</h2><table><tr><th>State</th><th>Kind</th><th>First</th><th>Now</th><th>Causes found</th></tr>${report.items.map(i => `<tr><td><a href="#${esc(i.id)}">${esc(i.id)}</a></td><td>${esc(i.kind)}${i.z !== 100 ? ` ${i.z}%` : ''}</td><td>${pct(i.firstPct)}</td><td>${pct(i.pct)} ${i.pct === null ? esc(i.note || i.error || '') : badge(i.pass)}</td><td>${[...new Set(i.causes.map(c => c.cause))].map(esc).join(', ') || '—'}</td></tr>`).join('')}</table>
${report.items.filter(i => i.sideBySide).map(i => `<div class="card" id="${esc(i.id)}"><h2>${esc(i.id)} · ${pct(i.pct)} ${badge(i.pass)}</h2><a href="${esc(i.sideBySide)}"><img src="${esc(i.sideBySide)}" alt="real and replica side by side"></a>${i.pct > 0 ? `<p class="muted">Differing pixels, in red: <a href="${esc(i.diff)}">diff</a></p>` : ''}</div>`).join('')}
</html>`;
writeFileSync(join(OUT, 'report.html'), html);
console.log('@fidelity ' + JSON.stringify({ event: 'report', pass: report.pass, html: join(OUT, 'report.html'), json: join(OUT, 'report.json'), summary: report.summary }));
