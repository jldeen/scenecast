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

**The desktop app is how presenters use it: no terminal.** Make a demo, record it in Edge or Chrome, build and check
it, compare it with the real product, match the script to focus points, edit, present full screen with the
**presenter guide** on the laptop screen, and export it for someone else, all in one window (macOS `.dmg`, Windows
`.msi` or setup `.exe`). **Start here: [the one-page guide](docs/guide.md)** ([PDF](docs/guide.pdf)); the app in
detail: [docs/app](docs/app/README.md). The CLI stays underneath for automation and CI; both drive the same Rust core.

**Small fixes are fast.** After each change, only the checks for what it touched run (`scenecast quick`: a minute or
two; the app runs it on its own after a build, a script or an edit). The whole checklist runs once, before a release
(`scenecast release`, the app's Export).

**The presenter guide** (⌥G, Ctrl+Alt+G on Windows; [docs/presenter.md](docs/presenter.md)) is a second window for the
laptop screen that follows the stage: the talk track word for word, the clicks, the watch-outs, a timer against the
script's times, and pictures of what's on screen now and next. It's made from the same script as the focus points.

## Layout

| Path | What |
|---|---|
| `crates/scenecast-core` | Bundle model (schema v2) and validation; v1 bundles migrate on read. JSON Schema export. |
| `crates/scenecast-build` | Library: new projects, running the JS engine with progress, `manifest.json` from a build. |
| `crates/scenecast-cli` | The `scenecast` binary. |
| `crates/scenecast-app` | What the desktop app calls: the demo library and each step, with serializable progress (no UI toolkit). |
| `apps/desktop` | The desktop app (Tauri): its window (`ui/`), shell (`src-tauri/`), UI test and installers. |
| `packages/kit` | The engine's CLI entry (run by `scenecast`), demo settings, flow compiler, workflow, project template. |
| `packages/recorder` | Capture: the recorder extension (MV3, Edge and Chrome), serializer, driver, recorder, side-state audits (hovers, clicks, drags, lists), receiver, build of raw captures. |
| `packages/player` | The replica: server, morph engine, streams, presenter keys, focus points, the presenter guide (`presenter/`, `app/presenter-module.js`), app-window launcher. |
| `packages/checks` | The fidelity checklist, the presenter guide's pictures and its check (`guide-shots.mjs`, `notes-check.mjs`). |
| `packages/script` | Script to focus points: the script parsed, every screen indexed, the pluggable matcher (deterministic by default), the line-to-screen sheet and the cue sheet. |
| `packages/editor` | The editor inside the replica: focus-point dots, wording and date changes, beat starts, undo. |
| `packages/fixer` | The fidelity fixer: pluggable diagnosers and the per-demo patches. |
| `packages/selftest` | End-to-end tests against `examples/fixture-app` (a local fake product). |
| `skill/SKILL.md` | The "replicate a demo" skill for Copilot, driving the CLI (`scenecast install-skill`). |
| `schema/bundle.v2.schema.json` | The manifest schema, generated from the Rust types (`scenecast schema`). |
| `docs/` | [One-page guide](docs/guide.md), [presenter guide](docs/presenter.md), [CLI](docs/cli.md), [bundle format](docs/bundle-format.md), [architecture](docs/architecture.md), [engine flow format](docs/engine/flow-format.md), [checklist](docs/engine/checklist.md), [lessons](docs/engine/lessons.md). |

## Setup (macOS or Windows)

Presenters: install the app from the [latest release](https://github.com/jldeen/scenecast/releases/latest) (the
[one-page guide](docs/guide.md) has the one-time "open anyway" step for each system). Everything below is for the CLI
and for working on Scenecast.

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
scenecast script script.md       # each line on its screen, its focus points, the line-to-screen and cue sheets
scenecast notes && scenecast guide-shots   # the presenter guide from the same script (⌥G on the stage)
scenecast edit                   # adjust in the replica: dots, wording and dates, beat starts (⌥⇧E toggles it)
scenecast quick                  # after each change: only what it touched
scenecast release --push         # once: the whole checklist, then commit and push
```

Presenter keys: ⌥ on the Mac; **Ctrl+Alt** on Windows (where browsers keep Alt for their menus). Modifier+0
resets, modifier+1–9 selects a beat, modifier+an app's key switches apps, modifier+P types the scripted text,
modifier+N advances, modifier+F / modifier+Shift+F moves through focus points, and modifier+G opens the presenter
guide. Modifier+Shift+E turns the editor on
and off (only where the replica is served for authoring; never with `present` or in an export).

Full command reference: [docs/cli.md](docs/cli.md). For Copilot: `scenecast install-skill` installs the "replicate a
demo" skill ([skill/SKILL.md](skill/SKILL.md)), which drives this CLI.

## Development

```bash
cargo fmt --all
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
npm test                         # builds the binary, then the JS unit, capture and end-to-end tests (headless)
```

CI (`.github/workflows/ci.yml`) runs all of it on Ubuntu, macOS and Windows.
A version tag (`git tag v0.3.0 && git push origin v0.3.0`) runs CI and, when it's green, publishes a GitHub Release
with the macOS and Windows installers attached (the `release` job). `node scripts/guide-pdf.mjs` makes
`docs/guide.pdf` from `docs/guide.md`.
`.github/workflows/repeat.yml` runs `npm test` five times side by side on one OS, then the hover check and the
checklist again on each run's demo (`gh workflow run repeat.yml -f os=windows-latest`): a check that passes one run
and not the next is a bug.
