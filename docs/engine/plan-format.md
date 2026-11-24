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
2. **Any other step:** its plan's proof while that still proves it, else the first of new words (headings, then
   lines, then labels; the page's own before its frame), a control's state, what a box says, a control only this
   screen has, and words gone with the page's own words still there.
3. **Numbers last.** Words without a number first. A number that only identifies (`#2`, `PO-1001`) or is part of
   what nearly every screen of the site shows (`Microsoft 365 admin center`) doesn't count. Words with a number only
   when nothing else tells the screens apart, and then the review lists the step under **Needs you** ("A number that
   can change").
4. **Never:** what a reload, the clock or the computer changes (a time or a date, a duration, a size, a long number,
   a shortcut's keys like `⌘⇧B`); what's in a live region (a toast, a status: role `status`, `alert`, `log`,
   `marquee` or `timer`, `aria-live`, an `output`); what Copilot wrote as the recording ran (its answers, a heading or
   a button it named, the names it made up, and what's in a part of the page named by one); what another step types;
   words the screen's own captures show differently (its zoom levels and toggles: a greeting that changes on each
   visit); what's in a closed dialog.
5. **`still`:** the page's own words: not in a nav, an aside or its header, not what half the site's pages show, a
   heading first, no number, on the screen before and after.
6. **Nothing proves it:** the review lists the step under **Needs you** ("A run can't check this step").

The site's frame is what half its pages show or more: a site is the app's host, a page an address with all its
screens. The offline walker checks a step the same way (`walker.landed(at, step)`).

## Details under a line

`Focus:` says what the line points at (one per focus point, in order):

| Form | Points at |
|---|---|
| `"words"` | Those words on the screen. |
| `"a", "b"` | The box around all of them. |
| `the card around "words"` | The card, row, list or section holding those words (`card`, `row`, `list`, `item`, `section`, `button`, `pane`). |

Then, each after ` · `: `arrow` (with `n`, `s`, `e`, `w`, `ne`, `nw`, `se` or `sw`, where its tail goes) instead of a
rectangle; `via <step>` for a point one click or hover away (⌥F takes that step first, as `via` in
[flow-format.md](flow-format.md#focus-points-focusmjs)); `on <screen>` when the line's screen is known.

`scenecast script` turns these into focus points once the replica is built, checked where they land.

## Approval, and what runs on its own

Approving a plan approves its exact text: Scenecast keeps the SHA-256 of `plan.md` (`.out/ai/approved.json`), and any
edit after that needs approving again. A run without a person (the capture pass, `scenecast ai bench --yes plan`)
keeps to these rules:

- A step with `Writes:` runs only as the plan says it. If the step has to change (another control's name, or a
  `Differs:` on it), it asks first, or it's skipped.
- After any step in an app misses its `Lands on:`, that app's remaining writes are skipped and logged.
- A risky step without `Writes:` is skipped, unless it says `Safe:`. Signing in is never part of a plan.
- Each landing is recorded in `run.json` as `{ step, expected, got: { screen, url, text }, ok }`, matched on the
  words, since screen names only exist after capture.

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
  its own signed-in session with what its run made (`{taskId}`, `{skill}`), and the `Note:` has the steps by hand for
  when it can't. What a run leaves besides its writes (saved memories) is undone only when its check finds something.
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
`proveLandings(plan, walker, flags)` chooses each step's proof (`chooseProof()`), `holds(screen, lands)` checks one on
a screen the reader read (`true`, `false`, or `null` for none). `packages/ai/walker.mjs`: `landed(at, step)` (`{ ok,
why }`), `written(text)`, `unstable(text, app)`.

## Changes

- **2**: details under steps (`Writes`, `Safe`, `Undo`, `Lands on`, `Script`, `Differs`) and lines (`Focus`), all
  optional.
- **1** (Scenecast 0.5): beats, steps, lines, `— ask first`.
