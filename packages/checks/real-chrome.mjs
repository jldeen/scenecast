// A real Chrome (or Edge) for the checker: the installed browser, the same one a screen was recorded in, so the
// replica's text is drawn the way the real page's was (headless Chrome draws it differently: a screen of text read
// about 1% off, a zoomed one up to 5%, Nov 2026). Its own throwaway profile, at the page zoom the tab was recorded at
// (Chrome's ⌘+ / Ctrl+), and never on the presenter's screen. It's the capture browser's launcher
// (@stuntdouble/capture/browser.mjs), one for both: each page a window of its own (a background tab doesn't draw),
// minimized on macOS and off every display on Windows (a minimized window there barely draws), with backgrounding
// off, which draws exactly as on screen (measured: 0.000% apart). On a CI Mac it starts Chrome's own binary (a start
// through open waits on a dialog there). macOS and Windows only, as before: elsewhere the checker stays headless.
//   launchRealChrome({ zoom, channel }) → { browser, ctx, newPage(), close() } or null (no such browser here, or it didn't start)
import { browserApp as installed, launchRealChrome as launch } from '@stuntdouble/capture/browser.mjs';

const here = () => process.platform === 'darwin' || process.platform === 'win32';
export const browserApp = (channel = 'chrome') => (here() ? installed(channel) : null);
export const launchRealChrome = (opts = {}) => (here() ? launch(opts) : Promise.resolve(null));

// Chrome keeps page zoom as a level: zoom = 1.2^level.
export const zoomLevel = zoom => Math.log(zoom) / Math.log(1.2);
