// Presenter keys: ⌥ (Option) on the Mac; Ctrl+Alt on Windows, where Edge and Windows keep Alt alone for their menus
// (Edge's Alt+F opens its Settings menu, and the page never sees it). Ctrl+Alt works on the Mac too. Detected at
// runtime from the browser's platform, so one replica works on both.
const browserPlatform = () => globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || '';
export const isWindows = (platform = browserPlatform()) => /^win/i.test(platform);
export function presenterKey(event, platform = browserPlatform()) {
  return event.altKey && !event.metaKey && (!isWindows(platform) || event.ctrlKey);
}
// How a key reads on this platform: '⌥F' → 'Ctrl+Alt+F' on Windows, '⌥⇧F' → 'Ctrl+Alt+Shift+F', '⌘R' → 'Ctrl+R'.
export function keyLabel(text, platform = browserPlatform()) {
  if (!isWindows(platform)) return String(text);
  return String(text)
    .replace(/⌃?⌥(⇧?)(\S)/g, (m, sh, k) => `Ctrl+Alt+${sh ? 'Shift+' : ''}${k}`)
    .replace(/⌘(\S)/g, 'Ctrl+$1').replace(/⇧(\S)/g, 'Shift+$1');
}
