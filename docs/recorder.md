# The recorder

The presenter runs the demo once in their own Edge or Chrome. The recorder captures the **real page** at every
state (DOM, CSSOM, fonts, frames, shadow DOM), a **real screenshot** of each state as the fidelity reference (never
as the scene), every side state a presenter can reach (hovers, menus, panes, step groups, "+N" chips, resize
handles, zoom 50–200%, long virtualized lists), and each AI answer as it streams in.

## Install (once, macOS and Windows)

```bash
scenecast extension            # writes ~/.scenecast/extension (Windows: %USERPROFILE%\.scenecast\extension)
```

Then in the browser the demo runs in:

1. Open `edge://extensions` (Edge) or `chrome://extensions` (Chrome).
2. Turn on **Developer mode**.
3. **Load unpacked** → pick that folder.

The extension's popup shows whether it's connected to scenecast and the receiver's port (47621 unless the demo's
`demo.json` says `receiverPort`; change it in the popup to match). While it records, the browser shows a "started
debugging this browser" bar: leave it (Cancel stops the recording).

After a scenecast update, run `scenecast extension` again and press the reload button on the extension's card
(`scenecast preflight` rebuilds the folder when its version is behind).

## Before recording: `scenecast preflight`

A fast check, item by item, that fixes only what fails:

| Item | Checks | If it fails |
|---|---|---|
| receiver | Up on the demo's port | Starts it in the background |
| browser | Edge or Chrome running with the demo's user data folder and profile (`chrome.browser`, `chrome.profile`, `chrome.userDataDir` in `demo.json`); with the agent recorder, the debugging port too | Not running: starts it with that profile. Running without the profile open: opens a window of it. **A running browser is never relaunched.** Running without a needed debugging port: says so and leaves it. |
| recorder | The extension (or agent) is polling the receiver. If it is, the browser check is skipped. | Rebuilds the extension folder if it's out of date and says how to load it |
| app *id* | Its tab is open, reads light, and is on its start screen (`start` in the app's settings) | Opens a missing tab; reloads one that's off its start screen; a dark one needs its theme set by hand |

When everything is set it takes a few seconds (the selftest: 0.7 s). `--check` only checks; `--json` prints the
result; `--ndjson` prints each item as it lands (what the desktop app shows). It matches replica-kit's
`replica preflight`.

## Recording

```bash
scenecast record start         # then run the demo; wait until record status says busy: false before each step
scenecast record status
scenecast record stop
```

`record status` and `record stop` report `timing`: the **recorder's own time** (side states swept, screens
captured, making sure each action was done) apart from the **product's** (from each action to its last change: an
answer streaming in). Every side path also says how much of its time was fixed waiting.

### What it captures that a page script can't

- **Closed shadow roots**, through the DevTools protocol: written as declarative shadow DOM (open, marked
  `data-sc-closed`) so the replica can reach into them.
- **Cross-site iframes** in their own process (OOPIFs): attached as their own sessions, captured like any frame.
- **Cross-origin resources** (stylesheets, fonts, images): fetched by the extension itself, so CORS doesn't stop them.
- **Every font file the page loaded**, including ones loaded by script through the FontFace API (no @font-face rule
  in any stylesheet): listed with the capture (`meta.fontFiles`) and fetched, so `scenecast fidelity` can match the
  replica's fonts to the real files.

### Speed: waiting for a quiet screen

The recorder never sits out a fixed delay to let a page settle. It waits for the screen to be **quiet**: no DOM
change, no request in flight (the extension sees the browser's requests; event streams and sockets don't count),
and no finite animation running. Side paths with nothing new to do on a screen (every control already hovered or
clicked on another screen, no row of chips) return before any waiting, and each app's neutral pointer spot and
background churn are learned once.

On the fixture (two apps, 12 screens), the side-state sweep went from 196 s to about 95 s. Most of what's left is
each control's hover delay, which has to be waited out to see whether it shows anything.

Side states are swept in the presenter's tab, not in parallel hidden tabs: a background tab in a real (headed)
browser doesn't paint and its timers are throttled to about a second, so hovers, layouts that follow the window
size, and animations would come out wrong there.

### Checkpoint and resume

The recording is checkpointed to the receiver after every step (`raw/recording-partial.json`). MV3 lets the browser
stop the extension's service worker at any time; when it starts again, the extension picks the recording up from the
checkpoint by itself (the selftest stops it mid-recording to prove this). `scenecast record start --resume` does the
same by hand, and lists any app tab that isn't on the screen it was on.

## How it's built

`packages/recorder/build.mjs` builds one body of code two ways:

- **`extension/`** (`scenecast extension`): an MV3 service worker. `extension/cdp-page.js` is a Playwright-shaped
  shim over `chrome.debugger` (pages, frames, `evaluate`, `frameElement`, mouse, keyboard, `screenshot`, CDP
  sessions), so the driver, recorder and side-state audits run unchanged. `extension/shadow.js` hands closed shadow
  roots to the serializer. `extension/main.js` holds the receiver port, the command loop and the resume.
- **`agent.js`** (`scenecast agent`): the same, for a browser driven by Playwright (`browser_run_code_unsafe`).

The extension needs Chrome or Edge 125 or later (flattened sessions for cross-site frames). It can't run scripts it's
sent (`scenecast run`); every built-in command and side path works.

## Tests

- `packages/selftest/selftest.mjs`: the fixture recorded **through the extension**, end to end (preflight, record
  with every side state, a service-worker stop and resume, build, the full checklist twice). `--agent` runs it on
  the Playwright agent instead; `--record-only` stops after recording (for timing).
- `packages/selftest/hover-repeat.mjs`: the hover check and the checklist over and over on a kept selftest demo
  (`.github/workflows/repeat.yml`). A missed hover prints the player's hover trace (`d1.hoverTrace()`); the hover
  check reads the player once it has settled, never at a fixed time, and the selftest proves it with every page timer
  300 ms late (`SCENECAST_LATE_TIMERS`).
- `packages/selftest/capture-fixture.mjs`: the capture of a tricky page, including a closed shadow root and a
  cross-site frame.
- `packages/selftest/fidelity-loop.mjs`: the fixture's lab app (`examples/fixture-app/lab.mjs`, seeded with a
  script-loaded font, a one-time image link, a menu with adopted styles, a script-pinned composer and a virtualized
  list without row indexes) recorded, built, and fixed by `scenecast fidelity` to within 0.5% everywhere.
- `packages/selftest/extension-browsers.mjs`: the extension loaded in branded Chrome and Edge (wherever they're
  installed), connected, capturing a page with its font and a screenshot.
