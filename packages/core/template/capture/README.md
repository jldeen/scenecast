# Demo-specific capture scripts

Scripts here run on the presenter's Chrome through the capture agent: `scenecast run capture/<file>.js '{"…"}'`.
`ctx`, `page`, `H` (driver helpers: `H.snap`, `H.find`, `H.pageFor`, …) and the helpers in the kit's
`capture/lib.js` are in scope; `return` a value to print it.

Write one only for what the recorder can't see: getting each tab to its start screen (`prep.js`), a card or
screen that only appears in a throwaway run (then `compose` it in `flow.overrides.mjs`), or a check of a live
run before you keep it (a judge). Never click menu items as a fallback when a menu ignores Escape.
