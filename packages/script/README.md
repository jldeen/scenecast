# @scenecast/script

Script to focus points (`scenecast script <file>`, docs/cli.md):

- `parse.mjs`: the script (plain text, Markdown, RunLines `.sk`) as lines, with optional beats and cues.
- `match.mjs`: the matcher interface and the deterministic `text` matcher (word rarity, sentences, roles, lines in
  order over the run-through). A demo can plug in its own (a model): `--matcher <file.mjs>`.
- `index.mjs`: indexes every screen in the replica, runs the matcher, turns picks into checked focus points, plays
  each once to see where it lands, writes `focus.json` and `.out/script/`.
- `sheet.mjs`: the line-to-screen sheet (HTML, PDF) and the cue sheet (Markdown, HTML).
- `docx.mjs`, `talk.mjs`, `html.mjs`: for Make it from my script (docs/ai.md): a Word file as Markdown, a talk track as
  beats with Say, Do and Screen lines and prompts, and a capture's controls and words without a browser.
