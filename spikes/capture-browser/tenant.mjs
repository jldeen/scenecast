// Spike (stage C): the capture browser on a demo's real apps, in phases. Reads the apps from the demo's own demo.json
// (nothing about a tenant is in this file); writes pictures and numbers to --out (outside the repository).
// Read-only: it loads pages, moves the pointer, and opens and closes panes and menus with the recorder's own click
// audit (which never clicks anything that acts). The profile lives outside the repository (--profile).
//   node spikes/capture-browser/tenant.mjs --demo <dir> --profile <dir> --out <dir> --phase signin|restart|parity|twins|expiry
//   (--apps id=url,id=url instead of --demo, for a dry run on the fixture; --wait-signin s for how long sign-in may take)
import { mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, rmSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, loadavg } from 'node:os';
import { chromium } from 'playwright-core';
import { launchCaptureBrowser, probe } from './browser.mjs';
import { comparePngs, luminance } from '../../packages/checks/compare.mjs';
import { core } from '../../packages/capture/build.mjs';
import { flowScript } from '../../packages/capture/cli.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const PHASE = arg('--phase', 'parity'), OUT = resolve(arg('--out', 'tenant-out')), PROFILE = resolve(arg('--profile', join(tmpdir(), 'sd-capture-dry')));
mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const APPS = arg('--apps') ? arg('--apps').split(',').map(x => { const [id, ...u] = x.split('='); return { id, url: u.join('=') }; })
  : JSON.parse(readFileSync(join(resolve(arg('--demo')), 'demo.json'), 'utf8')).apps.filter(a => a.url && /^https?:/.test(a.url)).map(a => ({ id: a.id, url: a.url, match: a.match }));
const SIGN_IN = /(^|\.)(login|signin|sign-in|auth|sso|accounts|adfs)[.-]|login\.microsoftonline\.com|login\.live\.com|accounts\.google\.com/i;
const BLOCKED = /can.t get there from here|you can.t access this|set up your device|device (?:is|isn.t|must be) (?:compliant|managed|registered)|help us keep your device secure|approve sign.in request/i;
const VP = { width: +arg('--width', 1400), height: +arg('--height', 800) };
const log = (...a) => { const s = `${new Date().toISOString().slice(11, 19)} ${a.join(' ')}`; console.log(s); writeFileSync(join(OUT, `${PHASE}.log`), s + '\n', { flag: 'a' }); };
const save = (name, v) => writeFileSync(join(OUT, name), JSON.stringify(v, null, 1));
// Where a page is: signed in on the app, on a sign-in page, or blocked by a policy.
async function where(p) {
  const url = p.url(); let host = ''; try { host = new URL(url).host; } catch (e) {}
  const text = await p.evaluate(() => document.body ? document.body.innerText.slice(0, 4000) : '').catch(() => '');
  return { host, signIn: SIGN_IN.test(host), blocked: BLOCKED.test(text), title: await p.title().catch(() => '') };
}
// Loaded and quiet: the page's own load, then nothing new on screen for a moment (live apps never fully stop).
async function settle(p, ms = 9000) { await p.waitForLoadState('load', { timeout: 60000 }).catch(() => {}); await sleep(ms); await p.evaluate(() => document.fonts.ready).catch(() => {}); }
const cookieReport = async ctx => (await ctx.cookies()).filter(c => /ESTSAUTH|SignInStateCookie|buid|fpc|x-ms-gateway|MSISAuth|AADSSO|user_session|_gh_sess|logged_in/i.test(c.name))
  .map(c => ({ name: c.name, domain: c.domain.replace(/^\./, '').split('.').slice(-2).join('.'), session: c.expires === -1, expires: c.expires > 0 ? new Date(c.expires * 1000).toISOString().slice(0, 10) : null }));

let cb = null;
const stop = async () => { if (cb) await cb.close().catch(() => {}); cb = null; };
process.on('SIGINT', async () => { await stop(); process.exit(1); });
try {
  if (PHASE === 'signin' && !arg('--signin-mode')) {
    // The package's sign-in window (@stuntdouble/capture: what stunt capture sign-in runs), on her screen.
    const { signInWindow } = await import('@stuntdouble/capture/browser.mjs');
    log(`sign in in the window that opens (${APPS.length} apps)`);
    const r = await signInWindow({ profile: PROFILE, apps: APPS, timeoutS: +arg('--wait-signin', 600), viewport: VP, flags: ['--disable-features=LocalNetworkAccessChecks'],
      onState: st => log('apps: ' + st.map(x => `${x.id} ${x.at === 'app' ? 'in' : x.at === 'blocked' ? 'BLOCKED' : x.at ? 'sign-in' : '-'}`).join(', ')) });
    save('signin.json', { secs: r.secs, ok: r.ok, seen: r.seen, states: Object.fromEntries((r.apps || []).map(x => [x.id, { ok: x.at === 'app', blocked: x.at === 'blocked', signIn: x.at === 'signin', at: x.secs }])), cookies: r.cookies, error: r.error });
    log(`signed in: ${r.ok} in ${r.secs} s; pages on the way: ${(r.seen || []).join(', ') || 'none'}`);
  }
  if (PHASE === 'signin' && arg('--signin-mode')) {
    // A visible window on the first app: she signs in there (and says Yes to staying signed in). Then each app is
    // opened in turn until every one lands on itself, not a sign-in page.
    const t0 = Date.now(), maxS = +arg('--wait-signin', 600);
    cb = await launchCaptureBrowser({ profile: PROFILE, mode: arg('--signin-mode', 'visible'), width: VP.width, height: VP.height, extraFlags: ['--disable-features=LocalNetworkAccessChecks'] });
    const p = await cb.newPage({ url: APPS[0].url, ...VP });
    log(`capture browser up in ${cb && (await cb.info()).startMs} ms; sign in in its window (${APPS.length} apps)`);
    const states = {};
    for (;;) {
      for (const a of APPS) {
        if (states[a.id] && states[a.id].ok) continue;
        if (p.url().split('#')[0] !== a.url.split('#')[0]) await p.goto(a.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await settle(p, 6000);
        const w = await where(p);
        states[a.id] = { ok: !w.signIn && !w.blocked, ...w, at: Math.round((Date.now() - t0) / 1000) };
        if (!states[a.id].ok) break;
      }
      log('apps: ' + APPS.map(a => `${a.id} ${states[a.id] ? (states[a.id].ok ? 'in' : states[a.id].blocked ? 'BLOCKED' : 'sign-in') : '-'}`).join(', '));
      if (APPS.every(a => states[a.id] && states[a.id].ok) || Date.now() - t0 > maxS * 1000) break;
      await sleep(4000);
    }
    save('signin.json', { secs: Math.round((Date.now() - t0) / 1000), states: Object.fromEntries(Object.entries(states).map(([k, v]) => [k, { ok: v.ok, blocked: v.blocked, signIn: v.signIn, at: v.at }])), cookies: await cookieReport(cb.ctx) });
  }
  if (PHASE === 'restart' || PHASE === 'expiry') {
    // Signed in after Chrome restarts: the profile alone, every app in a minimized window. expiry: the same on a copy
    // of the profile with its cookies cleared, to see the engine tell "sign in again".
    let profile = PROFILE;
    if (PHASE === 'expiry') { profile = mkdtempSync(join(tmpdir(), 'sd-expired-')); cpSync(PROFILE, profile, { recursive: true }); for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) rmSync(join(profile, f), { force: true }); }
    const t0 = Date.now();
    cb = await launchCaptureBrowser({ profile, mode: 'minimized', width: VP.width, height: VP.height });
    if (PHASE === 'expiry') await cb.ctx.clearCookies();
    const out = { startMs: (await cb.info()).startMs, apps: {} };
    await Promise.all(APPS.map(async a => {
      const t = Date.now(); const p = await cb.newPage({ url: a.url, ...VP }); await settle(p, 5000);
      out.apps[a.id] = { ...(await where(p)), secs: +((Date.now() - t) / 1000).toFixed(1) };
      delete out.apps[a.id].title;
    }));
    out.secs = +((Date.now() - t0) / 1000).toFixed(1);
    if (PHASE === 'restart') out.cookies = await cookieReport(cb.ctx);
    log(JSON.stringify(out.apps));
    save(`${PHASE}.json`, out);
    if (PHASE === 'expiry') { await stop(); rmSync(profile, { recursive: true, force: true }); }
  }
  if (PHASE === 'parity') {
    // Per app, three windows at the same moment: two minimized (live content's own noise between them) and one
    // visible (the screen's drawing). Then, in a minimized window: hovers and menus through CDP input.
    // --part shots: only the windows on the screen (the sitting pauses after it); --part audits: only the hovers and
    // menus, added to the shots' parity.json.
    const modes = arg('--modes', 'minimized,visible').split(',');
    const PART = arg('--part', 'all');
    const res = PART === 'audits' ? JSON.parse(readFileSync(join(OUT, 'parity.json'), 'utf8')).res : {};
    if (PART !== 'audits') {
    const cmpB = await chromium.launch({ channel: 'chrome', headless: true }); const cp = await cmpB.newPage();
    for (const a of APPS) {
      const r = res[a.id] = {};
      const t0 = Date.now();
      const shots = {};
      // One browser: two minimized windows and (when asked) one visible, loaded and shot at the same moment.
      const visible = modes.includes('visible');
      cb = await launchCaptureBrowser({ profile: PROFILE, mode: visible ? 'visible' : 'minimized', width: VP.width, height: VP.height });
      // offscreen: a normal window placed off every display (the fallback; on a Mac, does it stay there?).
      const want = [['minimized', 1], ['minimized', 2], ...(visible ? [['visible', 0]] : []), ...(modes.includes('offscreen') ? [['offscreen', 0]] : [])];
      const pages = [];
      for (const [m] of want) pages.push(await cb.newPage({ url: a.url, ...VP, state: m }));
      await Promise.all(pages.map(p => settle(p)));
      for (const p of pages) await p.mouse.move(VP.width - 3, VP.height - 3);
      await sleep(400);
      const pngs = await Promise.all(pages.map(p => p.screenshot()));
      pngs.forEach((b, i) => { const [m, k] = want[i]; const nm = `${a.id}-${m}${m === 'minimized' ? '-' + k : ''}.png`; writeFileSync(join(OUT, nm), b); shots[nm] = b.toString('base64'); });
      for (const [i, [m, k]] of want.entries()) if (k !== 2) { r[m] = { probe: await probe(pages[i]), where: await where(pages[i]) }; delete r[m].where.title; }
      // Where the OS put each window (bounds and state only).
      r.windows = ((await cb.info()).wins || []).map(w => ({ state: w.state, left: w.left, top: w.top, width: w.width, height: w.height }));
      await stop();
      const n = (m, i) => `${a.id}-${m}${m === 'minimized' ? '-' + i : ''}.png`;
      if (shots[n('minimized', 2)]) r.noise = (await comparePngs(cp, [[shots[n('minimized', 1)], shots[n('minimized', 2)]]]))[0];
      if (shots[n('visible')]) r.visibleVsMinimized = (await comparePngs(cp, [[shots[n('visible')], shots[n('minimized', 1)]]]))[0];
      if (shots[n('offscreen')]) r.offscreenVsMinimized = (await comparePngs(cp, [[shots[n('offscreen')], shots[n('minimized', 1)]]]))[0];
      r.light = (await luminance(cp, [shots[n('minimized', 1)]]))[0];
      r.secs = Math.round((Date.now() - t0) / 1000);
      log(`${a.id}: noise ${r.noise && r.noise.pct}% · visible vs minimized ${r.visibleVsMinimized && r.visibleVsMinimized.pct}% · offscreen vs minimized ${r.offscreenVsMinimized && r.offscreenVsMinimized.pct}% · luminance ${r.light} · raf ${r.minimized.probe.raf} · t250 ${r.minimized.probe.timer250} · fonts ${r.minimized.probe.fonts} (${r.minimized.probe.faces} faces, ${r.minimized.probe.facesFailed} failed)`);
    }
    await cmpB.close();
    log('screen free: nothing more shows on the screen');
    save('parity.json', { viewport: VP, load: loadavg(), res });
    }
    if (PART !== 'shots') {
    // Hovers and menus through CDP input, in minimized windows: the recorder's own audits, a few controls each.
    cb = await launchCaptureBrowser({ profile: PROFILE, mode: 'minimized', width: VP.width, height: VP.height });
    const make = new Function('return async (page0) => { const RX = "http://127.0.0.1:9"; const AGENT_ID = "spike"; const AGENT_QS = async () => ""; ' + core() + '\nreturn { OPS, H }; }')();
    const { OPS } = await make(cb.ctx.pages()[0]);
    // What the apps send while they're only looked at (for a network guard on read-only steps): methods and hosts,
    // counted, never bodies or paths. Watched only; nothing is blocked.
    let stage = 'load', net = null;
    cb.ctx.on('request', q => { if (!net) return; let h = ''; try { h = new URL(q.url()).host; } catch (e) {} if (!/^https?:/.test(q.url())) return; const k = `${stage} ${q.method()} ${h}`; net[k] = (net[k] || 0) + 1; });
    for (const a of APPS) {
      net = {}; stage = 'load';
      const p = await cb.newPage({ url: a.url + (a.url.includes('#') ? '' : ''), ...VP }); await settle(p);
      stage = 'hover';
      await p.evaluate(id => sessionStorage.setItem('d1tab', id), 'spike-' + a.id);
      const t = Date.now();
      const hv = await OPS.js({ code: flowScript(resolve('packages/capture/flows/hover-audit.js'), { tab: 'spike-' + a.id, page: a.id, max: 10 }).code }).catch(e => ({ error: String(e.message || e).slice(0, 200) }));
      const tc = Date.now(); stage = 'menu';
      const ck = await OPS.js({ code: flowScript(resolve('packages/capture/flows/click-audit.js'), { tab: 'spike-' + a.id, page: a.id, pick: { max: 4 } }).code }).catch(e => ({ error: String(e.message || e).slice(0, 200) }));
      res[a.id].hovers = { shown: hv.n, tried: hv.tried, secs: (tc - t) / 1000, error: hv.error };
      res[a.id].menus = { opened: ck && ck.n, tried: ck && (ck.results || []).length, restores: ck && (ck.results || []).map(x => x.restore || x.effect || x.skip || x.error).filter(Boolean), secs: (Date.now() - tc) / 1000, error: ck && ck.error };
      res[a.id].net = net; net = null;
      const nonGet = Object.entries(res[a.id].net).filter(([k]) => !/ (GET|OPTIONS|HEAD) /.test(k)).reduce((n, [k, v]) => (n[k.split(' ')[0]] = (n[k.split(' ')[0]] || 0) + v, n), {});
      res[a.id].nonGet = nonGet;
      writeFileSync(join(OUT, `${a.id}-after-audits.png`), await p.screenshot());
      log(`${a.id}: hovers ${JSON.stringify(res[a.id].hovers)} menus ${JSON.stringify(res[a.id].menus)} non-GET by stage ${JSON.stringify(res[a.id].nonGet)}`);
      await p.close();
    }
    await stop();
    save('parity.json', { viewport: VP, load: loadavg(), res });
    }
  }
  if (PHASE === 'twins') {
    // The first app, 1 then 2 then 4 windows at once, each hovering up to 10 controls.
    const a = APPS.find(x => x.id === arg('--app', APPS[0].id));
    cb = await launchCaptureBrowser({ profile: PROFILE, mode: 'minimized', width: VP.width, height: VP.height });
    const make = new Function('return async (page0) => { const RX = "http://127.0.0.1:9"; const AGENT_ID = "spike"; const AGENT_QS = async () => ""; ' + core() + '\nreturn { OPS, H }; }')();
    const { OPS } = await make(cb.ctx.pages()[0]);
    const out = [];
    for (const n of arg('--n', '1,2,4').split(',').map(Number)) {
      const pages = await Promise.all(Array.from({ length: n }, () => cb.newPage({ url: a.url, ...VP })));
      await Promise.all(pages.map(p => settle(p)));
      for (const [i, p] of pages.entries()) await p.evaluate(id => { sessionStorage.setItem('d1tab', id); window.__frames = 0; const f = () => { window.__frames++; requestAnimationFrame(f); }; requestAnimationFrame(f); }, `twin-${n}-${i}`);
      const cpu0 = await cb.cpu(), t0 = Date.now(), l0 = loadavg()[0];
      const runs = await Promise.all(pages.map((p, i) => OPS.js({ code: flowScript(resolve('packages/capture/flows/hover-audit.js'), { tab: `twin-${n}-${i}`, page: `twin${n}${i}`, max: 10 }).code }).then(o => ({ n: o.n, tried: o.tried }), e => ({ error: String(e.message || e).slice(0, 160) }))));
      const wall = (Date.now() - t0) / 1000, cpu = (await cb.cpu()) - cpu0;
      const fps = await Promise.all(pages.map(p => p.evaluate(() => window.__frames).catch(() => 0)));
      out.push({ n, wall: +wall.toFixed(1), perScreen: +(wall / n).toFixed(1), cpuCores: +(cpu / wall).toFixed(2), fps: fps.map(f => Math.round(f / wall)), runs, load: [+l0.toFixed(1), +loadavg()[0].toFixed(1)] });
      log(JSON.stringify(out[out.length - 1]));
      for (const p of pages) await p.close();
    }
    save('twins.json', { app: a.id, out });
  }
} finally { await stop(); }
process.exit(0);
