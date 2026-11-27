# Working on Scenecast

Building it, testing it, and releasing it. The repository layout is in [architecture.md](architecture.md#layout).

## Set up

Rust (stable), Node 22 or later, and Google Chrome or Microsoft Edge, on macOS, Windows or Linux.

```bash
git clone https://github.com/jldeen/scenecast && cd scenecast
npm ci                           # the root workspace: the engine's JS and its tests
npm ci --prefix apps/desktop     # the desktop app's tools (Tauri CLI, WebdriverIO)
cargo build -p stuntdouble-cli   # target/debug/scenecast and target/debug/stuntdouble: one CLI, two names
```

The desktop app's shell (`apps/desktop/src-tauri`) is its own Cargo workspace: run its `cargo` commands from there.
`npm run dev` in `apps/desktop` runs the app from source.

## Test

| What | Command | Notes |
|---|---|---|
| Rust | `cargo fmt --all`, `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings` | Also in `apps/desktop/src-tauri`, where CI lints with `--features webdriver` too. |
| JS unit tests | `npm run test:unit` | Seconds, no browser. `npm test` runs the same list first. |
| Everything else | `npm test` | Builds the binary, then the extension in branded Chrome and Edge, capture, the end-to-end selftest on `examples/fixture-app`, the fidelity loop, the capture browser and its unattended run, and the AI modes (on a stand-in model). Headless. Every harness calls `selftestGuard` (`packages/selftest/guard.mjs`) first, so nothing it starts reaches a presenter's Scenecast. |
| The app's window, without the app | `node apps/desktop/tests/preview/shots.mjs <folder> [--only record,present] [--browser chromium]` | The real `apps/desktop/ui` with a stand-in for the Rust side (`tests/preview/mock.js`), in headless WebKit (the Mac's engine) or Chromium (Windows' WebView2). Saves each screen on both systems and reports any screen with more than one primary button or engine words on its default view. |
| The app itself | `npm run build:test && npm run test:ui` in `apps/desktop` | The real app window, driven through its embedded WebDriver server, from New demo to Share. It opens a window on your screen: let CI run it. `SCENECAST_UI_SHOTS=<folder>` saves each screen. |
| The installers | `apps/desktop/tests/packaged.test.mjs`, `update.test.mjs` | Install and start the app as a presenter would, and update version N to N+1 (CI). |

Useful while testing:

| Variable | What it does |
|---|---|
| `SCENECAST_LIBRARY` | Where the app keeps its demos (default `Documents/Scenecast`). |
| `SCENECAST_EXTENSION_DIR` | Where the recorder extension goes. |
| `REPLICA_NO_OPEN=1` | Serve replicas without opening a browser window; the address is shown instead. |
| `REPLICA_RX_PORT` | The receiver's port. |
| `SCENECAST_AI_MODEL=stub` | The AI modes on a deterministic stand-in: no network, no GitHub account. |
| `SCENECAST_UPDATE_URL` | A different update feed (the UI and update tests serve their own). |
| `STUNTDOUBLE_JS`, `STUNTDOUBLE_NODE` (or `SCENECAST_JS`, `SCENECAST_NODE`) | The folder that holds the engine's packages (`core/`, `player/`, …) and the Node that runs them. |

## CI

`.github/workflows/ci.yml` runs on pull requests, pushes to `main`, version tags, and by hand. **A push to any other
branch doesn't run it:** start it with `gh workflow run ci.yml --ref <branch>` and follow it with `gh run watch`.

Jobs: Rust and the engine on Ubuntu, macOS and Windows; the desktop UI test, the installers, the installed app and the
in-app update on macOS and Windows; and, on a version tag, the release. Each green run keeps the installers and the
UI test's screens as artifacts.

`.github/workflows/repeat.yml` runs `npm test` several times side by side on one system, then the hover check and the
checklist again on each run's demo (`gh workflow run repeat.yml -f os=windows-latest`): a check that passes once and
not the next time is a bug.

## Release

1. **The version, everywhere:** `version` in `package.json`, `packages/*/package.json`, `apps/desktop/package.json`,
   `Cargo.toml` (the workspace), `apps/desktop/src-tauri/Cargo.toml` and `apps/desktop/src-tauri/tauri.conf.json`; then
   refresh the lockfiles (`package-lock.json`, `apps/desktop/package-lock.json`, `Cargo.lock`,
   `apps/desktop/src-tauri/Cargo.lock`).
   A release candidate (`0.5.6-rc.1`) also needs `bundle.windows.wix.version` in `tauri.conf.json`, all numbers
   (`0.5.6.1`): Windows' MSI installer can't take `rc.1`. The release itself drops it again.
2. **The notes:** `docs/releases/vX.Y.Z.md`, for presenters: one line on what's new, how to update ("click **Update to
   vX.Y.Z** at the bottom left"), then what's fixed and what's new in plain words.
3. **The guide**, if it changed: `node scripts/guide-pdf.mjs` makes `docs/guide.pdf` from `docs/guide.md`.
4. **Tag it:** `git tag vX.Y.Z && git push origin vX.Y.Z`. CI runs everything; when it's green, the release job checks the
   tag matches the app's version and publishes a GitHub Release with the macOS and Windows installers, the same
   installers under names that don't change (`Scenecast-mac.dmg`, `Scenecast-windows-setup.exe`, for
   `releases/latest/download/…` links), and the guide PDF.
5. **The update feed:** when the installers were built with the updater's key, the release also gets `latest.json`
   and the signed update files, and installed apps offer the new version. Without the key, apps don't see it.

Keys and certificates (none of them are in the repository):

- The updater's key: its public half is `plugins.updater.pubkey` in `apps/desktop/src-tauri/tauri.conf.json`; the
  private half and its password are the repository secrets `TAURI_SIGNING_PRIVATE_KEY` and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- Signing the installers (Apple Developer ID and notarization, Windows Authenticode): [app/signing.md](app/signing.md).
- The recorder in the Chrome Web Store and Edge Add-ons: [store/listing.md](store/listing.md).

## Commits

A subject that says what changed, a body in plain words, and the trailer
`Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>` when Copilot helped. The repository is
public: scan before you push (`node packages/checks/secrets.mjs <folder>`), and never commit a secret, a real tenant's
screenshot or a recording.
