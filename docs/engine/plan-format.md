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
| `Lands on:` | The screen the step should end on: a captured screen's name, then optionally `· "words on it"`. The capture pass checks it. |
| `Script:` | The talk track's Do line it came from, when the plan words it differently. |
| `Differs:` | Where the product isn't what the talk track says. Shown once, when the presenter approves. |

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

Made from the plan's writes, in reverse (`scenecast ai reset`). The capture pass runs it before and after a run.

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

## Check

- chat: Added doesn't list the skill
  From: beat 2

## Needs you

- Beat 1: Press Enter: part of its undo is by hand (delete the task "Supplier delay" from Recent)
```

- **Undo**, per app: plan steps, run the same way as the plan's. `You:` is a step for a person. `Undoes:` says which
  writes the group undoes; `Note:` what the app pack says about it. `Undo with the app pack: <pack>:<write>` is a
  private pack's API undo, named and not written out (its host and IDs stay in the pack): the capture pass calls it in
  its own signed-in session with what its run made (`{taskId}`, `{skill}`), and the `Note:` has the steps by hand for
  when it can't. What a run leaves besides its writes (saved memories) is undone only when its check finds something.
- **Check**: read-only. Each line is something the screen shows, and none of them clicks anything that changes.
- **Needs you**: what the reset can't do on its own (an undo by hand, or one nobody has tried yet).

Names come from the captures (the task's title, the skill's name). Copilot can name things differently on each run,
so the capture pass fills in what its own run made.

`packages/ai/reset.mjs`: `resetFor(plan, { walker, packs })`, `formatReset(r)`, `parseReset(text)` (its Undo as a plan,
and its checks).

## In code

`packages/ai/plan.mjs`: `parsePlan(text)` gives `{ title, beats: [{ title, steps, say, lines }] }`. Each step is
`parseStep()`'s, plus the details it has: `writes`, `undo`, `lands: { screen, text }`, `script`, `differs`. `say` is
still the lines' words; `lines` has the same lines with `focus: [{ texts, around, mark, dir, via, on }]`.
`formatPlan(plan)` writes it back. `writesOf(plan)` lists the approved writes. `packages/ai/make.mjs`: `approve(demo)`
and `approval(demo)` (whether `plan.md` is still the text that was approved).

## Changes

- **2**: details under steps (`Writes`, `Safe`, `Undo`, `Lands on`, `Script`, `Differs`) and lines (`Focus`), all
  optional.
- **1** (Scenecast 0.5): beats, steps, lines, `— ask first`.
