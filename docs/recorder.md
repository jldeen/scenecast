# The recorder

The presenter runs the demo once in their own Edge or Chrome. The recorder captures the **real page** at every
state (DOM, CSSOM, fonts, frames, shadow DOM), a **real screenshot** of each state as the fidelity reference (never
as the scene), every side state a presenter can reach (hovers, menus, panes, step groups, "+N" chips, resize
handles, zoom 50–200%, long virtualized lists), and each AI answer as it streams in.

## Install (once, macOS and Windows)

```bash
scenecast extension            # writes Documents/Scenecast/Recorder Extension (SCENECAST_EXTENSION_DIR to change)
```

Then in the browser the demo runs in:

1. Open `edge://extensions` (Edge) or `chrome://extensions` (Chrome).
2. Turn on **Developer mode**.
3. **Load unpacked** → pick that folder.

In the desktop app, **Install recorder** does the first step and opens the page for you. The extension finds the
receiver by itself: the demo's port (47621 unless `demo.json` says `receiverPort`) and the next nine, the desktop
app's own first; its popup says whether it's connected. While it records, the browser shows a "started
debugging this browser" bar: leave it (Cancel stops the recording).

After a scenecast update, the folder is rebuilt (the app does it when it starts; `scenecast preflight` when its
version is behind) and the extension reloads itself when it's connected (`preflight` with fixes asks it to); if it
can't, press **Reload** on its card. 0.3.0 and earlier used a hidden `~/.scenecast/extension` folder: remove that
copy from the browser (the app replaces its files with a stub that says so).

## Before recording: `scenecast preflight`

A fast check, item by item, that fixes only what fails:

| Item | Checks | If it fails |
|---|---|---|
| receiver | Up on the demo's port | Starts it in the background |
| browser | Edge or Chrome running with the demo's user data folder and profile (`chrome.browser`, `chrome.profile`, `chrome.userDataDir` in `demo.json`); with the agent recorder, the debugging port too | Not running: starts it with that profile. Running without the profile open: opens a window of it. **A running browser is never relaunched.** Running without a needed debugging port: says so and leaves it. |
| recorder | The extension (or agent) is polling the receiver. If it is, the browser check is skipped. | Rebuilds the extension folder if it's out of date and says how to load it |

With `"recorder": "capture"` (the capture browser, below), the **browser** item is the capture browser instead: not
running, Fix starts it; an app on a sign-in page fails with **Sign in again** (`scenecast capture sign-in`), the one
fix that needs the presenter.
| app *id* | Its tab is open and on its start screen (`start` in the app's settings). Its theme is said; with `preflight.theme` in `demo.json` (`"light"` or `"dark"`), a tab in the other theme fails | Opens a missing tab; reloads one that's off its start screen, or runs `preflight.prep` (the demo's own script) instead; a tab in the wrong theme needs its app set to that theme by hand (not System) |
| reset | With `preflight.reset` in `demo.json`: the demo's own check that everything is as the show starts | Runs `preflight.resetFix` (the demo's reset), then the check again |
| dock | macOS: where the Dock is and whether it hides. Never a failure | An app that bounces for attention peeks out of a hidden Dock into a full-screen recording: bring it to the front once |

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

### Pause and go on

`scenecast record pause` holds the recording: nothing the presenter does is recorded. Closing the browser's
"debugging" bar does the same by itself (the recorder sees `canceled_by_user` and pauses; status says `held: {why:
"bar"}`). `scenecast record go-on` drops whatever was done while paused, attaches again and picks up where it
stopped, with every screen so far kept, once each app's tab is back on the screen it was on; one that isn't comes back
as `off` (`--anyway` goes on from where it is). The app's capture window shows both as **Paused**, with **Go on** or
**Pick up where I left off**.

## Driven by the AI

Record for me (docs/ai.md) runs the demo through the same command loop: `observe` reads the page as the AI sees it
(its controls by role and name, where they are, its headings and words: `outline-page.js`), then `click`, `type` and
`press` do the step, so the recorder captures it exactly as it captures a person's clicks. `record status` lists the
last few steps (`recent`), which the coach follows. The receiver also serves the coach window (`/coach`).

## The capture browser (opt-in)

`"recorder": "capture"` in `demo.json` records in **the capture browser** instead of the presenter's own: the
installed Chrome (or Edge) with a profile of its own, every window off her screen, and the recorder running in it
over the DevTools protocol. No extension, no debugging bar, and her browser and tabs are never touched. The default
stays the extension in her own browser.

- **One sign-in, kept.** The profile is a folder of its own, `~/.stuntdouble/capture/<name>` (`capture.profile`,
  default `default`), outside every repository. `scenecast capture sign-in` opens its one window on her screen: she
  signs in to the demo's tenant (and says Yes to staying signed in); it closes once every app lands on itself.
  Preflight says when a sign-in has run out.
- **Off the screen, drawn as on it.** Each page is a window of its own (a background tab doesn't draw), with
  backgrounding off. macOS: minimized windows. Windows: a normal window placed off every display (a minimized one
  there shrinks to a title bar and slows to a few frames a second). `capture.window: "auto"` (the default) picks by
  OS, probes a window, and switches when it doesn't draw. Measured: 0.000% apart from the same page on screen.
- **At the demo's viewport, light.** A window can't be bigger than the display, so each page's viewport is emulated
  at `viewport` (size and pixel ratio), and pages draw light.
- **The same recorder.** It's the agent's code (`agentCode()` in `build.mjs`), told it's in the capture browser,
  with closed shadow roots handed over through the DevTools protocol as the extension does (`cdp-shadow.js`). On the
  fixture it records the same states, path, beats, streams and side states as the extension, and the same markup.
- **Only the demo's tenant.** With `capture.tenant` (the demo tenant's domain or id), the capture host reads which
  tenant each app is signed in to (the tenant ids in its sign-in library's storage keys) before it starts the
  recorder, and refuses to capture when any app is signed in to another tenant, or to one it can't see; while it
  runs, a page signed in to another tenant stops it at once. A demo that doesn't name its tenant is refused as soon
  as an app is signed in to any.
- **No account picker.** On a managed Mac, Chrome's own single sign-on (the Mac's work accounts, through its
  sign-on extension) is what signs the apps in, and it offers every account the Mac has, so Entra asks which one to
  use. With `capture.account`, the demo's account is pinned: `login_hint` and `domain_hint` added at Entra's
  sign-in, its "pick an account" dropped, and an app whose own landing asks which account (M365 Copilot's "Sign in
  to start") opened again with the account as its `login_hint`. Measured on a managed Mac: Teams, M365 Copilot, the
  admin center and Microsoft IQ all signed in to the demo tenant with no picker and no click, and again after a
  restart. `capture.macSso: false` turns the Mac's sign-on off in the profile alone; then the profile's own sign-in
  has to carry every app (measured: on a managed Mac it carried only Teams).
- **A guard for read-only steps** (`guard()` in `browser.mjs`, not on by default): every request that isn't a read
  (GET, HEAD, OPTIONS) to a guarded host is held before it leaves, every page and frame included; `pass()` lets a
  planned write through. WebSocket messages don't go through it.

The tenant and the account live in the demo's own `demo.json`, never in this repository.

`scenecast capture start|stop|status|sign-in|run` (preflight runs `start`). The host's state is `.out/capture.json`
and its log `.out/capture.log`. `demo.json`:

```json
"recorder": "capture",
"capture": { "profile": "demo-tenant", "tenant": "<the demo tenant's domain>", "account": "<the demo account>",
             "channel": "chrome", "window": "auto", "flags": [], "macSso": true }
```

`packages/capture/browser.mjs` is the launcher (`openCaptureBrowser`, `signInWindow`), and its `launchRealChrome` is
the checker's real Chrome in the same shape. `packages/capture/host.mjs` keeps it up for a demo.

## How it's built

`packages/capture/build.mjs` builds one body of code two ways:

- **`extension/`** (`scenecast extension`): an MV3 service worker. `extension/cdp-page.js` is a Playwright-shaped
  shim over `chrome.debugger` (pages, frames, `evaluate`, `frameElement`, mouse, keyboard, `screenshot`, CDP
  sessions), so the driver, recorder and side-state audits run unchanged. `extension/shadow.js` hands closed shadow
  roots to the serializer. `extension/main.js` holds the receiver port, the command loop and the resume.
- **`agent.js`** (`scenecast agent`): the same, for a browser driven by Playwright (`browser_run_code_unsafe`), and
  in the capture browser (`host.mjs`), where it runs in the host's own process.

The extension needs Chrome or Edge 125 or later (flattened sessions for cross-site frames). It can't run scripts it's
sent (`scenecast run`); every built-in command and side path works.

## Tests

- `packages/selftest/selftest.mjs`: the fixture recorded **through the extension**, end to end (preflight, record
  with every side state, a service-worker stop and resume, build, the full checklist twice). `--agent` runs it on
  the Playwright agent instead, `--capture` in the capture browser (preflight starts it); `--record-only` stops
  after recording (for timing).
- `packages/selftest/capture-browser.mjs`: the capture browser on the fixture apps: off the screen on this OS,
  drawing, at the demo's viewport, twins, sign-in landing, the guard, closed shadow roots, nothing left running.
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
