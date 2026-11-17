// Builds dist/agent.js: the capture driver and recorder with their in-page code inlined, for playwright-chrome's
// browser_run_code_unsafe (no require or fs there) or a local Playwright page.
//   node capture/build.mjs [outDir] [--port 47621]
// playwright-chrome only reads files inside the session workspace: pass that folder as outDir and run
// <outDir>/agent.js. The receiver must listen on the same port.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const port = +(args.includes('--port') ? args[args.indexOf('--port') + 1] : process.env.REPLICA_RX_PORT || 47621);
const outDir = resolve(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--port') || join(here, 'dist'));
const read = f => readFileSync(join(here, f), 'utf8');
const strip = s => s.replace(/^\/\/.*\n/gm, '');
const code = `async (page0) => {
const RX = ${JSON.stringify('http://127.0.0.1:' + port)};
const SER = ${JSON.stringify(read('serialize.js'))};
const HOVER_PAGE = ${JSON.stringify(strip(read('hover-page.js')))};
const REC_PAGE = ${JSON.stringify(strip(read('recorder-page.js')))};
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
${read('recorder.js')}
startLoop();
return 'agent started';
}
`;
new Function('return ' + code);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'agent.js'), code);
console.log(`${join(outDir, 'agent.js')} ${Math.round(code.length / 1024)} KB (receiver ${port})`);
