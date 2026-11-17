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
- **Phase 3: fidelity loop and AI fixer.**
- **Phase 4: script to focus points, and the editor.**
- **Phase 5: ready for anyone**, then a desktop app (Tauri, macOS and Windows) on the same Rust core.

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
