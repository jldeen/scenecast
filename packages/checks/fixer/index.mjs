// The fidelity fixer: for each real-vs-replica difference over the threshold, a diagnoser says why (the cause, with
// the evidence) and, where it can, writes a per-demo patch (patches.mjs) that the loop builds and checks again.
//
// Diagnosers are pluggable. The rule-based one (rules.mjs) knows the causes the Demo 1 replica taught
// (docs/engine/lessons.md) and needs no model, so CI runs it as is. Another one (a model, a team's own rules) is a module
// whose default export is a diagnoser, or a list of them, named in demo.json `fidelity.diagnosers` (paths in the demo
// folder) or SCENECAST_DIAGNOSERS (paths, separated by the platform's path delimiter). They run before the rules; the
// first patch for a cause wins.
//
// A diagnoser:
//   { name: 'my-model',
//     async diagnose(finding, ctx) → [diagnosis] }
// finding: one item of compare.json that's over the threshold, or has a font that isn't the real file:
//   { id, kind: 'state' | 'zoom' | 'click', app, state, snap, z, click, pct, regions: [{ x, y, w, h, px }],
//     fonts: [{ family, name, weight, style, status, loadedBy }], size, sideBySide, diff, real, replica }
//   (regions are in screenshot pixels; ctx.toCss converts them to the app's CSS pixels)
// ctx: { demo, flow, compare, fixes, raw, show(finding) → { page }, toCss(finding, region), refOf(url) }
//   raw: { snap(id), main(id), urls, blob(url) → { file, html, type } | null, snaps() }
// diagnosis:
//   { cause: 'font-substituted' | 'missing-asset' | 'late-style' | 'script-pinned' | 'script-sized' | 'virtualized'
//            | 'size' | 'unexplained' | <your own>,
//     summary: 'one line for the presenter', confidence: 0..1, evidence: { … },
//     patch?: one of the kinds in patches.mjs (never a screenshot) }
import { join, delimiter, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rules } from './rules.mjs';

export { PATCH_KINDS, readFixes, writeFixes, patchKey, applyFixesToFlow } from './patches.mjs';

export async function loadDiagnosers(demo) {
  const named = [...((demo.cfg.fidelity || {}).diagnosers || []), ...(process.env.SCENECAST_DIAGNOSERS || '').split(delimiter).filter(Boolean)];
  const out = [];
  for (const f of named) {
    const m = await import(pathToFileURL(isAbsolute(f) ? f : join(demo.dir, f)).href);
    for (const d of [].concat(m.default || [])) {
      if (!d || typeof d.diagnose !== 'function') throw new Error(`${f}: its default export isn't a diagnoser ({ name, diagnose(finding, ctx) })`);
      out.push(d);
    }
  }
  return [...out, ...rules];
}
