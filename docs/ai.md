# AI-assisted recording

Presenters don't need to know the demo's beats. When you make a **New demo**, Scenecast asks how:

| | What you do | What GitHub Copilot does |
|---|---|---|
| **Record for me** | Say what the demo should show (one line is enough), or give it your notes, a doc, an email or a script (a RunLines `.sk` too). Read the plan, change anything, **Approve and record**. Say yes when it asks. | Drafts a plan from your words and each app's start screen: beats, the clicks and typing, the prompts, what to say. Then clicks through in your own signed-in browser, through the recorder extension, while the recorder captures every screen and side state. It waits for AI answers to finish. Afterwards it writes the beats, the talk track, the focus points and your presenter guide from what actually happened, and the checks run. |
| **I'll click, you script it** | Click through once with the recorder on, without knowing the beats. | Writes the beats, the talk track, the focus points and the presenter guide from the recording. |
| **Coach me** | Click through yourself. | Shows the next step and what to say, live: on the Record step and in a small **coach window** for your laptop screen (never on the stage). It follows a plan (drafted from your goal) and keeps up as you go; if you go your own way, it suggests what's next. Afterwards, the same as above. |
| **I know my demo** | Record it yourself and bring your own script (as before). | Nothing. |

## Make it from my script

Already have your talk track? On the Record step, **Make it from my script…** and pick it: a Word document, Markdown,
a RunLines `.sk` file, or plain text with `Do:` and `Say:` lines. Scenecast reads your beats, your lines and what you
click in each, and makes the plan:

- each Do line becomes steps on the real controls, with your prompts typed word for word;
- each step says the screen it lands on;
- the steps that change something (send a prompt, save, add, certify) are marked, and approving the plan approves
  those, and only those;
- what each line points at becomes a focus point, framed the way you'd frame it:
  - things a line names together share one box: two rows of one list ("Contoso IQ … and my Supply chain disruption
    plugin"), or a step and the steps it goes on to;
  - a name it says frames the row it heads ("from Fabric IQ": **Fabric IQ · Semantic model**), and "my plugin" is the
    one you named before;
  - a section it names or describes ("the right people") frames its first card, and "every step" frames the list's
    heading and its first step;
- where the product isn't what your script says, it says so once (your script says **Approve** on a **Copy file**
  card; the product shows **Save skill**). Steps your script leaves out, it takes from the recording and marks. A
  search the recording made before a click (and that isn't a write) goes in as you recorded it, and the review lists
  it under **Added from your recording**, for information.

When the demo has been recorded before, the plan is checked against every recorded screen, so a new version of your
script takes minutes. A script written for presenting the replica works too: its ⌥ keys say where each beat starts.

When you're signed in, Copilot reads your script with the recorded screens and proposes each line's steps and what it
points at, so a script that only tells the story (no Do lines) gets steps too. Every step it proposes is put on the
real controls the same way as yours, and anything that doesn't fit is flagged. What it gets:

- your script;
- each screen's title, headings and control names;
- where each recorded step leads;
- the screens' words, only when **Send page text** is on (Settings → Copilot).

It takes one question to Copilot, about a minute, and the answer is kept: making the same plan again asks nothing.
Without Copilot, the plan comes from your Do lines alone.
**Approve and start** approves the plan exactly as it is: change it after that and it asks again.

Afterwards Scenecast writes `reset.md`: each change undone, the state your demo starts in (what's switched on or off,
the mode picked, the theme, as your first screens show it) set first, and a checklist that only looks. If a later
screen shows something switched that no step of your plan switches, it says which step to add. Once the demo is
built, the finish: your script for the presenter guide with its Do lines in presenter keys, ⌥1–⌥9 on your beats, the
focus points, and one page to look at (`.out/review/index.html`): every screen, the timings (how long each beat takes
to say against the time your script gives it), and anything that needs you. One walkthrough works the same way
(`scenecast ai plan --walkthrough recording.json`).

## GitHub Copilot, through your own sign-in

The AI is **GitHub Copilot**, through your own GitHub account and its Copilot plan: no keys to hand out. On the
**Copilot** page (left side), **Sign in with GitHub** shows a code; enter it at github.com/login/device. That's it.

How: the [GitHub Copilot SDK](https://github.com/github/copilot-sdk) (`@github/copilot-sdk` 1.0.31), GitHub's
supported way for an app to use Copilot on a user's behalf. The sign-in is its device flow ("GitHub signed-in user"
in the SDK's [authentication docs](https://github.com/github/copilot-sdk/blob/main/docs/auth/authenticate.md)); the
credential is kept in the system's own store (Keychain, Credential Manager) when the runtime can reach it. In the app
it often can't ("system keychain unreachable"), so it's kept in Scenecast's own Copilot folder instead
(`ai/copilot/config.json`, readable only by you), never the Copilot CLI's. **Sign out** removes it. Requests use the model **Automatic** picks, or the one you choose on the Copilot page.

The SDK's runtime (about 80 MB a system) isn't in the installers: the first sign-in fetches it once from this
repository's [`copilot-runtime-1.0.31`](https://github.com/jldeen/scenecast/releases/tag/copilot-runtime-1.0.31)
release (GitHub works where npm is blocked; npm is the fallback) and checks its SHA-256 (in `packages/ai/copilot.mjs`)
before using it. It lives in the app's data folder (`~/Library/Application Support/Scenecast/ai` on the Mac,
`%LOCALAPPDATA%\Scenecast\ai` on Windows), with your settings.

## When something goes wrong

The Copilot page shows the real error, with **Show the logs**: `scenecast.log` (the app) and `ai.log` (each sign-in
step and what GitHub answered, never a token) in `…/Scenecast/ai/logs`, and Copilot's own logs in
`…/Scenecast/ai/copilot/logs`.

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

Unattended (in the capture browser, nobody there: `ai record --unattended`), there's nobody to ask, so you approve
every write before it starts: the approval lists each one by beat and step, and the run does only those. Anything
else that could change something is held, and stops the run with a picture of where it was.

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
- Make it from my script: `packages/script/docx.mjs` (Word to Markdown, no dependencies), `talk.mjs` (a talk track's
  beats, Say, Do and Screen lines and prompts), `html.mjs` (a capture's controls and words, without a browser);
  `packages/ai/walker.mjs` (the recorded screens and where each step leads, the capture browser's interface),
  `from-script.mjs` (Do lines to steps, grounded, with writes, landings, differences and focus), `walkthrough.mjs`,
  `reset.mjs`, `make.mjs` (plan, approval, reset), `finish.mjs` (guide script, beat keys, focus points, the review),
  `landing.mjs` (what proves each step), `reground.mjs` (those proofs again, on the screens a live walk read today:
  `scenecast ai reground`).
  The plan's format: [engine/plan-format.md](engine/plan-format.md). App packs (`@stuntdouble/apps`) give each app's names,
  writes and their undos when they're there; without them, plain rules.
- The recorder's `observe` command (`packages/capture/outline-page.js`) gives the page as the AI sees it; the AI
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
