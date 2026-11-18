// Opens a page of a served replica as an app window, in the demo's browser and profile (demo.json chrome), the same
// browser as the stage: the presenter guide talks to the stage over a BroadcastChannel, which only works inside one
// browser profile. The desktop app's "Open presenter guide" runs this.
//   node packages/player/open.mjs --demo <dir> --url <url> [--position x,y] [--size w,h]
import { loadDemo, arg } from '../kit/lib/demo.mjs';
import { openApp } from './launch.mjs';

const args = process.argv.slice(2);
const demo = loadDemo(args);
const url = arg(args, '--url');
if (!url || !/^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(url)) { console.error('open: --url must be the replica on localhost'); process.exit(1); }
const pair = k => { const v = arg(args, k); return v && /^-?\d+,-?\d+$/.test(v) ? v.split(',').map(Number) : undefined; };
openApp(url, { ...demo.cfg.chrome, position: pair('--position'), size: pair('--size') });
console.log(`opened ${url}`);
