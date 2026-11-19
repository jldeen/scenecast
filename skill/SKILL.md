---
name: scenecast-replicate-demo
description: Build or change an offline, deterministic replica of a live web demo with Scenecast (record it once in Edge or Chrome, build, check fidelity, match the script to focus points, edit, add the presenter guide, release), fast, by driving the scenecast CLI. Use when the user says "replicate a demo with scenecast", "make a scenecast replica", "record this demo for offline", "recapture the replica", "change the wording/date in the replica", "add the presenter guide", or "run the scenecast checks".
---

# Replicate a demo with Scenecast

Scenecast turns a live web demo into a replica for **live presenting**: every screen is the real page, captured
(its DOM, live CSS, fonts, frames), AI answers replay from their real streamed frames, every run is identical, and
ZoomIt-style focus points zoom to what each line of the script points at. It runs offline, in Edge or Chrome, on the
Mac and on Windows.

Most presenters use the **desktop app** (one window: New demo, Record, Build & check, Fidelity, Script, Edit,
Present, Export). This skill drives the same steps through the `scenecast` CLI, for an agent working in a demo
folder. The references next to this file: the [one-page guide](references/guide.md) (what the presenter sees), the
[CLI](references/cli.md), the [presenter guide](references/presenter.md), the [checklist](references/checklist.md),
the [flow format](references/flow-format.md) and the [lessons](references/lessons.md). Read the lessons before
recording.

**Getting the CLI.** `scenecast --version`. If it's missing: `gh repo clone jldeen/scenecast ~/git/scenecast && cd
~/git/scenecast && npm ci && cargo build --release -p scenecast-cli`, then use `~/git/scenecast/target/release/scenecast`
(`scenecast.exe` on Windows). It needs Node 20+ and Edge or Chrome. Run every demo command from inside the demo folder
(or pass `--demo <dir>`).

**Keys on both systems.** Presenter keys are **⌥** on the Mac and **Ctrl+Alt** on Windows (Edge keeps Alt for its
menus). Whenever you write a key for the presenter, give both: **⌥F** / **Ctrl+Alt+F**. `scenecast present` opens
Chrome on the Mac (**⌃⌘F** full screen) and Edge on Windows (**F11**); demo.json `chrome.browser` picks.

## The three rules that keep it fast

1. **Do what was asked, nothing more.** A wording change is a wording change: no audits, no recaptures, no full
   checklist per edit. If you spot something else, list it in your report.
2. **Quick checks per change, the full checklist once.** After each change, `scenecast quick` (only what the change
   touched, minutes at most). `scenecast check` (or `release`) runs everything once, before the replica goes out.
   Never run the full checklist to confirm a small fix.
3. **The browser is for new screens only.** The presenter's browser is the slow, shared resource. Use it only when
   the replica needs a screen, an answer or a control that was never captured. Never for wording, dates, beats,
   focus points or checks.

Commit after every step that works (`scenecast save "…"`). After any interruption, start with `scenecast status`.

## Time budgets

| Step | Budget | On the fixture (CI measures it) |
|---|---|---|
| A wording or date tweak, visible on reload | **< 2 min** | 0.1 s, served live, no build |
| `scenecast quick` (what the change touched) | **< 3 min** | 15–30 s |
| `scenecast build` (changed captures only) | **< 1 min** | 1–2 s |
| `scenecast release` (full checklist) | **< 10 min** | about 1 min |
| `scenecast preflight`, everything already set | **< 1 min** | under 1 s |
| Recording: the demo once, every side state on the way | **< 45 min** for a demo the size of Demo 1 | 2–3 min (12 screens) |
| `scenecast notes` + `guide-shots` | **< 2 min** | a few seconds |

If a step runs over its budget, stop and say so. Over budget usually means the scope grew (rule 1).

## Which workflow

- **Tweak** (most asks: wording, a date, a beat's start, a focus point, a line of the talk track): no browser, no
  rebuild. Go to [Tweak](#tweak).
- **New screen or recapture**: a short recording of just that part (preflight, `record start`, the new part,
  `record stop`), then the tweak loop.
- **New demo**: steps 0–7.

## Tweak

```bash
scenecast status                          # where things stand
scenecast text "by six days" "by a week"  # one wording or date change, live on reload
scenecast quick                           # only what it touched; < 3 min
scenecast save "wording: by a week"       # secret scan, commit
```

A focus point or a beat start: `scenecast edit` opens the replica in edit mode (dots, wording and dates, beat
starts; every change saved to `focus.json` and `flow.editor.json`), or edit `focus.mjs` / `flow.overrides.mjs` by
hand. Focus points made from the script follow wording changes on their own.

A change to the talk: edit the script (`script.md`, `script.txt` or `script.sk` in the demo, or `presenter/script.md`),
then `scenecast script <file>` if the lines that point at things changed, and `scenecast quick`: it makes the
presenter guide's notes again from the script and checks the guide.

`scenecast release --push` once at the end (the full checklist, then commit and push), not after every tweak.

## New demo

### 0 · Scope (ask, one question at a time, with ask_user)

- Which demo, and where its script or talk track is.
- The apps and their start URLs, and which tenant and account. No customer or tenant data goes into a public repo.
- Edge or Chrome, and which profile.
- The private repo to push to, if any.

### 1 · Scaffold (2 min)

```bash
scenecast new <demo-name> --title "<Title>" --app <id>=<url> --app <id>=<url>
cd <demo-name> && scenecast save "scaffold"
```

Each app gets a presenter key from its id (never F, G, N or P: those are focus, the presenter guide, next and fill).
Edit `demo.json` as needed: each app's `match` and `start`, `chrome.browser` and `chrome.profile`, `record.busy`
(what shows while an answer is still coming), `zooms`.

### 2 · Preflight (seconds when it's all set)

1. **Ask first** before taking the presenter's browser (the coordinator, or ask_user), and say for how long.
2. Once per browser: `scenecast extension`, then load `Documents/Scenecast/Recorder Extension` unpacked (`edge://extensions` or
   `chrome://extensions`, Developer mode, Load unpacked). See references/guide.md for the presenter's version.
3. `scenecast preflight`: receiver, browser and profile, recorder, each app's tab (open, on its start screen; its
   theme, light or dark, is said, never a failure). It fixes only what fails and never relaunches a running browser.
   Set each app's theme explicitly (Light or Dark, not System). Run it again until everything passes; nothing else.

### 3 · Record: one pass (< 45 min for a Demo 1-size demo)

```bash
scenecast record start            # refuses dark pages
scenecast record status           # after every action: wait for busy: false
scenecast record stop             # lists what each screen got; read its notes
```

The presenter runs the demo once, as on stage, in their own browser. After **every** action, wait until
`record status` says `busy: false` before the next. Every new screen's side states (hovers, menus, panes, step
groups, "+N" chips, zoom, long lists) are captured on the way. A missed side state is one command on that screen:
`scenecast record side hovers|clicks|chips|drags|groups|zoom|list --app <id>`. If the browser stops the
extension mid-recording, `scenecast record start --resume` continues from the last checkpoint.

Then tell the coordinator the browser is free, and `scenecast save "recording"`.

**The presenter doesn't know the beats?** Use the AI modes (docs/ai.md; GitHub Copilot through their own sign-in,
`scenecast ai status`): put the goal in `ai.json` (`{ "mode": "record", "goal": "…" }`) and any material in
`source.md`, then `scenecast ai plan` (show them `plan.md`; they approve or edit it) and `scenecast ai record`, which
runs it in their browser while recording and asks before every send or change (answer with `scenecast ai answer`
only what the presenter says). Or they click through once and `scenecast ai script` writes `script.md` from the
recording; or `scenecast ai coach` suggests each next step while they record. Step 6 then takes that script.md.

### 4 · Build (1 min)

```bash
scenecast build --from-raw && scenecast save "build"
```

Secrets and personal data are scrubbed on the way (`.out/scrub.json`); a credential stops the build. Read every
note it prints. Hand edits go in `flow.overrides.mjs`, with a line on why. Never edit `flow.json` or `manifest.json`.

### 5 · Fidelity (< 15 min)

```bash
scenecast fidelity                # real vs replica for every captured state; diagnoses and fixes; → .out/fidelity/report.html
scenecast quick
```

Every state should match the real product (within 0.5% of pixels) with the real font files. What's left is listed
with why; never put a screenshot in a page's place. Fallback (screenshot or video) scenes are for a screen that
truly can't be captured live, and every check flags them.

### 6 · Script, focus points and the presenter guide (30 min)

Put the presenter's script in the demo (`script.md`; Markdown with `>` quotes for the spoken lines and `##` headings
for beats, plain text, or a RunLines `.sk`; the formats are in references/presenter.md). Then:

```bash
scenecast script script.md        # each line on its screen, its focus points (focus.json), the line-to-screen and cue sheets
scenecast notes                   # the presenter guide's notes from the same script → presenter/notes.json
scenecast guide-shots             # the guide's pictures → presenter/shots/
scenecast notes --check           # the walk: script ↔ guide ↔ replica (add --as-windows for Edge on Windows)
scenecast quick
```

Look at `.out/script/sheet.html`: lines flagged "not on screen" need a dot (`scenecast edit`) or a different line.
Script beat n is ⌥n; a beat past ⌥9, or not on its beat key, goes in demo.json `presenter.beats`. Fix every failure
`notes --check` reports.

### 7 · Release

```bash
scenecast release                 # build, the full checklist (two runs, cold starts, zoom, focus, the guide), secret scan, commit
gh repo create <owner>/<demo>-replica --private --source . --push     # the first time only
```

After that, `scenecast release --push`. A cold-start failure is a file that isn't in the repository, or something
that only happens on a first start: fix it, never skip it.

## Presenting (what to tell the presenter)

In the app: **Present** → **Start presenting** (with the presenter guide ticked). The stage goes full screen on the
projector, the guide opens on the laptop screen; **⌥0** (**Ctrl+Alt+0**); the guide's dot reads **In sync**. On the
command line: `scenecast present`, then **⌥G** (**Ctrl+Alt+G**) on the stage and drag the guide to the laptop.

## Rules

- **Never click a menu item as a fallback** when a menu ignores Escape: click a neutral spot or reload.
- **Never approve, send or delete** anything in the real product while recording, beyond what the demo itself does.
- Don't change tenant settings beyond the demo's own reset. No tenant data in a shared repo.
- One theme per demo, set explicitly in each app (Light or Dark, not System); demo.json `"theme"` names it.
- Her name is **Jessica**, never "Jess".
- Report what still needs a person: running the demo while it records, judging the sheets, rehearsing on the venue
  display with the presenter guide on the laptop screen.
