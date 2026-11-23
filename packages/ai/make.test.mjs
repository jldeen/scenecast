// Make it from my script, on a small recorded demo (two apps, seven screens): a talk track to the plan (steps on the
// real controls, where they land, what they write, what differs), the reset from its writes, the one approval, a
// walkthrough to the same plan, and the finish (focus points with via, her script for the guide).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatPlan, parsePlan } from './plan.mjs';
import { walkerFromDemo } from './walker.mjs';
import { planFromTrack, intentsOf, promptFor, namedRows, stepsFrom, firstOfKind, sectionsOf, myNames } from './from-script.mjs';
import { planFromRecording } from './walkthrough.mjs';
import { resetFor, formatReset, parseReset } from './reset.mjs';
import { approve, approval } from './make.mjs';
import { scriptPlanInput, planWithModel } from './script-plan.mjs';
import { makeModel } from './model.mjs';
import { pointsFromPlan, guideScript, beatStarts, beatTimings } from './finish.mjs';
import { parseTalkTrack } from '@scenecast/script/talk.mjs';
import { parseScript as guideParse } from '@stuntdouble/core/lib/notes.mjs';
import { checkFocusJson } from '@stuntdouble/core/lib/overrides.mjs';

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
  const page = body => `<!doctype html><html data-color-scheme="light"><head><title>t</title><style>p{color:red}</style></head><body>${body}</body></html>`;
  const box = '<div role="textbox" contenteditable="true" aria-label="Message"></div>';
  const snaps = {
    'chat-home': `<h1>New chat</h1>${box}<div role="radiogroup"><div role="radio" aria-checked="false">Chat</div><div role="radio" aria-checked="true">Notes</div></div>`,
    'chat-typed': `<h1>New chat</h1>${box}`,
    'chat-answer': `<h2>Kestrel delay answer</h2><p>Kestrel moved the ship date by six days.</p><p>That puts about $35,073 in penalties at risk with Brightline.</p><section><h3>Save note</h3><button aria-label="Save: Save note">Save</button><button aria-label="Cancel: Save note">Cancel</button></section><div role="tab">Sources</div>${box}`,
    'chat-saved': '<p>Your note is saved as kestrel-note in your notes.</p>',
    'chat-sources': "<p>Sources: the supplier's notice in Teams and two emails.</p>",
    'admin-home': '<h1>Plugin admin</h1><p>17 curated here</p><button aria-label="Certified" data-testid="cert-badge">Certified</button><span aria-hidden="true">Uncertified</span><button aria-label="Add one seat">+</button><div role="switch" aria-checked="false" aria-label="Enable Sync"></div><p>Version 2.1.0</p>',
    'admin-certified': '<h1>Plugin admin</h1><p>18 curated here</p><span>Certified by you</span><div role="switch" aria-checked="true" aria-label="Enable Sync"></div>',
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

// A talk track that only tells the story (no Do lines): Copilot proposes the steps, the rules ground them.
const PROSE = `# Delay demo

## 1. The question

> I ask what changed on the order.

> Kestrel moved the ship date by six days.

## 2. Certify it

> I certify it, so everyone knows it's ours.

## Prompts

1. Ask: “What's changed on PO-1?”
`;

test('Copilot reads a prose talk track: its steps grounded on the recorded screens, its points framed, the rest the rules', async () => {
  const walker = walkerFromDemo(demoDir());
  const track = parseTalkTrack(PROSE, 'p.md');
  const answer = { beats: [
    { n: 1, lines: [{ id: '1.1', steps: ['Go to chat', `Type "What's changed on PO-1?" in "Message"`, 'Press Enter', 'Wait for the answer'], point: [] },
      { id: '1.2', steps: [], point: [{ text: 'Kestrel moved the ship date by six days.', screen: 'chat-answer' }] }] },
    { n: 2, lines: [{ id: '2.1', steps: ['Beat 1', 'Click "Certified"'], point: [{ texts: ['Certified by you', '18 curated here'], screen: 'admin-certified' }] }] },
  ] };
  let asked = null;
  const model = { kind: 'test', ask: async (task, input) => { asked = { task, input }; return answer; } };
  const r = await planWithModel(track, { walker, model });
  assert.equal(asked.task, 'script-plan');
  // What was asked: her lines, the screens with their moves, the beats; no screen words unless allowed.
  assert.ok(asked.input.screens.find(x => x.id === 'chat-answer').moves.some(m => /Save: Save note.*→ chat-saved/.test(m)));
  assert.ok(asked.input.screens.every(x => !x.words));
  assert.deepEqual(r.plan.beats.flatMap(b => b.steps).map(st => st.text), ['Go to chat', `Type "What's changed on PO-1?" in "Message"`, 'Press Enter', 'Wait for the answer', 'Go to admin', 'Click "Certified"']);
  assert.deepEqual(r.plan.beats.flatMap(b => b.steps).filter(st => st.writes).map(st => st.writes), ['sends prompt 1 (Ask) in Chat app', 'endorses it: "Certified"']);
  assert.deepEqual(r.plan.beats[0].lines[1].focus[0].texts, ['Kestrel moved the ship date by six days.']);
  assert.deepEqual(r.plan.beats[1].lines[0].focus[0], { texts: ['Certified by you', '18 curated here'], on: 'admin-certified' });
  // No answer that fits (the stand-in model, or an error): the rules' plan, as without Copilot.
  const rules = await planWithModel(track, { walker, model: await makeModel({ kind: 'stub' }) });
  assert.deepEqual([rules.model.fallback, rules.plan.beats.flatMap(b => b.steps).length], [true, planFromTrack(track, { walker }).plan.beats.flatMap(b => b.steps).length]);
  const failing = await planWithModel(track, { walker, model: { kind: 'test', ask: async () => { throw new Error('offline'); } } });
  assert.deepEqual([failing.model.fallback, failing.model.error], [true, 'offline']);
});

test('Copilot\'s steps keep to her script: the prompt her line names, and a write it proposes twice done once', async () => {
  const walker = walkerFromDemo(demoDir());
  const ask = "What's changed on PO-1?", payoff = "What's changed on PO-1? And what will it cost us?";
  const track = parseTalkTrack(`# D\n\n## 1. Ask\n\n> I ask, and save it.\n\n**Do:** ⌥C, ⌥P (prompt 2), Enter. Click Approve on the Save note card.\n\n## Prompts\n\n1. Ask: “${ask}”\n2. Payoff: “${payoff}”\n`, 'd.md');
  // Prompt 2 starts with prompt 1's words: it's still prompt 2.
  assert.deepEqual([promptFor(track.prompts, payoff).n, promptFor(track.prompts, ask).n], [2, 1]);
  const steps = ['Go to chat', `Type "${ask}" in "Message"`, 'Press Enter', 'Wait for the answer', 'Click "Save: Save note"', 'Click "Save: Save note"'];
  const model = { kind: 'test', ask: async () => ({ beats: [{ n: 1, lines: [{ id: '1.1', steps, point: [] }] }] }) };
  const { plan, flags } = await planWithModel(track, { walker, model });
  const all = plan.beats.flatMap(b => b.steps);
  assert.equal(all.find(st => st.kind === 'type').value, payoff);
  assert.deepEqual(all.filter(st => st.writes).map(st => st.writes), ['sends prompt 2 (Payoff) in Chat app', 'saves "Save note" ("Save: Save note")']);
  assert.ok(!flags.some(f => f.kind === 'order'));
});

test('Copilot gets a screen\'s words only when page text is allowed, redacted; asking again comes from the cache', async () => {
  const demo = demoDir();
  writeFileSync(join(demo.dir, 'data', 'snaps', 'chat-saved.html'), '<!doctype html><html><body><p>Your note is saved as kestrel-note. Mail seth@example.com about it.</p></body></html>');
  const walker = walkerFromDemo(demo);
  const track = parseTalkTrack(PROSE, 'p.md');
  const words = scriptPlanInput(track, walker, { pageText: true }).screens.find(x => x.id === 'chat-saved').words;
  assert.match(words, /saved as kestrel-note\. Mail \[email\] about it/);
  assert.equal(scriptPlanInput(track, walker, { pageText: false }).screens.find(x => x.id === 'chat-saved').words, undefined);
  const file = join(demo.dir, 'model.mjs');
  writeFileSync(file, 'export let n = 0; export async function ask() { n++; return { beats: [] }; }');
  const m = await makeModel({ kind: file, cacheDir: join(demo.dir, 'cache') });
  await m.ask('script-plan', { a: 1 });
  await m.ask('script-plan', { a: 1 });
  await m.ask('script-plan', { a: 2 });
  assert.deepEqual([(await import(pathToFileURL(file).href)).n, m.stats.cached], [2, 1]);
});

test('one box for what a line names together: rows of one list, a step and the steps it goes on to', () => {
  const item = (i, text, more = {}) => ({ i, kind: 'text', role: 'generic', tag: 'span', text, box: [i * 10, 0, i * 10 + 1, 1], ...more });
  const rows = (say, items) => namedRows(say, { items }).map(g => g.map(it => it.text));
  const added = [item(1, 'Added (3)', { role: 'heading', tag: 'h1' }), item(2, 'Supply chain disruption'), item(3, 'Contoso IQ'), item(4, 'Fabric IQ'), item(5, 'Catalog', { role: 'heading', tag: 'h2' }), item(6, 'Work IQ Mail')];
  assert.deepEqual(rows('Under Added: my Supply chain disruption plugin, and Contoso IQ.', added), [['Supply chain disruption', 'Contoso IQ']]);
  // A heading between them: two lists, so no box around both.
  assert.deepEqual(rows('Contoso IQ, and Work IQ Mail in the catalog.', added), []);
  // Rows that start with the same name, told apart by the words she says. A description isn't one of them.
  const conn = [item(1, 'Fabrikam Procurement'), item(2, 'Fabrikam procurement: suppliers and orders.'), item(3, 'Fabrikam Inventory'), item(4, 'Fabrikam Sales'), item(5, 'What changed'), item(6, 'What it does')];
  assert.deepEqual(rows('It connects to procurement, inventory and sales, and you can see what changed.', conn), [['Fabrikam Procurement', 'Fabrikam Inventory', 'Fabrikam Sales']]);
  // A step and the ones it goes on to, to the next step of its kind; what every step has isn't one.
  const steps = [item(1, 'Reviewed custom skill Contoso IQ'), item(2, 'Thought process'), item(3, 'Retrieve memories'), item(4, 'Thought process'), item(5, 'Thought process'), item(6, 'Reviewed custom skill Supply chain disruption'), item(7, 'Get purchase order')];
  assert.deepEqual(stepsFrom(steps, steps[0]).map(x => x.text), ['Reviewed custom skill Contoso IQ', 'Retrieve memories']);
  // "My plugin" is the one she named before.
  const mine = myNames();
  assert.deepEqual(mine('Under Added: our business plugin, and my Supply chain disruption plugin.'), []);
  assert.deepEqual(mine('Then it calls my plugin to check our orders.'), [{ name: 'Supply chain disruption', word: 'plugin' }]);
});

test('a list framed the way she shows one: its heading and first step; a section by its first card', () => {
  const item = (i, text, more = {}) => ({ i, kind: 'text', role: 'generic', tag: 'span', text, box: [i * 10, 0, i * 10 + 1, 1], ...more });
  const h = (i, text, tag = 'h5') => item(i, text, { role: 'heading', tag });
  const skill = [h(1, 'Inputs'), h(2, 'Workflow'), h(3, 'Step 1: Find the notice', 'h6'), h(4, 'Step 2: Extract the facts', 'h6'), h(5, 'Output Format')];
  assert.deepEqual(firstOfKind('Every step is in plain language.', { items: skill }).map(x => x.text), ['Workflow', 'Step 1: Find the notice']);
  assert.equal(firstOfKind('It reads in plain language.', { items: skill }), null);
  // Sections: labels of one kind, each over a list of cards (something to click with its own line under it).
  const label = (i, text) => item(i, text, { role: 'textbox' });
  const card = (i, name, sub) => [item(i, name, { role: 'button' }), item(i + 1, sub)];
  const page = { items: [label(10, 'Our process'), ...card(12, 'Spend policy', 'File'), ...card(15, 'Escalation steps', 'Skill'), ...card(18, 'Shipping exceptions', 'Skill'),
    label(30, 'Our people'), ...card(32, 'Avery Chen', 'People'), ...card(35, 'Sam Ortiz', 'People'), ...card(38, 'Lee Park', 'People'),
    item(50, 'Delete group', { role: 'button' }), item(51, 'Delete group', { role: 'button' })] };
  assert.deepEqual(sectionsOf(page).map(s => [s.label.text, s.cards[0].text]), [['Our process', 'Spend policy'], ['Our people', 'Avery Chen']]);
  // Headings over buttons that do things aren't sections.
  assert.deepEqual(sectionsOf({ items: [h(1, 'Comments', 'h2'), item(2, 'Write a reply', { role: 'button' }), item(3, 'Skip comments', { role: 'button' }), h(4, 'Footer', 'h2'), item(5, 'Manage cookies', { role: 'button' })] }), []);
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
  assert.deepEqual(r.checks.filter(c => !/^start/.test(c.from)).map(c => `${c.app}: ${c.text}`), ['admin: no endorsement', 'chat: no "kestrel-note"', 'chat: no task "Kestrel delay answer" from this run in Recent', 'admin: shows "17 curated here"']);
  assert.match(formatReset(r), /## Undo · Admin center\n\n- Go to admin\n- Remove the endorsement/);
  // A private pack's API undo: named, not written out; the steps by hand are what's left if it can't.
  const api = { forApp: { chat: { ...pack, writes: [{ ...pack.writes[0], undo: { ...pack.writes[0].undo, api: { use: 'notes', method: 'DELETE', path: '/notes/{skill}' } } }] } }, writeFor };
  const viaApi = resetFor(plan, { walker, packs: api }).undo.find(u => /notes:save-note/.test(u.steps[0]));
  assert.deepEqual([viaApi.steps, viaApi.note], [['Undo with the app pack: notes:save-note'], `an API call in the capture browser's own signed-in session, with {skill} from the run; if it can't: Click "Delete kestrel-note"`]);
  // Two new chats the captures title the same: one undo, done for each.
  const send = '- Type "x" in "Message"\n- Press Enter — ask first\n  Writes: sends a prompt (a new chat)\n  Lands on: chat-answer\n';
  const twice = resetFor(parsePlan(`# T\n\n## Beat 1 · A\n\n- Go to chat\n${send}\n## Beat 2 · B\n\n- Click "New chat"\n${send}`), { walker });
  assert.deepEqual(twice.undo.map(u => [u.undoes, u.times]), [['beat 2, Press Enter; beat 1, Press Enter', 2]]);
  assert.match(formatReset(twice), /Note: do these steps 2 times, once for each/);
});

test('the start state: what the first screens show is set first and checked; a change no step makes needs one', () => {
  const walker = walkerFromDemo(demoDir());
  const pack = { id: 'admin', writes: [{ id: 'sync', on: { kind: 'click', target: 'Enable Sync' }, undo: { open: 'https://admin.test/sync', steps: ['Click "Enable Sync"'] } }] };
  const writeFor = (p, step) => (p.writes || []).find(w => w.on.kind === step.kind && w.on.target.toLowerCase() === String(step.target).toLowerCase()) || null;
  const { plan } = planFromTrack(parseTalkTrack(SCRIPT, 'x.md'), { walker });
  const r = resetFor(plan, { walker, packs: { forApp: { admin: pack }, writeFor } });
  assert.deepEqual(r.set.map(s => [s.app, s.text, s.how.control, s.how.open]), [['admin', '"Sync" is off', 'Enable Sync', 'https://admin.test/sync']]);
  assert.deepEqual(r.checks.filter(c => /^start/.test(c.from)).map(c => `${c.app}: ${c.text}`), ['chat: "Notes" is picked (Chat | Notes)', 'chat: renders light', 'admin: "Sync" is off', 'admin: Plugin admin is version 2.1.0', 'admin: renders light']);
  // On before the certify and on after it, with no step between that switches it: the plan needs that step.
  assert.match(r.needs.find(n => n.kind === 'start').text, /^"Sync" is off before Click "Certified" and on after it.*Add Click "Enable Sync" after it$/);
  assert.deepEqual(parseReset(formatReset(r)).set, [{ what: 'admin: "Sync" is off', set: '"Enable Sync" · admin:sync', opens: 'https://admin.test/sync', seen: 'beat 2, admin-home' }]);
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
