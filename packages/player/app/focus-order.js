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

const beatOf = p => Number.isInteger(p.beat) ? p.beat : 0;
function screenPos(flow) {
  const first = new Map();
  stateSequence(flow).forEach((x, i) => { if (!first.has(x.state)) first.set(x.state, i); });
  return p => Math.min(...(p.states || []).map(s => first.has(s) ? first.get(s) : 1e9), 1e9);
}

export function orderFocus(points, flow) {
  const pos = screenPos(flow);
  return points.map((p, i) => ({ p, i, b: beatOf(p), s: pos(p) })).sort((a, b) => a.b - b.b || a.s - b.s || a.i - b.i).map(x => x.p);
}

// focus.json points (the script's and the editor's) placed among focus.mjs points. Hand-written points keep the order
// their author wrote within a beat (a beat can go from one screen to another and back: LTG1189's session log, its
// trace, then the log again), grouped by beat so a beat key starts at its first point; each focus.json point goes
// before the first hand-written one of a later beat, or of its beat on a screen that comes no sooner than its own.
export function mergeFocus(fromJson, fromMjs, flow) {
  const pos = screenPos(flow);
  const out = (fromMjs || []).map((p, i) => ({ p, i, b: beatOf(p), s: pos(p), hand: true })).sort((a, b) => a.b - b.b || a.i - b.i);
  let from = 0;
  for (const p of orderFocus(fromJson || [], flow)) {
    const g = { p, b: beatOf(p), s: pos(p) };
    let at = out.findIndex((h, k) => k >= from && h.hand && (h.b > g.b || (h.b === g.b && h.s >= g.s)));
    if (at < 0) at = out.length;
    out.splice(at, 0, g); from = at + 1;
  }
  return out.map(x => x.p);
}
