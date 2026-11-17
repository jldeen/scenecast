# __TITLE__ replica

A local, offline replica of the __TITLE__ demo, made with [replica-kit](https://github.com/jldeen/replica-kit).
Every screen is the real page, captured in light mode: the DOM with its CSS, fonts and images, with no scripts or
sign-in tokens. Clicks, typing and Enter move between those captures the way the app would, and answers replay from
their real streamed frames. Nothing touches the network. It runs the same way every time.

## Start it

```bash
replica serve --demo . --open
```

That serves `http://127.0.0.1:__PORT__/` and opens it in Chrome as an app window. Press **⌃⌘F** for full screen.

## Presenter keys

All keys use ⌥ (Option) and show nothing on screen.

| Key | What |
|---|---|
| **⌥0** | Reset: everything back to the start. |
| **⌥1 … ⌥9** | Jump to a beat (below). |
| __APPKEYS__ |
| **⌥← ⌥→** | Previous or next app. |
| **⌥P** | Types the scripted text into the field the presenter is in. Press Enter yourself. |
| **⌥N** | Does the screen's next scripted step. |
| **⌥F** | Zooms to the next focus point for the beat and draws its mark, like ZoomIt (`focus.mjs`). **⌥⇧F** goes back one. |
| **Esc** | While zoomed: erases the mark and zooms out. **↑ ↓** or the wheel zoom in and out a step. |

| Beat | Starts on |
|---|---|
| ⌥1 | (from flow.json beats) |

## The path

(One line per step of the demo, in order: what to click, what to type, what to hover.)

## Where it differs from the live product

- **Only the recorded path responds to clicks.** Other controls do nothing; scrolling, hovers and switches work.
- (Every difference, edit or composed part, with why.)

## Changing it

Most changes are tweaks: `replica text "<old>" "<new>"` (or an edit in `flow.overrides.mjs`), reload, `replica
quick`, `replica save "<what>"`. `replica release --push` once at the end. `replica status` says where things stand.
A new screen means a short recording (`replica record start`, only the new part, `replica record stop`). See the
kit's README.
