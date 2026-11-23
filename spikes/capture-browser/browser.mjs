// Spike (stage C): the capture browser, now @stuntdouble/capture/browser.mjs. This keeps the spike scripts'
// interface (launchCaptureBrowser({ mode }) → newPage({ url, viewport: 'window' | 'emulated', state })) on top of it,
// plus Chrome's own headless for comparison, so the measurements run on the package's code.
import { chromium } from 'playwright-core';
import { openCaptureBrowser, browserApp, probe } from '@stuntdouble/capture/browser.mjs';
export { browserApp, probe };

export async function launchCaptureBrowser({ profile = null, mode = 'minimized', channel = 'chrome', extension = null, width = 1600, height = 1000, extraFlags = [], mockKeychain, log = () => {} } = {}) {
  if (mode === 'headless') {
    const browser = await chromium.launch({ channel, headless: true, args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
    const ctx = await browser.newContext({ viewport: null, deviceScaleFactor: undefined });
    const newPage = async ({ url = 'about:blank', light = true, width: w = width, height: h = height } = {}) => {
      const p = await ctx.newPage(); await p.setViewportSize({ width: w, height: h });
      if (light) await p.emulateMedia({ colorScheme: 'light' });
      if (url !== 'about:blank') await p.goto(url);
      return p;
    };
    return { browser, ctx, newPage, info: async () => ({ mode }), cpu: async () => 0, close: () => browser.close() };
  }
  const cb = await openCaptureBrowser({ profile, channel, window: mode, extension, flags: extraFlags, width, height, mockKeychain, log });
  if (!cb) return null;
  const newPage = ({ url = 'about:blank', light = true, focus = true, width: w = width, height: h = height, viewport = 'window', dpr = 0, state = mode } = {}) =>
    cb.open(url, { light, focus, window: state, width: w, height: h, viewport: viewport === 'emulated' ? { width: w, height: h, dpr } : null });
  return { ...cb, newPage };
}
