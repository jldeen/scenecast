# The Scenecast app

The way presenters use Scenecast: one window for the whole demo, from making it to presenting it, on macOS and
Windows, with Edge or Chrome. No terminal. (The `scenecast` CLI does the same underneath, for automation and CI.)

![The demo library](library.png)

## Install

From the latest green CI run on `main` (Actions → CI → the run → Artifacts):

- **macOS** (Apple silicon and Intel): `scenecast-macOS-installers` → `Scenecast_<version>_universal.dmg`. Open it and
  drag Scenecast to Applications.
- **Windows**: `scenecast-Windows-installers` → `Scenecast_<version>_x64_en-US.msi`, or the setup `.exe` (installs for
  you only, no admin).

The app carries what it needs (its engine and Node). You need Microsoft Edge or Google Chrome. Until the installers
are signed ([signing.md](signing.md)), macOS asks once (Control-click → Open) and Windows SmartScreen says "unknown
publisher" (More info → Run anyway).

Your demos are kept in `Documents/Scenecast`.

## A demo, step by step

| Step | What you do |
|---|---|
| **New demo** | Name it, list its apps (each one's start page: a tab while you record), pick Edge or Chrome. |
| **Record** | Set up the recorder once (it builds the extension and shows you the three clicks to load it in your browser). **Check** says whether everything's ready: the receiver, your browser and profile, the recorder, each app's tab (open, light theme, on its start screen); **Check and fix** puts right what it can, and never restarts a browser you already have open. Then **Start recording** and run the demo once: the app shows each screen as it's captured, the side states being swept, and the recorder's time apart from the product's. **Stop recording**. |
| **Build & check** | Turns the recording into the replica, scrubbing secrets and personal data on the way (the scrub report lists what was removed; a password, key or token stops the build). Then the checks: what changed, or every check. |
| **Fidelity** | Every captured state of the real product next to the replica, compared pixel by pixel, with the fonts. **Fix differences** diagnoses each one, patches this demo, builds and compares again. |
| **Script** | Paste your script or open it (text, Markdown or RunLines `.sk`). **Find the focus points** puts each line on its screen and makes its focus points; the line-to-screen sheet and the cue sheet show here. |
| **Edit** | Opens the replica in edit mode in Edge or Chrome: add dots, change wording and dates, set beat starts. Each saved change is listed in the app as it happens. |
| **Present** | The presenter keys on one page first. **Start presenting** opens the replica full screen in Edge or Chrome, and the app steps out of the way (the key page is never on screen while you present). **Stop presenting** when you're done. |
| **Export** | The replica as a plain folder or a zip, for another presenter: they open `index.html`, no install. |

From the library: open, duplicate (with its recording) or delete (to the Trash or Recycle Bin) any demo, with where
each one stands: recorded, built, fidelity score, focus points, last checked.

## Screens

| | |
|---|---|
| ![New demo](new-demo.png) New demo | ![Ready to record](record.png) Record: ready to record |
| ![Recording](recording.png) Recording, live | ![Build and check](build.png) Build, scrub report, checks |
| ![Fidelity](fidelity.png) Fidelity: real vs replica | ![Script](script.png) Script to focus points |
| ![Edit](edit.png) Edit: saved changes | ![Present](present.png) Present: the key reference |
| ![Export](export.png) Export | ![Library](library.png) The library |

## Why the replica opens in Edge or Chrome

The app's own window is a system webview: WebView2 (Edge's engine) on Windows, but WebKit (Safari's) on the Mac. The
replica is captured in, and its fidelity measured in, Chromium; so editing and presenting happen in an Edge or Chrome
app window (no tabs or address bar, full screen for presenting), the same on both systems.

## For developers

```bash
npm ci && npx playwright-core install chromium      # the repository root: the engine, and the test's browser
cd apps/desktop && npm ci
npx tauri dev                                        # the app, from source (Linux needs the WebKitGTK packages)
npm run build:test && npm run test:ui                # the UI test: the whole flow on the fixture app
```

- `crates/scenecast-app`: the commands the window calls (library, record, build and checks, fidelity, script,
  servers for edit and present, key reference, export, a loopback file server for reports, the update stub), each
  with a typed result and serializable progress. Unit-tested in the main workspace on Ubuntu, macOS and Windows.
- `apps/desktop/src-tauri`: the Tauri shell (its own Cargo workspace): commands, `job` events, one job per demo at a
  time. Built with `--features webdriver`, it has an embedded WebDriver server for the UI test; installers never do.
- `apps/desktop/ui`: the window, plain HTML, CSS and JavaScript (no build step). Light, Fluent and macOS conventions,
  keyboard reachable (arrow keys between steps), labelled for screen readers, progress announced.
- `apps/desktop/tests/ui.test.mjs`: WebdriverIO against the real app window (the embedded WebDriver server works on
  macOS, Windows and Linux). CI runs it on macOS and Windows; `SCENECAST_UI_SHOTS=<dir>` saves each screen.
- Installers: `scripts/prepare-bundle.mjs` (Node, checked by SHA-256; signing when its secrets are set), then
  `tauri build`. See [signing.md](signing.md).
- App updates: `scenecast_app::updates::check` is a stub ("Check for updates" in the window calls it). An update
  service would plug in there (the Tauri updater plugin with a signed feed).

The screenshots here come from the UI test (`SCENECAST_UI_SHOTS`).
