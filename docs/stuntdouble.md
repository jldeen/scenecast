# StuntDouble

StuntDouble is the replica engine under Scenecast: it takes the risky live shot, so the real product doesn't have
to. It records a live web demo once and replays it offline, the same way every time. Scenecast (the desktop app, its
Copilot modes, script to focus points and the editor) is built on top of it, and the demos that ran on replica-kit
(Ignite's Demo 1 in jldeen/inv641, the Lightning talks' replicas) run on it too. One engine, so a fix lands once.

**Not on npm yet.** The `@stuntdouble` scope waits on the name and a legal check. Until then, a demo outside this
repository gets the packages as tarballs (below).

## The packages

| Package | What |
|---|---|
| `@stuntdouble/cli` | The `stunt` command (also `stuntdouble`). It runs the binary for this OS, or the JavaScript engine straight when there isn't one (serve, check, record, notes and the rest still work). |
| `@stuntdouble/build` | `binaryPath()`: the Rust binary (format, build, CLI) for this OS, from `@stuntdouble/build-<os>-<cpu>`, `STUNTDOUBLE_BINARY`, or this checkout's `target/`. |
| `@stuntdouble/core` | The engine entry (`bin/engine.mjs`), demo settings, the flow compiler, text rules and edits, presenter notes, the workflow (`text`, `status`, `save`, `release`), the project template, and `at()`. |
| `@stuntdouble/capture` | The recorder (the MV3 extension, or `agent.js` in a Playwright browser), the serializer, side-state sweeps, the receiver, raw captures → `data/`. |
| `@stuntdouble/player` | The replica: server, morph engine, streams, presenter keys, focus points, the presenter guide (⌥G), the launcher (Chrome on the Mac, Edge on Windows). |
| `@stuntdouble/checks` | The fidelity checklist, real vs replica, and the fixer. |
| `@stuntdouble/format` | The manifest's JSON Schema, generated from the Rust types. |
| `@stuntdouble/apps` | App packs: what a known app needs, once per app. Packs outside the repository (internal hosts, tenant names) go in `STUNTDOUBLE_PACKS` or `~/.stuntdouble/packs` and merge over the built-in ones; a demo's `demo.json` always wins. |

The Rust crates are `stuntdouble-format`, `stuntdouble-build` and `stuntdouble-cli`. The CLI is built under two names,
`stuntdouble` and `scenecast`: the same commands.

Scenecast's own packages (`@scenecast/ai`, `@scenecast/script`, `@scenecast/editor`) plug into the engine when
they're installed next to it (`stunt ai`, `stunt script`, the editor in the replica); without them, those commands
say which package they need.

## A demo on StuntDouble

```bash
# once, in this repository: the tarballs into the demo, and the demo depending on them
node scripts/stuntdouble-pack.mjs --into ~/git/my-demo
cd ~/git/my-demo && npm install          # gh detour run -- npm install, on a managed laptop
npx stunt serve --open                    # or: stunt build, stunt check, stunt notes, …
```

Every `replica <command>` from replica-kit is `stunt <command>` (`replica build` is `stunt build`, and so on),
except two: the full checklist (`replica fidelity`) is `stunt check`, and the recorded path twice (`replica check`)
is `stunt check --only two-run`. `stunt fidelity` is something new: every captured state of the real product against
the replica, each difference diagnosed and fixed. A replica-kit demo builds and serves unchanged: `demo.json`, `recording.json`, `flow.overrides.mjs`, `focus.mjs`,
`build.hook`, `engine.modules`, `static` folders and `checks.known` all mean what they meant. Raw captures from a
recorder older than Scenecast 0.4.5 can still hold sign-in tokens in their markup (Power BI's): the build refuses
them, so redact them once with `stunt scrub --redact <raw folder>` before the first build.

Updating a demo to a newer StuntDouble is the same `stuntdouble-pack.mjs --into` again, then `npm install`.

The pack brings this machine's binary. For the other systems, CI's Binary jobs upload `stuntdouble-<os>-<cpu>`
(darwin-arm64, darwin-x64, win32-x64, win32-arm64). Pack each one into the demo after the first pack. npm installs
only the one for the machine it runs on:

```bash
gh run download <CI run> -n stuntdouble-win32-x64 -D /tmp/sd-win32-x64
node scripts/stuntdouble-pack.mjs --into ~/git/my-demo --binary /tmp/sd-win32-x64/stuntdouble.exe --platform win32-x64
```

## Environment

| Variable | What |
|---|---|
| `STUNTDOUBLE_BINARY` | A binary to use instead of the prebuilt one. |
| `STUNTDOUBLE_JS` | The folder that holds `core/` (the `stunt` command sets it). `SCENECAST_JS` still works. |
| `STUNTDOUBLE_NODE` | The Node that runs the engine. `SCENECAST_NODE` still works. |
| `STUNTDOUBLE_PACKS` | App pack folders outside the repository, separated as on `PATH` (default `~/.stuntdouble/packs`). |
