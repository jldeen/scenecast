# AGENTS.md

For AI agents working on this repository. People should start with the [README](README.md).

Scenecast records a live web demo once in the presenter's own browser and turns it into a replica that plays the same
way every time, offline. Presenters use the desktop app (Tauri, macOS and Windows); the `scenecast` CLI does the same
underneath. Rust owns the bundle format, the build and the app's commands; JavaScript owns everything that runs in a
browser (the recorder extension, the player, the checks).

## Where things are

| Path | What |
|---|---|
| `apps/desktop/ui/` | The app's window: plain HTML, CSS and JS, no build step. `app.js` (every screen), `errors.js` (error catalog), `app.css`. |
| `apps/desktop/src-tauri/` | The app's shell and commands. Its own Cargo workspace. |
| `apps/desktop/tests/` | The real-window UI test, the installer and update tests, `preview/` (the window without the app). |
| `crates/scenecast-app` | What the app's commands call: the library, each step, run of show, share. |
| `crates/stuntdouble-build`, `stuntdouble-format`, `stuntdouble-cli` | The engine (StuntDouble): the build, the bundle model and schema, the CLI (built as `stuntdouble` and `scenecast`). |
| `packages/core` (`@stuntdouble/core`) | Engine entry (`bin/engine.mjs`), demo settings, flow compiler, text rules and edits, notes, workflow, `at()`. |
| `packages/capture` | The recorder extension, capture, preflight's browser half, the receiver, raw → `data/`. |
| `packages/player` | The replica: server, player, presenter keys, focus points, the presenter guide. |
| `packages/apps` | App packs: each app's recording, build, layout, theme and platform rules and its writes, once per app (`packages/apps/README.md`). Private parts live in `~/.stuntdouble/packs`, never here. |
| `packages/checks`, `format`, `build`, `cli` | The checklist and fixer, the schema, the prebuilt binary, the `stunt` command. |
| `packages/script`, `editor`, `ai`, `selftest` | Scenecast's own: script to focus points, the in-replica editor, Copilot modes, end-to-end tests. |
| `docs/` | The docs ([index](docs/README.md)). |

More: [docs/architecture.md](docs/architecture.md). The engine is StuntDouble ([docs/stuntdouble.md](docs/stuntdouble.md)):
replica-kit's demos (inv641, the Lightning talks) run on the same packages, so a fix lands once.

## Build and test

```bash
npm ci && npm ci --prefix apps/desktop
cargo fmt --all && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings
(cd apps/desktop/src-tauri && cargo clippy --all-targets -- -D warnings && cargo clippy --features webdriver -- -D warnings)
npm run test:unit                                   # seconds; npm test runs the same list first
npm test                                            # the engine end to end, headless browsers
node apps/desktop/tests/preview/shots.mjs <folder>  # every screen of the window, Mac and Windows, no app
```

The real-window UI test (`npm run build:test && npm run test:ui` in `apps/desktop`) opens a window on the screen:
leave it to CI unless you're on a machine nobody is using. Details, variables and the test list:
[docs/development.md](docs/development.md).

## Conventions

- **Copy** on screen and in docs: short, plain, human. Controls name their action. Errors say what happened and offer
  one fix (add new ones to `apps/desktop/ui/errors.js`; its test fails on an unmapped one). Never show green without
  proof. Use "Jessica", never "Jess", and never the word "playbook".
- **The window's look:** [docs/app/design.md](docs/app/design.md). One primary button per screen, yellow only for "you
  are here", no ports, paths or engine words on a default view (they go under **Details**).
- **macOS and Windows are equal.** ⌥ or Ctrl+Alt, Finder or File Explorer, Trash or Recycle Bin. Test both.
- **Live pages by default.** Screenshot or video scenes are a fallback only, and the checks flag them.
- **The UI test finds things by `data-test`.** Keep those attributes when you change a screen, and update
  `apps/desktop/tests/ui.test.mjs` with the structure.
- **Between packages:** a package import (`@stuntdouble/core/lib/demo.mjs`) or, for a file to spawn or serve,
  `at('player', 'serve.mjs')` (`@stuntdouble/core/lib/at.mjs`). Never `../other-package/`: it breaks in an install.
- **Tests:** a few focused ones for what you change. Unit tests go in `package.json`'s `test:unit` list.
- **Commits:** a subject that says what changed, a plain body, and
  `Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>`. Never force-push.

## Releasing

The steps are in [docs/development.md](docs/development.md#release): the version in every manifest, release notes in
`docs/releases/vX.Y.Z.md` written for presenters, the guide PDF if the guide changed, then a `vX.Y.Z` tag. CI publishes
the installers and, with the updater key, the update feed installed apps read.

## Gotchas

- **CI on a branch:** pushes only run CI on `main` and tags. Run `gh workflow run ci.yml --ref <branch>`, then
  `gh run watch`. Job logs only download once the whole run has finished; the UI test's screens are artifacts.
- **Package installs on a managed laptop:** the public npm and Python registries may be blocked, and on Jessica's Mac
  any attempt to reach them raises a security alert, so never probe them. Use the `gh detour` extension: `gh detour
  state`, then `gh detour run -- npm ci` if it says `repo` or `partial`, and `gh detour check` (and `gh detour fix`)
  before committing a lockfile. Committed lockfiles resolve from `https://registry.npmjs.org/`.
- **The updater's keys aren't in the repository.** Its public half is `plugins.updater.pubkey` in
  `apps/desktop/src-tauri/tauri.conf.json`; the private half and its password are the repository secrets
  `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Never print or commit them. Without them a release
  has no `latest.json` and installed apps don't see it. Installer signing: [docs/app/signing.md](docs/app/signing.md).
- **The repository is public.** Scan before you push (`node packages/checks/secrets.mjs <folder>`). No secrets, tenant
  screenshots or recordings in commits.
- **One recorder per receiver.** Don't start a test browser with the recorder extension while someone is recording:
  two recorders on one receiver is what made "Ready to record" followed by "not open" happen.
- **Someone else's browser and screen are theirs.** Don't drive a person's Chrome or Edge, their installed app or their
  screen unless they've said so, and ask them to step away from the keyboard first. Don't launch Chrome for Testing in
  their place.

## When it counts as done

CI and the fixture app are necessary, not enough. A change to recording, the app or presenting is done when it works
on a presenter's real setup:

- the installed app, updated through its own **Update** button;
- the presenter's own Chrome or Edge, on a profile that isn't Default, with lots of tabs open, and the computer in
  dark mode;
- first run, New demo, Record, Review, Present and Share, end to end;
- on both a Mac and a Windows PC;
- with screenshots and logs kept as evidence.
