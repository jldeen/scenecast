// Each beat in plain words, from the recorded path: a name for what's on screen when it starts ("Copilot: after
// “Summarize…”", not "copilot: copilot-03-summarize-the-supp") and the steps the presenter does in it ("Click
// **Library**", "Type `…`, then **Enter**"). The beat labels (⌥1–⌥9) and, until there's a script, the presenter guide
// (presenter/notes.json) come from it, so a fresh recording says where a prompt or a click is expected.
const clip = (s, n = 60) => { s = String(s || '').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };
const appTitle = (flow, id) => ((flow.apps || []).find(a => a.id === id) || {}).title || id;
const appKey = (flow, id) => ((flow.apps || []).find(a => a.id === id) || {}).key;

// What a click was on: its text, else its aria-label.
export function controlName(spec) {
  if (!spec) return '';
  if (spec.text) return clip(spec.text, 48);
  const m = /aria-label="([^"]+)"/.exec(spec.sel || '') || /aria-label='([^']+)'/.exec(spec.sel || '');
  return m ? clip(m[1], 48) : '';
}

function stepText(flow, s, typed) {
  if (s.app) { const k = appKey(flow, s.app); return `Switch to **${appTitle(flow, s.app)}**${k ? ` (**⌥${k.toUpperCase()}**)` : ''}`; }
  if (s.click) { const n = controlName(s.click); return n ? `Click **${n}**` : 'Click the control'; }
  if (s.type) return `Type \`${clip(s.text, 200)}\` (**⌥P** types it)`;
  if (s.enter) return typed ? 'Press **Enter**: the answer streams in' : 'Press **Enter**';
  if (s.key === 'Escape') return 'Press **Esc**';
  return null;
}

// One entry per flow beat: { title, do: [text] }. Beat 0 is the reset (⌥0); the rest follow the recorded path.
export function beatSteps(flow) {
  const beats = flow.beats || [], path = flow.path || [], states = flow.states || {};
  const out = beats.map(() => ({ title: '', do: [], landing: null }));
  if (!beats.length) return out;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const cur = { ...(beats[0].states || {}) };
  let active = beats[0].active, j = 1, pending = [], typed = '';
  const landing = [];
  for (const s of path) {
    if (s.app) active = s.app;
    if (s.checkpoint && states[s.checkpoint]) { cur[states[s.checkpoint].app] = s.checkpoint; active = states[s.checkpoint].app; }
    if (s.type) typed = s.text || typed;
    const t = stepText(flow, s, typed);
    if (t) pending.push(t);
    landing.push({ s, typed });
    if (s.enter || s.click) typed = s.enter ? '' : typed;
    while (j < beats.length && beats[j].active === active && same(beats[j].states, cur)) {
      // The steps up to here led into beat j: they're beat j-1's to do (beat 1's first step is the start itself).
      if (j > 1) out[j - 1].do.push(...pending);
      out[j].landing = landing[landing.length - 1];
      pending = []; j++;
    }
  }
  if (j > 1) out[j - 1].do.push(...pending);
  out.forEach((b, i) => {
    const app = beats[i].active, A = appTitle(flow, app), l = b.landing && b.landing.s;
    b.title = i === 0 ? 'Reset'
      : !l || l.app || i === 1 ? `${A}: start`
      : l.enter ? `${A}: after “${clip(b.landing.typed || controlName(l.enter), 48)}”`
      : l.click ? `${A}: ${controlName(l.click) || 'after a click'}`
      : A;
    delete b.landing;
  });
  return out;
}

// The beat labels the app and the stage show: "3 Copilot: Library".
export function plainLabels(flow) {
  const steps = beatSteps(flow);
  (flow.beats || []).forEach((b, i) => { if (i > 0) b.label = `${i} ${steps[i].title}`; });
  return flow;
}

// A script (Markdown, as notes.mjs reads it) from the recording alone: the presenter guide before there's a real script.
export function scriptFromFlow(flow, title) {
  const steps = beatSteps(flow);
  let md = `# ${title || 'Demo'}\n\n`;
  for (let i = 1; i < steps.length; i++) {
    md += `## ${i}. ${steps[i].title}\n\n**Do**\n\n`;
    md += (steps[i].do.length ? steps[i].do : ['(Nothing to click: talk over this screen.)']).map(d => `- ${d}`).join('\n') + '\n\n';
  }
  return md;
}
