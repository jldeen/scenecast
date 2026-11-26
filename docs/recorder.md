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
  (GET, HEAD, OPTIONS) to a guarded host is held before it leaves, except what the app's pack allows
  (`guard.allow`); `pass()` lets a planned write through. It's set on every target, the pages there already and every
  new one, their frames and workers, and service workers (`fetch-all.mjs`: a browser-wide one only caught pages made
  after it). WebSocket messages don't go through it, so a chat box's Enter counts as a write.

The tenant and the account live in the demo's own `demo.json`, never in this repository.

### Record for me, unattended

`scenecast ai record --unattended` (`packages/ai/unattended.mjs`) runs the approved plan in the capture browser with
nobody there, while the recorder records. It's what the capture browser is for: no screen, no clicks, no waiting.

- **Approved, all of it.** The plan word for word, and the list of every write by beat and step, with reset.md's
  undo and set-first steps (`ai approve`; its hash covers the list). A write runs only when it's on that list, its
  app's pack knows it, and exactly one control on the fresh screen has its name; the guard opens the app's own hosts
  for that one step, and the write's own calls to a service of its app's (its pack write's `opens`: Copilot's send is
  `POST <runtime>/v1/messages`, not its page's host). A write that isn't approved stops the run before it, with a
  picture.
- **Services the apps need** (a pack's `services`: IQ's plugin service). First, before the reset before (so a
  failing service costs nothing: no write, nothing to put back), each app with one is opened and the page's own call
  has to answer 2xx (it waits up to 90 s for it); again once the reset is done, at its start screen. Else nothing is
  captured: "IQ's plugin service is failing (500). Try again later.", or "didn't answer (net::ERR_FAILED)" for a call
  with no answer at all (a network error, or CORS when its preflight failed). A call the page called off (a reload)
  isn't an answer. During a run, one answering 500 or failing stops the run
  before that beat's next write, runs the reset after, and lists the step in `needsYou`. Every answer is in
  run.json's `services`.
- **Read-only between writes.** The guard holds the rest, all run long; what it held goes in run.json, each with
  the tab, the frame and the app it came from (by the request's own target and document, never by when it came: a
  background tab sends during another app's step), and each passed non-read with the allow entry that let it through
  (or, for a write's, what it asked for: a server function's action, a GraphQL operation, a body's Verb; its body
  kept in `.out/ai/write-bodies.json`, local only). A pack's `guard.stayHeld` stays held even during a write's step
  (the app's own background calls to the host the write opens).
- **Writes in frames too** (Microsoft IQ's Power BI frame): exactly one control by that name in the page and its
  frames, the reader agreeing in that frame's markup, the click hit-tested through the frames, and the guard open for
  that step on the app's hosts and its pack's `guard.hosts` (a frame's host goes there; a tenant's in a private pack).
- **API undos.** reset.md's `Undo with the app pack: <pack>:<write>` runs the pack's `undo.api` (a private pack's) in
  the app's own signed-in session: its `apis.<use>.open` page opened, the Authorization it sends to that host caught
  in memory for the one call, the call made from the page or frame that sent it (`apis.<use>.from` names the frame
  when the page around it calls that host too: IQ's Power BI frame, not its portal), with the guard open for that one
  call only (its method and exact address). Its `{placeholders}`
  are filled from demo.json's `apps[].values` (the demo's own IDs and names: which business plugin, which section),
  then run.json's results; the demo's values win, and each value is one encoded path segment, so it can't add a
  segment or a query. If it can't, the Note's `if it can't: A › B` steps run instead (approved with the rest: the
  approval list shows them). After a run, it undoes each write the group covers with what that write made (its own
  ids, read from its address too: Cowork's `/cowork/#/task/<id>`). If the API won't take an id, or the run recorded
  none (the write's call was held, or its address had no id), the pack's `undo.find` lists what's there: by that id
  (whole or a `:` part), else by the group's Names (exactly, never one the recording's start screen shows). Found, it's
  undone by the list's id; a list the API answered (2xx) with no match is nothing to undo; a find that failed falls to
  the Note's steps. The checks after a run load each app again at its start (a real page load, not only a route) and
  prove it's there before reading its lines.
- **Stops for anything the plan didn't ask for**, with a picture in `.out/ai/stops/`: a window or a native dialog,
  leaving the app's hosts, a sign-in page (never signed in: Sign in again; the guard holding an app's sign-in says
  so, with the request), what a step lands on not showing, a control that isn't there, a step only a person can do.
- **Checks every step's proof** (`Lands on:`, [plan-format.md](engine/plan-format.md#what-proves-a-step-lands-on)):
  words on the page, a control by its exact name (in a state), a box's text (its live value), or words gone with
  words that stay. A proof that isn't there stops the run, with a picture.
- **Proves each landing on the live page** ([plan-format.md](engine/plan-format.md#a-landing-on-the-live-page),
  `liveProof`): it reads the page before each step (for `Go to X`, the app the plan was on) and twice after it, in
  the reader's shape, and records the landing in run.json's `landings` as strong, weak or none, with what proved it.
  After a write, its pack's read-only check (`check.api` with `made`: the status, or the fields, it answers once the
  write ran) passing is strong; it runs in the app's own session, as the write's own calls carried it.
- **A step it can't prove** (not strong, and no proof or one that was already there before it) goes in run.json's
  `unprovable`. The run goes on only if the next step's control is the one (exactly one by its exact name, of its
  kind), and a write never follows it.
- **Writes only after strong landings** (`writeGate`): the landings in the write's app since its last write all
  strong. The run never asks: where it would, it stops before the write, keeps a picture and both reads of the page
  (`.out/ai/stops/`), runs the reset after, and lists the step in run.json's `needsYou`.
- **Clicks only what it means.** Before every click, what's at the point (through the frames under it) has to be the
  control itself, not a toast, a banner or a backdrop on top: measured again for up to 2 s, then a read-only step
  is missing and a write stops the run. Each input's record keeps what it hit (`landed`).
- **Names controls the reader's way** (`controlOf`, `packages/script/naming.mjs`), so a plan's step finds the control
  the reader named on the recorded screen. Until the two are shown alike (`packages/selftest/name-parity.mjs`), a
  write also needs the reader, reading the screen's markup as it is then, to find its control the same way.
- **The reset before and after.** The demo's `preflight.reset`/`resetFix`, else reset.md: before, the check (a check
  on a screen other than the start is reached by the plan's own read-only steps there, under the guard, before any
  of the reset's writes; `pathTo`), then the undos and the set-first steps, then the check again (it fails closed: nothing is recorded when the tenant isn't
  as the demo starts); after, the undos of what ran, the start set again, the check.
- **Set before** (reset.md's `## Set before beat N, <step>`): just before that step, each line is set off camera in a
  tab of its own of the same capture browser (`capTab`, at its `Opens:` page), as Set first sets it: read, and when
  it isn't so, its control as an approved write (the approval lists the lines with the writes), under the write gate;
  then read there again, and the tab closed. The recorded tab never moves and no screen of the set is saved. A line
  whose app pack lacks the write its `Set:` names, or that the approval doesn't list, fails closed before any tab
  opens. Once the step lands, each line is checked on that screen as drawn: one that reads the old way (a cached
  list) stops the run there, before the beat's next write, with a picture. Lookups by an app's tab find its own by
  its mark first (`pickTab`), so a second tab at the same address never stands in for it. run.json: `setBefore`.
- **Leave out** (reset.md's `## Leave out`): from the run's start, before anything reads the apps, the capture
  browser filters what each line names out of what the page is given (`capLeaveOut`), in every tab, frame and worker,
  the Set before tab included; the apps with a line are opened again so what they show comes filtered. A response
  filter (its app pack's `filters` entry) takes the items out of the app's own response at its response stage: the
  request goes as it was, and the page draws itself without them (no hole, counts right). A list the app draws from
  its own store (Teams' teams) is marked and hidden instead, never removed, and the snapshot leaves it out. Before the
  recorder saves anything (a screen, a hover's parts, a stream's frame), the negative check: her lines' words, and
  each item the filters took out by its own text, on no part of it, in any frame. A hit isn't saved: the take stops
  there, with a picture and where it was, and the run stops at its next step and lists it for her. So does a filter
  whose response can't be read or has lost its list, before that app's next save. A line naming a filter no pack of
  the demo has refuses the run before anything runs. What it names never proves a live landing. The approval lists
  the lines apart from the writes ("Left out of the replica: …"). A live walk does the same, and checks each screen it
  keeps. run.json and walk.json: `leaveOut` (per rule, each request it filtered and what it took out; the checks).
- **Your own status** (an app pack's `ownStatus`: Teams' avatar, Available or Away). The capture browser's Teams
  never reports you active, so the status it shows comes from your own Teams app: away from your computer, it turns
  Away, and the replica would keep it. Before the recorder saves a screen of that app (before Leave out's check),
  the status is read (`capOwnStatus`): it must be what the recording's start screen shows (else the pack's
  `expect`). If it isn't, it's read again every 2 s for up to the pack's `waitS` (90 s); a step waiting on it doesn't
  run out of time. Still not, and that screen isn't saved, nor anything after it: the run stops with a picture, lists
  "Teams showed you as Away. Start again while you're using your Mac, with Teams open." (PC on Windows) and runs the
  reset after. A screen without the control saves as it is. run.json: `ownStatus` (each read, the stop); the summary
  prints what the start screens (with their sweeps) and beat 1 showed. A live walk and `ai check` only note it.
  Where her pack names where her presence comes from (Teams' `presence`: getpresence), the capture browser gives her
  own entry in those answers the status the recording shows (`capPresence`, `capture/presence.mjs`): who she is is the
  signed-in account's object id, read from the page's sign-in at run time; only her entry's availability and
  activity change; everyone else's status stays as the service says; the request goes out unchanged. So nobody has to
  be at the computer; the status check above stays as the backstop. run.json, check.json: `presence` (each rule's
  answers and how many it changed).
- **Notices a replica never keeps** (an app pack's `notices`: Teams' "Loading latest updates… in the meantime, you can
  still send and respond to messages", which comes across the top of a channel while Teams catches up and moves the
  whole page down). Before the recorder saves a screen, or a stream's frame, of that app, it looks for the notice's
  words (`capNotices`). Showing: it waits up to the pack's `waitS` (60 s) for it to go, then presses the notice's own
  close button (a pointer click past the recorder's page script: not a step of hers), and saves once it's gone. Still
  there, and the run stops before that save, with a picture, and lists it for her. A frame taken while it showed is
  never kept. run.json: `notices` (each save that met one: waited, closed, the stop). A live walk and `ai check` only
  note it (`notices`).
- **The recording's hovers are a floor** (a demo built from an earlier recording: its `data/snaps/hovers-<app>.json`).
  The hovers sweep learns to stop trying a kind of control that never shows anything (10 tries), and waits at most
  900 ms; on a busy computer a slow card would read as none. Each recorded hover is found on the live page as the
  replica finds it (its anchor by selector, place and words, then its scope); when its place has moved (a bare `div`
  whose surroundings changed), by its words, numbers aside (an element whose own name or words are the anchor's, else
  start with them; else, for an anchor of four words or more, one holding 80% of them in any order, without its own
  card's words when the card was inside it; the innermost, nearest the recorded spot; an anchor with no words, by the
  name in its selector). An anchor with nothing of its own (a bare tag, no words, no container: Teams' people cards,
  recorded on the avatar's `div`) would match half the page; it's found by its trigger instead: the control whose own
  name holds a name from its card ("Profile picture of Pat Doe." for "PD Pat Doe Engineer…"), nearest
  the recorded spot, else the element of its kind at that spot, about its size.
  The controls that are it or sit inside it, and the nearest control around it, are never skipped that way, nor by a
  screen's cap or time: while any is left, the next one hovered is theirs. Their first tries don't count against the
  screen's budget (`auto.maxS`): the clicks after them get the time they had without them (Nov 25: Teams' 47
  recorded hovers took 208 s on its start screen and left the rest of it out of time). Zoom, lists and drags have
  their own time, outside the budget (zoom: `auto.zoomMaxS`, 90 s), and a kind of screen's zoom, chips and drags count
  as done only once they've run, so a screen whose sweep stopped short leaves them to that kind's next screen. One that
  shows nothing, or whose controls couldn't be pointed at, or whose one control showed another card (a card left from
  the control before), is tried once more for 2.5 s, last, after the screen's other side states, once no card is
  showing, its control found again from scratch,
  within `auto.floorRetryS` (45 s a screen; reaching it is said in the notes and the timeline's `hovers-again`)
  (`capHoverFloor`). After the run each recorded hover is captured (a hover captured in its app
  shows its card: the same words, numbers aside, or most of them in another order; `hover-card.mjs`), missed (its anchor was there and its card wasn't
  captured), gone (its anchor's words were on no screen the run swept) or not reached (recorded only on screens the
  recording has that the run never got to: its plan stopped first, or doesn't go there; so even when a control like
  it showed another card on another screen): a missed one goes under Needs you with a
  picture of the screen (only a missed one keeps its picture; those the cap cut share one, and so do those whose
  controls showed other cards: a firm answer, not tried again, since a container's every control is the hover's). run.json: `hovers` (the
  list, how each anchor was found, and the counts the summary prints). A live walk and `ai check` don't sweep
  hovers.
- **The recording's menus are a floor** too (`hovers-<app>.json` `clicks`: what the recording's click audit opened).
  Each is found by its selector; else by the same without the name its label holds, when what's left still says which
  control (an id or data- attribute) and finds exactly one (Teams' profile button, whose name carries the status and
  the account); else by its name, numbers aside, or as the one control sharing its first three words or more, most of
  its own ("Your profile, status Away" for "Your profile, status Available for …"); nearest the recorded spot, its
  point read again just before the click. A bare `button[type="button"]` is never enough (it once clicked one of
  Copilot's suggestion cards for "Format text", filling the composer). Clicked whatever
  `auto.clickMax` or the time, captured, and put back its recorded way. The heuristic picks that aren't recorded keep
  the cap and what's left of the budget, and leave out the clicks the demo's build dropped (its flow's `clickPages`
  `drop`: Teams' " Bot Available" opens a chat). After the run each is captured, missed (it was there and nothing
  opened, it went to another screen, or it couldn't be clicked: under Needs you, "Open "<name>" (<app>)", with a
  picture), gone or not reached. run.json: `menus` (the list and the counts, next to `hovers`).
- **Each screen put back.** After each kind of side path, and at the end of a screen's sweep, the screen must be as it
  was saved: the same screen (its address, and its title, an unread count and numbers aside: Teams' address never
  changes, its title names the conversation), no menu, dialog, listbox or popover opened, no pane (an aside, a
  complementary or named region or section) opened or closed, no expander flipped (Copilot's "Collapse sidebar",
  admin's Cloud Shell pane), no text left in a box (Copilot's composer). Not a raw signature: admin's grid order changes on every load. Another screen is left
  first: its address again, else the control its title names, most specific part first ("Launch plans" for "Chat |
  Design | Launch plans | Microsoft Teams"). What else differs is closed (Escape; text in a box that was empty
  cleared by clicking in, selecting all and Delete, never Enter; then each flipped control flipped back, the recorder
  stepping aside so none is a step of hers), else the tab is reloaded and gets back on
  the screen the same way, else nothing more is saved: the run stops before its next save, with pictures before and
  after, and lists it for her. The click audit does the same after each reload and after a click that changes the
  title at the same address. Before it reloads at all, it closes what a click opened in order: the recorded way
  (Escape, or the control again), the control again (the same element, or one drawn in its place that says it's on:
  `aria-pressed`/`aria-expanded` true, or "toggle" in its test id, as Teams' Find in channel), the close button of what
  it opened (Close, Dismiss, Cancel alone, an ×), then a control that says it opens or closes something, then a click
  on the empty spot the sweep rests on (kept as Escape, marked `dismissed`); Escape goes twice, the second time from
  inside what opened (a search box clears first; a dialog that didn't take focus). Closed means
  nothing the click opened is left: no part added or removed, no state attribute (expanded, pressed, selected, hidden,
  open…) still changed; an app's own churn on other attributes (Teams' rotating search placeholder, generated ids, a
  status in a name) doesn't count, since put-back checks the screen after the kind. After a
  reload (a real one: an address with a `#/` route, the admin center's, would only change its route and keep what the
  click changed) it waits for the app to go quiet (15 s at most) before learning its own churn again, else every click after
  it reads as stuck. A recorded menu that visibly opened and read as nothing is pressed once more with the learned
  churn forgotten. What stayed when a click was stuck is in the recording (`sides.clicks[].results[].stayed`). The recording: `putBack` (each screen, after what, what it found, and how it was put
  back); run.json: `stopped.kind: 'put-back'`.
- **Counts a page loads after itself** (admin's bell: "Notifications" until its count loads; the recording has
  "Notifications, 1 unread items"). The controls the recording's screens name with a count or status after a comma
  (starting with a number or "status") are armed per app (`capCounts`). A page's first save after it loads (a start
  screen; any save after a reload: the list sweep saves admin's screen again after the click audit reloaded it, its
  bell back without its count yet) waits up to `record.countWaitS` (20 s) while one shows only its bare name,
  then saves; one that never gets its count saves anyway with a note: `admin: "Notifications" shows no count; the
  recording has "Notifications, 1 unread items"`. run.json: `counts` (the controls, and each wait).
- **A page that moves while it's swept** (a banner on top, a list that loads): every hover and every click reads its
  control's point again just before the pointer goes there, and uses where it is now; one that has gone from there is
  found once more by its kind and words (`hover-page.js` `pos`, `ctlPos`).
- **run.json**: each step and its time, each write and what it made (ids, the page, what was typed, for the undos),
  the time per beat, the reset, what the guard held, every non-read it let through and why (allowed, or a planned
  write), every host reached outside the apps', every input sent (`inputs`: what it was for, the control's name, its
  frame, and whether it's the one the step names), the stop.
- The recording is the recorder's own (build, checks and Review work unchanged); its start sweeps run side by
  side, an app per window.

It needs the capture browser started holding (`"capture": { "guard": "hold" }`): the guard is on from the
browser's first request, with the apps' allow-lists, so what the apps send while they load is held too; a run's own
guard replaces it and it comes back after. Each app starts on its start screen in the recording, checked against it
(the words its first `Go to` lands on) before the recording starts. `apps[].start` in demo.json says how: an address
(Teams opens where it was last: a link to the demo's first screen), plan steps for a start screen no address
reaches (`["Click \"Supply Chain Operations\""]` for a Microsoft IQ business plugin), or both. They're navigation
only (a click, a hover, a scroll, a wait), under the guard; anything else is refused. `startSteps` is the older
name. The capture browser denies every app's
site notifications (never grants them): an app's "turn on notifications" banner isn't in any recording.

A capture start waits up to `capture.signInSettleS` (60 s) for each app's sign-in to settle before the tenant check
refuses (M365 Copilot's can take a while after its own landing); another tenant refuses at once.

`scenecast ai walk --live` walks the plan read-only (`walkLive`). Every screen it lands on goes in
`.out/ai/walk-screens/<beat>-<step>.json`, and each app's start screen in `start-<app>.json` (its app, address and
title; its words in every frame; every control's name, role, frame, state and what a box holds), with
`<name>.reads.json.gz` beside it: the screen in the reader's shape (`[{ at, docs: [{ key, html }] }]`, read twice
about a second apart, the recorder's serialization), local only, to re-ground a plan on the product as it is today.
walk.json names the plan it walked by its sha256 (`plan`): a re-ground refuses a walk of another plan. Each step
also keeps, with their app and frame, what the guard held in it (`held`, from its first input to its last read) and
the requests that failed other than by the guard or answered 400 or more, with every answer from a pack-named service
(`net`, from its first input to the next step's: an answer after its last read is still its own): how a service
error shows up. `suspect` lists the steps whose app's page may have been broken today, not by the product, by the
re-ground's own rule (`regroundPlan` in `packages/ai/reground.mjs`: a held request no pack has reviewed, an answer of
500 or more for that app, an error the recording doesn't show, or words lost while nothing ran), until the page loads
again. It compares with the recording, so it covers the steps whose proof names a recorded screen, and a demo
without a recording says why instead (`none`).
A demo's `capture.keepBodies` (in its local demo.json) keeps the bodies of the held requests it names in
`.out/ai/held-bodies.json`, for a person reviewing an allow entry. At a write it skips the rest of that beat and goes
on with the next; walk.json says, for each step, reached, drifted (its words changed), unproven (its words were there
before), a write, after a write, or missed (and which write it needed), with what each click hit (`hit`), any error
the app showed (`trouble`), every input (`inputs`) and the guard's held and passed requests. `ai walk` without
`--live` walks the recording's screens instead (`walkerFromDemo`), for comparison.

A control the walker can't see on the page's outline (it lists only what's on screen) is looked for in the whole
page and its frames by name (`nameFits`: equal, starting with it, or most of it), then brought into view before
it's clicked: Microsoft IQ draws in Power BI frames and scrolls inside them.

`scenecast capture start|stop|status|sign-in|run` (preflight runs `start`). The host's state is `.out/capture.json`
and its log `.out/capture.log`. `demo.json`:

```json
"recorder": "capture",
"capture": { "profile": "demo-tenant", "tenant": "<the demo tenant's domain>", "account": "<the demo account>",
             "channel": "chrome", "window": "auto", "flags": [], "macSso": true, "guard": "hold" }
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
  drawing, at the demo's viewport, twins, sign-in landing, the guard (on a page open before it, and turned off and
  on), closed shadow roots, nothing left running.
- `packages/selftest/capture-run.mjs`: Record for me, unattended, on the fixture's tasks app (its server keeps what
  writes change): the reset before and after, an approved write, a POST the guard holds, a write that isn't approved
  and a step off the app (each stops the run), an edited plan (nothing runs), a live walk, and the same raw
  recording as the extension's. Headless on Linux.
- `packages/selftest/guard.mjs`: every selftest calls it first. Nothing a test starts reaches a presenter's
  Scenecast: no receiver, command or recorder on the app's ports (47621–47630), no demo, raw folder, extension or
  capture profile outside the test's own temp folder, no command to a receiver the test didn't start (the engine
  refuses them while `SCENECAST_TEST_FENCE` is set: `@stuntdouble/core/lib/test-fence.mjs`).
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
