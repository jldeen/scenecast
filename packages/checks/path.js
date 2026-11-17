// The recorded path through the replica (flow.path), with real mouse and keyboard input (Playwright). No imports,
// so the same text runs in Node (checks/check.mjs) and inside playwright-chrome (a run-through in her Chrome).
//   runPath(page, flow, { checkpoint(name), hold(ms), typeDelay, cursor })
// Each step: { app } switches app (⌥ + its key), { click, dx } clicks an element, { type, text } clicks a field
// and types, { clear } empties a field, { enter } presses Enter, { key } presses a key. A step's checkpoint is
// the state the recording reached; it's checked against the replica's state, then opt.checkpoint(name) runs.
async function runPath(page, flow, opt = {}) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // At a compressed clock (opt.speed, the replica's ?speed=) the pauses between steps shrink too.
  const hold = ms => sleep(opt.hold ? opt.hold(ms) : (opt.speed || 1) > 1 ? 40 : 150);
  const vp = (page.viewportSize && page.viewportSize()) || await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const idle = async () => { await sleep(120); await page.evaluate(() => window.d1.idle()); };
  const mismatches = [];
  const seen = {};
  let cur = { x: Math.round(vp.width * 0.78), y: Math.round(vp.height * 0.6) };
  const move = async (x, y) => {
    const steps = opt.cursor ? Math.max(12, Math.round(Math.hypot(x - cur.x, y - cur.y) / 18)) : 4;
    for (let i = 1; i <= steps; i++) { const k = i / steps, e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; await page.mouse.move(cur.x + (x - cur.x) * e, cur.y + (y - cur.y) * e); }
    cur = { x, y };
  };
  const park = () => move(vp.width - 6, Math.round(vp.height * 0.6));
  const at = async (m, app) => {
    for (let i = 0; i < 40; i++) { const r = await page.evaluate(([m, app]) => window.d1.locate(m, app), [m, app]); if (r && r.w) return r; await sleep(100); }
    throw new Error('not found: ' + JSON.stringify(m));
  };
  // Wheel-scrolls (like a person would) until the target is on screen.
  const reveal = async m => {
    let last = null;
    for (let i = 0; i < 12; i++) {
      const r = await at(m);
      // On screen (its middle inside the window), or scrolling doesn't move it (a fixed header): click it there.
      if ((r.y >= 4 && r.y <= vp.height - 4) || (last && Math.abs(last.y - r.y) < 1)) return r;
      last = r;
      await move(Math.min(Math.max(r.x, 200), vp.width - 200), Math.round(vp.height / 2));
      await page.mouse.wheel(0, Math.max(-700, Math.min(700, r.y - vp.height / 2))); await sleep(opt.speed > 1 ? 150 : 350);
    }
    return at(m);
  };
  const click = async (m, dx) => { const r = await reveal(m); const x = dx === undefined ? r.x : r.x - r.w / 2 + Math.min(dx, r.w - 4); await move(x, r.y); await hold(300); await page.mouse.click(cur.x, cur.y); await hold(400); };
  // The field that has the cursor, through the app's frames: its text, or null when no field has it.
  const activeText = () => page.evaluate(() => { let d = window.d1.doc(), a = d.activeElement; while (a && a.localName === 'iframe' && a.contentDocument) { d = a.contentDocument; a = d.activeElement; } return a && (a.isContentEditable || /^(input|textarea)$/.test(a.localName)) ? (a.value !== undefined && a.localName !== 'div' && a.localName !== 'span' ? a.value : a.innerText || '').trim() : null; });
  const focusField = async m => { if (!(await page.evaluate(m => window.d1.focused(m), m))) await click(m, 40); };
  const selectAll = () => page.keyboard.press('ControlOrMeta+A');
  const keyOf = id => (flow.apps.find(a => a.id === id) || {}).key;
  const check = async name => {
    await idle();
    const n = seen[name] = (seen[name] || 0) + 1;
    const st = await page.evaluate(() => window.d1.state);
    const app = (flow.states[name] || {}).app;
    if (app && st.states[app] !== name) mismatches.push(`${name}: the replica is on ${st.states[app]}`);
    if (opt.checkpoint) await opt.checkpoint(n > 1 ? `${name}@${n}` : name);
  };

  await page.waitForFunction(() => window.d1 && window.d1.state.active);
  await page.keyboard.press('Alt+Digit0'); await idle(); await park();
  for (const s of flow.path || []) {
    if (s.app) { const k = keyOf(s.app); if (k) await page.keyboard.press('Alt+Key' + k.toUpperCase()); else await page.evaluate(id => window.d1.activate(id), s.app); await sleep(200); }
    else if (s.type) {
      await focusField(s.type);
      if (await activeText()) { await selectAll(); await page.keyboard.press('Backspace'); await idle(); }
      await page.keyboard.type(s.text, { delay: opt.typeDelay === undefined ? 4 : opt.typeDelay });
      await hold(400);
    } else if (s.clear) { await focusField(s.clear); await selectAll(); await page.keyboard.press('Backspace'); await hold(300); }
    else if (s.enter) { await page.keyboard.press('Enter'); await park(); }
    else if (s.click) { await click(s.click, s.dx); await park(); }
    else if (s.key) { await page.keyboard.press(s.key); }
    if (s.checkpoint) { await check(s.checkpoint); await hold(800); }
  }
  await park(); await idle();
  return { mismatches };
}
