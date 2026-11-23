// Spike (stage C): the account picker, and what gets around it with no click. Every window minimized, nothing clicked
// on any page. For each case and app: where it landed (the app, a sign-in page, the picker), how many accounts a
// picker lists (a count, never who), the tenants the app's sign-in library holds (the demo's, another, none), and
// how often the account was pinned. The tenant and account come from the command line, never from this file.
//   node spikes/capture-browser/picker.mjs --demo <dir> --profile <dir> --out <dir> [--only a,b]
//        --tenant <domain or id> --login-hint <account> [--domain-hint <domain>] [--cases a,b]
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openCaptureBrowser, landedOn, resolveTenant } from '@stuntdouble/capture/browser.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const OUT = resolve(arg('--out', 'picker-out')), PROFILE = resolve(arg('--profile'));
mkdirSync(OUT, { recursive: true });
const only = arg('--only') ? arg('--only').split(',') : null;
const APPS = JSON.parse(readFileSync(join(resolve(arg('--demo')), 'demo.json'), 'utf8')).apps
  .filter(a => a.url && /^https?:/.test(a.url) && (!only || only.includes(a.id))).map(a => ({ id: a.id, url: a.url, match: a.match }));
const want = await resolveTenant(arg('--tenant'));
const pin = { loginHint: arg('--login-hint') || null, domainHint: arg('--domain-hint') || null };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => { const s = `${new Date().toISOString().slice(11, 19)} ${a.join(' ')}`; console.log(s); writeFileSync(join(OUT, 'picker.log'), s + '\n', { flag: 'a' }); };

const CASES = {
  'fresh-sso-on': { profile: null, macSso: true },
  'fresh-sso-off': { profile: null, macSso: false },
  'demo-sso-off': { profile: PROFILE, macSso: false },
  'demo-pinned': { profile: PROFILE, macSso: false, pin: true },
  'demo-pinned-restart': { profile: PROFILE, macSso: false, pin: true },
};
const res = {};
for (const name of (arg('--cases') || Object.keys(CASES).join(',')).split(',')) {
  const c = CASES[name];
  const cb = await openCaptureBrowser({ profile: c.profile, window: 'minimized', macSso: c.macSso, width: 1400, height: 800, log: m => log(name, m) });
  if (!cb) { res[name] = { error: 'no browser' }; continue; }
  const pinned = c.pin ? await cb.pinAccount(pin) : null;
  const r = res[name] = {};
  // Side by side, each in its own window; then a minute for redirects and silent sign-ins to settle.
  const pages = await Promise.all(APPS.map(a => cb.open(a)));
  await Promise.all(pages.map(p => p.waitForLoadState('load', { timeout: 60000 }).catch(() => {})));
  await sleep(15000);
  for (const [i, a] of APPS.entries()) {
    const p = pages[i];
    const text = await p.evaluate(() => document.body ? document.body.innerText.slice(0, 6000) : '').catch(() => '');
    const l = landedOn(p.url(), text, a.match);
    const ten = (await cb.tenantsOf({ [a.id]: p }))[a.id];
    r[a.id] = {
      at: l.at, host: l.host,
      picker: /pick an account/i.test(text), accountsListed: (text.match(/\bSigned in\b/g) || []).length,
      tenants: ten.map(t => t === want ? 'demo' : 'other'),
    };
    writeFileSync(join(OUT, `${name}-${a.id}.png`), await p.screenshot().catch(() => Buffer.alloc(0)));
  }
  if (pinned) r.pinned = pinned.pinned();
  log(name, JSON.stringify(r));
  await cb.close();
}
writeFileSync(join(OUT, 'picker.json'), JSON.stringify({ apps: APPS.map(a => a.id), res }, null, 1));
process.exit(0);
