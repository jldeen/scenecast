// Builds the recorder for the browser, from one source (driver.js, recorder.js, flows/*, the in-page code):
//   agent.js     for playwright-chrome's browser_run_code_unsafe or a local Playwright page (no require or fs there)
//   extension/   the MV3 recorder extension for Edge and Chrome (chrome.debugger; load it unpacked)
//   node recorder/build.mjs [outDir] [--port 47621]               → <outDir>/agent.js
//   node recorder/build.mjs --extension [outDir] [--port 47621]   → <outDir> (an unpacked extension)
// playwright-chrome only reads files inside the session workspace: pass that folder as outDir and run
// <outDir>/agent.js. The receiver must listen on the same port (the extension's popup can change it later).
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = f => readFileSync(join(here, f), 'utf8');
const strip = s => s.replace(/^\/\/.*\n/gm, '');
const VERSION = JSON.parse(read('package.json')).version;

// The recorder itself: what both builds run, given page0, RX and (in the extension) EXPOSE_SHADOW.
export function core() {
  return `const SER = ${JSON.stringify(read('serialize.js'))};
const HOVER_PAGE = ${JSON.stringify(strip(read('hover-page.js')))};
const REC_PAGE = ${JSON.stringify(strip(read('recorder-page.js')))};
const OUTLINE_PAGE = ${JSON.stringify(strip(read('outline-page.js')))};
${read('driver.js')}
const SIDE_HOVERS = async (ARGS) => {
${read('flows/hover-audit.js')}
};
const SIDE_CLICKS = async (ARGS) => {
${read('flows/click-audit.js')}
};
const SIDE_DRAGS = async (ARGS) => {
${read('flows/drag-audit.js')}
};
const SIDE_LIST = async (ARGS) => {
${read('flows/virtual-list.js')}
};
const PREFLIGHT = async (ARGS) => {
${read('flows/preflight.js')}
};
OPS.preflight = c => PREFLIGHT(c);
${read('recorder.js')}
`;
}

export function buildAgent(outDir, port) {
  const code = `async (page0) => {
const RX = ${JSON.stringify('http://127.0.0.1:' + port)};
${core()}
startLoop();
return 'agent started';
}
`;
  new Function('return ' + code);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'agent.js'), code);
  return { file: join(outDir, 'agent.js'), kb: Math.round(code.length / 1024) };
}

export function buildExtension(outDir, port) {
  const ext = f => readFileSync(join(here, 'extension', f), 'utf8');
  // One classic service worker script: the debugger shim, the recorder, then the glue that starts it.
  const sw = `// Built by scenecast (packages/recorder/build.mjs --extension); edit the sources, not this file.
const DEFAULT_PORT = ${+port};
let RX = 'http://127.0.0.1:' + DEFAULT_PORT;
${ext('cdp-page.js')}
const page0 = { context: () => CDPX.ctx, request: CDPX.ctx.request, url: () => '', frames: () => [] };
${ext('shadow.js')}
${core()}
${ext('main.js')}
`;
  new Function(sw);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const manifest = JSON.parse(ext('manifest.json'));
  manifest.version = VERSION;
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(outDir, 'sw.js'), sw);
  for (const f of ['popup.html', 'popup.js', 'icon.png']) copyFileSync(join(here, 'extension', f), join(outDir, f));
  return { dir: outDir, kb: Math.round(sw.length / 1024) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const port = +(args.includes('--port') ? args[args.indexOf('--port') + 1] : process.env.REPLICA_RX_PORT || 47621);
  const pos = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--port');
  if (args.includes('--extension')) {
    const r = buildExtension(resolve(pos || join(here, 'dist', 'extension')), port);
    console.log(`${r.dir} (${r.kb} KB, receiver ${port})`);
    console.log('Load it once: edge://extensions or chrome://extensions → Developer mode on → Load unpacked → this folder.');
  } else {
    const r = buildAgent(resolve(pos || join(here, 'dist')), port);
    console.log(`${r.file} ${r.kb} KB (receiver ${port})`);
  }
}
