# Flow format (version 1)

A demo folder holds:

| File | Written by | What |
|---|---|---|
| `demo.json` | you (from `replica new`) | The demo's settings: apps, viewport, Chrome profile, ports, recorder settings. |
| `recording.json` | the recorder (`replica build --from-raw`) | What happened when the demo was recorded. Don't edit. |
| `flow.fixes.json` | `scenecast fidelity` | The fidelity loop's per-demo patches (fonts, assets, click CSS, pin, set, rows), each with its cause and evidence. Applied before the overrides. Remove one to undo it. |
| `flow.overrides.mjs` | you | Hand edits, applied after the recording. Keep every edit here, with why. |
| `flow.editor.json` | the editor (`scenecast edit`) | Wording and date changes and beat starts made in the replica. Applied after `flow.overrides.mjs`. |
| `focus.mjs`, `focus.json` | you; `scenecast script` and the editor | Focus points (below). |
| `flow.json` | `replica flow` / `replica build` | What the replica runs. Never edit by hand. |
| `data/` | `replica build` | `snaps/` (pages), `streams/` (answers' frames), `assets/` (CSS, fonts, images). |

## demo.json

```json
{
  "kit": 1,
  "name": "ignite-demo2",
  "title": "Ignite Demo 2",
  "port": 4720,
  "viewport": { "width": 1920, "height": 1080, "dpr": 2 },
  "chrome": { "profile": "Profile 10" },
  "raw": "~/.replica-kit/ignite-demo2/raw",
  "receiverPort": 47621,
  "apps": [
    { "id": "teams", "key": "T", "title": "Teams", "url": "https://teams.cloud.microsoft/", "match": "teams.cloud.microsoft" }
  ],
  "record": { "busy": [{ "text": "Working on it" }, { "sel": "[aria-label=\"Stop\"]" }], "settleMs": 2500, "typeIdleMs": 1200, "streamMinMs": 1500, "streamMaxMs": 10000 },
  "zooms": [50, 67, 75, 90, 110, 125, 150, 175, 200]
}
```

- `apps[].match`: text in the app tab's URL (or a `sessionStorage.d1tab` mark set with `replica cmd mark`). `key`:
  one letter for ⌥ + key (not P or N).
- `raw`: where raw captures go. They hold real URLs, some with tokens: keep it outside the demo folder.
- `record`: `busy` markers (`{ sel, text? }` or `{ text }`) that mean an answer is still coming; `settleMs` (no
  change this long = settled), `typeIdleMs` (a pause in typing this long captures the typed screen), `everyMs`
  (how often a streaming page is read), `streamMinMs` / `streamMinFrames` (a change that keeps going at least this
  long, over this many frames, is a stream), `streamMaxMs` (longest replay at pace 5), `maxS` (stop waiting for a
  screen to settle after this many seconds, 240), `ignore` (selectors whose text changes on its own, like a clock,
  presence or a typing indicator: not counted as the page changing).
- `record.auto`: the side states captured on every new screen as the demo is recorded. On by default; `false` (or
  `record start --no-auto`) turns it off. Fields, all optional: `hovers`, `clicks`, `groups`, `chips`, `lists`,
  `drags`, `zoom` (each `true`/`false`), `maxS` (seconds per screen, all kinds together, before the rest is skipped and
  named in the report, 90), `hoverMax` / `hoverMaxS` (at most this many hover candidates, this long, per screen: 40,
  45), `clickMax` / `clickMaxS` (25, 45), `zoomMinS` (zoom only starts with this many seconds of the screen's budget
  left: 60), `chipWidths` (window widths tried for "+N": `[1366, 1100]`), `zooms`
  (default: `zooms` below). Hovers and clicks are captured once per control; zoom, chips and drags once per kind
  of screen (its landmarks and layout); groups on every answer; lists on every screen with a scrolling list.
- `zooms`: what zoom captures and `fidelity` checks.
- `engine` (optional): `{ dir, modules }`, the demo's own engine modules: `dir` (default `app`) is served as `/demo/`,
  and each of `modules` is imported by the replica at start. Its default export gets an API: `on('key' | 'activate' |
  'jump', fn)` (a key hook returns true to take the key), `expose(name, value)` (on `window.d1`, for checks), and
  `flow`, `stage`, `apps`, `docsOf`, `current()`, `groupButton(app, label)`, `openGroup(app, label)`, `speed`.
  Focus points are a built-in module of this kind.
- `build` (optional): `{ hook, hookFiles }`, the demo's own text pass. `hook` is a module whose default export takes
  `{ elementEnd }` and returns `{ html(text, ctx, opt), plain(text, ctx), leftovers(text, ctx), unused(), report() }`;
  `html` runs after the edits on every page (ctx: its snap id), stream frame (`stream:<name>`, `{ partial: true }`)
  and hover and click part (`hover:<app>`, `click:<app>`), `plain` on their plain text. The build fails on anything
  `leftovers` or `unused` reports. `hookFiles` (what it reads) are part of the build key.
- `fidelity` (optional): `{ diagnosers: ["file.mjs"] }`, the demo's own diagnosers for `scenecast fidelity`, run
  before the rule-based one (interface in `packages/fixer/index.mjs`).
- `theme` (optional): `"light"` or `"dark"`, the theme the demo should be recorded in. Only a note when a screen
  isn't (preflight, record stop, `fidelity`); either theme records.
- `checks` (optional): `known: ["text a failure starts with", …]` makes those accepted differences warnings.

## flow.json

```js
{
  version: 1, kit: '1.0.0', name, title,
  pace: 5,            // seconds-per-answer scale: 5 = recorded speed; ?pace=N in the URL overrides
  apps: [ { id, key, title, layout: {…}, on: [transition…] } ],
  states: { <id>: state },
  streams: { <name>: stream },
  beats: [ { label, active, states: { <app>: <state> } } ],   // beats[0] is ⌥0 (reset)
  path: [ step… ],    // the recorded run-through, for the checks
  hoverPages: [ { page, app, base, frame?, only?, cssFrom?, delayMs? } ],
  clickPages: [ clickPage… ],  // panes, sections, menus off the path (record side clicks)
  drags: [ drag… ],            // resize handles (record side drags)
  groups: [ group… ],          // collapsed step groups in answers (record side groups)
  variants: [ snapId… ],       // captures used only as sources (zoom bands, composed parts)
  lists: [ { app, state, list, seen, count, placed } ],
  zoomRefs: [ { app, state, z, snap, vw, vh, dpr, landmarks } ],
  compose: [ … ], edits: [ … ], chipCards: [ … ], lateItems: [ … ],   // from overrides
  notes: [ "…" ]      // what the recorder or compiler wants a person to look at
}
```

### States

```js
'chat-03-plugins': {
  app: 'chat',
  snap: 'chat-03-plugins',            // data/snaps/<snap>.html (+ <snap>.<frame>.html for each iframe)
  title: 'Plugins | Fixture',         // the window title while it shows
  focus: { sel: 'span[aria-label="Message"]' },   // where the real app put the cursor when it opened
  on: [ transition… ],
  fill: [ { sel: '…', value: 'the scripted text', ms: 24 } ],     // ⌥P types value into that field
  next: { click: matcher } | { enter: matcher } | { app: 'admin' }, // ⌥N
  esc: 'chat-01-message',             // Escape goes here
}
```

### Transitions

Each has one trigger: `click`, `enter`, `type` or `hover`, whose value is a **matcher**. Then:

| Field | What |
|---|---|
| `to` | The state it goes to (the page morphs into that capture). |
| `stream` | A streamed answer (`streams[name]`) plays, then lands on its `to`. |
| `query` | Enter in a search box: `{ 'iq': 'state-a', 'supply': 'state-b', '': 'default' }`, by the typed text. |
| `scope` | Only part of the page changes (a switch, an expander): `{ closest: 'li' }` or `{ up: 3 }`, morphed to the same place in `on`/`off` (states) or `snap` (a capture, `'@self'` for this screen's own). |
| `empty` | (`type`) the state when the field is emptied again. |
| `keep`, `keepAlso` | Matchers for fields kept as they are while the page morphs around them (text she's typing). |
| `typedFrom` | (`click`) a send button: carries that field's text into the stream, like Enter; does nothing on an empty field. |
| `scroll` | `'target'` (default: scroll offsets as captured) or `'keep'` (as they are now). |
| `app` | Switches to another app after. |
| `flag` | (`click`) toggles a flag on the app (a Collapse sidebar button); a `responsive` rule with that `flag` swaps its part for `flagVariant` while it's on. |
| `when` | (app-level `on`) only on these states. |
| `delay`, `within` | (`hover`) ms before it shows (350); a selector the pointer can move into without it closing. |

### Matchers

`{ sel, in, text, textStarts, textRe, label, labelStarts, testid, frame, nth, up }`: `sel` a CSS selector, `in` an
ancestor selector it must be inside, `text` / `textStarts` / `textRe` its visible text (whitespace collapsed),
`label` its aria-label, `frame` the iframe key (`f0`, `f1`, … stable across captures), `nth` which of several
look-alikes (only that one fires), `up` how many ancestors a click may climb to match (14). The recorder writes
`sel` from data-testid, data-tid, aria-label, role, placeholder or name, plus `text` when that's what tells it
apart, and `in` only when it needs a landmark. Never a generated class.

### Streams

```js
s001: { raw: 's001', frames: [0, 14], to: 'chat-01-message', prompt: 'Summarize …', timing: 'real', ms: 4211 }
```

`raw`: the raw frames' folder; `frames`: first and last used (inclusive); `to`: the state it ends on; `prompt`: the
text she sent (if she types something else, her words show in the replica's message instead); `ms`: how long
the replay takes at pace 5. `timing: 'real'` places each frame at its recorded time, scaled to `ms`. Without it,
frames are spread evenly, and `answerAt` (the raw frame where the answer starts) with `split` (0.6) gives the steps
that share of the time.

### Beats and the path

`beats[0]` is where ⌥0 resets to; ⌥1 … ⌥9 are `beats[1…9]`. The compiler makes one at the start and at each app
switch and streamed answer. The path is what was done, step by step: `{ app }`, `{ click, dx }`, `{ type, text }`,
`{ clear }`, `{ enter }`, `{ key }`, each with the `checkpoint` state it reached; `checks/path.js` replays it.

### Layout rules (`apps[].layout`)

The real apps place some things with script, in pixels, and redo it when the window changes size. Captures hold
those pixels from one size, so these rules redo that work on every resize and scroll:

| Rule | What |
|---|---|
| `responsive` | Below a width, a part of the page is swapped for the same part captured at that width: `{ part: { sel, css, up }, below, variant: { default, <state>: snap } }` or `bands: [{ below, variant }]` (the narrowest band the width falls under wins; a band's variant is a snap or `{ default, <state>: snap }`). `record side zoom` writes bands for zooms above 100%. With `flag` and `flagVariant` (a snap or `{ default, <state>: snap }`), the part is also swapped while that flag is on (a sidebar she collapsed). |
| `set` | Inline styles the script would have written: `{ sel, style: { flex: '0 0 25%' } }`. |
| `pin` | A fixed element kept over its placeholder: `{ el, anchor, sync }` (a script-pinned composer; `sync` keeps the placeholder as tall as the box when it grows). |
| `float` | A popup kept against its anchor: `{ el, anchor: matcher, place: 'bottom-start', gap, arrow, arrowHalf }`. |
| `stick` | A list that stays scrolled to its newest item unless she scrolls up: `{ el }`. |
| `gridfit` | A data grid that fits its columns to its container: `{ columns, ideal, min, extra }`. |
| `chips` | A chip list that shows N rows, then "+N": `{ list, item, rows, gap, plus: { from, marker, tag, less, labelMore, labelLess, noun } }`. `from` is a capture with the real "+N" (marked `data-d1-plusmark`, or found by its text); clicking it shows every chip and it says `less` ("Show less"), with aria-label `labelLess`; closed, its aria-label is `labelMore` with `{n}` ("+{n} more plugins"; or `noun`). It stays open through morphs until ⌥0 or a jump. `record side chips` writes this. |

### Clicks (`clickPages`)

`record side clicks` runs the click audit on a screen: it clicks each control that opens, closes, expands or toggles
something (the ones listed in `controls`, and with `pick` every visible button with `aria-expanded` or
`aria-haspopup`; never Send, Delete, Approve, menu items or links, nor labels matching `block`), records what
changed (in place, from an ancestor of the control; and new layers placed against it), and puts it back the page's
own way. The build stores each one in `data/snaps/hovers-<app>.json` (`clicks`); the replica plays it on any screen
where that control is, when the click isn't on the recorded path.

```js
{ page: 'chat-01-message', app: 'chat', base: 'chat-01-message', frame: 'f4',
  sticky: ['Projects'],                 // stays as she left it when the page morphs (panes, sections)
  restore: { 'Our process': 'toggle' }, // how it closes, where the audit misread it: toggle | escape | reopen | auto
  reopen: { 'Close panel': { sel: 'button[aria-label="Show panel"]' } },   // the control that appears in its place
  drop: ['…'], copies: { 'Collapse Our process': ['Our numbers', 'Our people'] },   // the same control elsewhere
  css: ['snap-id'], vendorCss: ['capture/vendor/menu.css'] }
```

The compiler makes a page sticky for each control that closes by `toggle` or `reopen` without a popup. Menus and
popups close with Escape, a click elsewhere, a menu item or a Close button; ⌥0 and beat jumps close everything.

**Styles that load late.** A menu's styles can arrive only when it first opens (and some apps remove them when it
closes). The click CSS comes from, in order: the page as it was at the end of the click audit; every stylesheet a
click brought in (the audit keeps them with that click); Griffel's atomic rules for the same class names in any other
capture; and `vendorCss`, files in the demo folder of plain rules, one per line, kept when every class they name is
used by the clicked parts (for a library's published rules, or rules measured from the real page's screenshot).
`lateItems: [{ placeholder: 'data-testid="…-loading"', role: 'menuitem', text: 'Give feedback' }]` swaps an item
caught while it was still loading for the loaded one from another capture.

### Step groups (`groups`)

Answers often fold their steps into a group ("21 items complete", "Approved 1 action") that opens on click, even
while the answer is still coming in. `record side groups` opens every closed group on a screen (the page's own
click), captures the screen with them open, and closes them again; the compiler writes one entry per app:

```js
{ app: 'chat',
  button: 'button[aria-expanded][aria-controls]',   // simple selectors (a tag, [attributes], .classes, commas)
  label: '.glabel', chevron: 'svg',                  // its label (else its text without aria-hidden parts)
  template: { closed: 'chat-01-message', open: 'grp-chat-01-message', label: '3 steps' },
  open: [{ open: 'grp-chat-01-message', closed: 'chat-01-message' }],   // real open captures, per screen
  streams: ['s001', 's009'],                         // runs whose frames still had a closed group's list
  dropLines: '<output [^>]*>[^<]*, Completed</output>',   // lines the product shows only while it runs
  grid: { closed: ['row-closed'], open: ['row-open'] } }  // groups whose list stays in the page
```

How a button changes when it opens (attributes, with the label as `{label}`; classes; children it drops, such as
icons), its chevron's classes and its region's classes come from the template pair. A *list* group's list is put in
when it opens (from the open capture for this screen, else the last frame of the run that ends on it where the
group was still filled) and its region slides open to the list's height; a *grid* group keeps its list in the page
and opens by swapping its region's classes. An open group stays open through the next frames and prompts (matched by
its region's id, else its label) until she closes it, or ⌥0 or a jump. A click the recorded path has on a group
button wins when nothing is playing. `record.groups` in demo.json sets `button`, `label` and `chevron` for the
recorder (the click audit leaves those buttons out).

### Drags (`drags`)

`record side drags` runs the drag audit: it holds each resize handle (a separator, a slider named for resizing,
anything with a resize cursor), moves it both ways, lets go, and puts it back. From what the page wrote, the recorder
writes the rule:

```js
{ app: 'chat', frame: undefined, handle: 'div[role="separator"][aria-label="Resize workspace"]',
  mode: 'live',            // live: follows the pointer; release: applied when she lets go
  write: 'px',             // px (target's width) | flexPercent (the pane after the handle's flex share; its CSS
                           // min/max) | cssVar (name on target, unit px or vw) | teamsSlot (Teams' layout)
  target: 'aside[aria-label="Workspace"]', name, unit,
  dir: -1,                 // +1: dragging right makes it bigger; -1: dragging left does
  min: 250, max: 480, cursor: 'col-resize' }
```

Sizes stay through morphs and go back on ⌥0 and beat jumps.

### Overrides-only fields

| Field | What |
|---|---|
| `edits` | `{ remove: 'sentence' }` takes text out of every page and frame (fails the build if any is left); `{ replace: [a, b], in: [snaps] }`; `{ dropTooltip: 'label', in: [snaps] }`. |
| `compose` | A part from one capture put into others: `{ from, marker, tag, anchor, text: [[a, b]] }` (a card that only appears in a throwaway run). |
| `chipCards` | Hover cards built for chips the hover audit couldn't reach (Copilot's Workspace chips). |
| `variants` | Extra captures used only as sources. |
| `edits` `replace` | `{ replace: [a, b] }` with no `in`: a text replaced in every page and frame (fails the build if any is left). |

### Focus points (`focus.mjs`)

The demo's `focus.mjs` (the scaffold makes one) is compiled into `flow.focus`, and its `options` export into
`flow.focusOptions` (`{ zoom: 2, pen: 5, color: 'rgb(255, 56, 60)' }` by default, Jessica's ZoomIt settings). Its
default export is the list, or a function of the flow that returns it. With any points, `flow.modules` starts with
`/app/focus-module.js`. Edits show on reload, like overrides. A point:

```js
{ id: 'the-cost', beat: 9, app: 'copilot', states: ['cop-payoff'],
  find: '$35,073 chargeback',                       // text on screen, or:
  union: ['Workflow', { sel: 'aside ul[role=list]' }, { text: 'Northwind IQ', up: 'button' }],   // the box around all
  mark: 'arrow', dir: 'sw', len: 150,               // default a rectangle; an arrow's head on it, its tail to dir
  open: ['21 items complete'], grow: [26, 0, 0, 0], maxZoom: 1.5, line: '7.5' }
```

`beat` is the ⌥ key that lands just before it: after that key, ⌥F starts at the beat's first point that's on the
screen, and skips points that aren't. `{ text, up }` is the element around a text (`up`: a selector for `closest()`,
or a number of parents). `open` opens step groups first. The view zooms to fit the target and its mark with a 9%
margin, never past `zoom`; a target against the screen's edge gets the most zoom that keeps the mark on screen.

### `focus.json` and `flow.editor.json`

`scenecast script` and the editor write these; by hand is fine too. `focus.json` is `{ version: 1, script, points }`:
points as above, each with `source` (`script`, `dot` for the editor's, `edited` for a script point moved in the
editor) and `label` (what it points at, for people); `scenecast script` replaces only its own (`script`) points.
They're merged with `focus.mjs`'s into `flow.focus` in order: by beat, then where the screen comes in the
run-through, keeping the order within a screen (`packages/player/app/focus-order.js`).

```js
// flow.editor.json
{ "version": 1,
  "edits": [{ "replace": ["Friday", "Monday"] }],                       // added to flow.edits (served live, built in)
  "beats": { "2": { "active": "chat", "states": { "chat": "chat-02" } } } }  // where ⌥2 starts (a new beat may follow the last)
```

### Serve-time tweaks and `data/build.json`

`replica serve` re-reads `flow.overrides.mjs` (and the demo's other `.mjs`/`.json`) on every reload and recompiles
`flow.json` when it changed. Text `edits` that aren't in `data/` yet are applied as pages, stream frames and hover
data are served, so a wording or date change shows without a build. `replica build` bakes them in;
`replica serve --release` serves `data/` exactly as built.

`data/build.json` is the build's manifest: `{ kit, at, key, inputs, ms, changed, files }`. `key` hashes every input
(the kit's capture code, the raw captures' listing, vendor CSS, the flow and the edits): a build with the same key
is skipped (`--force` builds anyway). `changed` lists the files the last build rewrote. `replica status` compares
the overrides with it and says whether anything needs a build (a removed built-in edit, a composed part, new
captures) or is only served live.

## The replica in the page

`window.d1` is there for the checks only (nothing on screen): `state`, `errors`, `jump(n)`, `activate(app)`,
`go(app, state)` (a fresh load: panes and sizes reset), `morph(app, state)` (like a transition: they stay),
`locate(matcher, app)`, `reveal(matcher, app)`, `focused(matcher, app)`, `idle()`, `doc(app)`, `fill()`, `next()`,
`hovers(app)`, `hoverAt(x, y, app)`, `clicks(app)`, `clickAt(x, y, app)`, `openAt(name, app)`, `clickFit(name, app)`,
`groups(app)`, `groupButtons(app)`, `flags(app)`,
`sizes(app)`. `?speed=N` in the URL runs the replica's clock N× faster (hover delays, stream pace, timers), for
the checks; `?pace=N` sets the stream pace for a person.

## Presenter keys

All keys use ⌥ and show nothing: **⌥0** reset, **⌥1–⌥9** beats, **⌥ + an app's key** switch app, **⌥← ⌥→**
previous / next app, **⌥P** type the scripted text into the field she's in, **⌥N** the screen's next step, **⌥F**
the next focus point (**⌥⇧F** the one before; while zoomed, **Esc** zooms out and **↑ ↓** or the wheel step the zoom).
**⌥⇧E** turns the editor on and off where the replica is served for authoring (docs/cli.md).

## Changes

- **1** (scenecast 0.2, Phase 4): added, all optional: `focus.json` (with `source`, `label`) and
  `flow.editor.json` in the demo folder; focus points `line` may be a script line id (`"2.1"`).
- **1** (kit 1.4.0): added, all optional: `focus`, `focusOptions`, `modules` (from `focus.mjs` and demo.json
  `engine`); demo.json `engine`, `build`, `checks` (from the Demo 1 replica, Nov 16).
- **1** (kit 1.3.0): no format change. Added `record.auto` in demo.json, `data/build.json`, serve-time edits and
  `?speed=`. `recording.json` side paths now come from the automatic pass, so a screen can have zoom, hover and
  click pages of its own without anything run by hand.
- **1** (kit 1.2.0): added, all optional: `groups`, `chips` `plus.tag` / `less` / `labelMore` / `labelLess` /
  `noun`, `edits` `replace` everywhere (from the Demo 1 replica, Nov 15 evening).
- **1** (kit 1.1.0): added, all optional: `clickPages`, `drags`, `lateItems`, `t.flag` with `responsive` `flag` /
  `flagVariant`, `pin.sync`, `hoverPages` `only` / `cssFrom` / `delayMs` (from the Demo 1 replica, Nov 15).
- **1** (kit 1.0.0): first version, from the Demo 1 replica's format, plus `version`, `kit`, `apps[].key`,
  `states[].esc`, `typedFrom`, `nth`, `timing: 'real'`, per-state band variants, `path`, `lists`, `zoomRefs`, `notes`.
