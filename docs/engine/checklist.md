# Fidelity checklist

The real-vs-replica fidelity loop (find and fix differences, state by state) is `scenecast fidelity` (docs/cli.md);
run it before the checklist.

Every replica gets the same checks before it goes on a stage. `scenecast check` runs the automatic ones (it starts
the replica server if it isn't running) and writes `.out/fidelity.md` and `.out/fidelity.json`. Each item passes
(✅), fails (❌), warns (⚠️, look at it), is skipped (➖, nothing to check) or is for a person (👤).
`--only id,id` or `--skip id,id` picks items.

**Fast and in parallel.** The replica runs on a fast clock (`?speed=10`: hover delays, stream pace and timers are
10× shorter) and the items run side by side in up to `--jobs` browsers (default: CPUs − 2, at most 6). On the kit's
fixture the full checklist takes about 25 s (168 s before 1.3.0). Each item's time is in `fidelity.json`.

**Full or quick.** The full checklist is for a release (`replica release` runs it). While changing a demo, use
`replica quick` (`fidelity --quick`): it fingerprints what each screen serves (its capture, the streams that end on
it, its app's layout and hovers, the beats) against the last passing run (`.out/check-base.json`) and checks only
the screens that changed: transitions, composer and render on those, lists, clicks, groups and chips that live
there, hovers for an app whose hovers changed, keys if the beats did. It skips two-run, zoom, drags, reset and the
contact sheet. Focus points run for screens that changed, or all of them if `focus.mjs` or the beats changed. A
wording tweak on one screen: about 10 s. Nothing changed: about 2 s. `--states a,b` checks the
named screens the same way.

| Id | Check | Fails when | Usual fix |
|---|---|---|---|
| `secrets` | Secret scan of the demo folder | Any JWT, bearer token, GitHub/AWS/Google/Slack/OpenAI-style key, Azure account key, private key, signed URL parameter with a value, password in a URL, or a `<script>` in a capture. | `replica build` scrubs most; find where the rest came from (a capture script, an override) and remove it. Never commit around it. |
| `render` | Every screen of the path renders (`.out/render/<state>.png`) | A screen throws, or doesn't render. | Look at the picture; usually a missing capture or a broken override. |
| `cold-start` | Three fresh clones (the files git keeps, or would keep), each with its own server and a browser that has never seen the replica | A first run's DOM differs from the warm two-run's, pixels differ by 0.01% or more, or there's an error, console message or failed request (a file that isn't in the repository). Not in `--quick`. | A missing file: commit it (check `.gitignore`). A difference only on a first start: something depends on timing (fonts still loading, styles added at a hover): an engine bug, report it with the demo. `--cold N` sets the number of clones. |
| `two-run` | The recorded path, twice, in parallel, in headless Chrome at the demo's viewport | A screen's DOM differs between runs, pixels differ by 0.01% or more, a step lands on a different state than recorded, a step's element isn't there, or there's an error, console message or off-site request. | A timer or date in a capture (edit it out), a hover left open (the path parks the pointer), a missing asset (recapture). |
| `light` | Light mode | A capture was recorded with `prefers-color-scheme: dark`, or a replica screen reads dark. | Set each app's theme to **Light** (not System) and record again. |
| `transitions` | Every recorded control, from its own screen | A click, Enter, typing or Escape lands on another state, or its element isn't on screen. On the recorded path: panes closing and reopening, the send arrow. | A matcher that finds a different element (`nth`, `in`), or a state recorded twice (merge in overrides). |
| `composer` | Cursor, ⌥P, send | The cursor isn't in the field the real app focuses (`focus`), ⌥P doesn't reach the typed state, or the send arrow sends an empty box. | Add `focus` for screens that put the cursor in a field; check `fill` values. |
| `keys` | Presenter keys | ⌥0–⌥9 don't land on their beats, or an app key doesn't switch. | Fix `beats` in overrides. |
| `focus` | Focus points (`focus.mjs`), each reached with ⌥F on its first screen, twice; reverse focus is also checked | A point isn't found, its zoom passes the zoom factor, its mark isn't on screen with an 8% margin (or, where the page puts it against the screen's edge, at least on screen), Esc leaves it zoomed, or a second run lands differently. Then: a beat key and ⌥F don't start at that beat's first point on screen, ↑/↓ don't step the zoom, or ⌥0 leaves it zoomed. Skipped with no points. | A text that isn't on that screen (check `states`, or the wording after an edit); a target too big for the screen (point at part of it, or `union` of two smaller parts); `beat` (the key that lands just before it). |
| `lists` | Virtualized lists in full | Fewer rows than captured, or the last row doesn't scroll into view. | `replica record side list` on that screen; pass `sel`/`row`/`index` if it picked the wrong list. If something resized the window after the list was placed (a headless run), the rows are lost: recapture. |
| `zoom` | Every screen at each zoom in `demo.json` (50–200%) | Errors, or a screen's field off screen. Warns when the page scrolls sideways or differs from the real page at that zoom by more than 3%. Writes `zoom-sheet.png`. | `replica record side zoom` on screens whose layout changes by script; `layout` rules for what the app re-places (pin, set, gridfit). |
| `clicks` | Panes, sections and menus (from `record side clicks`), resting on each control first (its hover showing) | A control doesn't open in the replica on its screen, doesn't close the real page's way (Escape, again, a click elsewhere, a control in its place, by itself), leaves the page different after closing, or (a sticky pane) doesn't stay through a morph. Warns if no clicks were captured. Writes `clicks/click-sheet-NN.png`. | An unstyled popup: its styles loaded late (see vendorCss in the flow format). A control that does nothing: its shape differs on that screen (`clickFit` in the console). Wrong close: `restore` in `clickPages`. |
| `drags` | Resizing panes (from `record side drags`) | A handle changes nothing, follows the pointer when the real one waits for release (or the other way), stops at other limits than the real page, or loses its size after a morph. | Recapture the drag audit; edit the rule in `flow.overrides.mjs` (`drags`). |
| `groups` | Step groups (from `record side groups`) | A collapsed group on a screen of the path doesn't open with its list, or the page differs after closing it; or a group opened while an answer is still coming in isn't open (with its list) when the answer ends. | No list: capture the group open (`record side groups` on that screen), or check `groups.button` / `label` in demo.json. A group that closes mid-answer: its button has no `aria-controls` (it's matched by label, which changes as it counts). |
| `chips` | "+N" chips (from `record side chips`) | At a width where "+N" shows, it doesn't show every chip and become "Show less" (or the real label), doesn't stay so through a morph, or "Show less" doesn't put the page back. | A pane pinned at a fixed width doesn't narrow with the window: recapture the chips (and zoom) on a screen before any drag; check `rows` and `gap` in the rule. |
| `reset` | ⌥0 and a beat jump | After opening panes, menus, a step group and "+N", and resizing, ⌥0 or ⌥1 leaves any of them changed, or ⌥0's page differs from a fresh start. | An engine bug: report it with the demo. |
| `hovers` | Hover states | Fewer than 90% of the captured hovers show. Warns if any don't. Warns too if no hovers were captured. | The automatic pass covers every screen; a screen it capped (`record stop` says) gets `replica record side hovers`. |
| `contact-sheet` | Real vs replica, every screen of the path | It can't be made. Warns over 5% of pixels different. | Look at the pair: a missing font, a stale capture, a state that didn't settle before capture. |
| `manual-theme` 👤 | Theme set to Light, not System, in every app, before recording | | |
| `manual-look` 👤 | The contact sheet and zoom sheet looked over: nothing missing, cut off or out of place | | |
| `manual-pace` 👤 | The pace feels right on stage (`flow.pace`, try `?pace=`) | | |
| `manual-differences` 👤 | The demo's README lists every difference from the live product, every edit and composed part | | |
| `manual-rehearse` 👤 | Rehearsed on the venue display, full screen (⌃⌘F), with the presenter keys | | |

The checklist in one line each, for a run sheet:

- [ ] zoom variants, 50–200%
- [ ] hover states
- [ ] panes closing, sections collapsing, menus opening (clicks)
- [ ] panes resizing (drags)
- [ ] step groups, also mid-answer
- [ ] "+N" chips and "Show less"
- [ ] clicks right after resting on a control
- [ ] ⌥0 and jumps put every pane back
- [ ] virtualized lists captured in full
- [ ] composer and send behaviour
- [ ] light mode
- [ ] secret scan (fail on any token)
- [ ] two-run identical DOM
- [ ] cold start: three fresh clones, each identical on its first run
- [ ] focus points (⌥F) land on screen, the same every time
- [ ] real-vs-replica contact sheets
- [ ] README: path, keys, differences
- [ ] rehearsed on the venue display
