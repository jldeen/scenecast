// Make it from my script, on a small recorded demo (two apps, seven screens): a talk track to the plan (steps on the
// real controls, where they land, what they write, what differs), the reset from its writes, the one approval, a
// walkthrough to the same plan, and the finish (focus points with via, her script for the guide).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatPlan, parsePlan } from './plan.mjs';
import { walkerFromDemo } from './walker.mjs';
import { planFromTrack, intentsOf } from './from-script.mjs';
import { planFromRecording } from './walkthrough.mjs';
import { resetFor, formatReset } from './reset.mjs';
import { approve, approval } from './make.mjs';
import { pointsFromPlan, guideScript, beatStarts, beatTimings } from './finish.mjs';
import { parseTalkTrack } from '../script/talk.mjs';
import { parseScript as guideParse } from '../kit/lib/notes.mjs';
import { checkFocusJson } from '../kit/lib/overrides.mjs';

const BOX = { sel: 'div[role=textbox][contenteditable=true]' };
function demoDir() {
  const dir = mkdtempSync(join(tmpdir(), 'sc-make-'));
  const flow = {
    apps: [{ id: 'chat', key: 'C' }, { id: 'admin', key: 'A' }],
    states: {
      'chat-home': { app: 'chat', snap: 'chat-home', on: [{ type: BOX, to: 'chat-typed' }], fill: [{ ...BOX, value: "What's changed on PO-1?" }] },
      'chat-typed': { app: 'chat', snap: 'chat-typed', on: [{ enter: BOX, stream: 'ask' }] },
      'chat-answer': { app: 'chat', snap: 'chat-answer', on: [{ click: { sel: 'button[aria-label="Save: Save note"]' }, to: 'chat-saved' }, { click: { sel: '[role=tab]', text: 'Sources' }, to: 'chat-sources' }] },
      'chat-saved': { app: 'chat', snap: 'chat-saved' },
      'chat-sources': { app: 'chat', snap: 'chat-sources' },
      'admin-home': { app: 'admin', snap: 'admin-home', on: [{ click: { sel: 'button[aria-label="Certified"]' }, to: 'admin-certified' }, { click: { sel: 'button[aria-label="Add one seat"]' }, to: 'admin-seat' }] },
      'admin-certified': { app: 'admin', snap: 'admin-certified' },
      'admin-seat': { app: 'admin', snap: 'admin-seat' },
    },
    streams: { ask: { to: 'chat-answer' } },
    beats: [{ active: 'chat', states: { chat: 'chat-home', admin: 'admin-home' } }, { active: 'admin', states: { chat: 'chat-home', admin: 'admin-home' } }],
    path: [],
  };
  const page = body => `<!doctype html><html><head><title>t</title><style>p{color:red}</style></head><body>${body}</body></html>`;
  const box = '<div role="textbox" contenteditable="true" aria-label="Message"></div>';
  const snaps = {
    'chat-home': `<h1>New chat</h1>${box}`,
    'chat-typed': `<h1>New chat</h1>${box}`,
    'chat-answer': `<h2>Kestrel delay answer</h2><p>Kestrel moved the ship date by six days.</p><p>That puts about $35,073 in penalties at risk with Brightline.</p><section><h3>Save note</h3><button aria-label="Save: Save note">Save</button><button aria-label="Cancel: Save note">Cancel</button></section><div role="tab">Sources</div>${box}`,
    'chat-saved': '<p>Your note is saved as kestrel-note in your notes.</p>',
    'chat-sources': "<p>Sources: the supplier's notice in Teams and two emails.</p>",
    'admin-home': '<h1>Plugin admin</h1><p>17 curated here</p><button aria-label="Certified" data-testid="cert-badge">Certified</button><span aria-hidden="true">Uncertified</span><button aria-label="Add one seat">+</button>',
    'admin-certified': '<h1>Plugin admin</h1><p>18 curated here</p><span>Certified by you</span>',
    'admin-seat': '<h1>Plugin admin</h1><p>2 seats</p>',
  };
  mkdirSync(join(dir, 'data', 'snaps'), { recursive: true });
  for (const [id, body] of Object.entries(snaps)) writeFileSync(join(dir, 'data', 'snaps', id + '.html'), page(body));
  // The build's record of a capture: its page title (a chat's name).
  writeFileSync(join(dir, 'data', 'snaps', 'chat-answer.json'), JSON.stringify({ id: 'chat-answer', title: 'Kestrel delay answer', frames: [] }));
  writeFileSync(join(dir, 'flow.json'), JSON.stringify(flow));
  const cfg = { name: 't', title: 'Delay demo', apps: [{ id: 'chat', key: 'C', title: 'Chat app', url: 'https://chat.test/' }, { id: 'admin', key: 'A', title: 'Admin center', url: 'https://admin.test/' }] };
  writeFileSync(join(dir, 'demo.json'), JSON.stringify(cfg));
  return { dir, out: join(dir, '.out'), raw: join(dir, 'no-raw'), cfg };
}
const SCRIPT = `# Delay demo

## 1. The question · ~40s

> Our supplier moved the ship date by six days.

**Do:** ⌥C, click the message box, ⌥P (prompt 1), Enter.

> Its sources are one click away: the supplier's notice and two emails.

> About thirty-five thousand dollars in penalties.

**Do:** Click Approve on the Save note card.

## 2. Certify it

> I certify it.

**Do:** ⌥A. Click Certified.

## Prompts

1. Ask: “What's changed on PO-1?”
`;

test('the words: keys, chains, prompts, hover cards and focus hints', () => {
  const ctx = { apps: [{ id: 'chat', key: 'C', title: 'Chat app' }, { id: 'admin', key: 'A', title: 'Microsoft 365 admin center' }], prompts: [{ n: 2, label: 'Skill', text: 'Make it a skill.' }] };
  const of = t => intentsOf(t, ctx).map(({ from, ...x }) => x);
  assert.deepEqual(of('Then ⌥C, click the message box, ⌥P (prompt 2), Enter.'), [{ app: 'chat' }, { click: 'message box', card: null, role: null }, { prompt: { n: 2, label: 'Skill', text: 'Make it a skill.' } }, { key: 'Enter' }]);
  assert.deepEqual(of('Plugins in the sidebar › Supply chain disruption').map(x => x.click), ['Plugins', 'Supply chain disruption']);
  assert.deepEqual(of('Hover Work IQ in the Workspace pane for its card.'), [{ hover: 'Work IQ', card: true }]);
  assert.deepEqual(of('Type prompt 2. Copilot saves the skill.'), [{ prompt: { n: 2, label: 'Skill', text: 'Make it a skill.' } }, { wait: true }]);
  assert.deepEqual(of('Point at Share.'), [{ hint: { texts: ['Share'], loose: true, mark: 'arrow' } }]);
  assert.equal(of('In the admin center: type IQ in Search by name')[0].app, 'admin');
  assert.deepEqual(of("Seth's post is on screen. Don't click."), []);
  // Scripts written for presenting a replica: "twice", the words typed with ⌥P, glyphs, and "it".
  assert.deepEqual(of('Click VIP Lounge + twice').map(x => x.click), ['VIP Lounge', 'VIP Lounge']);
  assert.deepEqual(of('Type REUNION25 (⌥P), Apply'), [{ prompt: { n: null, label: '', text: 'REUNION25' } }, { click: 'Apply', role: null, maybe: true }]);
  assert.deepEqual(of('Click the ▾ next to Copilot · Balanced').map(x => x.click), ['Copilot · Balanced']);
  assert.deepEqual(of('Click it to show the repo'), [{ unclear: 'Click it to show the repo' }]);
});

test('a talk track to a plan on the recorded screens: landings, writes, a difference, focus with via', () => {
  const demo = demoDir();
  const walker = walkerFromDemo(demo);
  const { plan, flags } = planFromTrack(parseTalkTrack(SCRIPT, 'x.md'), { walker });
  const steps = plan.beats.flatMap(b => b.steps);
  assert.deepEqual(steps.map(s => s.text), ['Go to chat', 'Click "Message"', `Type "What's changed on PO-1?" in "Message"`, 'Press Enter', 'Wait for the answer', 'Click "Save: Save note"', 'Go to admin', 'Click "Certified"']);
  assert.deepEqual(steps.filter(s => s.lands).map(s => s.lands.screen), ['chat-home', 'chat-typed', 'chat-answer', 'chat-saved', 'admin-home', 'admin-certified']);
  assert.deepEqual(steps.filter(s => s.writes).map(s => s.writes), ['sends prompt 1 (Ask) in Chat app', 'saves "Save note" ("Save: Save note")', 'endorses it: "Certified"']);
  // The script's Approve is the product's Save: flagged once, and the plan uses what the product has.
  assert.match(steps[5].differs, /"Save: Save note".*not "Approve"/);
  assert.deepEqual(flags.map(f => f.kind), ['differs']);
  const [l1, l2, l3] = plan.beats[0].lines;
  assert.deepEqual(l1.focus[0], { texts: ['Kestrel moved the ship date by six days.'], on: 'chat-answer' });
  // A screen one click off the path: ⌥F takes the click.
  assert.deepEqual([l2.focus[0].on, l2.focus[0].via && l2.focus[0].via.text], ['chat-sources', 'Click "Sources"']);
  // The card she clicks on, and a number said in words.
  assert.deepEqual(l3.focus.map(f => f.texts[0]), ['Save note', 'That puts about $35,073 in penalties at risk with Brightline.']);
  assert.deepEqual(plan.beats[1].lines[0].focus.map(f => [f.texts[0], f.on]), [['Certified', 'admin-certified']]);
  // ⌥F goes in the order she says things.
  const said = '# D\n\n## 1. Q\n\n> Kestrel moved the ship date by six days, so about thirty-five thousand dollars is at risk.\n\n**Do:** ⌥C, click the message box, ⌥P (prompt 1), Enter.\n\n## Prompts\n\n1. Ask: “What\'s changed on PO-1?”\n';
  assert.deepEqual(planFromTrack(parseTalkTrack(said, 'y.md'), { walker }).plan.beats[0].lines[0].focus.map(f => f.texts[0]), ['Kestrel moved the ship date by six days.', 'That puts about $35,073 in penalties at risk with Brightline.']);
  // Written and read back as the same plan.
  assert.equal(formatPlan(parsePlan(formatPlan(plan))), formatPlan(plan));
});

test('"Add X" takes the recording\'s way only when that way names X', () => {
  const walker = walkerFromDemo(demoDir());
  const steps = t => planFromTrack(parseTalkTrack(`# D\n\n## 1. A\n\n> Here.\n\n**Do:** ⌥A. ${t}\n`, 'z.md'), { walker }).plan.beats.flatMap(b => b.steps).map(s => s.text);
  assert.deepEqual(steps('Add a seat.'), ['Go to admin', 'Click "Add one seat"']);
  // A pull request's title isn't the Add button.
  assert.deepEqual(steps('Add worked examples to the docs.'), ['Go to admin']);
  // A script for presenting the replica: the beat's key in its Screen line is where the beat starts, before its Do.
  const keyed = planFromTrack(parseTalkTrack('# D\n\n## 1. A\n\n*Screen:* the admin page (⌥1)\n\n**Do**\n\n- Scroll down.\n\n**Say**\n\n> Here.\n', 'k.md'), { walker }).plan;
  assert.deepEqual(keyed.beats[0].steps.map(s => s.text), ['Go to admin', 'Scroll down']);
});

test('a walker never writes; offline, the recording says where a write went', () => {
  const walker = walkerFromDemo(demoDir());
  assert.throws(() => walker.step('chat-answer', { kind: 'click', target: 'Save: Save note', writes: 'saves it' }), e => e.code === 'WRITE');
  const r = walker.recorded('chat-answer', { kind: 'click', target: 'Save: Save note' });
  assert.deepEqual([r.screen.sig, r.screen.app, r.landed, r.wrote], ['chat-saved', 'chat', true, false]);
});

test('the reset: each write undone in reverse, a pack\'s undo with what the run made, read-only checks', () => {
  const demo = demoDir();
  const walker = walkerFromDemo(demo);
  const pack = { id: 'notes', writes: [{ id: 'save-note', on: { kind: 'click', target: 'Save' }, makes: 'note', undo: { steps: ['Click "Delete {skill}"'] }, check: { look: { absent: '{skill}' } } }] };
  const writeFor = (p, step) => (p.writes || []).find(w => w.on.kind === step.kind && w.on.target.toLowerCase() === String(step.target).toLowerCase()) || null;
  const packs = { forApp: { chat: pack }, writeFor };
  const { plan } = planFromTrack(parseTalkTrack(SCRIPT, 'x.md'), { walker, packs });
  assert.match(plan.beats[0].steps[5].writes, / · notes:save-note$/);
  // A pack's safe step: it only looks like a change, so it isn't asked about or undone.
  const quiet = planFromTrack(parseTalkTrack(SCRIPT, 'x.md'), { walker, packs: { forApp: { admin: { id: 'admin', safe: [{ id: 'cert', on: { kind: 'click', target: 'Certified' }, what: 'Only shows the endorsement menu.' }] } }, writeFor } }).plan;
  const cert = quiet.beats[1].steps.find(st => st.target === 'Certified');
  assert.deepEqual([cert.writes, cert.safe], [undefined, 'Only shows the endorsement menu · admin:cert']);
  assert.match(formatPlan(quiet), /- Click "Certified"\n  Safe: Only shows/);
  const r = resetFor(plan, { walker, packs });
  assert.deepEqual(r.undo.map(u => u.steps.join(' / ')), ['Remove the endorsement ("Certified")', 'Click "Delete kestrel-note"', 'Delete the task it made ("Kestrel delay answer")']);
  assert.deepEqual(r.checks.map(c => `${c.app}: ${c.text}`), ['admin: no endorsement', 'chat: no "kestrel-note"', 'chat: no task "Kestrel delay answer" from this run in Recent', 'admin: shows "17 curated here"']);
  assert.match(formatReset(r), /## Undo · Admin center\n\n- Go to admin\n- Remove the endorsement/);
  // Two new chats the captures title the same: one undo, done for each.
  const send = '- Type "x" in "Message"\n- Press Enter — ask first\n  Writes: sends a prompt (a new chat)\n  Lands on: chat-answer\n';
  const twice = resetFor(parsePlan(`# T\n\n## Beat 1 · A\n\n- Go to chat\n${send}\n## Beat 2 · B\n\n- Click "New chat"\n${send}`), { walker });
  assert.deepEqual(twice.undo.map(u => [u.undoes, u.times]), [['beat 2, Press Enter; beat 1, Press Enter', 2]]);
  assert.match(formatReset(twice), /Note: do these steps 2 times, once for each/);
});

test('the approval is the plan\'s exact text: an edit needs approving again', () => {
  const demo = demoDir();
  writeFileSync(join(demo.dir, 'plan.md'), '# T\n\n## Beat 1 · A\n\n- Click "Save" — ask first\n  Writes: saves it\n');
  assert.equal(approval(demo).approved, false);
  assert.deepEqual(approve(demo).writes.map(w => w.text), ['Click "Save"']);
  assert.equal(approval(demo).approved, true);
  writeFileSync(join(demo.dir, 'plan.md'), readFileSync(join(demo.dir, 'plan.md'), 'utf8').replace('Save"', 'Save all"'));
  assert.equal(approval(demo).approved, false);
});

test('a walkthrough makes the same kind of plan: steps, landings, writes, a beat per app and answer', () => {
  const walker = walkerFromDemo(demoDir());
  const rec = { path: [{ checkpoint: 'chat-home' }, { type: BOX, text: "What's changed on PO-1?", checkpoint: 'chat-typed' }, { enter: BOX, checkpoint: 'chat-answer' },
    { click: { sel: 'button[aria-label="Save: Save note"]' }, checkpoint: 'chat-saved' }, { app: 'admin', checkpoint: 'admin-home' }, { click: { sel: '[data-testid="cert-badge"]' }, checkpoint: 'admin-certified' }] };
  const plan = planFromRecording(rec, { walker });
  assert.deepEqual(plan.beats.map(b => b.steps.map(s => s.text)), [['Go to chat', `Type "What's changed on PO-1?"`, 'Press Enter', 'Wait for the answer'], ['Click "Save: Save note"'], ['Go to admin', 'Click "Certified"']]);
  // A click recorded by its test id is named from the screen; the prompt is the first one sent.
  assert.deepEqual(plan.beats.flatMap(b => b.steps).filter(s => s.writes).map(s => s.writes.split(' (')[0]), ['sends prompt 1 in Chat app', 'saves "Save note"', 'endorses it: "Certified"']);
});

test('the finish: focus points with via that the replica takes, beat keys, and her script for the guide', () => {
  const demo = demoDir();
  const walker = walkerFromDemo(demo);
  const track = parseTalkTrack(SCRIPT, 'x.md');
  const { plan } = planFromTrack(track, { walker });
  const points = pointsFromPlan(plan, walker.flow);
  assert.deepEqual(checkFocusJson({ points }), []);
  const via = points.find(p => p.via);
  assert.deepEqual([via.states, via.via], [['chat-sources'], { from: ['chat-answer'], to: 'chat-sources' }]);
  assert.deepEqual(points.find(p => p.union).union[0].text, 'Save note');
  assert.deepEqual(beatStarts(plan, walker.flow).map(b => [b.active, b.states[b.active]]), [['chat', 'chat-home'], ['admin', 'admin-home']]);
  const md = guideScript(track, plan, walker.flow, { keys: ['⌥1', '⌥2'], apps: walker.apps });
  const g = guideParse(md, 'script.md');
  assert.deepEqual(g.beats.map(b => [b.title, b.say.length]), [['The question', 3], ['Certify it', 1]]);
  assert.ok(g.beats[0].do.some(d => d.text === 'Switch to **Chat app** (**⌥C**)'));
  assert.ok(g.beats[0].do.some(d => /^\*\*⌥F\*\*: Kestrel moved/.test(d.text)));
  // The review's timings: each beat's lines at a steady pace, against the time her script gives it.
  assert.deepEqual(beatTimings(plan, ['5s', '~1m15s']).map(r => r[1]), ['about 11 s to say, in 5 s (long)', 'about 1 s to say, in 75 s', 'about 0:12 to say, in 1:20']);
});
