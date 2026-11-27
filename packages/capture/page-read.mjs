// A live page and its frames in the reader's shape (@scenecast/script/html.mjs readScreen): [{ key, html }], key 'main'
// for the page, else the frame's host (as the live walker's write gate names them). Each document is serialized the
// way the recorder writes a screen (serialize.js): form state as attributes (a box's value, a switch's checked, a
// text area's text), open dialogs and popovers marked, sign-in tokens left out; without CSS. So a live read and a
// recorded screen give the reader the same marks (values, states, frames, live regions, times).
//   READ_DOCS_SRC: code for the capture host's `js` command (it has `page`) → [{ key, html }]
import { readFileSync } from 'node:fs';

const SERIALIZE_SRC = readFileSync(new URL('./serialize.js', import.meta.url), 'utf8');

export const READ_DOCS_SRC = `const SER = ${JSON.stringify(SERIALIZE_SRC)};
const out = [];
for (const f of page.frames()) {
  let key = 'main';
  if (f !== page.mainFrame()) { try { key = new URL(f.url()).host; } catch (e) { key = 'a frame'; } }
  const r = await f.evaluate('(' + SER + ')({ css: false })').catch(() => null);
  out.push({ key, html: (r && r.html) || '' });
}
return out;`;
