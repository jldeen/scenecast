# The app's design

The look Jessica chose for the app: conference wayfinding, quiet. An ink rail like a signage panel, a white work area,
and every screen saying where you are (Record · Review · Present · Share) with one next step. Demos read like the
document keynote teams already use: a run of show, with a pre-show and the show's beats, each with its time and state.

It's a working tool: familiar controls, standard navigation, nothing decorative. The styles are
`apps/desktop/ui/app.css`; the font is bundled in `apps/desktop/ui/fonts/` so it works offline.

## Rules

- **One primary button per screen**, ink with a yellow arrow. Everything else is a secondary button or a link.
- **Yellow only means "you are here":** the current step, the current beat, the brand mark, the arrow in the primary
  button. Never a block of colour.
- **Hairlines, not shadows.** Panels are white with a 1 px rule. Shadows only on things that float (toasts, dialogs).
- **Plain words by default; Details for the technical view.** No ports, paths, profile folders, receivers or engine
  terms on a screen's default view. Each screen has a **Details** button with its folder, files, the matching command
  and **Copy diagnostics**.
- **Green only with proof.** A success says what was made ("Recorded 22 screens in 4 beats"); an error says what
  happened and offers one button to fix it (`apps/desktop/ui/errors.js`).
- **Mac and Windows are equal:** ⌥ or Ctrl+Alt, Finder or File Explorer, Trash or Recycle Bin, always for the system
  it's on.
- **Light mode.** The window is light on both systems.
- **Icons are drawn** (SVG, one stroke weight), never characters or emoji.

## Tokens

| Token | Value | Use |
|---|---|---|
| Ink | `#0E1A26` | Rail, primary button, text |
| Ink 2 | `#33414E` | Secondary text in tables |
| Muted | `#56626E` | Secondary text |
| Ground | `#F3F5F7` | The work area |
| Paper | `#FFFFFF` | Panels |
| Rule | `#DCE1E6` | Hairlines |
| Way | `#FFD100` | "You are here" only |
| Go | `#1F7A3A` on `#E5F1E9` | Ready, matches, on time |
| Hold | `#8A5200` on `#FFF1D1` | Needs a look, ran long |
| Stop | `#B42318` on `#FBE7E5` | Failed, Delete |

**Type:** Barlow 500–800 (SIL Open Font License, `fonts/OFL.txt`). Title 32 px bold, subhead 19 px bold, body 15 px
medium, labels 13 px bold capitals with 0.1em tracking. Times use tabular figures and en dashes (`1:15–3:30`).

**Shapes:** 8 px radius on controls, 10 px on panels; the rail is 264 px wide.

## Checking a change

`node apps/desktop/tests/preview/shots.mjs <folder>` renders every screen on both systems without the app, and flags a
screen with more than one primary button or engine words on its default view. The real-window UI test
(`apps/desktop/tests/ui.test.mjs`) checks the same on the app itself in CI.
