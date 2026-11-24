# @scenecast/apps (becomes @stuntdouble/apps)

App packs: what each real app needs to be recorded, built and shown, written **once per app, never per demo**. The
second demo of the same apps needs no tuning. Data plus small pure helpers; no dependency on the other packages.

| Pack | Apps it matches | What it holds | Where it came from |
|---|---|---|---|
| `teams` | teams.cloud.microsoft, teams.microsoft.com | busy markers, zoom levels, reflow part, channel stick, chat-list drag, launcher tooltip and search-hint rules, 3 themes, writes (post, theme) | inv641, spike E, spike A, demo1-reset |
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
  write, in the app's own session; passing, the write's landing is strong.
- `effects`: what a run leaves besides its writes (memories, tasks in Recent), each with a check.
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
- `why`: one line per entry (the entry is the key): what the app sends it for, why it changes nothing, and what the
  app looks like with it held. An app that shows an error with a read held gets that read allowed, after review: a
  replica never shows an error the product doesn't.
- `stayHeld`: entries in the same form for what the app sends by itself to a host its writes use (a refresh, a
  subscription): held even while a planned write opens that host, so only the write's own calls pass in its step.
  Each has a `why` line too: how often walks saw it, and that it was held through them with nothing broken. A held one
  during a write is marked `duringWrite` in run.json.

`guardFor(cfg)` gives a demo's: `{ hosts, allow, stayHeld }` (its apps' and their packs', plus `capture.allow`).

**Public and private.** Product behavior goes in these public packs. Tenant values (organization, plugin and item
names, IDs) never do. An API undo goes in a private pack: `{ "api": { "use": "<apis name>", "method", "path" } }`,
with `apis.<name>` naming the page that signs in (`open`), the host (`host`, or `hostPattern`) and, when the page
around it calls that host too, the frame's host whose calls to use (`from`: IQ's Power BI frame, not its portal); the
capture pass calls it from that page or frame, with the Authorization it sends, held in memory for the one call. A
`check.api` GET runs the same way, with the guard as it is. A path's `{placeholders}` are one segment each, filled from the demo's `apps[].values` (its IDs)
and the run's results. Packs never hold credentials or tokens (`checkPack` refuses them).

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
