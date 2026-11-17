// The order focus points play in, shared by the flow compiler (focus.json and focus.mjs merged into flow.focus), the
// script matcher and the editor. ⌥F steps through flow.focus in array order, and a beat key starts at its first point,
// so the list is sorted by beat, then by where its screen comes in the run-through, keeping the order within a screen.

// The run-through as a list of screens: where ⌥0 starts, then each step's checkpoint (a screen can come back later).
export function stateSequence(flow) {
  const S = flow.states || {}, seq = [];
  const push = (id, step) => { if (id && S[id] && (!seq.length || seq[seq.length - 1].state !== id)) seq.push({ state: id, app: S[id].app, step }); };
  const b0 = (flow.beats || [])[0];
  if (b0) push(b0.states[b0.active], null);
  (flow.path || []).forEach((st, i) => push(st.checkpoint, i));
  // Screens a beat starts on that the path doesn't reach, then any others, at the end in the flow's order.
  const seen = new Set(seq.map(x => x.state));
  for (const b of (flow.beats || []).slice(1)) { const id = b.states[b.active]; if (id && S[id] && !seen.has(id)) { seq.push({ state: id, app: S[id].app, step: null }); seen.add(id); } }
  for (const id of Object.keys(S)) if (!seen.has(id) && !S[id].fallback) { seq.push({ state: id, app: S[id].app, step: null }); seen.add(id); }
  return seq;
}

// Where each beat (⌥0 … ⌥9) lands in the sequence: the first time its active app's screen comes, after the beat before.
export function beatPositions(flow, seq = stateSequence(flow)) {
  const out = []; let from = 0;
  (flow.beats || []).forEach((b, k) => {
    const id = b.states[b.active];
    let at = seq.findIndex((x, i) => i >= from && x.state === id);
    if (at < 0) at = seq.findIndex(x => x.state === id);
    out.push(k === 0 ? 0 : at);
    if (at >= 0) from = at;
  });
  return out;
}
// The ⌥ beat key that lands just before a position in the sequence.
export function beatAt(pos, beats) {
  let k = 0;
  beats.forEach((p, i) => { if (p >= 0 && p <= pos && i >= k) k = i; });
  return k;
}

export function orderFocus(points, flow) {
  const seq = stateSequence(flow), first = new Map();
  seq.forEach((x, i) => { if (!first.has(x.state)) first.set(x.state, i); });
  const pos = p => Math.min(...(p.states || []).map(s => first.has(s) ? first.get(s) : 1e9), 1e9);
  return points.map((p, i) => ({ p, i, b: Number.isInteger(p.beat) ? p.beat : 0, s: pos(p) })).sort((a, b) => a.b - b.b || a.s - b.s || a.i - b.i).map(x => x.p);
}

// focus.json points and focus.mjs points together: focus.json's first within a screen (the script's and the editor's).
export const mergeFocus = (fromJson, fromMjs, flow) => orderFocus([...(fromJson || []), ...(fromMjs || [])], flow);
