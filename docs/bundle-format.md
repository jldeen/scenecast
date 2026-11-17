# `.scenecast` bundle format

A `.scenecast` bundle is currently a portable directory. It is designed so the same structure can later be zipped or published without changing the manifest model.

```text
demo.scenecast\
  manifest.json
  captures\
    start.png
  assets\
    logo.svg
```

## Schema v2 (`scenecast.bundle.v2`)

v2 is what scenecast writes. Its JSON Schema, generated from the Rust types, is
[`schema/bundle.v2.schema.json`](../schema/bundle.v2.schema.json) (`scenecast schema`; a test fails if it's stale).

**Scene kinds.** `live-page` is the default (a scene without `kind` is a live page). `screenshot`, `video-frame`
and `composite` are **fallbacks**, for a screen that can't be captured live or an explicit video import.

```json
{
  "schema_version": "scenecast.bundle.v2",
  "title": "Fixture",
  "apps": [{ "id": "chat", "title": "Chat", "key": "C", "url": "https://chat.example.test/" }],
  "viewport": { "width": 1920, "height": 1080, "dpr": 2.0 },
  "sections": [{ "id": "chat", "title": "Chat", "scenes": ["chat-start", "chat-start-typed", "chat-01-message"] }],
  "graph": {
    "start_scene": "chat-start",
    "scenes": [
      {
        "id": "chat-start-typed",
        "title": "Chat | Fixture",
        "kind": "live-page",
        "live": { "app": "chat", "snapshot": "data/snaps/chat-start-typed.html", "sha256": "…" },
        "transitions": [
          { "trigger": "enter", "target": "chat-01-message", "matcher": { "sel": "span[aria-label=\"Message\"]" }, "stream": "s001" }
        ],
        "hotspots": []
      }
    ]
  },
  "streams": [{ "id": "s001", "target": "chat-01-message", "frames": 15, "timing": "real", "duration_ms": 4215, "prompt": "Summarize …" }],
  "beats": [{ "label": "0 Reset", "active": "chat", "scenes": { "chat": "chat-start" } }],
  "focus_points": [{ "id": "answer-risk", "beat": 0, "app": "chat", "scenes": ["chat-01-message"], "find": "Two builds …", "mark": "box" }],
  "presenter": { "macos": "alt", "windows": "ctrl-alt", "focus_key": "F", "fill_key": "P", "next_key": "N" },
  "assets": []
}
```

| Field | What |
|---|---|
| `apps` | The web apps (browser tabs). `key`: one letter A–Z, not F, N or P; unique. |
| `scene.live` | The captured page (`snapshot`), its window `title`, a real-page screenshot kept only as the fidelity `reference`, and the built page's `sha256`. Absent until recorded (a warning). Only on `live-page` scenes. |
| `scene.transitions` | `trigger` (`click`, `enter`, `type`, `hover`, `escape`), `target` scene, `matcher` (the engine's: `sel`, `text`, `label`, `testid`, `in`, `nth`, `frame`, never a generated class), optional `stream` and `app`. |
| `streams` | Streamed answers: the scene they end on, frame count, `timing` (`real` or `even`), replay length, prompt. |
| `beats` | Presenter beats: beats[0] is reset (modifier+0), then modifier+1…9. Each says the active app and each app's scene. |
| `focus_points` | ZoomIt-style points: `beat`, `app`, `scenes`, a target (`find` text or a `union` of matchers), `mark` (`box`, `arrow` with `dir`, `zoom`), the script `line`. |
| `presenter` | The modifier per OS (⌥ on the Mac, Ctrl+Alt on Windows; the player takes both everywhere) and the focus, fill and next keys. |

v2 validation adds: app ids and keys valid and unique; every scene, transition, beat and focus point refers to
known apps and existing scenes and streams; focus beats within the beats; a focus point has a target; no captured
page on a fallback scene; snapshot and reference paths portable (and, with files checked, present).

`scenecast build` writes all of this from the engine's `flow.json` (docs/engine/flow-format.md). The player still
reads `flow.json` in this phase; it reads the bundle directly from Phase 2.

**v1 bundles still load.** A `scenecast.bundle.v1` manifest is migrated on read: a scene without `kind` (v1's
default, a screenshot) becomes `screenshot`, a fallback scene; every v1 field is still in v2. Edits write v2.

The rest of this page is the v1 format, all of which is still part of v2.

## `manifest.json`

The manifest is UTF-8 JSON. The v1 example below (schema version `scenecast.bundle.v1`) still loads.

```json
{
  "schema_version": "scenecast.bundle.v1",
  "title": "Product demo",
  "sections": [
    {
      "id": "overview",
      "title": "Overview",
      "scenes": ["start"]
    }
  ],
  "sources": [
    {
      "id": "demo-video",
      "kind": "video",
      "label": "demo.mp4",
      "media_type": "video/mp4"
    }
  ],
  "graph": {
    "start_scene": "start",
    "scenes": [
      {
        "id": "start",
        "title": "Start",
        "kind": "screenshot",
        "description": "Landing page with the primary call to action visible.",
        "assets": {
          "screenshot": "captures/start.png"
        },
        "provenance": {
          "source_id": "demo-video",
          "timestamp_ms": 0,
          "evidence": [
            { "kind": "frame", "id": "demo-frame-0001", "label": "Sampled frame 1" }
          ],
          "confidence": 1.0
        },
        "guide_marks": [
          {
            "id": "primary-cta-guide",
            "label": "Primary call to action",
            "bounds": { "x": 410, "y": 230, "width": 180, "height": 64 },
            "style": "pulse"
          }
        ],
        "hotspots": [
          {
            "id": "pricing-link",
            "label": "View pricing",
            "target": "pricing",
            "bounds": { "x": 420, "y": 240, "width": 160, "height": 48 },
            "trigger": "scroll",
            "scroll_direction": "down",
            "transition": {
              "kind": "frame-sequence",
              "default_frame_duration_ms": 90,
              "frames": [
                { "path": "captures/scroll-0001.png" },
                { "path": "captures/scroll-0002.png", "duration_ms": 120 }
              ]
            }
          }
        ]
      }
    ]
  },
  "assets": [
    {
      "path": "assets/logo.svg",
      "media_type": "image/svg+xml",
      "role": "supporting"
    }
  ]
}
```

## Validation rules

- `schema_version` must be `scenecast.bundle.v2` (a v1 manifest is migrated on read).
- `title` must not be empty.
- Optional `sections` define table-of-contents groupings for static players. Section IDs must be portable identifiers, section titles must not be empty, and every referenced scene must exist.
- Optional `sources` identify source artifacts used by importers. Source IDs must be portable identifiers, unique, and have non-empty labels. Source labels are display names, not required to be portable paths, so importers should not store machine-local absolute paths there.
- The graph must contain at least one scene.
- `start_scene` must reference an existing scene.
- Scene and hotspot identifiers must be unique within their scope.
- Guide mark identifiers must be unique within their scene.
- Guide mark labels must not be empty.
- Guide mark bounds follow the same finite coordinate rules as hotspots.
- Hotspot targets must reference existing scenes.
- Hotspot bounds must be finite and have positive width and height.
- Hotspot `trigger` defaults to `click`; set `scroll` for wheel-driven interactions.
- Scroll hotspots can set `scroll_direction` to `down`, `up`, or `any`; omitted values default to `any`.
- Transition `kind` currently supports `frame-sequence`.
- Transition frame paths must be portable bundle-relative paths.
- If a transition exists, it must include at least one frame.
- Transition default frame duration and per-frame `duration_ms` must be greater than 0 when provided.
- Asset paths must be portable bundle-relative paths using `/`, with no absolute paths, drive prefixes, URL schemes, empty segments, `.`, or `..`.
- CLI validation also verifies that referenced screenshot, video, transition frame, and bundle asset files exist in the bundle directory.
- Fallback scenes without a screenshot or video asset are valid but produce a warning, which supports incremental manual authoring. Live-page scenes without a captured page produce a "not recorded yet" warning.
- In v1 `kind` was advisory. In v2 it decides: `live-page` (the default) or a fallback kind.
- Hotspot `x` and `y` are finite capture-pixel coordinates and may be negative for off-canvas or transitional authoring states; `width` and `height` must be positive.
- `description` is optional authored text for search, accessibility, narration, and review. `notes` remain optional presenter or authoring notes.
- `provenance` is optional scene-level import metadata. It references a source by ID, can record a representative `timestamp_ms`, transcript segment IDs, evidence references, and a confidence value between 0 and 1. Provenance is evidence for review and adapters; it does not create hotspots by itself.
- Transcript-backed imports add both `video` and `transcript` source artifacts. Their scene descriptions and notes preserve cue text as a reviewable draft; transcript text alone must not be treated as evidence for real clickable UI hotspots.
- A transcript source can carry `transcript_segments`, each with a stable ID, start/end timestamps in milliseconds, and the original timed text. Scenes can use source-qualified transcript segment references in provenance. This keeps editorial evidence portable even when the original sidecar is not available to a downstream tool.
- Guide marks are visible non-navigation overlays. Use hotspots when an area should navigate; use guide marks when an area should draw attention without changing scenes.

## Authoring flow

The CLI creates and edits the manifest while preserving validation rules:

```powershell
cargo run -p scenecast-cli -- new demos\hello.scenecast --title "Hello Scenecast"
cargo run -p scenecast-cli -- add-scene demos\hello.scenecast pricing "Pricing" --screenshot captures\pricing.png
cargo run -p scenecast-cli -- add-hotspot demos\hello.scenecast start pricing-link "View pricing" pricing --x 420 --y 240 --width 160 --height 48
cargo run -p scenecast-cli -- add-guide-mark demos\hello.scenecast pricing price-callout "Plan selector" --x 320 --y 220 --width 240 --height 72
cargo run -p scenecast-cli -- add-section demos\hello.scenecast overview "Overview" --scenes start,pricing
cargo run -p scenecast-cli -- validate demos\hello.scenecast
```

Coordinates are currently capture-pixel coordinates. Future authoring surfaces can layer normalized coordinates or responsive layout metadata on top of this manifest without changing the initial click-through graph model.

CLI edit commands reject validation errors introduced by the requested edit, but they do not block edits solely because a hand-authored manifest already contains unrelated errors. This keeps the CLI usable for incremental repair workflows.

## Static publishing

`export-html` produces a static player folder that can be copied directly to GitHub Pages. The player uses relative bundle paths, so the same output works under a repository root, a `docs/` subdirectory, or a `gh-pages` branch. Hash routes such as `#/0/0` are used for section/scene deep links so static hosting does not need server-side rewrites.
