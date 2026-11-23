// Spike: the capture browser opens, every window where its mode puts it, pages probed, then closed.
//   node spikes/capture-browser/smoke.mjs [minimized|offscreen|visible|headless]
import { launchCaptureBrowser, probe } from './browser.mjs';
import { startFixture } from '../../examples/fixture-app/server.mjs';

const mode = process.argv[2] || 'minimized';
const fx = startFixture({ chatPort: 47811, adminPort: 47812 });
const t0 = Date.now();
const cb = await launchCaptureBrowser({ mode, width: 1600, height: 900 });
if (!cb) { console.log('no capture browser'); process.exit(1); }
try {
  const chat = await cb.newPage({ url: 'http://127.0.0.1:47811/' });
  const admin = await cb.newPage({ url: 'http://127.0.0.1:47812/' });
  const dark = await cb.newPage({ url: 'http://127.0.0.1:47811/', light: false });
  const big = await cb.newPage({ url: 'http://127.0.0.1:47812/', viewport: 'emulated', width: 1920, height: 1080, dpr: 2 });
  await chat.waitForTimeout(1500);
  const out = { ms: Date.now() - t0, info: await cb.info?.(), chat: await probe(chat), admin: await probe(admin), notLight: await probe(dark), emulated1920: await probe(big) };
  console.log(JSON.stringify(out, null, 1));
} finally { await cb.close(); fx.close?.(); process.exit(0); }
