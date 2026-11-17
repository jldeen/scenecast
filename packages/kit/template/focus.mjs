// Focus points: ⌥F zooms to the next one for the beat and draws its mark, like ZoomIt by hand. ⌥⇧F goes back, Esc
// zooms out, ↑/↓ and the wheel zoom in and out a step. They show on reload (no build); scenecast quick checks them.
// One per thing a line of the script points at, in script order. Leave the list empty for none.
//   id     a name of its own
//   beat   the ⌥ beat key (1–9, 0 for the start) that lands just before it: ⌥F after that key starts here
//   app    the app it's on; states: the screens it shows on (one or more)
//   find   text on the screen (the box around it), or union: several, the box around all of them, each one of
//          'text', { sel: 'a CSS selector' }, or { text: '…', up: 'li' | 2 } (the element around the text)
//   mark   'rect' (default) or 'arrow' (its head on the target; dir: where its tail lies, n s e w ne nw se sw)
//   open   step groups to open first (their labels); grow: [left, top, right, bottom] px added to the box
//   maxZoom  less zoom than the default for this one; line: the script line it goes with (for the README)
const F = (id, beat, app, states, target, extra = {}) => ({ id, beat, app, states: [].concat(states), ...(typeof target === 'string' ? { find: target } : Array.isArray(target) ? { union: target } : { union: [target] }), ...extra });

export default [
  // F('the-date', 1, 'teams', 'teams-start', 'from Nov 12 to Nov 26'),
  // F('the-chips', 2, 'copilot', 'copilot-01-message', { sel: 'aside ul[role=list]' }),
  // F('share', 3, 'copilot', 'copilot-03-skill', 'Share', { mark: 'arrow', dir: 'sw' }),
];

// Her ZoomIt settings are the defaults: zoom 2, pen 5, macOS systemRed.
// export const options = { zoom: 2, pen: 5, color: 'rgb(255, 56, 60)' };
