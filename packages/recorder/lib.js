// Prepended to every capture flow script (cli.mjs run). In scope: ctx, page, H (driver helpers).
const sleep = H.sleep;

async function tabOf(kind) { return H.pageFor(kind); }
async function emulate(p, w = 1920, h = 1080, dpr = 2) {
  const s = await ctx.newCDPSession(p);
  await s.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile: false, screenWidth: w, screenHeight: h });
  return s;
}
async function waitFor(p, fn, arg, s = 30, frame) { for (let i = 0; i < s * 2; i++) { const f = frame ? H.frameFor(p, frame) : p.mainFrame(); const r = await f.evaluate(fn, arg).catch(() => null); if (r) return r; await sleep(500); } return null; }
// A sign-in account picker that shows up again mid-run: clicks the account (ARGS.account or the one given).
async function pickAccount(p, account = ARGS.account) {
  if (!account) return false;
  for (const f of p.frames()) { try { const el = f.getByText(account, { exact: false }).first(); if (await el.count() && await el.isVisible()) { await el.click({ timeout: 3000 }); return true; } } catch (e) {} }
  return false;
}
async function clickFind(p, spec, what) { const pt = await H.find(p, spec); if (!pt) throw new Error('not found: ' + (what || JSON.stringify(spec))); await p.mouse.move(pt.x, pt.y, { steps: 5 }); await sleep(120); await p.mouse.click(pt.x, pt.y); return pt; }
async function lightness(p) {
  return p.evaluate(() => { const c = getComputedStyle(document.elementFromPoint(innerWidth / 2, innerHeight / 2) || document.body).backgroundColor; return { bg: c, dark: matchMedia('(prefers-color-scheme: dark)').matches }; }).catch(e => String(e));
}
