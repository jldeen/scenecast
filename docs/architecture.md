# Architecture

## How a replica works

Every screen is the **real page, captured**: its DOM with the live CSS, fonts, shadow DOM, iframes and form, scroll
and popover state, with no scripts and no sign-in tokens. Clicks, typing, Enter and Escape move between captured
screens by morphing the page, the way a single-page app re-renders. AI answers replay from their real streamed
frames. Hidden presenter keys jump between beats, and ZoomIt-style focus points zoom to what each line of the
script points at. Nothing touches the network, and a determinism checklist (two runs, three cold starts, clicks,
hovers, drags, zoom 50–200%, focus) proves two runs come out identical.

**`live-page` scenes (captured pages) are the default.** Screenshot and video-frame scenes are kept only as a fallback,
for a screen that truly can't be captured live or an explicit video import; checks flag every fallback scene.

**macOS and Windows are both first-class.** The CLI, the recorder, the player, the launcher (Chrome or Edge as an app
window), the desktop app and the checks run on both, and CI tests both (and Linux).

**The desktop app is how presenters use it** ([app/README.md](app/README.md)); the CLI ([cli.md](cli.md)) stays
underneath for automation and CI, and both drive the same Rust core. **Small fixes are fast:** after each change only
the checks for what it touched run (`scenecast quick`, a minute or two; the app runs it after a build, a script or an
edit). The whole checklist runs once, before a release or a share.

Scenecast started as Seth Juarez's `.scenecast` bundle format and CLI, and was rebuilt around the replica engine from
Ignite '26 Demo 1 (replica-kit 1.4.0).

## Layout

The replica engine is **StuntDouble**: the `@stuntdouble/*` packages and the `stuntdouble-*` crates. Scenecast is the
app on top of it: the desktop app, the AI modes, script to focus points and the editor. They live in one repository,
so a fix to the engine lands once for Scenecast and for every demo that runs `stunt` (see
[stuntdouble.md](stuntdouble.md)).

```text
crates/
  stuntdouble-format   StuntDouble: bundle model (v2) + validation, v1 migration, JSON Schema
  stuntdouble-build    StuntDouble: library: new projects, the JS engine, manifest.json from a build
  stuntdouble-cli      StuntDouble: the CLI, built under two names: stuntdouble (stunt from npm runs it) and scenecast
  scenecast-app        Scenecast: what the desktop app calls: the demo library, each step with serializable progress
apps/desktop           Scenecast: the desktop app (Tauri): ui/, src-tauri/ (its own Cargo workspace), the UI test
packages/              npm workspaces: everything that runs in the browser
  cli                  @stuntdouble/cli: the stunt command (also stuntdouble), which runs the binary for this OS
  build                @stuntdouble/build: binaryPath(), the prebuilt binary for this OS (or this checkout's target/)
  core                 @stuntdouble/core: the engine entry (bin/engine.mjs), demo settings, flow compiler, text rules,
                       edits, presenter notes, workflow (text, status, save, release), template, at()
  capture              @stuntdouble/capture: the recorder extension (MV3, Edge and Chrome), capture (DOM, CSSOM, fonts,
                       shadow DOM, iframes), side-state audits, preflight's browser half, the receiver, raw → data/
  player               @stuntdouble/player: server, morph engine, streams, presenter keys, focus points, the presenter
                       guide, the launcher
  checks               @stuntdouble/checks: the fidelity checklist; real vs replica and its report; the fixer
                       (checks/fixer: pluggable diagnosers and the per-demo patches, flow.fixes.json)
  format               @stuntdouble/format: the manifest's JSON Schema (schema/bundle.v2.schema.json, generated from
                       the Rust types: stuntdouble schema)
  apps                 @stuntdouble/apps: app packs (recording settings, build rules, theme and platform packs, once
                       per app); packs outside the repository from STUNTDOUBLE_PACKS or ~/.stuntdouble/packs
  script               @scenecast/script: script to focus points: parse, index each screen, pluggable matcher, sheets
  editor               @scenecast/editor: the editor inside the replica (dots, wording and dates, beat starts, undo)
  ai                   @scenecast/ai: AI-assisted recording with GitHub Copilot (the presenter's own sign-in) or a
                       deterministic stand-in: plans, Record for me, the talk track, the coach (docs/ai.md)
  selftest             end-to-end tests against examples/fixture-app (the fidelity loop, the AI modes)
examples/              fixture-app (a local fake product the tests record), sample bundles
skill/SKILL.md         the "replicate a demo" skill for Copilot, driving the CLI (scenecast install-skill)
scripts/               guide-pdf.mjs (docs/guide.pdf from docs/guide.md)
docs/                  the docs (index: docs/README.md)
```

**Inside the packages:** one package reaches another by its package name (`@stuntdouble/core/lib/demo.mjs`), never
by `../`, and a file in another package (a script to spawn, a folder to serve) through `at('player', 'serve.mjs')`
from `@stuntdouble/core/lib/at.mjs`. Both work here (npm workspaces link the packages) and in an install. The desktop
app carries the packages as `node_modules/@stuntdouble/*` and `node_modules/@scenecast/*`.

**The split.** Rust owns the bundle format, validation, build orchestration and the CLI; JavaScript owns what
runs in a browser. The manifest's JSON Schema is generated from the Rust types, so the two can't drift.
`stuntdouble-build` is a library with structured results (`ProjectCreated`, `SyncReport`, and in `recorder`:
`PreflightReport` item by item, `RecordStatus`, `RecordSummary` with `RecordTiming`) and line-by-line progress
(`Engine::run_with_progress`), so the CLI and the planned desktop app (Tauri, macOS and Windows) share it.
`build::build` also reports build stages and per-file fingerprint progress. `fidelity::run` runs the fidelity loop
(compare, diagnose and patch, build, again) with `FidelityProgress` events and a typed `FidelityReport`.
`script::run` runs script to focus with `ScriptProgress` events and a typed `ScriptReport`; `edit::start` runs the
editor's server and reports each saved change. Rust compiles the recorded base flow
and rewrites captured pages, stream frames, interaction fragments, assets and CSS, deduplicates and indexes streams, composes captured parts, isolates generated classes and filters non-visual interaction operations, publishes staged outputs by
content hash, and prunes unreferenced assets. JavaScript still applies flow overrides and focus hooks and orchestrates
composition and interaction processing; moving that processing to Rust remains unfinished. The resolved raw folder is passed explicitly
to the engine so it cannot process a different folder from the one Rust scanned.

**The desktop app** is a Tauri window over `scenecast-app`, which wraps `stuntdouble-build` for a UI: demos as a
library (status from what's on disk), each step returning a typed result and reporting `Update`s (stages, engine
lines, preflight items, recorder status, checklist items, fidelity and script events, editor saves) that the shell
forwards as `job` events, one job per demo at a time. Reports and pictures from a demo's `.out` are shown through the app's own
`scenecast:` protocol, limited to the library. The replica is edited and presented in Edge or Chrome (the browser its
fidelity is measured in), not the app's own webview, which is WebKit on the Mac. Installers carry the packages (as
`node_modules/@stuntdouble/*` and `node_modules/@scenecast/*`), `playwright-core` and Node, and the app points the engine
at them. See [app/README.md](app/README.md).

**The recorder** is one body of code (driver, recorder, side-state audits) that runs two ways: as an MV3 extension
in the presenter's own Edge or Chrome, where a Playwright-shaped shim over `chrome.debugger` gives it pages, frames
(cross-site ones in their own process too), input and screenshots; or as `agent.js` in a Playwright-driven browser.
See [recorder.md](recorder.md).

**Cross-platform.** Everything works the same on macOS and Windows: paths are normalized to `/` in the bundle and
the build's records, the launcher opens Chrome on the Mac and Edge on Windows as an app window (either can be
chosen), presenter keys take ⌥ or Ctrl+Alt, projects carry `.gitattributes` so captures are served byte for byte
on any OS, and CI runs Rust and the engine end to end on Ubuntu, macOS and Windows. Browser key tests run
headlessly and do not verify native browser or operating-system shortcut interception.

### `stuntdouble-format`

`stuntdouble-format` owns the data model and validation rules that every surface shares (v2 adds live-page scenes, apps, transitions, streams, beats, focus points and presenter config; see bundle-format.md):

- typed `SceneId` and `HotspotId` values with validated serialization and deserialization;
- `BundleManifest`, `Section`, `SceneGraph`, `Scene`, `Hotspot`, `GuideMark`, `Rect`, source/provenance, and asset primitives;
- structural validation for scene graph integrity, hotspot targets, bounds, schema version, and portable asset paths;
- filesystem validation for exact-case referenced files inside a bundle directory;
- manifest read/write helpers.

The core crate does not depend on CLI concerns. Future web, Tauri, native capture, or cloud services should use the same core primitives or generated equivalents so bundle behavior stays consistent.

### `stuntdouble-cli`

`stuntdouble-cli` (the `stuntdouble` and `scenecast` binaries) provides the first authoring surface:

- create bundles with `new` or `init`;
- inspect bundle summaries;
- validate structural and filesystem correctness;
- add screenshot-backed scenes;
- add click-through hotspots between scenes;
- add guide marks that visually focus attention without navigating;
- add table-of-contents sections for static players.

The CLI validates edits before writing them. It rejects errors introduced by the requested edit while still allowing unrelated pre-existing manifest errors, which keeps the CLI useful for repairing hand-authored bundles.

## Bundle boundary

A `.scenecast` is currently a directory with `manifest.json` plus referenced captures/assets. The manifest stores portable paths with `/` separators and no absolute, parent-directory, URL-scheme, or Windows-drive paths. CLI validation checks referenced files with exact case so a bundle authored on Windows or macOS does not accidentally fail later on Linux. Import provenance records source IDs, labels, timestamps, evidence, and confidence without requiring machine-local source paths in the portable bundle.

## Static player boundary

`export-html` emits a static player folder that is designed for GitHub Pages and other static hosts. It keeps all bundle references relative, uses hash routes for deep links, and requires no server-side rewrites. The player supports screenshot scenes, video scenes, hotspots, guide marks, section-based table of contents, keyboard navigation, authored descriptions, and presenter notes embedded in the exported data model.

## Write safety

Manifest writes go through a temporary file in the bundle directory before replacing `manifest.json`. This keeps normal CLI edits from directly truncating the existing manifest during serialization or write failures.

## Tracing

The CLI initializes `tracing` and instruments the mutation and validation paths that matter for authoring operations. Default output remains quiet; set `RUST_LOG` when investigating CLI behavior.
