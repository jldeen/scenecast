// Pure helpers that turn the demo's app packs into what the build uses. No imports from the other packages: flow
// compile and the build call these and apply the result with their own code (core's text rules for build rules).
//
//   flowDefaults(flow, appPacks)  the packs' flow parts merged under the demo's flow (named layout and drag rules a demo
//                                 references with { use }, rules every demo of the app gets, step-group selectors, menu
//                                 items that load late, vendor CSS for menus). The demo's own entries always win.
//   htmlPasses(packs, opts)       the packs' build parts as data: per pack, its URL match, attributes to strip, the CSS
//                                 repair map and its text rules (the core text-rule format, extended with url, has and
//                                 the re and css kinds: README.md).
import { readFileSync } from 'node:fs';
import { packFile, packsForDemo, packs as allPacks } from './index.mjs';

const key = x => JSON.stringify(x);
const META = new Set(['kind', 'always', 'on', 'note', 'source']);
const fields = rule => Object.fromEntries(Object.entries(rule).filter(([k]) => !META.has(k)));
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const deep = (a, b) => { const o = { ...a }; for (const [k, v] of Object.entries(b)) o[k] = isObj(v) && isObj(a[k]) ? deep(a[k], v) : v; return o; };

// One named rule of a pack ({ use: name, ...demo fields }): the pack's fields first, the demo's over them (objects
// merge: the demo's plus: { from } keeps the pack's plus.marker).
function resolve(entry, table, what) {
  if (!entry || typeof entry !== 'object' || !entry.use) return { rule: entry, base: null };
  const base = table && table[entry.use];
  if (!base) throw new Error(`${what}: no pack rule "${entry.use}"`);
  const { use, ...own } = entry;
  return { rule: deep(fields(base), own), base };
}

export function flowDefaults(flow, appPacks, opts = {}) {
  const used = [];
  const report = [];
  const addOn = (app, triggers) => {
    for (const t of triggers || []) if (!(app.on || []).some(x => key(x) === key(t))) { (app.on = app.on || []).push(t); report.push(`${app.id}: trigger ${key(t.click || t).slice(0, 60)}`); }
  };
  for (const app of flow.apps || []) {
    const p = appPacks[app.id];
    if (!p) continue;
    used.push({ app: app.id, pack: p.id });
    const table = (p.flow || {}).layout || {};
    app.layout = app.layout || {};
    // Rules the demo references by name.
    for (const [kind, list] of Object.entries(app.layout)) {
      if (!Array.isArray(list)) continue;
      app.layout[kind] = list.map(e => {
        const { rule, base } = resolve(e, table, `${app.id} layout.${kind}`);
        if (base) { if (base.kind !== kind) throw new Error(`${app.id} layout.${kind}: pack rule "${e.use}" is a ${base.kind} rule`); addOn(app, base.on); report.push(`${app.id}: ${kind} ${e.use}`); }
        return rule;
      });
    }
    // Rules every demo of the app gets, unless it has the same rule already.
    for (const [name, base] of Object.entries(table)) {
      if (!base.always) continue;
      const r = fields(base), list = app.layout[base.kind] || [];
      if (!list.some(x => key(x) === key(r))) { app.layout[base.kind] = [...list, r]; report.push(`${app.id}: ${base.kind} ${name}`); }
      addOn(app, base.on);
    }
  }
  // Resize handles: named ones (a demo gives { use, app } and, for a frame, its key) and the ones every demo gets.
  if (flow.drags || Object.values(appPacks).some(p => Object.values(((p.flow || {}).drags) || {}).some(d => d.always))) {
    flow.drags = (flow.drags || []).map(d => {
      const p = appPacks[d.app]; if (!d.use) return d;
      const { rule } = resolve(d, p && (p.flow || {}).drags, `drags (${d.app})`);
      report.push(`${d.app}: drag ${d.use}`);
      return rule;
    });
    for (const [appId, p] of Object.entries(appPacks)) {
      for (const [name, base] of Object.entries(((p.flow || {}).drags) || {})) {
        if (!base.always || base.frame) continue;
        if (flow.drags.some(d => d.app === appId && d.handle === base.handle)) continue;
        flow.drags.push({ app: appId, ...fields(base) }); report.push(`${appId}: drag ${name}`);
      }
    }
  }
  // Step groups: the app's selectors and the classes its region swaps, where the demo's entry has none.
  for (const g of flow.groups || []) {
    const p = appPacks[g.app]; if (!p) continue;
    const sel = (p.record || {}).groups || {}, more = (p.flow || {}).groups || {};
    for (const k of ['button', 'label', 'chevron']) if (g[k] == null && sel[k] != null) g[k] = sel[k];
    for (const k of ['dropLines', 'grid']) if (g[k] == null && more[k] != null) g[k] = more[k];
  }
  // Menu items that load a moment after their menu opens.
  for (const [appId, p] of Object.entries(appPacks)) {
    for (const li of ((p.flow || {}).lateItems) || []) {
      if ((flow.lateItems || []).some(x => key(x) === key(li))) continue;
      (flow.lateItems = flow.lateItems || []).push(li); report.push(`${appId}: late item ${li.text}`);
    }
  }
  // Library and measured CSS for the app's menus (pack:<id>/<file>, read by the build from the pack's folder).
  for (const cp of flow.clickPages || []) {
    const p = appPacks[cp.app]; const files = ((p && p.flow) || {}).vendorCss;
    if (!files || !files.length || cp.vendorCss) continue;
    cp.vendorCss = files.map(f => `pack:${p.id}/${f}`);
    report.push(`${cp.app}: vendor CSS on ${cp.page}`);
  }
  // Clicks the replica can't play (a live terminal, a page of another site): left out of every screen of the app, and
  // a later recording doesn't click them.
  for (const cp of flow.clickPages || []) {
    const p = appPacks[cp.app]; const names = ((p && p.flow) || {}).dropClicks || [];
    const add = names.filter(n => !(cp.drop || []).includes(n));
    if (!add.length) continue;
    cp.drop = [...(cp.drop || []), ...add];
    report.push(`${cp.app}: left out on ${cp.page}: ${add.join(', ')}`);
  }
  flow.packs = used;
  return { flow, report };
}

// The demo's packs over its flow (flow compile and the build both call it; running it twice changes nothing).
// demo.json packs: false turns packs off.
export function flowPacks(flow, cfg, list = allPacks()) {
  if (!cfg || cfg.packs === false) return { flow, report: [] };
  return flowDefaults(flow, packsForDemo(cfg, list));
}

// A pack file named in a flow (pack:<id>/<file>): its path, or null.
export function packPath(ref, packList = allPacks()) {
  const m = /^pack:([a-z0-9-]+)\/(.+)$/.exec(ref || '');
  if (!m) return null;
  const p = packList.find(x => x.id === m[1]);
  return p ? packFile(p, m[2]) : null;
}

// The build parts of packs, as data. opts.off: rule ids to leave out ("github:staff-toggle", or "github" for all of a
// pack's rules). Each rule keeps its kind and conditions; `pack` and a full id ("<pack>:<rule>") are added.
export function htmlPasses(packList, opts = {}) {
  const off = new Set(opts.off || []);
  return packList.map(p => {
    const b = p.build || {};
    const f = b.repairs && b.repairs.css ? packFile(p, b.repairs.css) : null;
    return {
      pack: p.id,
      match: p.match || [],
      frames: ((p.frames || {}).match) || [],
      strip: ((b.strip || {}).attrs) || [],
      repairs: f ? JSON.parse(readFileSync(f, 'utf8')) : null,
      rules: off.has(p.id) ? [] : (b.rules || []).filter(r => !off.has(`${p.id}:${r.id}`)).map(r => ({ optional: true, ...r, pack: p.id, id: `${p.id}:${r.id}` })),
    };
  });
}
