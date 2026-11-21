// Preflight, on the recorder (scenecast preflight runs it; the same as replica-kit's replica preflight): each app's tab is open and on its start screen (light or dark).
// It only reads, and doesn't bring tabs to the front. With ARGS.fix it acts on what failed: a missing tab is opened
// at the app's URL, and a tab that isn't on its start screen loads the app's URL again. Then it checks again.
// A tab it opens is found the way Record finds it (pageFor, by the app's match). One that ended up on another host:
// a sign-in page says so (o.signIn); otherwise the tab is marked as the app's (d1tab) and o.moved has its host, which
// scenecast preflight keeps as the app's match. A tab it can't find comes back with the open tabs (_tabs), so the
// app can ask which one it is.
// ARGS: { apps: [{ id, match, url, start?: { url?, text?, sel? } }], fix, waitS }
const DARK = 0.35;
async function probe(p, start) {
  const run = p.evaluate(start => {
    const lum = (c, a0 = 0.5) => { const m = /rgba?\(([^)]+)\)/.exec(c || ''); if (!m) return null; const v = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); if (v.length > 3 && v[3] < a0) return null; return (0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]) / 255; };
    // The background under a point: the first element up from it that paints one (into same-origin frames).
    const bgAt = (doc, x, y) => {
      let e = doc.elementFromPoint(x, y);
      if (e && e.localName === 'iframe') { try { const r = e.getBoundingClientRect(), d = e.contentDocument; if (d && d.documentElement) return bgAt(d, x - r.x, y - r.y); } catch (er) {} }
      const cs = el => doc.defaultView.getComputedStyle(el);
      for (; e; e = e.parentElement) { const l = lum(cs(e).backgroundColor); if (l !== null) return l; }
      const root = lum(cs(doc.documentElement).backgroundColor, 0.01);
      return root === null ? (doc.defaultView.matchMedia('(prefers-color-scheme: dark)').matches && /dark/.test(cs(doc.documentElement).colorScheme) ? 0 : 1) : root;
    };
    const W = innerWidth, H = innerHeight;
    const ls = [[0.5, 0.5], [0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7], [0.5, 0.12], [0.12, 0.5]].map(([a, b]) => bgAt(document, W * a, H * b)).sort((a, b) => a - b);
    const norm = s => (s || '').replace(/\s+/g, ' ').trim();
    const shown = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const at = start ? {
      url: start.url ? new RegExp(start.url).test(location.href) : undefined,
      text: start.text ? norm(document.body && document.body.innerText).includes(norm(start.text)) : undefined,
      sel: start.sel ? [...document.querySelectorAll(start.sel)].some(shown) : undefined,
    } : null;
    return { url: location.href.split(/[?#]/)[0].slice(0, 120), title: document.title.slice(0, 80), lum: Math.round(ls[3] * 100) / 100, prefersDark: matchMedia('(prefers-color-scheme: dark)').matches, ready: document.readyState, start: at };
  }, start || null);
  return Promise.race([run.catch(e => ({ error: String(e.message || e).slice(0, 160) })), sleep(6000).then(() => ({ error: 'the tab doesn\'t answer (asleep or discarded?): bring it to the front once' }))]);
}
const startOk = r => !r.start ? null : Object.values(r.start).every(v => v !== false);
const say = msg => (typeof rlog === 'function' ? rlog('preflight: ' + msg) : Promise.resolve()).catch(() => {});
// A tab that's loading: its start screen, for at most s seconds in all (a page that never answers, or an error page,
// doesn't hold the check up).
async function waitStart(p, a, s) {
  let r = null;
  const until = Date.now() + s * 1000;
  while (Date.now() < until) {
    await sleep(500);
    if (/^chrome-error:|^edge-error:/.test(p.url())) { r = { error: `${a.id} didn't load (${p.url().slice(0, 60)})` }; break; }
    r = await probe(p, a.start);
    if (!r.error && r.ready !== 'loading' && startOk(r) !== false) break;
  }
  if (r && r.error) { await say(`${a.id}: ${r.error} at ${p.url().slice(0, 120)}`); return r; }
  if (!a.start) await sleep(1500);
  return a.start ? r : await probe(p, a.start);
}
const SIGN_IN = /(^|\.)(login|signin|sign-in|auth|sso|accounts|adfs)[.-]|login\.microsoftonline\.com|login\.live\.com|accounts\.google\.com/i;
const hostOf = u => { try { return new URL(u).host; } catch (e) { return ''; } };
// Where a tab it opened or reloaded ended up: still the app's (found by match), moved to another host, or a sign-in.
async function landed(p, a, o) {
  const url = p.url(), host = hostOf(url);
  await say(`${a.id}: opened ${a.url}, landed on ${url.slice(0, 120)}`);
  if (!a.match || url.includes(a.match)) return;
  if (SIGN_IN.test(host)) { o.signIn = host; return; }
  await Promise.race([H.mark(p, a.match).catch(() => {}), sleep(4000)]);
  o.moved = { host, url: url.split(/[?#]/)[0] };
}
const out = {};
let missing = false;
for (const a of ARGS.apps || []) {
  const o = out[a.id] = { fixed: [] };
  let p = null; try { p = await H.pageFor(a.match); } catch (e) {}
  if (!p && ARGS.fix && a.url) {
    await say(`${a.id}: no tab with ${a.match}; opening ${a.url}`);
    const t0 = Date.now();
    p = await ctx.newPage(a.url, { direct: true });
    // Playwright's agent opens a blank page: it goes to the address itself.
    if (!/^https?:|^file:/.test(p.url())) await p.goto(a.url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => say(`${a.id}: goto: ${e.message || e}`));
    await say(`${a.id}: tab open in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    o.fixed.push('opened'); o.r = await waitStart(p, a, ARGS.waitS || 20);
    await landed(p, a, o);
  }
  if (!p) { o.missing = true; missing = true; continue; }
  o.r = o.r || await probe(p, a.start);
  if (ARGS.fix && !o.r.error && startOk(o.r) === false && a.url) {
    await p.goto(a.url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    o.fixed.push('start'); o.r = await waitStart(p, a, ARGS.waitS || 20);
    await landed(p, a, o);
  }
  o.light = o.r.error ? null : o.r.lum >= DARK;
  o.onStart = o.r.error ? null : startOk(o.r);
}
// Which tab is it? The open tabs, by title and address, for an app it couldn't find.
if (missing) { try { out._tabs = (await H.tabs()).filter(t => /^https?:/.test(t.url)).map(t => ({ title: t.title, url: t.url.split(/[?#]/)[0], host: hostOf(t.url) })); } catch (e) { out._tabs = []; } }
return out;
