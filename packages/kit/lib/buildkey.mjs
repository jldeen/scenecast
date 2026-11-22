// What a build's output depends on, hashed: the build code, the parts of the flow the build reads, the raw captures
// (by name, size and time), vendor CSS and the app packs' build rules. data/build.json keeps the hashes of the last build, so
//   - scenecast build skips a build whose inputs haven't changed, and
//   - the server knows which tweaks are already baked in, which it can apply as it serves (text edits), and which
//     only a build can make (everything else the build reads).
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { KIT } from './demo.mjs';
import { editSig } from './edits.mjs';
import { activePacks } from '../../apps/index.mjs';
import { htmlPasses, packPath } from '../../apps/build.mjs';

const sha = s => createHash('sha256').update(s).digest('hex').slice(0, 16);
const CODE = ['recorder/process.mjs', 'recorder/compose.mjs', 'recorder/pack-rules.mjs', 'kit/lib/edits.mjs', 'fixer/patches.mjs', 'apps/index.mjs', 'apps/build.mjs'];
let codeHash = null;

// Parts of the flow the build reads, by name (so a change can say which part needs a build).
export function flowParts(flow) {
  return {
    states: Object.fromEntries(Object.entries(flow.states || {}).map(([k, s]) => [k, [s.app, s.snap]])),
    variants: flow.variants || [],
    streams: Object.fromEntries(Object.entries(flow.streams || {}).map(([k, s]) => [k, [s.raw || k, s.frames || null, s.to]])),
    compose: flow.compose || [],
    layout: (flow.apps || []).map(a => [a.id, ((a.layout || {}).chips) || null, ((a.layout || {}).responsive) || null]),
    hoverPages: flow.hoverPages || [], clickPages: flow.clickPages || [], chipCards: flow.chipCards || [],
    groups: flow.groups || null, lateItems: flow.lateItems || [],
    // The fidelity loop's build-time fixes (fonts, assets, rows: flow.fixes.json).
    fixes: flow.fixes || [],
    // Edits the server can't apply as it serves (a tooltip dropped from a capture).
    buildEdits: (flow.edits || []).filter(e => !(e.remove || e.replace)).map(editSig),
  };
}
function rawSig(raw) {
  if (!existsSync(raw)) return 'none';
  const parts = [];
  const walk = (dir, depth) => {
    let names; try { names = readdirSync(dir).sort(); } catch (e) { return; }
    for (const n of names) {
      if (n === 'receiver.log' || n === 'recording.json' || n === 'recording-partial.json' || n === 'blobs') continue;
      const p = join(dir, n); let st; try { st = statSync(p); } catch (e) { continue; }
      if (st.isDirectory()) { if (depth < 3) walk(p, depth + 1); } else parts.push(p.slice(raw.length) + ':' + st.size + ':' + Math.round(st.mtimeMs));
    }
  };
  walk(raw, 0);
  return sha(parts.join('\n'));
}
export function buildInputs(demo, flow) {
  if (!codeHash) codeHash = sha(CODE.map(f => readFileSync(join(KIT, f), 'utf8')).join('\u0000'));
  const parts = flowParts(flow);
  const vendor = sha((flow.clickPages || []).flatMap(c => c.vendorCss || []).map(f => { try { return readFileSync(packPath(f) || join(demo.dir, f), 'utf8'); } catch (e) { return f + ':missing'; } }).join('\u0000'));
  // The app packs' build rules, attributes to strip and CSS repairs (packages/apps, and private packs).
  const packs = sha(JSON.stringify(htmlPasses(activePacks(demo.cfg), { off: ((demo.cfg && demo.cfg.packs) || {}).offRules })));
  // demo.json build.hook and build.hookFiles: the demo's own text pass (capture/process.mjs) and what it reads.
  const B = (demo.cfg && demo.cfg.build) || {};
  const hook = B.hook ? sha([B.hook, ...(B.hookFiles || [])].map(f => { try { return readFileSync(join(demo.dir, f), 'utf8'); } catch (e) { return f + ':missing'; } }).join('\u0000')) : undefined;
  return {
    code: codeHash, raw: rawSig(demo.raw), vendor, hook, packs,
    parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, sha(JSON.stringify(v))])),
    // Text edits, one signature each: the server applies the ones not built in yet.
    edits: (flow.edits || []).filter(e => e.remove || e.replace).map(editSig),
  };
}
export const buildKey = inputs => sha(JSON.stringify(inputs));
// What the last build (data/build.json) lacks compared with these inputs: the text edits the server applies as it
// serves (serveEdits), and the reasons a build is needed (anything else). A built-in edit whose replacement changed
// ("six" → "nine", now "six" → "ten") is served as the change on top ("nine" → "ten").
const unsig = s => { const [remove, replace, , inn] = JSON.parse(s); return { remove: remove || undefined, replace: replace || undefined, in: inn || undefined }; };
const whatOf = e => e.remove || e.replace[0];
export function buildDiff(last, inputs) {
  const liveEdits = inputs.edits.map(unsig);
  if (!last || !last.inputs) return { needsBuild: ['no build yet'], serveEdits: liveEdits };
  const L = last.inputs, why = [];
  if (L.code !== inputs.code) why.push('the kit\'s build code changed');
  if (L.raw !== inputs.raw) why.push('raw captures changed');
  if (L.vendor !== inputs.vendor) why.push('vendor CSS changed');
  if (L.hook !== inputs.hook) why.push('the demo\'s build hook changed');
  if (L.packs !== inputs.packs) why.push('app packs changed');
  for (const [k, v] of Object.entries(inputs.parts)) if ((L.parts || {})[k] !== v) why.push(`flow ${k} changed`);
  const bakedSigs = new Set(L.edits || []), liveSigs = new Set(inputs.edits);
  const baked = (L.edits || []).filter(s => !liveSigs.has(s)).map(unsig);
  const serveEdits = [];
  for (const [i, e] of liveEdits.entries()) {
    if (bakedSigs.has(inputs.edits[i])) continue;
    const was = baked.find(b => whatOf(b) === whatOf(e) && JSON.stringify(b.in || null) === JSON.stringify(e.in || null));
    if (!was) { serveEdits.push(e); continue; }
    was.followed = true;
    if (was.remove) { why.push(`"${whatOf(e).slice(0, 40)}" is removed in the build; to bring it back`); continue; }
    serveEdits.push(e.remove ? { remove: was.replace[1], in: e.in } : { replace: [was.replace[1], e.replace[1]], in: e.in });
  }
  for (const b of baked) if (!b.followed) why.push(`the built-in edit of "${whatOf(b).slice(0, 40)}" was taken out`);
  return { needsBuild: why, serveEdits };
}
