# Plan format (`plan.md`, version 2)

A plan is the demo in plain words: its beats, the steps to take in the browser and the lines to say. It's
`plan.md` in the demo folder. Copilot drafts it from a goal, from the presenter's talk track (`scenecast ai plan
--script`), or from one walkthrough (`--walkthrough`). The presenter reads it, changes anything, and approves it once.
Record for me and the capture pass run it.

Version 2 keeps every version 1 line as it was and adds **details**: indented `Key: value` lines under a step or a
line. A version 1 reader skips them (they aren't `- ` steps or `> ` lines), so a version 2 plan runs anywhere a
version 1 plan does.

```markdown
# Supplier delay

## Beat 1 · The question

- Go to chat
  Lands on: chat-start
- Type "Summarize the supplier delay on PO-450101" in "Message"
- Press Enter — ask first
  Writes: sends a prompt (a new chat)
  Lands on: chat-answer · "Kestrel moved the ship date"
- Wait for the answer

> Kestrel moved the ship date by six days.
  Focus: "moved the ship date by six days"

## Beat 2 · Keep it

- Click "Save" — ask first
  Script: Click "Approve" on the "Copy file" card
  Differs: this screen has "Save" on a "Save skill" card, not "Approve"
  Writes: saves the skill "supplier-delay"
  Undo: delete the skill "supplier-delay"
  Lands on: chat-saved

> Now I can share it with my team.
  Focus: "Share" · arrow sw
  Focus: the card around "Work IQ" · via Hover over "Work IQ"
```

## Steps and lines

As in version 1 ([ai.md](../ai.md#the-plan)): `## ` headings are beats, `- ` lines are steps, `> ` lines are what to
say, and a step that could send, save or change something says `— ask first`.

## Details under a step

| Detail | What |
|---|---|
| `Writes:` | What the step changes, in plain words. Approving the plan approves these steps, and only these. The demo's reset (`reset.md`) undoes each one. When an app pack knows the write, it ends with ` · <pack>:<write>` (`· m365-copilot:save-skill`); the app hides that part. |
| `Safe:` | Why a step that looks like a change isn't one, from the app's pack (`· <pack>:<id>`): "Add content to…" only opens a picker; Enter in a search box only filters. The step has no `— ask first` and runs on its own. |
| `Undo:` | How to undo it, when it isn't the plain opposite. The reset uses it. |
| `Lands on:` | The screen the step should end on (a captured screen's name), then what proves the step ran there: words on it, a control, a box's text, or words that are gone ([below](#what-proves-a-step-lands-on)). The capture pass checks it. |
| `Script:` | The talk track's Do line it came from, when the plan words it differently. |
| `Differs:` | Where the product isn't what the talk track says. Shown once, when the presenter approves. |

## What proves a step (`Lands on:`)

After the screen's name and ` · `, one proof, in plain words. Either part may be left out.

| Form | What a run checks on the page after the step | `step.lands` (parsed) |
|---|---|---|
| `"words"` | Its words include them. | `{ screen, kind: 'words', text }` |
| `control "Name"` | A control with that name is on it: a button, link, tab, option, switch, box. | `{ screen, kind: 'control', text: null, control, state: null }` |
| `control "Name" selected` | …and it's selected (`aria-selected="true"`). | `{ …, state: 'selected' }` |
| `control "Name" open` | …and it's expanded (`aria-expanded="true"`). | `{ …, state: 'open' }` |
| `control "Name" on` | …and it's checked or pressed (`checked`, `aria-checked="true"`, `aria-pressed="true"`). | `{ …, state: 'on' }` |
| `control "Name" off` | …and it isn't (an unchecked checkbox or radio, `aria-checked="false"`, `aria-pressed="false"`). | `{ …, state: 'off' }` |
| `box "Name" says "text"` | A box you type in (an input, a text area, an editable area) with that name starts with the text. | `{ screen, kind: 'box', text: null, box, says }` |
| `gone "words", still "words"` | Its words no longer include the first, and still include the second. The first were on the page before the step; the second, on it before and after, are the page's own (its heading, or a line that doesn't change between runs): it's the same page with something taken away, not a blank page, an error or somewhere else. | `{ screen, kind: 'gone', text: null, gone, still }` |
| (none) | Nothing: the review lists the step under **Needs you**. | `{ screen, kind: null, text: null }` |

- **The page's words:** what it shows in every frame (`innerText`), not what's in a closed dialog.
- **A control:** as below, the same rule the reader uses on a recorded page.
- **Comparing:** words, names and a box's text are compared lowercased, with quotes (`"“”'‘’`) and invisible
  characters dropped and runs of spaces as one space. A name is the whole name; a box's text is its start.
- **Quotes:** a value with a straight quote in it is written in curly quotes (`“He said "go"”`). `text` is only ever
  the words a run looks for in the page's words.

```markdown
- Click "Plugins"
  Lands on: picker-plugins · control "Plugins" selected
- Type "IQ" in "Search tools by name"
  Lands on: tools-typed · box "Search tools by name" says "IQ"
- Click "Close panel"
  Lands on: landing · gone "Use When", still "Our numbers"
```

### Controls, their roles and names

One rule, `controlOf(el, acc)` in `packages/core/lib/control-name.mjs` (`@stuntdouble/core`): Scenecast's reader uses
it on a recorded page, and a run sends it to the live page as it is (it's self-contained; its comment shows how). Plan
steps (`Click "Name"`) and proofs (`control "Name"`) name controls by it.

- **A control** is an `input` (not `hidden` or `password`), `button`, `summary`, `select`, `textarea`, an `a` with
  `href`, an editable area (`contenteditable` empty, `"true"` or `"plaintext-only"`), an element with `role` button,
  link, tab, menuitem, menuitemcheckbox, menuitemradio, option, treeitem, switch, checkbox, radio, textbox, searchbox,
  combobox or gridcell, a `row` or `listitem` with `tabindex`, or anything with `tabindex="0"`.
- **Its role** is its `role` attribute; else from its tag: an `a` with `href` is a link; `button` and `summary`, a
  button; `select`, a combobox; `textarea`, a textbox; an `input` is a checkbox, a radio, a button (`button`,
  `submit`, `reset`, `image`), a searchbox (`search`) or else a textbox; an editable area, a textbox; anything else,
  its tag.
- **Its name** is the first of these that isn't empty: `aria-label`; the words of the elements its `aria-labelledby`
  names (for each id, the first element with it), joined by a space; for an `input`, `select` or `textarea`, the
  words of its `<label>`s (`el.labels`: a label whose `for` is its id, or around it), joined by a space; its own
  words (`innerText`; not for an `input`, a `textarea` or an editable area); `placeholder`; `data-placeholder`;
  `aria-placeholder`; `title`; `alt`; for an `input` of type `button`, `submit` or `reset`, its `value` (never what's
  typed in a box).
  Each is cleaned first: invisible characters (zero-width spaces and joiners, direction marks) dropped, runs of
  spaces as one, ends trimmed. A name said twice in a row (`Share Share`) counts once, and a name is cut at 90
  characters.
- **Not counted:** what's hidden (`hidden`, `display: none`, `visibility: hidden`) and what's inside
  `aria-hidden="true"` or `inert`. A control in a closed `<dialog>` is read but never a proof.

### How Scenecast chooses a proof

From the recording, the way a run will read the page, for each step against the screen the plan was on before it (for
`Go to …`, the other app's). Every proof holds on the screen the step lands on and not on the one before. Rules-only
plans, Copilot's (after its answer is grounded) and walkthroughs all get the same pass.

1. **A Type step:** the start of its own words: in the page's words when the box is an editable area, else
   `box "Name" says "…"`. When the recorded screen has other words in that box, the step says so (`Differs:`): the
   recording can't show it, and a run checks it.
2. **Any other step:** its plan's proof while that still proves it, else the first of: the control the plan's next
   step clicks, when it's in a live region (an approval card: the next step needs exactly it); new words (headings,
   then lines, then labels; the page's own before its frame); a control's state; what a box says; a control only this
   screen has; and words gone with the page's own words still there.
3. **A Go to step** lands on one page of its site. When other recorded pages of the site show its proof too
   ("Status and details" is on every pull request's page), the words its page names itself by (in its title: the pull
   request's) that none of those pages show come first. An app that's one page with panels over it (one address) has
   nothing to tell apart.
4. **Numbers last.** Words without a number first. A number that only identifies (`#2`, `PO-1001`) or is part of
   what nearly every screen of the site shows (`Microsoft 365 admin center`) doesn't count. Words with a number only
   when nothing else tells the screens apart, and then the review lists the step under **Needs you** ("A number that
   can change").
5. **Words in a message after everything else.** Words that show only inside a message (a chat message, a post, a
   comment: an `article`) come after every other proof, `still` and `gone` included: a run can't tell the app's words
   there from what Copilot wrote (a review comment's heading). When only they tell the screens apart, the review
   lists the step under **Needs you** ("Words in a message"), unless it's a write its app pack checks: a run proves
   that by the pack's check.
6. **Never:** what a reload, the clock or the computer changes (a time or a date, a duration, a size, a long number,
   a shortcut's keys like `⌘⇧B`); someone's presence ("Your profile, status Available"); what's in a live region (a
   toast, a status: role `status`, `alert`, `log`, `marquee` or `timer`, `aria-live`, an `output`), but for the
   control the next step clicks (above); what Copilot wrote as the recording ran (its answers, a heading or a button
   it named, the names it made up, and what's in a part of the page named by one); what another step types; words the
   screen's own captures show differently (its zoom levels and toggles: a greeting that changes on each visit); what's
   in a closed dialog.
7. **`still`:** the page's own words: not in a nav, an aside or its header, not a skip link ("Skip to main content"),
   not what half the site's pages show, a heading first, no number, on the screen before and after.
8. **Nothing proves it:** the review lists the step under **Needs you** ("A run can't check this step").

The site's frame is what half its pages show or more: a site is the app's host, a page an address with all its
screens. The offline walker checks a step the same way (`walker.landed(at, step)`).

### Proofs on today's product (`scenecast ai reground`)

The product changes after it's recorded: a heading is renamed, a greeting is different. A live walk of the plan
(read-only, in the capture browser) saves each screen it reaches, read twice once the page is quiet, about a second
apart, and each app's start screen. `scenecast ai reground` chooses each step's proof again, by the rules above, on
those reads:

1. **It holds today and in the recording:** on the recorded screen and on every read of the step's screen today, and
   on none of the screens before it, the recording's or today's (the reads after the step before; before anything
   ran, the app's start screen). The plan's own proof stays while it does.
2. **Today only:** when nothing does, a proof on today's reads alone, marked: the product changed since the
   recording. Never words in a message (today's can't be told from Copilot's), words where the recording's captures
   differ (what the greeting says today), or words that change between the two reads; and never for a step the walk
   says needs a write it didn't make (`needs`: what isn't there may be that write's doing).
3. **Nothing proves it today:** the step goes on **Needs you**.
4. **When something other than the product may have broken a page,** the app's steps that don't land as planned
   from then on keep their proofs, and so does one that landed but whose proof would change. None of them gets a new
   proof, or one from today alone, and each goes on **Needs you** with its reason:
   - **The guard held a request** that isn't telemetry and that no pack has reviewed as staying held (`stayHeld`):
     a walk holds anything that isn't a read, and a page can lose part of itself for it (a list that never loads).
     Its kind is its method, host and path, with ids as `*`. It counts for the app it was for: the request's own
     `app` or frame, else the app whose hosts it went to (its address, its pack's `match` and `guard.hosts`), else
     the app of the step it was held in.
   - **A service the step's app needed answered 500 or more,** in the step's window (from its first input to the next
     step's), and isn't telemetry: from the step's start, so its own reads count too (the answer can come after them).
     A response for another app doesn't count.
   - **Today's screen shows an error the recording doesn't:** "couldn't load" (or "could not be loaded", "failed to
     load", "unable to load"), "check your connection", "try again", "something went wrong", or anything in an alert.
   - **An app lost words while nothing ran in it:** what its last read showed and its next one, after a Go to,
     doesn't.

   A page that's broken stays broken until it loads again (a new document of the app's, in the walk's `events`: `{
   kind: 'loaded', app?, host, at }`; a route change isn't one), else to the end of the walk.
5. **Not checked today:** a step behind a write the walk didn't make (or that needs one: a step it missed for want of
   one, the steps after that miss in its beat), one it missed, or one it didn't get to keeps its recorded proof,
   marked.

It writes `.out/ai/reground.md` (each proof before and after, and why; the steps that need you; what's missing and
what's extra since the recording, [below](#whats-missing-and-whats-extra); the steps not checked today),
`reground.json` and `plan.reground.md`. `plan.md` stays as it is. Its new proofs go in with `--adopt` (built after stage
F, [below](#approval-and-what-runs-on-its-own)); until then, adopting `plan.reground.md` means approving it again. A
walk is of one plan: re-grounding another is refused. `--plan <file>` names the plan the walk walked when it isn't the
demo's `plan.md` now.

The walk's files, in `.out/ai` (or `--walk <dir>`), as the live walk writes them: `walk.json` (a row per step: `{ step,
text, status, why, window? }`, `window` from the step's first input to its end; `guard.held`, each held request `{
method, host, path, at, app?, frame? }`; `inputs`, each thing the walk did `{ at, for }`, `for` naming its step; `net`,
each request that failed or answered 400 or more, `{ at, method, host, path, status | failed, app?, frame? }`;
`events`, each `{ kind, app?, host, at }`, `loaded` for a new document) and, in `walk-screens/`, `<beat>-<step>.reads.json.gz` (both counted
from 1) and `start-<app>.reads.json.gz`. Each is gzipped JSON, `[{ at, docs: [{ key, html }] }, …]`: the page read
twice, about a second apart once it's quiet. A read's documents are the page's own (`key: "main"`) and then each frame's
(by its host), as the recorder's serializer writes them (`packages/capture/serialize.js`, without CSS), so a box's
value, a checked box and open shadow roots are in the markup. A step whose screen was saved without them (only
`<beat>-<step>.json`'s words and controls) is listed as not reached. What the guard held while a step ran is
`<beat>-<step>.json`'s `held` (`[{ method, host, path }]`) when the walk gives it; otherwise it's the held requests from
the step's first input (else the last read before it) to its own last read.

### What's missing, and what's extra

**Missing since the recording:** on each screen the walk read, the words and controls the recorded screen has that both
of today's reads lack, leaving out what a proof never uses (times, keys, messages, Copilot's words, another step's
typing, live regions). Each goes in the first class that fits:

1. **Beyond the walk's view:** in a row the recording's capture scrolled to and put back (`data-d1-row`: a list that
   shows only the rows in view, which `packages/capture/flows/virtual-list.js` scrolls through), when no read today has
   the row. A walk doesn't scroll, so these aren't missing. The rows the page showed (no `data-d1-row`) compare with
   today's rows in view as any others do.
2. **Varies between runs:** someone's presence, or words in the page's own content that the recording's captures show
   differently (a greeting), even when the recording first shows them after a write.
3. **Made by a write the walk didn't make:** the recording first shows it, in path order, after that write (the app's
   last before it): on the write's own screen, at an address the app showed before the write, or in the app's frame.
   So is what's in a row named by words a write made (a skill it saved). A name with more after it ("…, unread") is
   first shown where its name is. Words in the app's frame that vary between captures are a write's when it explains
   them (a chat's title in Recent); else they vary too.
4. **A number changed:** the same words today but for a number ("Plugins: 486" → "Plugins: 529"). Each of today's
   matches one recorded, the one sharing the most numbers in the same places first. So do the rows a list says it has
   (`aria-rowcount`, else `aria-setsize`), when the same list today says another number.
5. **Renamed:** a control today, of the same role, has the recorded name and more after it, set off (", 99%
   remaining"), and the recorded screen has no control by that name.
6. **Missing:** the rest, each with what may have broken its app's page (item 4 above). These are the ones to look at.

**Extra since the recording:** what both of today's reads have and no capture of the screen in the recording has (its
own and its variants'), with the same exclusions, less today's side of what's renamed or a number that changed, words
in a place that varies between runs, and what describes a row the recording has only as one its capture put back (a
row's tooltip lives in a portal the capture doesn't copy). It's what a capture now would show that the recording doesn't: new teams,
test notes, other chats.

In both, a list is what the reader marks as one (a list, listbox, grid, table, tree, tablist, menu, radio group or feed;
`ul`, `ol`, `table`, `menu`), with its rows (an item, option, row, tree item, tab, menu item, radio or post; `li`,
`tr`). A row's name is its first words (not someone's initials before their name). What describes one row's element
(`aria-describedby`: a tooltip in a portal) is in that row. Its rows are one line:

- Rows gone (no read today has the row's name) or new (no capture has it): how many, the first five, and the list's
  first five on each side. What's in a row goes with it.
- What's gone from, or new in, rows that are still there: another line.
- Entries that start the same way ("Name: …", three or more): another line.

A row's own control, named by everything in it, counts as what's in it. The same line on several steps is listed once,
with its screens and steps.

## Details under a line

`Focus:` says what the line points at (one per focus point, in order):

| Form | Points at |
|---|---|
| `"words"` | Those words on the screen. |
| `"a", "b"` | The box around all of them. |
| `the card around "words"` | The card, row, list or section holding those words (`card`, `row`, `list`, `item`, `section`, `button`, `pane`). |

Words that hold a straight quote go in curly ones: `“Under our agreement, "the supplier pays."”`.

Then, each after ` · `: `arrow` (with `n`, `s`, `e`, `w`, `ne`, `nw`, `se` or `sw`, where its tail goes) instead of a
rectangle; `via <step>` for a point one click or hover away (⌥F takes that step first, as `via` in
[flow-format.md](flow-format.md#focus-points-focusmjs)); `on <screen>` when the line's screen is known.

`scenecast script` turns these into focus points once the replica is built, checked where they land.

## Approval, and what runs on its own

Approving a plan approves its exact text: Scenecast keeps the SHA-256 of `plan.md` (`.out/ai/approved.json`), and any
edit after that needs approving again. Its writes are approved with it, ahead of the run.

**How each step is proven is the rules' part, not hers** (the rule, built after stage F: stage F's first approval
comes after its re-ground):

- The approval binds `plan.md` without its `Lands on:` and `Differs:` lines, and `reset.md`, exactly: its steps,
  their typed words, its `Writes:` lines and the reset. Any edit to those needs approving again.
- Proof lines change only through `scenecast ai reground --adopt`. It refuses if any other line differs, and it
  records the new proofs' hash and the walk they came from.
- A run refuses proof lines that match neither the approved ones nor an adopted re-ground, and `run.json` records
  which set it ran.
- Why: she can't judge proofs by eye. The rules choose them, and a run stops before any write that a weaker proof
  can't support (below).

A run without a person (the capture pass) never asks mid-run: once she's away, it never waits on her. It keeps to
these rules:

- A step with `Writes:` runs only as the plan says it: its control found by its exact name. If the step has to
  change (another control's name, or a `Differs:` on it), the run stops before it. Only a run with her there may ask.
- **Before each write**, the landings in its app since its last write are all strong (below), and the page is the
  app's own (its address is the app pack's, not a sign-in page). Otherwise the run stops before it.
- **When a run stops before a write**, it keeps a picture and both reads of the page, runs the reset, and lists the
  step under **Needs you**.
- After any step in an app misses its `Lands on:`, that app's remaining writes are skipped and logged.
- A risky step without `Writes:` is skipped, unless it says `Safe:`. Signing in is never part of a plan.
- **A new demo from a script** (no recording yet): its first live pass stops before its first write and keeps the
  screens it reached, so the next pass has a recording.
- Each landing is recorded in `run.json` as `{ step, expected, got: { screen, url, text }, ok, strength }`.

### A landing on the live page

A run reads the page before each step and twice after it, once the page is quiet, about a second apart. A proof
holds on both reads after the step and not on the one before, with the exclusions above, the plan's own words
included: never Copilot's words, another step's typing, a time, or a live region's words.

| Strength | What proves the step | Example |
|---|---|---|
| **Strong** | The plan's own proof; the step's own control in its new state ("Show more X" now `control "Show less X" open`, and back); what it typed, in its box; the control the plan's next step needs, there now. After a write: its app pack's read-only check. | Click "Plugins", then `control "Plugins" selected`. |
| **Weak** | The page changed, in a way the plan doesn't name (new words, another control, words gone), or only by a number. | A panel opens with words the script never mentions. |
| **None** | Nothing a run can count on changed. | Escape when nothing was open. |

`packages/ai/landing.mjs`: `liveProof(step, { before, afters, next, typed, walker })` (`{ lands, strength, why }`,
from the reader's reads of the live page), `writeGate(landings, app)` (`{ ok, why }`, from the run's landings so far,
each `{ app, strength, wrote, step }`).

## The reset (`reset.md`)

Made from the plan's writes, in reverse, and from the state the demo's first screens show (`scenecast ai reset`). The
capture pass runs it before and after a run: Undo, then Set first, then Check.

```markdown
# Reset: Supplier delay

## Undo · Chat

- Go to chat
- Click "More actions for supplier-delay"
  Undoes: beat 2, Click "Save"
- Click "Delete"
- You: delete the task "Supplier delay" from Recent
  Undoes: beat 3, Press Enter; beat 1, Press Enter
  Note: do these steps 2 times, once for each

## Set first

- chat: "Notes" is picked (Chat | Notes)
  Set: "Notes" · chat-app:composer-mode
  Opens: https://chat.example.com/
  Seen: beat 1, chat-home

## Check

- chat: Added doesn't list the skill
  From: beat 2
- chat on chat-home: "Notes" is picked (Chat | Notes)
  From: start: beat 1, chat-home

## Needs you

- Beat 1: Press Enter: part of its undo is by hand (delete the task "Supplier delay" from Recent)
- Beat 3: "Sync" is off before Click "Manage all" and on after it, and no step turns it on: a run of your script won't
  show that. Add Click "Enable Sync" after it
```

- **Undo**, per app: plan steps, run the same way as the plan's. `You:` is a step for a person. `Undoes:` says which
  writes the group undoes; `Note:` what the app pack says about it. `Undo with the app pack: <pack>:<write>` is a
  private pack's API undo, named and not written out (its host and IDs stay in the pack): the capture pass calls it in
  its own signed-in session, its `{placeholders}` filled from the demo's values (demo.json `apps[].values`: which
  plugin, which section), else from what its run made (`{taskId}`, `{skill}`), and the `Note:` has the steps by hand
  for when it can't. What a run leaves besides its writes (saved memories) is undone only when its check finds
  something.
- **Set first**: the state the demo starts in, as the first screen that shows each thing has it, in the plan's order:
  what's switched on or off, the option picked (Chat | Cowork), and the theme. `Set:` is the control that changes it
  and the app pack's write for it (only when the pack knows one), `Opens:` where, `Seen:` the screen it's read from.
  The capture pass sets each one that isn't already, then checks it.
- **Check**: read-only. Each line is something the screen shows, and none of them clicks anything that changes. With
  the writes' checks come the start state's (`From: start: …`): the settings above, versions ("is version 1.4.9"),
  what a list of switches holds, the theme each app renders in, and what the demo points at on an app's first screen
  (not words its captures show differently, like a greeting that changes on each visit). `<app> on <screen>:` names
  the screen a check is read on, when Scenecast knows it (where a start state was seen, an app's first screen); the
  capture pass gets there by the plan's read-only steps. Without it, the check reads the app as the run finds it.
- **Needs you**: what the reset can't do on its own (an undo by hand, or one nobody has tried yet), and a state that a
  later screen shows changed with no step of the plan between: a run can't show it until the plan has that step.

Names come from the captures (the task's title, the skill's name). Copilot can name things differently on each run,
so the capture pass fills in what its own run made.

`packages/ai/reset.mjs`: `resetFor(plan, { walker, packs })`, `formatReset(r)`, `parseReset(text)` (`{ undo, set, checks,
needs }`: its Undo as a plan; each check `{ app, screen, text, from }`, `screen` null when the line has none).
`packages/ai/start.mjs`: `startState(plan, { walker, packs })` (`{ facts, changes }`).

## In code

`packages/ai/plan.mjs`: `parsePlan(text)` gives `{ title, beats: [{ title, steps, say, lines }] }`. Each step is
`parseStep()`'s, plus the details it has: `writes`, `undo`, `lands` (`parseLands()`: `{ screen, kind, text, … }`,
[above](#what-proves-a-step-lands-on)), `script`, `differs`. `formatLands()` writes a `lands` back. `say` is
still the lines' words; `lines` has the same lines with `focus: [{ texts, around, mark, dir, via, on }]`.
`formatPlan(plan)` writes it back. `writesOf(plan)` lists the approved writes. `packages/ai/make.mjs`: `approve(demo)`
and `approval(demo)` (whether `plan.md` is still the text that was approved). `packages/ai/landing.mjs`:
`proveLandings(plan, walker, flags, { checked })` chooses each step's proof (`chooseProof()`; `checked` is
`packChecked(packs)`, the writes its app packs check), `holds(screen, lands)` checks one on a screen the reader read
(`true`, `false`, or `null` for none). `packages/ai/walker.mjs`: `landed(at, step)` (`{ ok, why }`: on the screen its
`Lands on` names, with its proof holding there), `written(text)`, `unstable(text, app)`.
`packages/ai/reground.mjs`: `regroundPlan(plan, { walker, walk, reads })` (`{ plan, rows }`, a row per step with its
proof before and after and its `basis`: `both`, `today`, `none`, `suspect`, `write`, `missed` or `unreached`; `missing`
and `extra`, each entry with its class `cls`), `walkReads(dir)`, `formatReground(rows)`, `regroundCounts(rows)`,
`missingCounts(rows)`, `heldKind(request)`. `walker.captures(id)`: every capture the recording has of a screen. The
reader (`packages/script/html.mjs`) marks each item and control with the `list` and `row` it's in (`lists[at]` is the
list's name and role).

## Changes

- **2**: details under steps (`Writes`, `Safe`, `Undo`, `Lands on`, `Script`, `Differs`) and lines (`Focus`), all
  optional.
- **1** (Scenecast 0.5): beats, steps, lines, `— ask first`.
