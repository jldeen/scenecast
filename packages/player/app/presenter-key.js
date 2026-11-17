// Windows browsers reserve Alt shortcuts for their menus.
export function presenterKey(event, platform = globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || '') {
  return event.altKey && !event.metaKey && (!/^win/i.test(platform) || event.ctrlKey);
}
