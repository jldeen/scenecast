# @scenecast/editor

The editor, inside the replica (`app/editor.js`): edit mode for people to adjust what `scenecast script` worked out,
or add their own focus points. The replica's server loads it whenever a demo is served for authoring (never with
`present`, `--release` or in an export); nothing of it shows until its key, ⌥⇧E (Ctrl+Alt+Shift+E on Windows), or
`?edit=1` (`scenecast edit`).

- Dots: click to drop a focus point (snapped by `player/app/focus-target.js`, the same code the script matcher
  uses), drag to move, Delete, `[` `]` to reorder, M for box or arrow, ▶ to preview.
- Wording and dates: drag across text, type, Enter: a `{ replace }` edit for every screen and answer frame.
- Beat starts: Start here.
- Undo: ⌘Z / Ctrl+Z.

Each change shows at once and is saved through the server (`/__replica/editor`, which checks it) to `focus.json` and
`flow.editor.json`. See docs/cli.md.
