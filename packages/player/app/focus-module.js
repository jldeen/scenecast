// Focus points (the demo's focus.mjs → flow.focus), loaded by the shell when a demo has any: ⌥F zooms to the next
// point for the beat and draws its mark like ZoomIt, ⌥⇧F goes back, Esc zooms out, ↑/↓ and the wheel nudge the zoom.
// The engine is focus.js. Beat jumps and ⌥0 start the beat's points again; switching apps clears the zoom.
import { createFocus } from './focus.js';
import { presenterKey } from './presenter-key.js';

export default function focusModule(api) {
  const focus = createFocus({
    stage: api.stage, points: api.flow.focus || [], options: api.flow.focusOptions || {}, speed: api.speed, docsOf: api.docsOf,
    current: api.current, groupButton: api.groupButton, openGroup: api.openGroup,
    // A point's `via`: the shell's own move to the screen one step on (as the click there would).
    go: api.morph ? (app, state) => api.morph(app, state) : null,
  });
  // While zoomed: Esc and ↑/↓ are ZoomIt's, before anything else. ⌥F and ⌥⇧F step through the points; Ctrl+Alt+F
  // and Ctrl+Alt+Shift+F too, on any OS (Edge on Windows keeps Alt+F for its menu).
  api.on('key', e => {
    if (focus.key(e)) return true;
    if (presenterKey(e) && e.code === 'KeyF') { if (e.shiftKey) focus.back(); else focus.next(); return true; }
    return false;
  });
  api.on('activate', () => focus.clear());
  api.on('jump', n => focus.reset(n));
  api.expose('focus', focus);
}
