# Lessons from Demo 1

What the Ignite '26 Demo 1 replica taught, the hard way. The kit handles most of them; the rest are rules.

## Before recording

- **Pick the theme, set it explicitly (Light or Dark, not System).** System follows the Mac, which can flip
  mid-capture. The recorder records either one, and each screen keeps the theme it was captured in (the replica
  answers `prefers-color-scheme` as it was then). demo.json `"theme"` says which the demo should be in: a screen in
  the other is noted, and `fidelity` checks every screen against the theme it was recorded in. Never a refusal.
- **Chrome without the debugger bar.** Quit Chrome and relaunch it with `--silent-debugger-extension-api` on the
  presenter's profile. Clicking the bar's × detaches every tab from the automation: the recorder loses them all.
- **Ask before taking her Chrome.** Other sessions may be driving it. Message the coordinator first, and say when
  you're done.
- **Resets flip settings.** A reset script switches things off (plugins, features) so the show can switch them
  on. Record from a fresh reset and check every switch is where the show starts it, or the recorded start is wrong.
  Resets also leave traces in answers ("You already had a skill by that name"): take those out with `edits`.
- **Personal state changes what the product does.** A same-named skill or setting on the account can win over the
  one the demo is about. Record on the account exactly as the show uses it.
- **The Dock and other apps.** An auto-hidden Dock peeks out when a background app bounces. Bring such apps to the
  front once before recording a screen.

## While capturing

- **Menus that ignore Escape: never click a menu item as a fallback.** A capture script that closed a stuck menu
  by clicking "an item" ran a real action. Close with a neutral click elsewhere, or reload. The recorder never
  clicks for you except to replay the click the person made.
- **Autofocus is live-only.** The real app puts the cursor in its composer by script when a screen opens; a
  capture can't hold focus. The recorder writes `focus` from the focused field after the screen settles, and the
  replica puts the cursor there. Keep the Chrome window focused while recording, or it can't see the cursor.
- **Script-pinned composers.** Copilot's message box is fixed and placed by script over a placeholder. Captured
  pixels are only right at the captured size: add a `pin` layout rule.
- **Virtualized grids.** Only the rows in view exist. `record side list` scrolls through, keeps every row, and puts
  them back, so the replica scrolls through all of them (485 tools, 467 plugins in Demo 1).
- **Wait for the screen to settle.** Busy markers ("Working on it", a Stop button) mean an answer is still
  coming. Add the product's to `record.busy`, or a half-finished answer becomes the final state.
- **Pages that never sit still.** A clock, presence dots or "is typing" keep a screen from settling. Add their
  selectors to `record.ignore`, or each capture waits until `record.maxS`.
- **Sign-in pickers come back mid-run.** `pickAccount(p, account)` in a capture script clicks the account.
- **The clipboard is hers.** Anything that copies (a capture script pasting text, the replica's Copy button)
  overwrites the presenter's clipboard. Save it first and put it back after.
- **Styles that load with a menu.** Some menus bring their stylesheet when they first open, and some take it away
  when they close, so a snapshot of the page never has it and the replica's menu comes out unstyled. The click audit
  keeps every stylesheet a click brings in; Griffel rules come from any capture that has the same class; what's
  still missing goes in a `vendorCss` file (a library's published rules, or rules measured from the real page's
  screenshot), keyed to the menu's own classes.
- **Items still loading.** A menu caught a moment too early has a spinner where an item goes; `lateItems` swaps in
  the loaded item from another capture.
- **Panes she changes stay changed, until a reset.** A pane closed, a section collapsed or a pane resized stays that
  way through prompts, the way the product does; ⌥0 and beat jumps put them back. Check with `replica fidelity`.
- **A hover can move what a click changes.** Resting on a control can put something next to it (an action button,
  a highlight row), which shifts what its click opens or closes by one place. The replica takes the hover off before
  it matches a recorded click, and puts it back if the click does nothing; the fidelity check rests on each control
  before clicking.
- **Step groups count while they stream.** Their label changes ("1 step", "2 steps"), so an open group is kept open
  by its region's id. The product can also drop a group's list when the answer ends: capture it open
  (`record side groups`), or the build takes it from the last frame that still had it.
- **Labels repeat.** Two answers can both say "3 steps": lists are kept per screen.
- **Chips before drags.** A pane the drag audit resized keeps its width, so a narrower window won't bring up "+N"
  any more: run `record side chips` before `record side drags` on a screen.
- **Some panes resize only on release** (Teams' list). The drag audit tells live from release; trust it over how it
  looks.
- **Throwaway runs for parts the show needs.** When today's product shows something else than the script (a "Save
  skill" card where the takes had "Copy file"), capture the real part from a throwaway task, never approve
  anything there, and `compose` it in. Say so in the demo's README.

## Speed (what made Demo 1 changes take hours, and what the kit does instead)

- **A one-word change rebuilt every capture and ran every check at real pace.** Tweaks now go in
  `flow.overrides.mjs` and show on reload; `replica quick` checks only the screens they touched, at 10×. The full
  checklist (parallel, also 10×) runs once, at release.
- **Each new kind of interaction needed its own Chrome audit** (hovers, then clicks, then drags, then "+N", then
  step groups), each with an approval and a pause of the other sessions. The recorder now captures all of them on
  every new screen in the one recording pass. Ask for Chrome once per demo, not once per kind of side state.
- **Long turns with nothing committed lost hours to two network timeouts.** `replica save` after every step that
  works; `replica status` and `record start --resume` to pick up.
- **Scope crept.** "Audit the rest of the path" turned small asks into long ones. Do what was asked; list what
  else you noticed.
- **An audit can leave the page not quite as it was.** Dragging a pane back to its size left it pinned at that
  width, so later zoom and "+N" captures didn't narrow. The drag audit now puts back the attributes it changed,
  and the automatic pass runs drags last on a screen.
- **An audit can close what the screen was saved with.** Microsoft 365 admin's plugin details is a modal drawer over
  the Tools grid; the drag audit pressed a column separator under it, hit the backdrop, and closed the drawer. The
  next step's proof wasn't there. The drag audit now presses only a handle that's on top, and the put-back says when a
  dialog the screen was saved with is gone.
- **Headless only: clearing a window override shrinks the viewport**, and the next screenshot snaps it back
  mid-capture (a virtualized list redraws and drops the rows it placed). The recorder sets the viewport back
  exactly. Her real Chrome has no such override.
- **A fast clock changes what a pointer path does.** At 10× a hover delay is a few ms, so moving across a
  neighbour opens its card. The hover check goes straight to each target when the clock is fast.

## Cold starts

- **A first start can differ from every run after it**, and two runs in one browser never show it. Demo 1's fresh
  clone differed on its first run: hover styles were added at the first hover, so a pointer passing over a control
  on the way changed the page's `<head>`; and Chrome draws fallback fonts while web fonts load whenever it judges
  the network slow, even on localhost, which moved scroll offsets. The engine now puts hover styles in switched off,
  loads every font before the first screen, and redoes the layout until fonts stay loaded. The `cold-start` check
  runs three fresh clones in new browsers on every release, so the next one of these is caught before a stage.
- **A file that's only on this machine** (ignored by git, or never added) works on every run here and fails on a
  clone. The cold-start check copies only what git keeps.

## Building

- **Assets that come back as HTML pages.** An image or font URL can answer with a sign-in page or an error page
  (with live scripts). `process.mjs` drops those: the page shows what the browser showed, nothing.
- **Generated class names collide.** Fluent v8 (merge-styles) names classes by load order, so `root-236` means
  different styles in two captures. Variants and hover parts get their own prefix (`isolateClasses`).
- **Tokens hide everywhere.** JWTs in file-preview links, signed URL parameters, bearer headers in inline JSON.
  `process.mjs` scrubs, then fails on any left; `replica scan` checks the whole folder before a push.
- **Relative times stay as captured.** "2 min ago" is what the take said. Don't fake a clock.

## On stage

- **Only the recorded path responds.** Other buttons do nothing; scrolling, hovers and switches work everywhere.
  Say so in the README.
- **Presenter keys show nothing.** ⌥0 resets everything; ⌥1–⌥9 jump to beats; ⌥P types the scripted text, and
  she presses Enter herself.
- **Her name is Jessica** in every script, seeded record and screen, never "Jess".
