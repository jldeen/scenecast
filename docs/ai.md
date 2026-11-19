# AI-assisted recording

Presenters don't need to know the demo's beats. When you make a **New demo**, Scenecast asks how:

| | What you do | What GitHub Copilot does |
|---|---|---|
| **Record for me** | Say what the demo should show (one line is enough), or give it your notes, a doc, an email or a script (a RunLines `.sk` too). Read the plan, change anything, **Approve and record**. Say yes when it asks. | Drafts a plan from your words and each app's start screen: beats, the clicks and typing, the prompts, what to say. Then clicks through in your own signed-in browser, through the recorder extension, while the recorder captures every screen and side state. It waits for AI answers to finish. Afterwards it writes the beats, the talk track, the focus points and your presenter guide from what actually happened, and the checks run. |
| **I'll click, you script it** | Click through once with the recorder on, without knowing the beats. | Writes the beats, the talk track, the focus points and the presenter guide from the recording. |
| **Coach me** | Click through yourself. | Shows the next step and what to say, live: on the Record step and in a small **coach window** for your laptop screen (never on the stage). It follows a plan (drafted from your goal) and keeps up as you go; if you go your own way, it suggests what's next. Afterwards, the same as above. |
| **I know my demo** | Record it yourself and bring your own script (as before). | Nothing. |

## GitHub Copilot, through your own sign-in

The AI is **GitHub Copilot**, through your own GitHub account and its Copilot plan: no keys to hand out. On the
**Copilot** page (left side), **Sign in with GitHub** shows a code; enter it at github.com/login/device. That's it.

How: the [GitHub Copilot SDK](https://github.com/github/copilot-sdk) (`@github/copilot-sdk` 1.0.31), GitHub's
supported way for an app to use Copilot on a user's behalf. The sign-in is its device flow ("GitHub signed-in user"
in the SDK's [authentication docs](https://github.com/github/copilot-sdk/blob/main/docs/auth/authenticate.md)); the
credential is kept in the system's own store (Keychain, Credential Manager), in Scenecast's own Copilot folder, never
the Copilot CLI's. Requests use the model **Automatic** picks, or the one you choose on the Copilot page.

The SDK's runtime (about 80 MB a system) isn't in the installers: the first sign-in fetches it once from this
repository's [`copilot-runtime-1.0.31`](https://github.com/jldeen/scenecast/releases/tag/copilot-runtime-1.0.31)
release (GitHub works where npm is blocked; npm is the fallback) and checks its SHA-256 (in `packages/ai/copilot.mjs`)
before using it. It lives in the app's data folder (`~/Library/Application Support/Scenecast/ai` on the Mac,
`%LOCALAPPDATA%\Scenecast\ai` on Windows), with your settings.

## What Copilot sees (and what stays on your computer)

Only what each step needs:

- what the demo should show, and your material;
- the plan;
- for the screen at hand: its buttons, links and boxes by role and name, its headings, and, unless you turn it off
  (Copilot page: **Send the page's words**), its words. Never screenshots, never the recording itself.

Email addresses, IDs, tokens and web address queries are taken out first. Every request, exactly as sent, is kept
with the demo (`.out/ai/sent/`) and listed on its Record step under **What was sent to Copilot**. Recordings, replicas
and scripts stay on your computer, as before.

## Never without you

Record for me never sends, posts, approves, buys, deletes or changes a setting on its own. Any step that could (a
**Send**, **Approve**, **Save** or **Add** button, Enter in a message box, a switch or checkbox) is marked **ask first**
in the plan, and when it gets there it stops and asks: **Do it**, **I'll click it myself** (it waits until you have),
**Skip it**, or **Stop recording** (what was recorded is kept). Reading, searching, opening and typing a draft are
fine. When a screen isn't what it expected, it waits for it, then works out what to do instead, then asks you
(**I did it**, **Skip it**, or tell it what to do in plain words).

## The plan

`plan.md` in the demo folder, in plain words you can edit on the Record step:

```markdown
# Supplier delay

## Beat 1 · The question

- Type "Summarize the supplier delay on PO-450101" in "Message"
- Press Enter — ask first
- Wait for the answer

> I ask about the supplier delay on PO-450101.

## Beat 2 · Admin

- Go to admin
- Type "alpha" in "Search tools by name"
- Press Enter
- Click "alpha-6"
```

Steps: `Go to <app>`, `Click "<name>"`, `Hover over "<name>"`, `Type "<text>" in "<field>"`, `Press <key>`,
`Wait for the answer`, `Scroll down|up`, `You: <something only you can do>` (it waits for you). Anything else is read by
the AI when it gets there. `>` lines are what to say. The talk track it writes afterwards is the demo's `script.md`,
one beat per beat of the replica: edit it under **Script** like any script.

## For developers

- `packages/ai`: `copilot.mjs` (the SDK: runtime, sign-in, one question), `model.mjs` (the tasks and their prompts,
  redaction, the sent log; pluggable), `stub.mjs` (the deterministic stand-in), `plan.mjs` (the plain-words plan and
  what asks first), `draft.mjs`, `drive.mjs` (Record for me), `write.mjs` (the talk track from a recording),
  `coach.mjs`, `cli.mjs` (`scenecast ai …`, docs/cli.md).
- The recorder's `observe` command (`packages/recorder/outline-page.js`) gives the page as the AI sees it; the AI
  clicks, types and presses through the recorder's own `click`, `type` and `press` commands, so the extension (or the
  Playwright agent) captures it exactly as it would a person's clicks. The receiver serves the coach window (`/coach`).
- `crates/scenecast-app/src/ai.rs`: what the desktop app calls; the window's part is in `apps/desktop/ui/app.js`.
- Tests run on the stand-in (`SCENECAST_AI_MODEL=stub`): `packages/ai/ai.test.mjs` (the rules) and
  `packages/selftest/ai-modes.mjs` (all three modes on the fixture, through the extension, to a replica that passes
  its checks, with beats, a talk track, focus points and a presenter guide; in `npm test` on macOS, Windows and Linux).
  The desktop UI test runs Record for me in the app window. `node packages/selftest/ai-modes.mjs --real` runs Record
  for me on real Copilot (`SCENECAST_COPILOT_TOKEN`, or your sign-in; `SCENECAST_AI_GOAL` for the goal), locally.
- A demo or a test can plug in its own model: `SCENECAST_AI_MODEL=<file.mjs>` exporting `ask(task, input)`.
- Next: the SDK has moved to `@microsoft/copilot-sdk` 2.x; move to it once it's past the npm age policy on managed
  machines (7 days).
