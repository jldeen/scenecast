// TEMPORARY: applies the app packs' build rules (packages/apps build.mjs htmlPasses) until the one text-rule applier,
// @stuntdouble/core/lib/text-rules.mjs, lands with the engine merge. Then process.mjs hands the same rule data to it
// and this file goes. Only what the seeded packs use is here:
//   raw:   [from, to]          literal swap anywhere in the markup
//   re:    [pattern, to, flags] a regular expression swap (flags default "g")
//   css:   'rules'             <style>rules</style> before </head> (whole pages only)
//   block: 'text', tag         the nearest enclosing <tag> of that visible text removed
// and per pack: strip (attributes blanked: sign-in tokens) and repairs (whole lines swapped from a map: CSS
// declarations Chrome's CSSOM dropped). Conditions: url (the document's URL has one of these substrings or matches
// /regex/), has (the markup holds this text), in (capture ids, * wildcards), pages: true (captured pages and their
// frames only: not hover or click parts, where the same element can be the real result). Pack rules are optional
// unless they say optional: false.
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const glob = p => new RegExp('^' + p.split('*').map(esc).join('.*') + '$');
const hit = (m, s) => m.length > 2 && m.startsWith('/') && m.endsWith('/') ? new RegExp(m.slice(1, -1)).test(s) : s.includes(m);
const list = v => v == null ? [] : Array.isArray(v) ? v : [v];

export function packRules(passes, { elementEnd }) {
  const byPack = new Map();
  const counts = {};
  for (const p of passes) {
    const rules = p.rules.map(r => {
      const kind = ['raw', 're', 'css', 'block', 'text', 'drop'].find(k => r[k] !== undefined);
      if (kind === 'text' || kind === 'drop') throw new Error(`pack rule ${r.id}: ${kind} rules need core's text rules (@stuntdouble/core/lib/text-rules.mjs)`);
      counts[r.id] = 0;
      return { ...r, kind, scope: r.in ? list(r.in).map(glob) : null, rx: kind === 're' ? new RegExp(r.re[0], r.re[2] || 'g') : null };
    });
    const strip = p.strip.length ? new RegExp(`(\\s(?:${p.strip.map(esc).join('|')})=")[^"]*"`, 'gi') : null;
    byPack.set(p.pack, { ...p, rules, strip, repairUsed: new Set() });
  }
  function block(html, text, tag, r) {
    const needle = `>${text}<`;
    for (let from = 0; ;) {
      const at = html.indexOf(needle, from);
      if (at < 0) return html;
      let st = html.lastIndexOf('<' + tag, at);
      while (st >= 0 && !/[\s>]/.test(html[st + tag.length + 1] || '')) st = html.lastIndexOf('<' + tag, st - 1);
      if (st < 0) { from = at + 1; continue; }
      const end = elementEnd(html, st);
      if (end <= at) { from = at + 1; continue; }
      html = html.slice(0, st) + html.slice(end); counts[r.id]++;
      from = st;
    }
  }
  function apply(html, packId, { url = '', ctx = '' } = {}) {
    const p = byPack.get(packId);
    if (!p) return html;
    if (p.strip) html = html.replace(p.strip, '$1"');
    for (const r of p.rules) {
      if (r.url && !(url && list(r.url).some(m => hit(m, url)))) continue;
      if (r.has && !list(r.has).some(h => html.includes(h))) continue;
      if (r.scope && !r.scope.some(g => g.test(ctx))) continue;
      if (r.pages && /^(hover|click|stream):/.test(ctx)) continue;
      if (r.kind === 'raw') { const n = html.split(r.raw[0]).length - 1; if (n) { html = html.split(r.raw[0]).join(r.raw[1]); counts[r.id] += n; } }
      else if (r.kind === 're') html = html.replace(r.rx, (...m) => { counts[r.id]++; return r.re[1].replace(/\$(\d)/g, (x, k) => m[+k] ?? ''); });
      else if (r.kind === 'css') { const at = html.indexOf('</head>'); if (at >= 0) { html = html.slice(0, at) + `<style>${r.css}</style>` + html.slice(at); counts[r.id]++; } }
      else if (r.kind === 'block') html = block(html, r.block, r.tag || 'div', r);
    }
    if (p.repairs && html.includes(' { ')) {
      let changed = false;
      const lines = html.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trimStart(), to = p.repairs[t];
        if (to === undefined) continue;
        lines[i] = lines[i].slice(0, lines[i].length - t.length) + to; p.repairUsed.add(t); changed = true;
      }
      if (changed) html = lines.join('\n');
    }
    return html;
  }
  return {
    apply,
    has: id => byPack.has(id),
    report: () => [...byPack.values()].filter(p => p.rules.length || p.repairs).map(p => `${p.pack}: ` + [...p.rules.map(r => `${r.id.split(':')[1]} ${counts[r.id]}`), p.repairs ? `css repairs ${p.repairUsed.size} of ${Object.keys(p.repairs).length}` : null].filter(Boolean).join(', ')),
    unused: () => [...byPack.values()].flatMap(p => p.rules.filter(r => r.optional === false && !counts[r.id]).map(r => r.id)),
  };
}
