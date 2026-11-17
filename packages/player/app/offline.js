// File-origin playback: captures and assets are embedded by the static exporter.
(() => {
  const files = globalThis.__scenecastFiles;
  const root = new URL('.', location.href);
  const cache = new Map(), modules = new Map();
  const keyOf = url => {
    const urlPath = new URL(url, root).pathname, rootPath = root.pathname;
    if (!urlPath.startsWith(rootPath)) throw new Error('Resource is outside the export');
    return decodeURIComponent(urlPath.slice(rootPath.length));
  };
  const file = url => {
    const key = keyOf(url), value = files[key];
    if (!value) throw new Error(`Missing exported resource: ${key}`);
    return value;
  };
  function asset(url, stack = new Set()) {
    const key = keyOf(url), entry = file(url);
    if (entry.url) return entry.url;
    if (stack.has(key)) throw new Error(`Circular asset: ${key}`);
    stack.add(key);
    const type = key.endsWith('.svg') ? 'image/svg+xml' : 'text/css';
    const value = `data:${type};charset=utf-8,${encodeURIComponent(replaceAssets(entry.text, stack))}`;
    stack.delete(key);
    return value;
  }
  function replaceAssets(text, stack = new Set()) {
    return text.replace(/(?:\.\.\/|\/)assets\/([^"'\\()\s?&#<>]+)/g, (_, name) => asset(new URL(`assets/${name}`, root), stack));
  }
  function text(url) {
    const entry = file(url);
    if (typeof entry.text !== 'string') throw new Error(`Not a text resource: ${keyOf(url)}`);
    if (keyOf(url) === '__replica/fonts' || keyOf(url) === 'manifest.json') return entry.text;
    return replaceAssets(entry.text);
  }
  function document(url, stack = new Set()) {
    const key = keyOf(url);
    if (stack.has(key)) throw new Error(`Circular frame: ${key}`);
    stack.add(key);
    const doc = new DOMParser().parseFromString(text(url), 'text/html');
    for (const frame of doc.querySelectorAll('iframe[data-d1-frame][src]')) {
      const src = frame.getAttribute('src');
      if (!src || src === 'about:blank') continue;
      frame.setAttribute('srcdoc', document(new URL(src, url), stack));
      frame.removeAttribute('src');
    }
    stack.delete(key);
    return '<!DOCTYPE html>' + doc.documentElement.outerHTML;
  }
  function module(path) {
    if (modules.has(path)) return modules.get(path);
    const allowed = ['/app/morph.js', '/app/presenter-key.js', '/app/bundle-flow.js', '/app/focus.js', '/app/focus-module.js', '/app/shell.js'];
    if (!allowed.includes(path)) throw new Error(`Offline playback does not support custom module ${path}`);
    let source = text(new URL(path.slice(1), root));
    const deps = {
      '/app/focus-module.js': ['./focus.js', './presenter-key.js'],
      '/app/shell.js': ['./morph.js', './presenter-key.js', './bundle-flow.js'],
    }[path] || [];
    for (const dep of deps) source = source.replaceAll(`'${dep}'`, JSON.stringify(module('/app/' + dep.slice(2))));
    const value = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(source);
    modules.set(path, value);
    return value;
  }
  globalThis.__scenecastOffline = { text, document, asset, module };
})();
