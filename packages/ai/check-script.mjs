// Check my script: before a recording, where a run of this plan would likely stop, and where it would only mark a
// beat, from a read-only live walk (walk.mjs statuses) and the run's own rules:
//   - a write never follows a step it couldn't prove (unproven, words drifted, a miss), since the app's last proven
//     screen; a wait, hover or scroll with no proof of its own carries the screen before it;
//   - a write needs its app pack's write, with an undo, for the reset after;
//   - the demo starts as it should (reset.md's Check), and the apps showed her as she should be.
// Steps after a write in its beat can't be walked read-only (their screens need the write). They're checked by rule:
// a proof there that quotes the words the app wrote (an answer's sentences, a quoted name) won't be there on another
// day, so it's a doubt; a control, or a short phrase of the product's own, is fine.
// → { stops: [{ beat, step, text, why, fix }], marks: [same], unchecked: n, ok }

import { formatStep } from './plan.mjs';

const TAG = / · ([\w-]+):([\w-]+)$/;
// A wait, hover or scroll, and a step group opened by its place, carry the proven screen before them (a run's rule).
const GROUP = /^\d+ (?:items?|background tasks?) complete\b/i;
const carries = s => /^(wait|hover|scroll)$/.test(s.kind) || (s.kind === 'click' && GROUP.test(s.target || ''));
// Words an app wrote, not its own interface: a sentence (6 words or more), or a quoted name in it.
export const answerLike = text => /['"‘’“”]/.test(text) || String(text).trim().split(/\s+/).length >= 6;

const GREETING = /^(hi|hello|hey|good (morning|afternoon|evening)|welcome back)\b/i;
const pn = t => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();

// names: each app's name as the window shows it ({ id: title }). titleOf: a recorded screen's page title (the name
// the app gave a new chat, on the screen a send made).
export function predictStops(plan, walk, { writeKnown = () => ({ ok: true }), names = {}, titleOf = () => null } = {}) {
  const stops = [], marks = [];
  let unchecked = 0;
  const row = (bi, si, s, why, fix) => ({ beat: bi + 1, step: si + 1, text: s ? s.text || null : null, why, ...(fix ? { fix } : {}) });
  const name = id => names[id] || (id ? id[0].toUpperCase() + id.slice(1) : 'An app');
  // A start check as she'd say it: "teams on teams: renders light" is Teams, "renders light".
  const said = t => { const m = /^([\w-]+)(?: on [\w-]+)?:\s*(.+)$/.exec(t || ''); return m ? `${name(m[1])}: ${m[2]}` : t || ''; };
  const c = walk.check;
  // The engine's words stay in detail (the CLI's answer), never in what the window shows.
  if (c && c.error) stops.push({ ...row(-1, -1, null, 'Before it starts, its checks stopped with an error', 'Check again. If it stops the same way, what went wrong is under Details'), detail: c.error });
  else if (c && (c.wrong || c.cant)) for (const l of (c.lines || []).filter(l => l.status !== 'pass')) stops.push({ ...(l.status === 'wrong'
    ? row(-1, -1, { text: l.text }, `Before it starts, the demo isn't as it should be (${said(l.text)})`, 'Put the demo back as it starts, then check again')
    : l.plan ? row(-1, -1, { text: l.text }, `Before it starts, it can't check this with the plan as it is (${said(l.text)})`, 'Make the plan again: its start checks are made with it')
      : l.setup ? row(-1, -1, { text: l.text }, `Before it starts, it can't check this (${said(l.text)}): the demo's reset or its app's pack doesn't say how`, 'Fix that check in the demo\'s reset or the app\'s pack (what\'s missing is under Details), then check again')
      : row(-1, -1, { text: l.text }, `Before it starts, it couldn't check this (${said(l.text)})${l.why ? `: ${l.why}` : ''}`, 'Open the demo where it starts, then check again')), ...(l.why ? { detail: l.why } : {}) });
  for (const o of walk.ownStatus || []) if (!o.ok) stops.push(row(-1, -1, null, o.error || `${name(o.app)} showed you as ${o.status}, not ${(o.expect || []).join(' or ')}`, 'Start again while you\'re at your computer, with that app open'));
  // Each app's start screen, as the run checks it before its first step.
  for (const st of walk.starts || []) if (st.ok === false) stops.push(row(-1, -1, null, `${name(st.app)} isn't where the demo starts: ${(st.why || 'not as the plan has it').replace(new RegExp(`^${st.app}\\b`), name(st.app))}`, 'Open it where the demo starts, or fix its start in the plan'));
  // The doubt a run carries in each app, since its last proven screen there.
  const doubt = {};
  let app = null;
  // What she typed: a proof that quotes it is her words in a box, not the app's.
  const typed = plan.beats.flatMap(b => b.steps).filter(s => s.kind === 'type' && s.value).map(s => s.value);
  const hers = text => typed.some(v => v.includes(text));
  // The screen each step starts from: the last one the plan landed on before it.
  const startsOn = new Map();
  let landed = null;
  for (const st of plan.beats.flatMap(b => b.steps)) { startsOn.set(st, landed); if (st.lands && st.lands.screen) landed = st.lands.screen; }
  for (const [bi, beat] of plan.beats.entries()) {
    const rows = ((walk.beats || [])[bi] || { steps: [] }).steps;
    // Blind: the rest of the beat needs a write the walk didn't run (after it, or after a miss it caused).
    let blind = false;
    for (const [si, s] of beat.steps.entries()) {
      const r = rows[si] || { status: 'after-write' };
      // Hers to do, or not a step it can do: a run stops there (needs you), whatever comes after.
      if (s.kind === 'manual' || s.kind === 'free') { stops.push(row(bi, si, { text: r.text || formatStep(s) }, s.kind === 'manual' ? "it's yours to do, and a run on its own stops there" : "it isn't a step a run can do on its own", 'Make it a step Copilot can do, or move it to the reset')); continue; }
      if (r.status === 'missed' && r.needs) blind = true;
      if (r.status === 'after-miss' && !blind && !s.writes) continue;
      const text = r.text || formatStep(s);
      if (s.kind === 'app') app = s.app;
      const tag = s.writes && TAG.exec(s.writes);
      const isWrite = r.status === 'write' || !!s.writes;
      if (isWrite) {
        const d = doubt[app];
        if (d) stops.push(row(bi, si, { text }, `a write after a step it couldn't prove (step ${d.step}: ${d.why})`, d.fix));
        const k = tag ? writeKnown(tag[1], tag[2]) : { ok: false, why: 'the plan names no app pack write for it' };
        if (!k.ok) stops.push(row(bi, si, { text }, `no undo for this write: ${k.why}`, 'Add the write to its app pack, with its undo'));
        // A run checks where a write lands, after it: its proof can't be words the app writes there.
        const l = s.lands;
        // What the app makes up: an answer's words, a greeting, or the name it gave the new chat.
        // A title the write gave its screen: not the one the screen before it had.
        const title = l && l.screen ? pn(titleOf(l.screen)) : '';
        const titled = !!title && title !== pn(titleOf(startsOn.get(s)));
        // The title can be a control's name too (the new chat's link in Recent).
        const said = l && (l.kind === 'words' ? l.text : l.kind === 'control' ? l.control : null);
        const made = !!said && ((l.kind === 'words' && ((!hers(said) && answerLike(said)) || GREETING.test(said.trim()))) || (titled && (pn(said) === title || title.includes(pn(said)) || pn(said).includes(title))));
        if (made) stops.push(row(bi, si, { text }, `its proof is words the app makes up ("${said.slice(0, 60)}"), and they change from run to run`, 'Prove it by a control on that screen, such as its message box'));
        doubt[app] = null;
        if (r.status === 'write') continue;
      }
      // lasts: until the app's next write, as an unproven landing does in a run (writeGate looks back to it); a drifted
      // or missed step is only marked there, and the next proven step clears it.
      const set = (why, fix, lasts = true) => { if (!doubt[app] || (lasts && !doubt[app].lasts)) doubt[app] = { step: si + 1, why, fix, lasts }; marks.push(row(bi, si, { text }, why, fix)); };
      const proven = () => { if (doubt[app] && !doubt[app].lasts) doubt[app] = null; };
      const ruled = r.status === 'after-write' || blind || (r.status === 'drifted' && r.needs);
      if (!ruled && r.status === 'reached') proven();
      // A wait or scroll carries the screen it's on only when nothing before it in the app is in doubt (the run's own
      // rule): after a doubt, its unproven landing counts against the next write. A hover or a step group's click is
      // proven by its own control, or only marked.
      else if (!ruled && r.status === 'unproven' && carries(s) && (s.target || !doubt[app])) continue;
      else if (!ruled && r.status === 'unproven') set(`nothing proves where it lands${r.why ? ` (${r.why})` : ''}`, 'Give it a Lands on: a control or words that only show once it has run');
      else if (!ruled && r.status === 'drifted') set(`the words it lands on aren't on the screen today${r.why ? ` (${r.why})` : ''}`, r.seen && r.seen.headings && r.seen.headings.length ? `Today the screen says: ${r.seen.headings.slice(0, 3).map(h => `"${h}"`).join(', ')}` : 'Land on what the screen says today', false);
      else if (!ruled && r.status === 'missed') set(`it can't be done today: ${r.why || 'not there'}`, r.needs ? `It may need ${r.needs}` : null, false);
      else if (ruled) {
        unchecked++;
        const l = s.lands;
        if (l && l.kind === 'words' && l.text && answerLike(l.text) && !hers(l.text)) set(`its proof quotes words the app wrote ("${l.text.slice(0, 60)}"), and they change from run to run`, 'Prove it by a control on that screen, or a short phrase of the product\'s own');
        else if (l && l.kind) proven();
        else if (!carries(s)) set('nothing proves where it lands, and it can only be seen once the write before it runs', 'Give it a Lands on: a control on that screen')
      }
    }
  }
  return { stops, marks, unchecked, ok: !stops.length };
}

// The live check: a read-only walk of the demo's plan in the capture browser (walkLive), then the stops it predicts.
// Saved as .out/ai/check-script.json for the app. → predictStops' result, with the walk's time.
export async function checkScript({ demo, emit = () => {}, cmd }) {
  const [{ walkLive }, { walkerPacks }, { packIndex }, { readPlan }, { aiDir }, fs, path] = await Promise.all([import('./unattended.mjs'), import('./live.mjs'), import('./check-lines.mjs'), import('./draft.mjs'), import('./run.mjs'), import('node:fs'), import('node:path')]);
  const packs = await walkerPacks();
  const plan = readPlan(demo);
  const walk = await walkLive({ demo, emit, cmd, packs });
  const idx = packIndex(packs, demo.cfg);
  const writeKnown = (packId, writeId) => {
    const p = idx.byId(packId), w = p && (p.writes || []).find(x => x.id === writeId);
    if (!p) return { ok: false, why: `no app pack called ${packId} is loaded` };
    if (!w) return { ok: false, why: `the ${packId} pack doesn't list ${writeId}` };
    return w.undo ? { ok: true } : { ok: false, why: `the ${packId} pack's ${writeId} has no undo` };
  };
  const names = Object.fromEntries((demo.cfg.apps || []).map(x => [x.id, x.title || x.id]));
  const { walkerFromDemo } = await import('./walker.mjs');
  const rec = walkerFromDemo(demo);
  const titleOf = id => { const t = ((rec && rec.screen(id)) || {}).title; return t && t !== id ? t : null; };
  const r = { ...predictStops(plan, walk, { writeKnown, names, titleOf }), secs: walk.secs };
  fs.mkdirSync(aiDir(demo), { recursive: true });
  fs.writeFileSync(path.join(aiDir(demo), 'check-script.json'), JSON.stringify(r, null, 1) + '\n');
  return r;
}
