// Spike (stage C): twins. N windows of one app in the capture browser at once, each running the recorder's own hover
// sweep (flows/hover-audit.js, the side state that takes longest) on its screen, through a real receiver. Per N: the
// wall time, the time per screen, the browser's CPU, whether every window drew all along (rAF during the sweep), and
// whether each found what one window alone finds.
//   node spikes/capture-browser/twins.mjs [--n 1,2,4] [--mode minimized] [--out dir]
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, cpus, loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { launchCaptureBrowser } from './browser.mjs';
import { startFixture } from '../../examples/fixture-app/server.mjs';
import { core } from '../../packages/capture/build.mjs';
import { flowScript } from '../../packages/capture/cli.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const NS = arg('--n', '1,2,4').split(',').map(Number);
const MODE = arg('--mode', 'minimized');
const OUT = arg('--out', join(process.env.DIAG_DIR || '.', 'twins'));
mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BIN = process.env.SCENECAST_BIN ? resolve(process.env.SCENECAST_BIN) : resolve('target', 'debug', process.platform === 'win32' ? 'scenecast.exe' : 'scenecast');
const RX = 47731;
const fx = startFixture({ chatPort: 47831, adminPort: 47832 });

// A demo folder for the receiver to write into.
const tmp = mkdtempSync(join(tmpdir(), 'sd-twins-'));
spawnSync(BIN, ['new', 'twins', '--dir', tmp, '--app', `chat=${fx.chat}`], { stdio: 'ignore' });
const DEMO = join(tmp, 'twins');
const cfg = JSON.parse(readFileSync(join(DEMO, 'demo.json'), 'utf8')); cfg.raw = join(tmp, 'raw'); cfg.receiverPort = RX;
writeFileSync(join(DEMO, 'demo.json'), JSON.stringify(cfg, null, 2));
const rx = spawn(BIN, ['receiver', '--demo', DEMO], { env: { ...process.env, REPLICA_RX_PORT: String(RX) }, stdio: 'ignore' });
for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${RX}/ping`)).ok) break; } catch (e) {} await sleep(200); }

const HOVER = resolve('packages/capture/flows/hover-audit.js');
const cb = await launchCaptureBrowser({ mode: MODE, width: 1280, height: 800, log: m => console.log(m) });
if (!cb) { console.log('no capture browser'); process.exit(1); }
const results = [];
try {
  // The recorder's helpers (H) and commands (OPS), in this process, over this browser's CDP connection.
  const anchor = cb.ctx.pages()[0];
  const make = new Function('return async (page0) => { const RX = ' + JSON.stringify('http://127.0.0.1:' + RX) + "; const AGENT_ID = 'twins'; const AGENT_QS = async () => ''; " + core() + '\nreturn { OPS, H }; }')();
  const { OPS } = await make(anchor);
  for (const n of NS) {
    const pages = [];
    for (let i = 0; i < n; i++) pages.push(await cb.newPage({ url: `${fx.chat}?twin=${n}-${i}`, viewport: 'emulated', width: 1280, height: 800, dpr: 2 }));
    for (const p of pages) await p.waitForLoadState('load');
    await sleep(800);
    // Every window counts its frames the whole time.
    for (const p of pages) await p.evaluate(() => { window.__frames = 0; const f = () => { window.__frames++; requestAnimationFrame(f); }; requestAnimationFrame(f); });
    const cpu0 = await cb.cpu(), t0 = Date.now(), load0 = loadavg()[0];
    const runs = await Promise.all(pages.map((p, i) => {
      const t = Date.now();
      return OPS.js({ code: flowScript(HOVER, { tab: `twin=${n}-${i}`, page: `twin${n}-${i}` }).code }).then(out => ({ secs: (Date.now() - t) / 1000, n: out.n, tried: out.tried }), e => ({ error: String(e.message || e).slice(0, 200) }));
    }));
    const wall = (Date.now() - t0) / 1000, cpu = (await cb.cpu()) - cpu0;
    const frames = await Promise.all(pages.map(p => p.evaluate(() => window.__frames)));
    results.push({ n, wall: +wall.toFixed(1), perScreen: +(wall / n).toFixed(1), cpuSecs: +cpu.toFixed(1), cpuCores: +(cpu / wall).toFixed(2), runs, fps: frames.map(f => Math.round(f / wall)), load: [+load0.toFixed(1), +loadavg()[0].toFixed(1)] });
    console.log(JSON.stringify(results[results.length - 1]));
    for (const p of pages) await p.close();
  }
} finally { await cb.close(); rx.kill(); fx.close(); }
const report = { platform: process.platform, cores: cpus().length, mode: MODE, results };
writeFileSync(join(OUT, `twins-${MODE}.json`), JSON.stringify(report, null, 1));
process.exit(0);
