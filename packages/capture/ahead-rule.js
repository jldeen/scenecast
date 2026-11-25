// Sweep ahead's rule (record.auto.ahead, recorder.js): a screen swept ahead in a twin window, during an answer, counts as
// the run's own sweep of that screen only where the run would have swept it exactly so now. So every screen's hovers
// and zoom levels are the same with sweep ahead on or off; the only cost of a miss is twin time.
//   hovers  the controls the twin tried, in order, are the ones this screen would try now: its candidates, less
//           those hovered on another screen of the app since (seen), less the kinds that never show (skipSels), up
//           to max; and with the same wait for each to show. A twin stopped by the answer's end, or out of time,
//           part way: not used.
//   zoom    the twin's screen kind is this screen's, and still new now (zoom runs once per kind of screen), and it
//           went through every level.
// Inlined by build.mjs ahead of recorder.js; ahead-rule.test.mjs loads it the same way.
function aheadTodo(cands, { seen = [], skipSels = [], max = 0 } = {}) {
  const s = new Set(seen), k = new Set(skipSels);
  const todo = (cands || []).filter(c => !s.has(c.sel + '|' + c.text) && !k.has(c.sel)).map(c => c.sel + '|' + c.text);
  return max ? todo.slice(0, max) : todo;
}
function aheadFits(ahead, now) {
  const out = { hovers: false, zoom: false, why: [] };
  const h = ahead && ahead.hovers;
  if (!h) out.why.push('no hovers ahead');
  else if (h.stopped || h.timedOut || h.error) out.why.push(`its hovers stopped part way (${h.stopped ? 'the answer ended' : h.timedOut ? 'out of time' : h.error})`);
  else if (now.waitMs !== undefined && h.waitMs !== now.waitMs) out.why.push(`its hovers waited ${h.waitMs} ms for each, this screen's wait is ${now.waitMs} ms now`);
  else {
    const want = aheadTodo(now.cands, now), got = h.keys || [];
    if (JSON.stringify(want) === JSON.stringify(got)) out.hovers = true;
    else out.why.push(`its hovers aren't this screen's now (${got.length} tried ahead, ${want.length} to try)`);
  }
  const z = ahead && ahead.zoom;
  if (z && z.complete && now.newKind && now.kind === z.kind) out.zoom = true;
  else if (z) out.why.push(!z.complete ? 'its zoom levels stopped part way' : !now.newKind ? 'its kind of screen has had its zoom levels' : 'another kind of screen');
  return out;
}
