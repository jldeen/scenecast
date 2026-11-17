# Scenecast

Record a live web demo once, then present it offline, the same way every time.

Every screen is the **real page, captured**: its DOM with the live CSS, fonts, shadow DOM, iframes and form, scroll
and popover state, with no scripts and no sign-in tokens. Clicks, typing, Enter and Escape move between captured
screens by morphing the page, the way a single-page app re-renders. AI answers replay from their real streamed
frames. Hidden presenter keys jump between beats, and ZoomIt-style focus points zoom to what each line of the
script points at. Nothing touches the network, and a determinism checklist (two runs, three cold starts, clicks,
hovers, drags, zoom 50–200%, focus) proves two runs come out identical.

Scenecast started as Seth Juarez's `.scenecast` bundle format and CLI. It is being rebuilt around the replica engine
from Ignite '26 Demo 1 (replica-kit 1.4.0). **`live-page` scenes (captured pages) are the default.** Screenshot and
video-frame scenes are kept only as a fallback, for a screen that truly can't be captured live or an explicit video
import; checks flag every fallback scene.

**macOS and Windows are both first-class.** The CLI, the recorder, the player, the launcher (Chrome or Edge as an app
window) and the checks run on both, and CI tests both (and Linux).

## Layout

| Path | What |
|---|---|
| `crates/scenecast-core` | Bundle model (schema v2) and validation; v1 bundles migrate on read. JSON Schema export. |
| `crates/scenecast-build` | Library: new projects, running the JS engine with progress, `manifest.json` from a build. |
| `crates/scenecast-cli` | The `scenecast` binary. |
| `packages/kit` | The engine's CLI entry (run by `scenecast`), demo settings, flow compiler, workflow, project template. |
| `packages/recorder` | Capture: the recorder extension (MV3, Edge and Chrome), serializer, driver, recorder, side-state audits (hovers, clicks, drags, lists), receiver, build of raw captures. |
| `packages/player` | The replica: server, morph engine, streams, presenter keys, focus points, app-window launcher. |
| `packages/checks` | The fidelity checklist. |
| `packages/editor`, `packages/fixer` | Placeholders for later phases. |
| `packages/selftest` | End-to-end tests against `examples/fixture-app` (a local fake product). |
| `schema/bundle.v2.schema.json` | The manifest schema, generated from the Rust types (`scenecast schema`). |
| `docs/` | [CLI](docs/cli.md), [bundle format](docs/bundle-format.md), [architecture](docs/architecture.md), [engine flow format](docs/engine/flow-format.md), [checklist](docs/engine/checklist.md), [lessons](docs/engine/lessons.md). |

## Setup (macOS or Windows)

Rust (stable), Node 20 or later, and Google Chrome or Microsoft Edge.

```bash
git clone https://github.com/jldeen/scenecast && cd scenecast
npm install                      # playwright-core, for capture and the checks (the replica itself needs nothing)
cargo build --release -p scenecast-cli   # target/release/scenecast (scenecast.exe on Windows)
```

`scenecast` finds the JS packages next to it (or set `SCENECAST_JS` to the `packages` folder) and runs them with
`node` (or `SCENECAST_NODE`).

## Make a replica

```bash
scenecast new ignite-demo2 --title "Ignite Demo 2" --app teams=https://teams.cloud.microsoft/ --app copilot=https://copilot.cloud.microsoft/
cd ignite-demo2
scenecast extension              # once: load ~/.scenecast/extension unpacked in Edge or Chrome (docs/recorder.md)
scenecast preflight              # receiver, browser, recorder, each app's tab; fixes only what fails
scenecast record start           # run the demo once; side states are captured on the way
scenecast record stop
scenecast build --from-raw       # data/ (scrubbed) and manifest.json (live-page scenes)
scenecast serve --open           # an app window: Chrome on the Mac, Edge on Windows
scenecast check                  # the whole checklist; quick for only what changed
scenecast release --push
```

Presenter keys: ⌥ on the Mac; **Ctrl+Alt** on Windows (where browsers keep Alt for their menus). Modifier+0
resets, modifier+1–9 selects a beat, modifier+an app's key switches apps, modifier+P types the scripted text,
modifier+N advances, and modifier+F / modifier+Shift+F moves through focus points.

Full command reference: [docs/cli.md](docs/cli.md).

## Development

```bash
cargo fmt --all
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
npm test                         # builds the binary, then the JS unit, capture and end-to-end tests (headless)
```

CI (`.github/workflows/ci.yml`) runs all of it on Ubuntu, macOS and Windows.
