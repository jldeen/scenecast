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
| `Writes:` | What the step changes, in plain words. Approving the plan approves these steps, and only these. The demo's reset (`reset.md`) undoes each one. |
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

## In code

`packages/ai/plan.mjs`: `parsePlan(text)` gives `{ title, beats: [{ title, steps, say, lines }] }`. Each step is
`parseStep()`'s, plus the details it has: `writes`, `undo`, `lands: { screen, text }`, `script`, `differs`. `say` is
still the lines' words; `lines` has the same lines with `focus: [{ texts, around, mark, dir, via, on }]`.
`formatPlan(plan)` writes it back. `writesOf(plan)` lists the approved writes.

## Changes

- **2**: details under steps (`Writes`, `Undo`, `Lands on`, `Script`, `Differs`) and lines (`Focus`), all optional.
- **1** (Scenecast 0.5): beats, steps, lines, `— ask first`.
