# @scenecast/fixer

The fidelity fixer behind `scenecast fidelity` (docs/cli.md): for each real-vs-replica difference over the threshold,
pluggable diagnosers say why and write a per-demo patch to the demo's `flow.fixes.json`; the loop builds and checks
again.

- `index.mjs`: the diagnoser interface and loader (demo.json `fidelity.diagnosers`, `SCENECAST_DIAGNOSERS`).
- `rules.mjs`: the rule-based diagnoser (no model): fonts loaded by script, assets that came back as HTML pages, late
  styles, script-pinned and script-sized layout, virtualized lists, screenshot size.
- `patches.mjs`: the patch kinds, `flow.fixes.json`, and how the flow compiler and build apply them.
- `fix.mjs`: one round of diagnosis (run by the scenecast binary as the engine's `fidelity-fix`).
