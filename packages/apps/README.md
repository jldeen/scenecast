# @scenecast/apps (becomes @stuntdouble/apps)

App packs: what each real app needs to be recorded, built and shown, written **once per app, never per demo**. The
second demo of the same apps needs no tuning. Data plus small pure helpers; no dependency on the other packages.

| Pack | Apps it matches | What it holds | Where it came from |
|---|---|---|---|
| `teams` | teams.cloud.microsoft, teams.microsoft.com | busy markers, zoom levels, reflow part, channel stick, chat-list drag, launcher tooltip and search-hint rules, 3 themes, writes (post, theme), your own status (the avatar) | inv641, spike E, spike A, demo1-reset |
| `m365-copilot` | m365.cloud.microsoft, copilot.cloud.microsoft | busy, stream timings, step groups (selectors, status lines, grid classes), nav, workspace pane and chips, composer pin, split-pane drag, late menu item, menu CSS (`vendor/`), 2 themes, writes (task, skill, plugin switch, Chat/Cowork, theme), effects (Recent, memories) | inv641, spike E, spike A, demo1-reset |
| `m365-admin` | admin.cloud.microsoft, admin.microsoft.com | busy, sweep budget (no step groups), nav and header breakpoints, Tools grid fit, 2 themes (with literal colors) | inv641, spike E, spike A |
| `microsoft-iq` | iq.microsoft.com (+ Power BI frames) | frames to skip, `powerbi-access-token` stripped, sweep budget (zoom only), endorsement menu float, side-pane drag, no dark theme, writes (add to business plugin, endorse) | inv641, spike E, the recorder, demo1-reset |
| `github` | github.com | relative times ignored, busy, staff toggle removed, CSS repairs (`repairs/css.json`: 200 rules the CSSOM loses), code text on `/blob/`, all diffs on Files changed, settings heading font, 14 Primer themes, writes (comment, commit, merge, re-request) | ltg1189 and ltg1194, spike E, spike A |
| `github-copilot-app` | tauri.localhost, localhost:1421 | error-page check, 2 themes, Windows title bar positions, prompt write (never sent at capture) | spikes A, B, C |
| `sentry` | sentry.io | the Session Replay and Seer ads hidden on issue pages | ltg1189 |

Each `pack.json` says where its rules came from (`sources`) and why each rule exists (`note`).

## The format: `packs/<id>/pack.json`

```jsonc
{
  "kind": "stuntdouble-app-pack", "version": 1,
  "id": "m365-copilot", "title": "Microsoft 365 Copilot",
  "names": ["Copilot", "Cowork", "M365 Copilot"],          // what a talk track calls it ("In Cowork…")
  "match": ["copilot.cloud.microsoft"],                     // URL substrings or "/regex/": how a page finds its pack
  "frames": { "match": ["powerbi.com"], "skip": ["^https://…/extension\\.html"] },
  "start": { "url": "…", "signIn": { "hosts": [], "hint": "…" }, "ready": { "sel": "…" } },
  "record": { "busy": [], "ignore": [], "groups": {}, "streamMinMs": 0, "streamMaxMs": 0, "auto": {}, "hoverDelayMs": [240, 390], "zooms": [] },
  "build": { "strip": { "attrs": [] }, "repairs": { "css": "repairs/css.json" }, "rules": [] },
  "flow": { "layout": {}, "drags": {}, "groups": {}, "lateItems": [], "vendorCss": [] },
  "theme": { "system": "fluent", "follows": "setting|system|none", "setting": "…", "markers": {}, "themes": { "dark": "themes/dark.json" }, "fallbacks": [] },
  "platform": { "frame": "browser|app", "platforms": { "windows": "platforms/windows.json" }, "shortcuts": { "⌥ ⌘ G": "Ctrl+Alt+G" } },
  "writes": [], "effects": [], "safe": [],
  "notes": "…", "sources": []
}
```

Next to it: `themes/<theme>.json` (the player's `extractThemePack` output), `platforms/<platform>.json`
(`extractPlatformPack`), `repairs/css.json`, `vendor/*.css`.

### Build rules (`build.rules`)

The engine's one text-rule format (inv641's `raw`, `text`, `drop`, `block`, with `in` scopes), applied by core's text
rules, with what packs add:

| Kind | Example | |
|---|---|---|
| `raw: [from, to]` | the Teams search hint | literal swap anywhere in the markup |
| `block: text, tag` | the launcher tooltip | the nearest enclosing `<tag>` of that visible text removed |
| `re: [pattern, to, flags]` | the GitHub staff toggle | a regular expression swap (added) |
| `css: rules` | GitHub's code text | `<style>rules</style>` before `</head>`, whole pages only (added) |

Conditions (all optional): `url` (the document's URL has one of these substrings, or matches `/regex/`), `has` (the
markup holds this text), `in` (capture ids), `pages: true` (captured pages and their frames only, not hover or click
parts, where the same element can be the real result). Every rule has an `id`; a demo turns one off with
`demo.json` `packs.offRules: ["github:heading-font"]`. Pack rules are optional (matching nothing is fine) unless they
say `optional: false`.

`build.strip.attrs`: attributes blanked (sign-in tokens kept in markup). `build.repairs.css`: whole captured CSS lines
swapped from a map (declarations Chrome's CSSOM wrote back empty).

### Flow rules (`flow`)

`flow.layout` and `flow.drags` are **named** rules. A demo references one and adds its own fields (the captured
variants, a frame key); objects merge, the demo's fields win:

```js
layout: { responsive: [{ use: 'nav', variant: { default: 'v200-cop-task' } }], chips: [{ use: 'workspace-chips', state: 'cop-payoff', plus: { from: 'v200-cop-task' } }] }
drags: [{ use: 'side-pane', app: 'iq', frame: 'f4' }]
```

A rule with `always: true` is in every demo of the app (once). `on` triggers a rule needs (Collapse sidebar's flag)
are added to the app's triggers. Responsive rules give the app's own breakpoint in CSS px (`below`) or its zoom
levels: never bands that assume a 1920-px window; the engine works bands out from the recorded width.

`flow.groups` fills a demo's step-group entry where it has none (status lines to drop, grid classes);
`flow.lateItems` are menu items that load after their menu opens; `flow.vendorCss` is CSS for menus no capture has
(referenced from the flow as `pack:<id>/<file>`).

### Writes, effects, safe (for plans and generated resets)

```jsonc
"writes": [{
  "id": "save-skill",
  "what": "Save on the Save skill card creates a skill of her own in Plugins › Added",
  "on": { "kind": "click", "target": "Save", "near": "Save skill" },   // a plan step: click | press | type | switch
  "makes": "skill",
  "undo": { "open": "https://…/plugins?…", "steps": ["Click \"More actions for {skill}\"", "Click \"Delete\"", "Click \"Delete\""] },
  "check": { "open": "…", "look": { "absent": "{skill}" }, "expect": "Added doesn't list the skill." }
}]
```

- `on`: the plan step that writes (`kind` as in `packages/ai/plan.mjs`; `target`/`field` are text or `/regex/`).
- `undo.steps`: plan lines (the same plain steps a plan uses), run in the capture browser. `{name}` placeholders are
  what the run made (the skill, the task). `You: …` is a step for a person. `undo: null` with `irreversible: true` or
  a `note` says there is none. `{ "same": "<write id>" }` reuses another write's undo or check.
- `check`: read-only (`steps` may only look; `checkPack` refuses a check step that could change something). A
  private pack's `check.api` (GET) can say what it answers once the write ran: `made`, a status (`"200"`) or the
  number and true/false fields it names (`{ "stage": [1, 2] }`). An unattended run makes that check right after the
  write, in the app's own session; passing, the write's landing is strong. A reset's Check line from a check is read
  by its `look` (docs/engine/plan-format.md, "How a machine reads one"): `absent`, `text`, `rows` (a label's rows,
  only those the recording's start screen has) or `box` with `equals`, on its page (`open`, or navigation `steps`
  from the app's start), proven by `lands` (words on that page; an `absent` look needs them). A check with only
  `expect` words isn't one a run can read: `ai reset` lists its line under Needs you.
- `effects`: what a run leaves besides its writes (memories, tasks in Recent), each with a check; `leftOf`: the
  writes whose leftovers it is (a wrong line from it runs their undos too).
- `safe`: clicks that look like writes but only open a picker or a menu (Microsoft IQ's "Add content to …" opens the
  add picker; "Add to business plugin" is the write). `checkPack` holds each to that: `on` is a click, `what` says it
  "only opens" a picker or menu, it's never a sign-in or account control, and no write in the pack has the same step.
  `safeFor(pack, step)` finds one.

### The read-only guard (`guard`)

An unattended capture pass holds every request that isn't a read (GET, HEAD, OPTIONS), on every host, unless the
app's pack allows it: what an app sends while it's only looked at (Teams' presence and telemetry, a search that's a
POST). A planned write opens the app's own hosts for its one step.

```json
"guard": { "hosts": ["substrate.office.com"], "allow": ["teams.cloud.microsoft/api/telemetry", "/^POST [^ ]+/search$/"] }
```

- `hosts`: the app's own hosts besides its `match` (where its writes go, a frame's host included): a planned write
  opens them too, for its one step.
- `allow`: a host and path prefix (any method), or a `/regex/` over `METHOD host/path`. Never everything
  (`checkPack` refuses `*`, an empty prefix and a regex that matches anything). Lists come from measured traffic
  (method, host and path) and are read by a person before they go in. A tenant's own hosts and pre-release hosts go
  in a private pack, and a private pack's list replaces the public one, so it carries the public entries it needs.
- An entry can end in `when body /regex/` for a request that only reads when its body says so, e.g. a catalog
  listing with nothing typed in it: it passes only when the body matches, and a body the guard can't see is held.
  A GraphQL endpoint passes queries only: the body's document starts with `query` and has no `mutation` or
  `subscription` (Teams' people card badges, on Loki); a batch, a persisted query (a hash, no text) or no body is held.
  Each GraphQL call that passed keeps its operation's name in run.json's `guard.passed` (`operation`).
- `why`: one line per entry (the entry is the key): what the app sends it for, why it changes nothing, and what the
  app looks like with it held. An app that shows an error with a read held gets that read allowed, after review: a
  replica never shows an error the product doesn't.
- `stayHeld`: entries in the same form for what the app sends by itself to a host its writes use (a refresh, a
  subscription): held even while a planned write opens that host, so only the write's own calls pass in its step.
  Each has a `why` line too: how often walks saw it, and that it was held through them with nothing broken. A held one
  during a write is marked `duringWrite` in run.json.

`guardFor(cfg)` gives a demo's: `{ hosts, allow, stayHeld }` (its apps' and their packs', plus `capture.allow`).

### Services the app needs (`services`)

A service of the app's own that its recorded screens depend on, which can fail by itself (Microsoft IQ's plugin
service: answering 500, its add picker says "Plugins could not be loaded").

```json
"services": [{ "name": "IQ's plugin service", "match": "/^GET substrate\\.office\\.com\\/copilotconnectors\\/[^/]+\\/api\\/plugins$/", "start": true, "waitS": 90, "why": "…" }]
```

- `name`: what people read ("IQ's plugin service is failing (500). Try again later.").
- `match`: the one call, as a guard entry over `METHOD host/path`. The capture never calls it: it watches the page's
  own calls, and keeps every answer (run.json `services`).
- `start`: the page asks for it as the app starts. An unattended capture opens the app first, before the reset before,
  and again at its start screen; each time it waits up to `waitS` (90 s) for that call, and captures nothing unless it
  answers 2xx. A call with no answer at all reads "didn't answer (net::ERR_FAILED)".
- During a run, a 500 or a failed call to it stops the run before that beat's next write, and lists the step.
- `cards` (optional): the answer is a list a screen draws (IQ's add picker's plugins), and a plan step that clicks one
  of its rows needs that row in it. `steps`: a /pattern/ over a step's words that marks such a step (`/ Plugin$/`);
  `suffix`: the type label a row's words end with; `name`: a /pattern/ whose group is the row's name, for the message;
  `list`: what people call it ("IQ's plugin list"). Each 2xx answer is read for every such step's row (its name where
  the words start, its description the rest, whatever the fields are called). One missing stops the run before
  anything runs: "IQ's plugin list doesn't show <name> today. Try again later." The words are the plan's, never the
  pack's.

`servicesFor(cfg)` gives a demo's: `[{ app, name, match, start, waitS }]`.

### What a demo can leave out (`filters`)

An app's own data a demo can leave out of its replica without changing the tenant (reset.md's `## Leave out`): the
capture browser filters it before the page draws it (`packages/capture/leave-out.mjs`). A pack names where the items
are; which items is the demo's alone, never the pack's.

```json
"filters": [
  { "id": "peek-messages", "why": "…", "url": "*://substrate.office.com/search/api/v1/suggestions*",
    "match": "/^POST substrate\\.office\\.com\\/search\\/api\\/v1\\/suggestions$/",
    "items": "Groups[Type=Message].Suggestions", "fields": ["From.EmailAddress.Address"],
    "refs": [{ "list": "LayoutHints.BestMatchSuggestions", "by": "ReferenceId" }], "shows": "Subject" },
  { "id": "team-tree", "kind": "dom", "why": "…", "list": "[role=tree] [role=treeitem][aria-level=\"2\"]" }
]
```

- `url`: where its responses come from, as the browser's request patterns write it; `match`: the one call, as a guard
  entry over `METHOD host/path`.
- `items`: where the item lists are, dotted keys, each optionally `[*]` (every element) or `[Key=Value]`. Its first
  key must be a list, or the response isn't the one the pack knows (the run stops before that app's screens).
- `fields`: the item's fields, any of which equal to a demo's value (exact, case aside) leaves it out.
- `refs`: other lists that name items (`by` a field): a left-out item's entries go too, so nothing dangles.
- `shows`: the item's field whose text must then be on no saved screen (else the value).
- `kind: "dom"`: a list the app draws from its own store (no response carries it): `list` selects its items, each
  matched by its own name; matching ones (and what's under them) are marked and hidden, never removed. Flow lists
  only, where a hidden item leaves no hole.

`filtersFor(cfg)` gives a demo's: `{ "<pack>:<filter>": { ...filter, pack, app, hosts } }`.

### Your own status (`ownStatus`)

Where the app shows the signed-in person's own status, which a replica keeps (Teams' avatar: "Your profile, status
Available for …"). An unattended run reads it before it saves a screen of the app, and stops rather than save
another status (docs/recorder.md, "Your own status").

```json
"ownStatus": { "why": "…", "role": "button", "name": "/^Your profile, status (.+?)(?: for |$)/", "expect": ["Available"], "waitS": 90 }
```

- `name`: a /pattern/ over the control's name, by the reader's rule (`controlOf`); its group is the status. `role`:
  the control's role.
- `expect`: what a save may show when the recording has none (a recording's start screen of the app wins).
- `waitS`: how long a wrong status is read again before the run stops (90 s).

`ownStatusFor(cfg)` gives a demo's: `[{ app, pack, label, name, role, expect, waitS }]`.

### Her own presence (`presence`)

Where an app's status for the signed-in person comes from, so the capture browser can show her as the recording does
(Available) whether or not she's at her computer: `[{ id, url, match, why }]`, `url` a browser request pattern for its
answers and `match` an anchored guard entry over `METHOD host/path`. Only with `ownStatus` (the status it reads as).
In those answers, her own entry (the one naming the signed-in account's object id, read at run time, never stored)
gets that availability and activity; nobody else's changes, and the request goes out as it is.

```json
"presence": [{ "id": "getpresence", "url": "*://teams.cloud.microsoft/ups/*", "match": "/^POST teams\\.cloud\\.microsoft\\/ups\\/[a-z]+\\/v1\\/presence\\/getpresence\\/?$/", "why": "…" }]
```

`presenceFor(cfg)` gives a demo's: `[{ app, pack, rules: [{ id, url, match }] }]`.

### Notices (`notices`)

What the app shows for a while that a replica must never keep (Teams' "Loading latest updates… in the meantime, you
can still send and respond to messages"). An unattended run waits for one before it saves a screen of the app, closes
it with its own button, and stops rather than save it (docs/recorder.md, "Notices a replica never keeps").

```json
"notices": [{ "words": "Loading latest updates", "why": "…", "close": "/^(close|dismiss)/i", "waitS": 60 }]
```

- `words`: the notice's own, as the page shows them (in its text).
- `close`: a /pattern/ over its close button's name (aria-label, title, else its text).
- `waitS`: how long a save waits for it to go before closing it (60 s).

`noticesFor(cfg)` gives a demo's: `[{ app, pack, label, notices: [{ words, close, waitS }] }]`.

**Public and private.** Product behavior goes in these public packs. Tenant values (organization, plugin and item
names, IDs) never do. An API undo goes in a private pack: `{ "api": { "use": "<apis name>", "method", "path" } }`,
with `apis.<name>` naming the page that signs in (`open`), the host (`host`, or `hostPattern`) and, when the page
around it calls that host too, the frame's host whose calls to use (`from`: IQ's Power BI frame, not its portal); the
capture pass calls it from that page or frame, with the Authorization it sends, held in memory for the one call. A
`check.api` GET runs the same way, with the guard as it is. A path's `{placeholders}` are one segment each, filled from the demo's `apps[].values` (its IDs)
and the run's results. An API undo's `find` (`{ use, path, list, name, id, as, by, where? }`, a GET) lets the reset
before undo the script's own leftovers with nothing a run recorded: the items of the answer's `list` whose `name`
is one of the reset's `Names:` (what the writes made, `by`: `task`, `skill`), and whose `where` fields match,
each undone with its `id` as `{<as>}`. Only their ids leave the page. Packs never hold credentials or tokens
(`checkPack` refuses them).

## Private packs

`STUNTDOUBLE_PACKS` (a path list) or `~/.stuntdouble/packs/<id>/pack.json`. A private pack merges over the built-in
one with the same id: objects merge, lists replace, `null` removes, and `rules`, `writes`, `effects` and `safe` merge
entry by entry by `id` (`{ id, off: true }` removes one). What lives only there: the GitHub Copilot app's message
allow-list and native-call defaults per app build, pre-release hosts (IQ's daily ring), undocumented API undos.

## The API

`index.mjs`:

| | |
|---|---|
| `packs()`, `loadPacks({ dirs })`, `resetPacks()` | every pack, built-in then private |
| `packFor(urlOrMatch)` | the pack for a page or frame URL |
| `packForName(text)` | the pack a talk-track line names ("In the admin center…"), longest name first |
| `packsForDemo(cfg)` | `{ <demo app id>: pack }` by each app's `url`, then `match`; `apps[].pack` names one or is `false` |
| `activePacks(cfg)` | the packs a build uses (less `packs.off`, apps with `pack: false`; `packs: false` is none) |
| `applyPacks(cfg)` | recording settings: `{ record, used }` (below) |
| `themePack(app, theme)`, `platformPack(app, platform)` | a theme or platform pack, by demo app id or pack id |
| `writeFor(pack, step, field)` | the write a parsed plan step makes, or null |
| `safeFor(pack, step, field)` | the safe entry for a plan step (it only opens a picker or menu), or null |
| `guardFor(cfg)` | the read-only guard's `{ hosts, allow, stayHeld }` for a demo (its apps' packs, plus `capture.allow`) |
| `servicesFor(cfg)` | the services a demo's apps need, from their packs (`[{ app, name, match, start, waitS }]`) |
| `filtersFor(cfg)` | what a demo's apps can leave out, from their packs (`{ "<pack>:<filter>": filter }`) |
| `ownStatusFor(cfg)` | where a demo's apps show the person's own status, from their packs (`[{ app, name, role, expect, waitS }]`) |
| `noticesFor(cfg)` | the notices a demo's apps show that a replica never keeps, from their packs (`[{ app, label, notices }]`) |
| `presenceFor(cfg)` | where each of a demo's apps gets her own presence from, for the capture browser to show her as the recording does (`[{ app, rules }]`) |
| `checkPack(pack)` | what's wrong with a pack (empty when it's fine) |

`build.mjs`: `flowPacks(flow, cfg)` / `flowDefaults(flow, appPacks)` (flow compile and the build; running twice
changes nothing), `htmlPasses(packs, { off })` (the build rules as data, for core's text rules), `packPath(ref)`.

`draft.mjs`: drafts a pack from a new app's first capture (below).

### What the recorder calls (stage D)

```js
import { applyPacks } from '@stuntdouble/apps';
const { record, used } = applyPacks(demoCfg);   // demo.json under it always wins
```

`record` is the demo's `record` with, from each app's pack:

- `busy`, `ignore`: joined (demo first).
- `groups`, `streamMinMs`, `streamMaxMs`, `settleMs`: only when the demo has none.
- `autoPerApp`: `{ <app>: { hoverMax, clickMax, maxS, zoom, groups, chips } }` (the demo's per-app values over the pack's).
- `hoverDelayMs`: `{ <app>: [min, max] }`, how long the app takes to show a hover card.
- `zoomsPerApp`: `{ <app>: [110, 125, …] }`, the zoom levels to capture for an app that reflows by script.
- `skipFrames`: frame URL patterns never captured.

Per pack, `start.signIn` (hosts and a hint) and `start.ready` (what shows when the app has loaded) are for preflight.

## Drafting a pack for a new app

```
node packages/apps/draft.mjs --raw ~/.scenecast/<demo>/raw --match sentry.io --out ~/.stuntdouble/packs/sentry
```

It reads the first capture and writes a pack with what it can tell for sure: the match and start page, the app's
name (from the page titles, or the host: never an organization or project a title names), the design system and
whether it themes by `prefers-color-scheme`, and token attributes to strip. Everything else is a candidate under
`draft` to confirm: frame hosts, busy markers, relative times, step-group buttons, script-placed popups, fixed parts,
CSS the capture lost (it needs a repair map), and controls that write. `checkPack` then lists what's still needed.

## Tests

`node --test packages/apps/apps.test.mjs` (in `npm run test:unit`). `packages/selftest/asset-build.mjs` checks the
build applies a pack's rules to a framed GitHub page the same in the JavaScript and Rust build paths.
