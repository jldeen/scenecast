# The presenter guide (⌥G)

A second window for the laptop screen that follows the stage: the talk track word for word, the clicks, the
watch-outs, the time, a picture of what's on screen and what's next. The stage goes full screen on the projector; the
guide stays on the laptop, where only the presenter sees it. (Ported from replica-kit 1.6.0's presenter window.)

It comes from the demo's script, the same script that makes the focus points. The desktop app makes it when you press
**Find the focus points** under Script; on the command line, `scenecast notes` reads the script and writes
`presenter/notes.json`, `scenecast guide-shots` makes the pictures, and `scenecast notes --check` holds the script, the
guide and the replica to each other. Everything runs offline, from the replica's own server.

Before there's a script, every build makes the guide from the recording: each beat with a plain name ("Copilot: after
“…”") and its steps ("Type `…` (⌥P types it)", "Press Enter: the answer streams in", "Click Library"), without
pictures. A script replaces it.

## Presenting with it

In the app:

1. **Present** → **Start presenting**, with **Open the presenter guide on this screen too** ticked. The stage opens full
   screen in Edge or Chrome; the guide opens on the screen the app is on (the laptop's); the app steps aside.
2. If the stage came up on the laptop, move it: on the Mac, ⌃⌘F to leave full screen, drag it to the projector, ⌃⌘F
   again; on Windows, Win+Shift+→ moves it to the next screen. If the guide came up on the projector, drag it to the
   laptop.
3. **⌥0** (**Ctrl+Alt+0**) on the stage. The guide's dot says **In sync**.
4. Lost the guide? **Open presenter guide** in the app, or **⌥G** (**Ctrl+Alt+G**) on the stage.

From the command line: `scenecast present`, then **⌥G** on the stage, and drag the guide to the laptop screen.

From then on, the guide follows the stage. Press keys on the stage as always; the guide catches up.

The guide and the stage must be in the same browser (the same Edge or Chrome, the same profile): they talk over a
`BroadcastChannel`. The app opens both in the demo's browser and profile. An exported folder (opened from
`index.html`) has no guide: present from the app, or `scenecast present`, to have one.

## What it shows

| Part | What |
|---|---|
| Sync dot | **In sync** while the stage answers; **Not connected** when it doesn't (closed, reloaded, another browser). |
| Title | The talk's title. |
| Time | The beat's time window from the script, and a running timer. The timer stays at 0:00 until the stage leaves Start, then runs from the beat's script start time. It turns amber past the beat's end. **Reset** puts it back to the stage beat's start. |
| Beat | Its count (Beat 3 of 12) and its part, its title, and **On screen** (what the stage shows for it). |
| Say | The talk track, word for word. Alternative lines ("(If …)") are set apart. |
| Clicks | The script's Do lines, then the beat's ⌥F focus points in order. |
| Watch-outs | What to look out for on this beat. |
| On screen now | A picture of the screen the stage is on. |
| Up next | The next action (a beat key, →, or the script's first click), where it goes, and its picture. |
| Beat circles | Start, 1 … N, End. The first beat of each script part is set apart. |
| Back / Next | Read the beat before or after. |
| Keys | The presenter keys. On Windows they read **Ctrl+Alt+…**. |

## Keys

On the stage:

| Mac | Windows | What |
|---|---|---|
| **⌥G** | **Ctrl+Alt+G** | Opens the presenter guide. |
| **→** or a clicker's **Page Down** | **→** or **Page Down** | While the guide is open, on a screen where the next beat has no screen of its own (a title slide, a closing line): steps the guide to that beat. The stage stays. With no guide open, → does what it always did. |
| **←** or **Page Up** | **←** or **Page Up** | The same, back. |

In the guide (these only **browse**; the stage stays put):

| Mac | Windows | What |
|---|---|---|
| **→ Page Down Space**, **Next** | **→ Page Down Space**, **Next** | Read the next beat. |
| **← Page Up**, **Back** | **← Page Up**, **Back** | Read the beat before. |
| **⌥0 … ⌥9**, a beat circle | **Ctrl+Alt+0 … 9**, a beat circle | Read that beat. |
| **Esc**, **Back to live** | **Esc**, **Back to live** | Back to the stage's beat. |
| **Go to this beat on stage** | **Go to this beat on stage** | Moves the stage to the start of the beat you're reading, the way its beat key does. |

While browsing, a banner says what's going on: "Previewing beat 7 · stage is on beat 3".

Because ⌥G is the guide's, an app's own key is never G (nor F, N or P).

## Which beat the stage is on

**⌥0–⌥9** (**Ctrl+Alt+0–9**) set it. After that, each screen belongs to the beats whose run-through reaches it (from
the demo's beats and recorded path). A move (a click, an app key, ⌥N) keeps the beat if the new screen belongs to it,
or takes the next beat it belongs to. demo.json `presenter.screens` overrides this where it guesses wrong (below).

A script beat *n* is the replica's ⌥*n* when the demo has that beat. A script with more beats than keys, or beats
that don't line up with them, says where each goes in demo.json `presenter.beats`. A beat with neither a beat key
nor `go` has no screen of its own: it shares the screen the beat before ends on, and → steps the guide to it.

## The script

The guide reads the first of demo.json `presenter.script`, `presenter/script.md`, `presenter/script.txt`,
`presenter/script.sk`, `script.md`, `script.txt`, `script.sk` (the app keeps the script you paste or open as
`script.md`, `script.txt` or `script.sk`), or `scenecast notes --script <file>` (which also sets
`presenter.script`). It can be Markdown, plain text or a RunLines `.sk` file: the same files script to focus points
reads.

Times are ranges as written (`0:00–0:45`), or durations (`~40s`, `1 min`) added up from 0:00. Beat numbers are as
written when they run 1, 2, 3 …; otherwise beats are numbered in order.

### Markdown

```markdown
# LTG1189: Find it, fix it, ship it

# Part 1 · The bug · 0:00–5:00
Something broke in checkout. We find it.

## Backstage
- Sentry open on the issues list, light mode.
- Jira board filtered to LTG.

## 1. The ticket · 0:00–0:45
*Screen:* Jira, LTG-1189

**Say**
> A customer can't check out. Here's the ticket.
>
> It came in this morning.
> *(If the board is slow)* While that loads: it came in this morning.

**Do**
- Click the ticket.

**Watch**
- The board can take a second to load.

## 2. Sentry has it (0:40)
**Do:** ⌥2, then open the first issue.
> Sentry already has the error.
**If** the issue list is empty, press ⌥2 again.

## If something goes wrong
- **Trace viewer blank:** reload; it's beat 8.
- **Nothing responds:** ⌥0 and start the beat again.

## After the talk
- Close the window, ⌥0.
```

- `# Title`: the talk's title.
- `# Part 1 · Name · 0:00–5:00` and a paragraph: a part and its summary.
- `## Backstage …` (or Before, Setup, Prep): its list items are the Start step's clicks.
- `## 1. Title · 0:00–0:45`, `## Beat 1 · Title`, `## Beat 1: Title (0:45)`, or any other `##` heading starts a beat.
- In a beat: `*Screen:* …`; sections `**Say**`, `**Do**`, `**Watch**` (or `### Say` …); an inline `**Do:** …`.
- `> quotes` are said word for word. A blank `>` line splits paragraphs. `*(If …)* text` is an alternative line.
- `**If** …` is a watch-out for this beat.
- `## If something goes wrong` with `- **Label:** text` items: an item or sub-item that names "beat N" or
  "beats N–M" shows on those beats; the rest show on the Start step, read before the talk.
- `## After the talk`: the End step.
- When the file has no `>` quotes, plain paragraphs in a beat are the talk track.

### Plain text

```text
Title: LTG1189: Find it, fix it, ship it
Open Sentry on the issues list.

Beat 1: The ticket (0:45)
Screen: Jira, LTG-1189
A customer can't check out. Here's the ticket.
Do: Click the ticket.
Watch: The board can take a second to load.

Beat 2: Sentry has it (0:40)
Sentry already has the error.
```

`Title:` is optional. `Beat 1: Title (0:45)` lines start beats; `Screen:`, `Do:` and `Watch:` lines are what they
say; every other line is said. Lines before the first beat are the Start step's clicks. With no Beat lines, each
paragraph is a beat.

### RunLines (.sk)

```json
{ "title": "LTG1189",
  "rows": [
    { "time": "~40s", "narrative": "A customer can't check out.\nHere's the ticket.", "demo_actions": "[TICKET] Open Jira · Click LTG-1189" }
  ] }
```

Each row is a beat. Each line of its narrative is said. Its demo_actions, split at " · ", are its clicks; a leading
`[TAG]` is its title.

## demo.json `presenter`

```json
"presenter": {
  "script": "talk/script.md",
  "beats": { "10": { "jump": 9, "go": [["trace", "trace-snapshot"], { "app": "trace", "state": "trace-zoom", "morph": true }] } },
  "screens": [["sentry", "^sentry-issue", [3, 4]]],
  "shotWait": { "trace": 4000 }
}
```

- `script`: the script's path, from the demo folder.
- `beats`: a beat past ⌥9, or one not on its beat key: `jump` (the beat key), then `go`, screens to go to, each
  `[app, state]`, or `{ app, state, morph: true }` to morph instead of loading (panes and sizes stay).
- `screens`: `[app, a regex on the state, [beats]]`: which beats a screen belongs to, where the run-through guesses
  wrong.
- `shotWait`: `{ app: ms }`, extra time for `scenecast guide-shots` to let a slow screen settle.

## The pictures: `scenecast guide-shots`

Renders the "On screen now" and "Up next" pictures from the replica in headless Chrome (at the demo's viewport, saved
at half size) to `presenter/shots/`: each beat's starting screen (`beat-NN.png`), and the first screen it shows on
each other app (`beat-NN-<app>.png`), shown while the stage is on that app. `shots/shots.json` lists what each is of.

## Kept current

`scenecast quick` and `scenecast check` (and the app's checks) make `presenter/notes.json` again from the script
first, when the demo has a guide: a changed script, a new focus point or a moved beat start shows in the guide
without a separate step. The pictures are taken again when a beat now starts on another screen.

## The check: `scenecast notes --check`

Script ↔ guide ↔ replica. It's the `notes` item of the checklist too (`scenecast check`, and the app's checks before an
export); `scenecast quick` runs it only when the notes, the script, the pictures, the beats or the focus points
changed. `--as-windows` runs it as Edge on Windows (Ctrl+Alt keys). It fails when:

- `notes.json` isn't current with the script (the words differ): run `scenecast notes`;
- the guide doesn't show a beat's talk track word for word, its clicks, its focus points or its watch-outs;
- a beat's picture is missing, or isn't a screen that beat shows: run `scenecast guide-shots`;
- a focus point belongs to no script beat;
- in headless Chrome with the guide open, it doesn't follow the stage through every beat key; Back/Next move the
  stage; "Go to this beat on stage" doesn't move it to each beat; → doesn't step the guide over the beats with no
  screen of their own; or the timer doesn't start, run and reset.

## How it works

The replica's server serves the guide: `/presenter.html`, `/presenter/presenter.js` and `/presenter/presenter.css`,
from `packages/player/presenter/`. A demo's own `presenter/` folder is served first: `notes.json`, `shots/`, and, if it
needs one, its own copy of any guide file. The stage's side is `packages/player/app/presenter-module.js`, loaded on
every served replica.

The stage and the guide talk over a `BroadcastChannel` named `scenecast-presenter:<demo name>`, on the replica's own
origin: offline, in the same browser. The guide sends `{ t: 'hello' }` every second and `{ t: 'goto', beat }` for
"Go to this beat on stage"; the stage answers with `{ t: 'state', beat, app, state }`, and sends it again on every
move. No answer for a while and the dot says **Not connected**.

The app's **Open presenter guide** runs `packages/player/open.mjs`: the guide's address as an app window in the demo's
browser and profile, asked to open on the screen the app's window is on (`--window-position`, `--window-size`, and the
page moves itself there with `#place=x,y,w,h` when the browser was already running).
