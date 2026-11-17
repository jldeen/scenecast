# CLI

`scenecast` is one binary for macOS and Windows (and Linux). It creates projects, runs the replica engine (the
JavaScript in `packages/`, under Node) and keeps the bundle manifest in step, and it edits and validates bundles.

## Create a project

```bash
scenecast new demos/hello --title "Hello" --app chat=https://chat.example.com/ --app admin=https://admin.example.com/
```

`init` is an alias. `--dir <parent>` creates it inside another folder; `--port` sets the replica's localhost port.
Each `--app id=url` is a browser tab of the demo; its presenter key is a letter of its id (never F, N or P).

A project is a demo folder that is also a `.scenecast` bundle:

```text
hello/
  manifest.json        bundle v2: one live-page start scene per app, waiting to be recorded
  demo.json            apps, viewport, browser profile, recorder settings
  focus.mjs            focus points (⌥F / Ctrl+Alt+F)
  flow.overrides.mjs   hand edits to the recorded flow
  capture/             the demo's own capture scripts (prep.js)
  data/                what the build writes (pages, streams, assets)
  captures/ assets/    images for fallback scenes, if one is ever needed
  .gitattributes       no line-ending conversion: a fresh clone on any OS serves the same bytes
```

Scenes are **live pages** by default. `new` never makes a screenshot or video-frame scene.

## Engine commands

Each runs on the project you're in (or `--demo <dir>`) and passes its other arguments to the engine.

| Command | What |
|---|---|
| `scenecast preflight [--check] [--json\|--ndjson]` | Is everything ready to record? Receiver, browser and profile, recorder, each app's tab (open, light, on its start screen). Fixes only what fails (`--check`: fixes nothing) and never relaunches a running browser. Seconds when all is set. See [recorder.md](recorder.md). |
| `scenecast extension [<dir>]` | Builds the recorder extension for Edge and Chrome (`~/.scenecast/extension` by default). Load it once, unpacked. |
| `scenecast receiver` | The local receiver the recorder posts to. Keep it running while recording (preflight starts it). |
| `scenecast agent [<dir>]` | Builds `agent.js`: the same recorder for a Playwright-driven browser instead of the extension. |
| `scenecast record start [--resume] [--no-auto]` / `status` / `stop` | Records the demo once; each new screen's side states (hovers, clicks, step groups, "+N", drags, zoom, long lists) are captured on the way. `status` and `stop` report the recorder's own time apart from the product's (`timing`). |
| `scenecast record side hovers\|clicks\|drags\|groups\|chips\|zoom\|list [--app id]` | One side path by hand. |
| `scenecast cmd <op> ['{json}']`, `scenecast run <script.js>` | One command on the recorder, or a script on the Playwright agent (an MV3 extension can't run scripts it's sent). |
| `scenecast flow [--from-raw]` | `recording.json` + `flow.overrides.mjs` → `flow.json`. |
| `scenecast build [--from-raw] [--force]` | Flow, raw captures → `data/` (changed captures only, scrubbed), secret scan, then `manifest.json` (below). |
| `scenecast sync` | `manifest.json` from what was built, on its own. |
| `scenecast serve [--open] [--pace N] [--release] [--no-editor]` | The replica on localhost. `--open`: an app window, Chrome on the Mac and Edge on Windows (`chrome.browser` and `chrome.profile` in `demo.json`). Served for authoring (not `--release`), the editor is in the page, hidden until its key. |
| `scenecast present [--pace N] [--release]` | Serve the replica and open the same app window, with no editor in the page. The URL is printed if the browser cannot be opened. |
| `scenecast script <file> [--matcher text\|<file.mjs>] [--no-write] [--no-pdf] [--strict] [--json\|--ndjson]` | Script to focus points (below). |
| `scenecast edit [--port N] [--no-open] [--ndjson]` | The replica in edit mode (below). |
| `scenecast text "<old>" "<new>"` | A wording or date tweak, live on reload. |
| `scenecast check [--only a,b] [--skip a,b]` | The whole fidelity checklist. Flags every fallback scene first. |
| `scenecast fidelity [--rounds 3] [--threshold 0.5] [--no-fix] [--json\|--ndjson]` | The fidelity loop: real vs replica for every captured state, each difference diagnosed and fixed in `flow.fixes.json`, built and checked again (below). |
| `scenecast quick` | The checks for only what changed. |
| `scenecast status`, `scenecast save "<msg>"` | Where things stand; secret scan and commit. |
| `scenecast release [--push]` | Build, manifest, full checklist, secret scan, commit (and push). |
| `scenecast sheet`, `scenecast hovers`, `scenecast scan [<dir>]` | Contact sheet, hover sheet, secret scan. |
| `scenecast schema [--out <file>]` | The manifest's JSON Schema (v2), generated from the Rust types. |

Builds inspect raw captures before processing and write `.out/scrub.json` without including matched values.
Detected credentials stop the build; email addresses and labeled tenant IDs in built text are redacted unless
their exact values appear in `demo.json` as `"scrub": { "allowlist": ["value"] }`. Credentials cannot be
allowlisted. Scripts, inline event handlers and JavaScript URLs in built captures, including SVG and JSON-embedded
markup, fail the build; malformed
UTF-8 in text capture files is rejected rather than skipped. Binary files are not inspected for PII.
Treat the raw capture folder as sensitive even after building.

`build` writes `manifest.json`: every state in `flow.json` becomes a `live-page` scene (`data/snaps/<id>.html`,
its SHA-256, its transitions), with the streams, beats, focus points and apps. Fallback scenes already in the
manifest are kept and listed. The build fails if the manifest doesn't validate or a page is missing. The file is
only rewritten when it changes.

Rust fingerprints the raw capture tree, built data and Rust processing code by content; changing any of them
forces capture processing even when file sizes and modification times are unchanged. The cache is kept in
`.out/build-fingerprint.json`.

## The fidelity loop: `scenecast fidelity`

Compares every captured state of the real product with the replica, the way its real screenshot was taken: each
state at 100% (the demo's viewport), each zoom capture at its zoom, and each menu or pane the click audit opened
(right after the click, the pointer on the control). For each: the share of pixels that differ, the regions, a
side-by-side and a diff picture. Each state's fonts are checked too: every font the real page had loaded must be in
the replica from the same file (SHA-256), else it's reported as substituted or a different file.

What's over the threshold (0.5% of pixels by default), or has a font that isn't the real file, goes to the fixer.
Its diagnosers say why, from evidence in the raw captures and the rendered replica, and write a patch for this demo
in `flow.fixes.json` (never a capture edited by hand, never a product-wide rule). Then the loop builds and compares
again, up to `--rounds` fix rounds (3). The rule-based diagnoser knows:

| Cause | Found from | Patch |
|---|---|---|
| font substituted | a font the real page loaded by script (the FontFace API) has no @font-face rule in any capture | `font`: an @font-face rule for the file the page fetched (matched by its name table) |
| missing asset | a blank image in a region that differs; its capture answered with an HTML page (a sign-in page) | `asset`: the same resource as captured from another URL of it (a one-time or signed link) |
| late style | a menu or pane opens unstyled: its classes have no rules (styles that came and went with it) | `clickCss`: the rules from the capture that has them |
| script-pinned | at another zoom, a fixed box isn't where the real page put it | `pin`: kept over the placeholder that's where the real page put it |
| script-sized | at another zoom, a size isn't the real page's | `set`: the size as a function of the window, from the two captures |
| virtualized | at another zoom, a scrolling list ends early: only the rows in view were captured | `rows`: the rows from the capture at that zoom |
| size | the screenshots aren't the same size | none: record at the demo's viewport |

Anything else is reported as unexplained. The loop never replaces a page with a screenshot: there is no such patch,
and it fails if the manifest has more fallback scenes at the end than at the start. Remove a patch from
`flow.fixes.json` to undo it; `flow.overrides.mjs` runs after the fixes, so a hand edit wins.

The diagnosers are pluggable (a model, a team's own rules): see `packages/fixer/index.mjs` for the interface, and
name modules in `demo.json` as `"fidelity": { "diagnosers": ["my-diagnoser.mjs"] }` or in `SCENECAST_DIAGNOSERS`.
They run before the rules.

It writes `.out/fidelity/report.html` and `report.json` (what's still different, where and how much, why; the fonts;
the fixes) and, per round, `.out/fidelity/round-N/` (the comparison, its pictures, the diagnoses). `--no-fix` only
compares and reports. `--ndjson` prints each event as it comes (what the desktop app shows); `--json` the outcome.
The exit code is 0 when every state is within the threshold, every font matches and no fallback scene was added.
From Rust: `scenecast_build::fidelity::run(dir, &FidelityOptions, |progress| …)`.

## Script to focus points: `scenecast script <file>`

The presenter pastes their script; Scenecast works out what each line points at. The script is plain text (each
line a line), Markdown (`>` quotes are the spoken lines, `##` headings or `Beat N:` lines start beats, `**Do:** …`
after a line is its cue; everything else is notes) or a RunLines `.sk` file (a row per beat). Beats are optional.
The fixture's sample is [examples/fixture-app/script.md](../examples/fixture-app/script.md).

1. Every screen of the run-through (the recorded path, in order) is opened in the replica and indexed: its text
   blocks, controls, lists and regions, with their accessibility roles and boxes.
2. A matcher puts each line on the screen it plays over (in order: a line is never on an earlier screen than the
   line before; a line nothing backs stays on the screen before it) and picks up to three elements that back it.
3. Each pick becomes a focus point: its target (the text, or the sentence in a long paragraph; a control by its
   label; list items together as one box), a box or, for a small control, an arrow whose tail comes from the open
   side of the screen; its beat (the ⌥ key that lands just before it); its order (as the line mentions them). Each
   target is checked with the focus engine's own locate, and each point is played once the way ⌥F plays it, to
   see where it lands (the zoom it fits, never past 2×, with the 9% margin).

It writes `focus.json` (the script's points; the editor's dots and points moved in the editor are kept on a
re-run), and in `.out/script/`: `sheet.html` and `sheet.pdf` (each line next to its screen, what backs it
highlighted and numbered in ⌥F order, where each point lands; a line nothing backs is flagged, and so are facts a
line states, numbers and names, that its screen doesn't show), `cues.md` and `cues.html` (the presenter's cue
sheet: per line, the steps to its screen or the beat key, then ⌥F per point) and `script.json` (all of it, for
tools). The exit code is 0 even with unbacked lines (they're flagged); `--strict` makes them fail.

The matcher is pluggable. `text`, the default, is deterministic (text similarity weighted by how rare each word
is across the screens, sentence by sentence, with accessibility roles), so CI runs it with no model. A demo can
bring its own, a model for instance: `--matcher my-matcher.mjs` or `demo.json` `"script": { "matcher": "…" }`,
whose default export is `{ name, async match({ lines, screens, sequence, flow }) }` (the interface and helpers
are in `packages/script/match.mjs`). From Rust: `scenecast_build::script::run(dir, &ScriptOptions, |progress| …)`.

## The editor: `scenecast edit`

The replica in edit mode, for people to adjust what the script matcher did, or to add their own focus points.
`scenecast edit` serves the demo and opens it in edit mode; in any replica served for authoring (`scenecast serve`)
the key **⌥⇧E** (**Ctrl+Alt+Shift+E** on Windows) turns it on and off. It's never in the page with `present`,
`--release` or an export, and nothing of it shows until its key.

| Do | How |
|---|---|
| Add a focus point | Click what the line points at: a dot. It snaps to the element (a control, the sentence under the pointer, a list item), and gets its zoom, a box or an arrow, its beat and its place in the beat (reading order). |
| Move one | Drag its dot onto something else. |
| Delete, reorder, box or arrow | Click its dot (or its row in the panel), then Delete; `[` `]` (or ↑ ↓) for its place in the beat; M for box or arrow. ▶ plays it as ⌥F does. |
| Change wording or a date | Drag across the text, type the new words, Enter. It changes everywhere the text appears (every screen and answer frame; the panel says how many). |
| Set where a beat starts | Go to the screen, then Start here next to the beat (⌥1–⌥9), or next to a new one. |
| Undo | ⌘Z / Ctrl+Z, or Undo. |
| Click the app itself | Use the app (the panel's button), then Edit again. Presenter keys work all the time. |

Every change shows at once (no rebuild, no reload) and is saved: focus points to `focus.json`, wording and beat
starts to `flow.editor.json` (docs/engine/flow-format.md). `scenecast build` bakes the wording in. The server prints
one `@edit {"event":"saved",…}` line per change. From Rust: `scenecast_build::edit::start(dir, &EditOptions)` returns
the server with its URL; its `events()` are the saved changes, until it stops.

Environment: `SCENECAST_JS` (the `packages` folder), `SCENECAST_NODE` (the Node binary), and the engine's
`REPLICA_RAW`, `REPLICA_PORT`, `REPLICA_RX_PORT`, `REPLICA_NO_OPEN=1`, `REPLICA_CHROME_CHANNEL` (`chrome`, or
`msedge` for Edge).

## Bundle commands

These edit and validate any bundle, v1 or v2. A v1 bundle is migrated on read: its scenes are fallback scenes.
Edits write v2.

## Inspect a bundle

```powershell
scenecast inspect demos\hello.scenecast
```

The summary includes title, schema version, start scene, section count, scene count, asset count, warning count, and error count.

## Add a scene

```powershell
scenecast add-scene demos\hello.scenecast pricing "Pricing" --description "Pricing page overview"
scenecast add-scene demos\hello.scenecast native "Native dialog" --screenshot captures\native.png --notes "Can't be captured live"
```

Without `--screenshot` the scene is a `live-page` scene, recorded later. With `--screenshot` it's a **fallback**
screenshot scene: use one only for a screen that can't be captured live (a native window, protected content).
`validate` and `check` flag every fallback scene. The screenshot path is stored relative to the bundle root. Paths must be portable and use `/` in the manifest; PowerShell accepts the command argument shown above, and the manifest examples use `/`. `--description` stores authored text for search, accessibility, narration, and review. `--notes` stores presenter or authoring notes.

## Add a hotspot

```powershell
scenecast add-hotspot demos\hello.scenecast start pricing-link "View pricing" pricing --x 420 --y 240 --width 160 --height 48 --trigger scroll --scroll-direction down
```

Hotspots belong to a source scene and target another scene by ID. Coordinates are capture-pixel values. Width and height must be positive. Trigger defaults to `click`; use `scroll` for wheel-style interactions. Scroll hotspots can use `--scroll-direction down`, `--scroll-direction up`, or the default `any`.

## Add a guide mark

```powershell
scenecast add-guide-mark demos\hello.scenecast pricing price-callout "Plan selector" --x 320 --y 220 --width 240 --height 72 --style highlight
```

Guide marks are visible overlays that draw attention without changing navigation. Coordinates are capture-pixel values. Styles are `pulse`, `ring`, and `highlight`.

## Add a table-of-contents section

```powershell
scenecast add-section demos\hello.scenecast overview "Overview" --scenes start,pricing
```

Sections group scenes for the exported player's table of contents and hash deep links. Scene IDs are comma-separated and stored in playback order.

## Add a transition frame sequence

```powershell
scenecast add-transition demos\hello.scenecast start pricing-link --frames captures\scroll-0001.png,captures\scroll-0002.png --frame-duration-ms 90
```

`add-transition` attaches a frame-sequence transition to an existing hotspot. Frames are stored as portable bundle-relative paths and replay before the hotspot lands on the target scene.

## Import video frames

```powershell
scenecast import-video demos\hello.scenecast demo.mp4 --scene-prefix demo --every-seconds 5 --crop 0,120,1920,960
```

`import-video` shells out to an existing `ffmpeg` executable on the OS. By default it runs `ffmpeg` from `PATH`; use `--ffmpeg <path>` or the `SCENECAST_FFMPEG` environment variable when the binary lives somewhere else.

The command extracts PNG frames into `captures\` and adds each generated frame as a video-frame scene. For example, `--scene-prefix demo` creates scene IDs such as `demo-0001` with screenshots such as `captures/demo-0001.png`.

Video imports also create a portable source artifact such as `demo-source` and attach scene provenance with the representative timestamp and frame evidence. The source label uses the input file name for review; the manifest does not store the machine-local absolute video path.

Imported frames are linked as a wheel-driven sequence. A fresh starter bundle uses the first imported frame as the start scene, and each imported frame gets a full-frame `next` hotspot to the following frame with a short frame-sequence transition.

Use `--crop x,y,width,height` to remove browser chrome or other recording matte before frames are extracted. The crop is applied by ffmpeg before sampling frames.

### Import a transcript-backed draft

If a same-basename `.srt` or `.vtt` exists beside the video, `import-video` detects it automatically. Pass `--transcript path\to\captions.vtt` to select a different sidecar explicitly:

```powershell
scenecast import-video demos\hello.scenecast recordings\demo.mp4 --scene-prefix demo --transcript recordings\demo.vtt
```

Scenecast parses timed cues into stable transcript segment evidence and groups them deterministically into draft scenes. It starts a new candidate at substantial pauses, topic-cue boundaries, maximum duration, or maximum text length, then samples a representative frame timestamp for each candidate. The bundle records both video-frame and transcript evidence, transcript segment IDs, and the draft text in the scene description and notes.

Transcript imports are drafts, not inferred UI maps. Scenecast does not create click hotspots from spoken text or claim that a phrase identifies a clickable control. Candidate scenes are only linked linearly with the existing scroll-style next navigation, ready for later review and authoring.

## Export an editorial draft

```powershell
scenecast export-draft demos\hello.scenecast demos\hello-editorial-draft
```

`export-draft` writes `draft.json` in the requested output directory using the generic `editorial-draft` schema version `1`. It copies each candidate screenshot beneath `assets/`, records a SHA-256 checksum, and rewrites paths so they resolve without the original bundle. Each scene includes its stable ID, transcript start/end range, verbatim transcript, empty `actions`, source-qualified transcript evidence, and notes. The empty action list is intentional: editorial tools must not mistake transcript text for inferred clickable UI.

## Export a local HTML player

```powershell
scenecast export-html demos\hello.scenecast demos\hello-player
```

The command writes `index.html` and copies referenced captures/assets into the output directory. Open the generated `index.html` in a browser to test the click-through locally.

Exported HTML is intentionally static-host friendly: the output folder contains `index.html` plus copied relative assets and can be published from `docs/`, a `gh-pages` branch, or any static file host. The player stretches screenshot or video scenes to the viewport, renders guide marks, provides a table of contents, supports keyboard navigation, and replays transition frames before landing on the destination scene. Hash routes such as `#/0/0` deep-link to section and scene positions without server rewrites. Add `?debug=1` to the URL for a minimal hotspot overlay while tuning bounds.

Recorded live-page bundles export the morph player and built captures instead. Open `index.html` directly or serve
the folder on a static host. Direct file playback currently excludes custom player modules; HTTP playback supports
them. Explicit screenshot and video-frame fallback scenes can be mixed with live pages; their app is determined
from their beat or connected scenes. An ambiguous fallback needs an `app` in its `playback.scenes` options.
Fallback scenes remain flagged by `check`.

The repository includes `examples\scroll.scenecast` as a complete static scroll sample. Export it with:

```powershell
scenecast export-html examples\scroll.scenecast demos\scroll-player
```

## Validate a bundle

```powershell
scenecast validate demos\hello.scenecast
```

Validation checks both manifest structure and referenced files:

- schema version and title;
- start scene existence;
- duplicate scene and hotspot IDs;
- duplicate guide mark IDs;
- section scene references;
- hotspot targets;
- hotspot and guide mark bounds;
- hotspot trigger and transition shape;
- portable asset paths;
- exact-case file existence for screenshots, videos, transition frames, and bundle assets.

Warnings do not fail validation. For example, a scene with no capture asset is valid during incremental authoring but emits a warning.
