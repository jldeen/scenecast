// Gets each app's tab to its start screen before recording, and reports whether each is in light mode.
// ARGS: { apps: [{ id, match, url }] } (replica run capture/prep.js passes demo.json's apps).
const out = {};
for (const a of ARGS.apps || []) {
  let p = null; try { p = await H.pageFor(a.match); } catch (e) {}
  if (!p) { p = await ctx.newPage(); await p.goto(a.url, { waitUntil: 'domcontentloaded' }); }
  await p.bringToFront(); await sleep(3000);
  // Get to the start screen here (open a channel, close a banner): clicks by text or label, never by class.
  out[a.id] = { url: p.url().split('?')[0].slice(0, 80), light: await lightness(p) };
}
return out;
