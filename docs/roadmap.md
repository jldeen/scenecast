# Roadmap

This document captures the near-term direction after the initial Rust foundation. It is not a commitment to a specific release order, but it describes the intended layers so future work stays coherent.

## Direction (Jessica's fork)

Scenecast is being rebuilt around the replica engine from Ignite '26 Demo 1: live-page scenes (captured pages)
are the default; screenshot and video-frame scenes stay only as fallbacks. macOS and Windows are both
first-class. Phases:

- **Phase 0 (done): foundation.** Bundle v2 with live-page scenes, states, transitions, streams, beats, focus
  points and presenter config; JSON Schema from Rust; v1 migration; replica-kit 1.4.0's engine in `packages/`,
  wrapped by the `scenecast` binary; CI on Ubuntu, macOS and Windows, including the fixture app end to end.
- **Phase 1 (fixture done; pilots next): recorder extension.** MV3 for Edge and Chrome over `chrome.debugger`
  (closed shadow roots, cross-site frames, a real screenshot per state), the side-state sweep with quiet waits, stream
  detection, resume after the browser stops the extension, `scenecast preflight`, and the recorder as a Rust library
  for the desktop app. Next: Demo 1 and Seth's Alaska app recorded with it (docs/recorder.md).
- **Phase 2 (done): player and build.** The player and the checks read bundle v2 (`manifest.json`) directly, from a
  server or a plain exported folder; presenter keys per platform (⌥ on the Mac, Ctrl+Alt on Windows, Edge and Chrome
  tested); `scenecast present` opens an app window or prints the URL; an incremental, content-hashed Rust build; the
  secret and PII scrub with `.out/scrub.json`, failing the build on any credential.
- **Phase 3 (done on the fixture; pilots next): fidelity loop and AI fixer.** `scenecast fidelity` compares every
  captured state with the replica (100%, each zoom capture, each menu or pane; fonts by file hash), diagnoses each
  difference with pluggable diagnosers (rule-based by default: script-loaded fonts, assets that came back as HTML
  pages, late styles, script-pinned and script-sized layout, virtualized lists), writes per-demo patches to
  `flow.fixes.json`, builds and checks again, and writes a residual report. Never a screenshot in a page's place.
  The fixture's lab app seeds each problem; the loop finds and fixes all of them on Ubuntu, macOS and Windows.
- **Phase 4 (done on the fixture; Demo 1's 27 checked in the pilots): script to focus points, and the editor.**
  `scenecast script <file>` puts each line of the presenter's script (text, Markdown or RunLines) on the screen it
  plays over and turns what backs it into focus points (`focus.json`), with the line-to-screen sheet (HTML and PDF,
  unbacked lines flagged) and the cue sheet; the matcher is pluggable, deterministic by default. The editor, inside
  the replica (⌥⇧E, or `scenecast edit`): dots that snap to what they point at, wording and date changes everywhere
  the text appears, beat starts, undo; every change shows at once and is saved. Both are Rust library calls with
  progress (`scenecast_build::script`, `scenecast_build::edit`).
- **Phase 4b (done): the desktop app.** Tauri, macOS and Windows, on the same Rust core (`crates/scenecast-app`, the
  commands; `apps/desktop`, the window): the demo library with each demo's status; new demo and record (preflight item
  by item with fixes, the one-time Load unpacked guided, live screens and recorder vs product time); build with the
  scrub report and the checks; fidelity with real vs replica side by side and Fix; script to focus points with the
  sheets; the editor; present (the key reference first, then full screen); export as a folder or zip. A universal
  `.dmg` and an `.msi` and NSIS installer from CI, signed when the secrets are set. A WebDriver test runs the whole
  flow on the fixture app in the real window on macOS and Windows. Updates are a stub.
- **Phase 5 (done; pilots next): ready for anyone.** The presenter guide (⌥G, from replica-kit 1.6.0): a window for the
  laptop screen that follows the stage over a BroadcastChannel, made from the same script as the focus points
  (`scenecast notes`, `guide-shots`, the `notes` check), opened by the app's Present step on the app's screen. Fast
  checks: `scenecast quick` checks only what a change touched (under 3 minutes on the fixture, measured in CI); the
  app runs it after a build, a script or an edit, and the whole checklist only on Export. Script focus points follow
  wording and date edits; marks against the screen's edge stay on screen. The one-page guide (`docs/guide.md` and its
  PDF), the "replicate a demo" skill (`skill/SKILL.md`, `scenecast install-skill`), and a GitHub Release with the
  installers from a version tag (v0.3.0; unsigned until the signing secrets exist). Next: the human pilot with a
  presenter outside Jessica's team, then pilots on real products.

## Foundation from Seth's scenecast

- Portable `.scenecast` directory bundle with `manifest.json`.
- Scene graph, sections, scenes, hotspots, guide marks, captures, bundle assets, and validation.
- CLI authoring for create, inspect, validate, add-scene, add-hotspot, add-guide-mark, add-section, ffmpeg-backed import-video, and static HTML export.

## Remaining foundation work

- Keep ingestion acceptance fixtures focused on real source artifact -> `.scenecast` bundle -> validation -> static HTML export before freezing generated contracts.
- Add an `add-asset` command for bundle-level supporting assets and non-capture media references.
- Add package/archive support so a `.scenecast` directory can become a single portable file when needed.
- Add richer validation against capture dimensions (for both hotspots and transition frame compatibility).
- Expand sample bundles that become end-to-end fixtures for click + scroll + transition playback.
- Add transition authoring ergonomics beyond manual frame lists (for example, sequence import helpers).
- Add GitHub Pages examples that publish exported players from `docs/` and `gh-pages`.

## Product surfaces

- Web authoring and production web player for interactive click-through demos.
- Manual screenshot import workflow.
- Video ingest that can extract frames into scenes, currently backed by an OS-provided ffmpeg executable.
- Native/Tauri capture workflows.
- Rust CLI workflows for automation and CI.
- GitHub Pages publishing for static player output.
- Later sharing and analytics.

## Design principles

- Keep bundle semantics portable and explicit.
- Keep core validation independent of any single UI.
- Prefer incremental authoring: drafts may warn while still being inspectable and repairable.
- Make authored bundles safe to move between Windows, macOS, Linux, local development, CI, and cloud publishing.
