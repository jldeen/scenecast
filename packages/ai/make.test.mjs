// Make it from my script, on a small recorded demo (two apps, seven screens): a talk track to the plan (steps on the
// real controls, where they land, what they write, what differs), the reset from its writes, the one approval, a
// walkthrough to the same plan, and the finish (focus points with via, her script for the guide).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatPlan, parsePlan, formatLands, formatStep } from './plan.mjs';
import { walkerFromDemo } from './walker.mjs';
import { planFromTrack, intentsOf, promptFor, namedRows, stepsFrom, firstOfKind, sectionsOf, myNames, proveLandings, packChecked } from './from-script.mjs';
import { holds, liveProof, writeGate } from './landing.mjs';
import { planFromRecording } from './walkthrough.mjs';
import { resetFor, formatReset, parseReset } from './reset.mjs';
import { approve, approval } from './make.mjs';
import { scriptPlanInput, planWithModel } from './script-plan.mjs';
import { makeModel } from './model.mjs';
import { pointsFromPlan, guideScript, beatStarts, beatTimings, needsYou, addedFromRecording, reviewHtml } from './finish.mjs';
import { regroundPlan, walkReads, formatReground, reground, missingCounts } from './reground.mjs';
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
    // A chat box shows what was typed in it (an input field wouldn't: its value isn't in the page's words).
    'chat-typed': `<h1>New chat</h1><div role="textbox" contenteditable="true" aria-label="Message">What's changed on PO-1?</div>`,
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

test('a landing proves its step: new words, a control\'s state, a control only it has, words gone with the page\'s own still there; numbers last', () => {
  // Screens as the reader reads them: items (with the reader's marks) and controls. Each starts with a skip link, the
  // app's chrome: it never proves a step, and never shows the page is still there.
  const sc = (items, controls = [], headings = []) => ({ headings, controls, items: [{ text: 'Skip to main content', role: 'link', tag: 'a' }, ...items].map((it, i) => ({ i, kind: 'text', role: 'generic', tag: 'span', ...(typeof it === 'string' ? { text: it } : it) })) });
  const S = {
    page: sc(['Operations', { text: 'Operations', nav: true }, 'Our numbers', '17 curated here', 'Add content'], [{ role: 'tab', name: 'Agents', selected: true }, { role: 'tab', name: 'Plugins', selected: false }]),
    // Words a run can't count on, all new here: a time, a toast, a date, a shortcut's keys, someone's presence, what
    // Copilot wrote, a greeting that changes on each visit, a closed dialog's heading. Then its own new tab.
    picker: sc(['Operations', 'Our numbers', '17 curated here', 'Add content', { text: '2 min ago', time: true }, { text: 'Message sent', live: true }, 'Commented on Nov 17, 2026', 'Show panel ⌘⇧B',
      'Avery Chen, status Available', 'Fabrikam moved the ship date', 'Hi, how can I help?', { text: 'Response time details', shut: true }, 'Web IQ'], [{ role: 'tab', name: 'Web IQ' }]),
    tabbed: sc(['Operations', { text: 'Operations', nav: true }, 'Our numbers', '17 curated here', 'Add content'], [{ role: 'tab', name: 'Agents', selected: false }, { role: 'tab', name: 'Plugins', selected: true }]),
    badge: sc(['Operations', { text: 'Operations', nav: true }, 'Our numbers', '17 curated here', 'Add content'], [{ role: 'tab', name: 'Agents', selected: true }, { role: 'button', name: 'Endorsement: Certified' }]),
    panel: sc(['Operations', { text: 'Operations', nav: true }, 'Our numbers', '17 curated here', 'Add content', { text: 'Use When', role: 'heading', nav: true }, { text: 'Spend policy', nav: true }], [{ role: 'tab', name: 'Agents', selected: true }, { role: 'tab', name: 'Plugins', selected: false }]),
    added: sc(['Operations', { text: 'Operations', nav: true }, 'Our numbers', '18 curated here', 'Add content'], [{ role: 'tab', name: 'Agents', selected: true }]),
  };
  // One page with panels over it (one address): no frame to tell its own words from.
  const walker = { screen: id => S[id], shown: id => S[id], view: () => ({ url: 'https://iq.example.com/home' }), states: Object.keys(S), flow: { states: Object.fromEntries(Object.keys(S).map(k => [k, { app: 'iq' }])) },
    written: t => /fabrikam moved/i.test(t), unstable: t => /how can i help/i.test(t) };
  const plan = { beats: [{ steps: [
    { kind: 'app', app: 'iq', lands: { screen: 'page', text: 'Our numbers' } },
    { kind: 'click', target: 'Add content', line: '1.1', lands: { screen: 'picker', text: 'Operations' } },
    { kind: 'press', key: 'Escape', line: '1.2', lands: { screen: 'page' } },
    { kind: 'click', target: 'Plugins', line: '1.3', lands: { screen: 'tabbed' } },
    { kind: 'click', target: 'Agents', line: '1.4', lands: { screen: 'page' } },
    { kind: 'click', target: 'Certified', line: '1.5', lands: { screen: 'badge', text: 'Operations' } },
    { kind: 'click', target: 'Spend policy', line: '1.6', lands: { screen: 'panel' } },
    { kind: 'click', target: 'Close panel', line: '1.7', lands: { screen: 'page' } },
    { kind: 'click', target: 'Add to business plugin', line: '1.8', lands: { screen: 'added' } },
    { kind: 'click', target: 'Refresh', line: '1.9', lands: { screen: 'added' } }] }] };
  const flags = proveLandings(plan, walker);
  assert.deepEqual(plan.beats[0].steps.map(s => formatLands(s.lands)), [
    'page · "Our numbers"',
    'picker · "Web IQ"',
    'page · control "Agents" selected',
    'tabbed · control "Plugins" selected',
    'page · control "Agents" selected',
    'badge · control "Endorsement: Certified"',
    'panel · "Use When"',
    'page · gone "Use When", still "Our numbers"',
    'added · "18 curated here"',
    'added',
  ]);
  assert.deepEqual(flags.map(f => [f.kind, f.at]), [['number', '1.8'], ['landing', '1.9']]);
  assert.match(flags[0].text, /a run checks it by “18 curated here”, a number that can change$/);
  assert.match(flags[1].text, /^Click "Refresh": it lands where it already was, so a run can't tell whether it worked$/);
  // Each holds on its own screen and not on the one before; gone needs its still.
  assert.equal(holds(S.page, { kind: 'gone', gone: 'Use When', still: 'Our numbers' }), true);
  assert.equal(holds(S.panel, { kind: 'gone', gone: 'Use When', still: 'Our numbers' }), false);
  assert.equal(holds({ items: [], controls: [] }, { kind: 'gone', gone: 'Use When', still: 'Our numbers' }), false);
  // The review lists them; Copilot isn't asked about them (they're not her script's to fix).
  assert.deepEqual(needsYou({ planReview: { flags }, plan: { beats: [] } }).map(n => [n.kind, n.where]), [['A number that can change', 'line 1.8'], ["A run can't check this step", 'line 1.9']]);
  const input = scriptPlanInput(parseTalkTrack(PROSE, 'p.md'), null, { draft: { plan: { beats: [] }, flags: [{ kind: 'landing', at: '1.1', text: 'x' }, { kind: 'number', at: '1.1', text: 'y' }, { kind: 'differs', at: '1.1', text: 'The product shows "Save"' }] } });
  assert.deepEqual(input.script.beats[0].lines[0].issues, ['The product shows "Save"']);
});

test('a step the recording took before a click (a search before a tab), and the script leaves out, goes first', () => {
  // A picker: the recording searched for "Fabrikam", then opened the Plugins tab, whose list then showed only that.
  // The build also lets the tab open straight from the picker, onto that same filtered list.
  const dir = mkdtempSync(join(tmpdir(), 'sc-picker-'));
  const SEARCH = { sel: 'textarea[data-testid="search"]' }, TAB = { sel: '[data-testid="tab-plugins"]' };
  const flow = {
    apps: [{ id: 'iq', key: 'I' }],
    states: {
      page: { app: 'iq', snap: 'page', on: [{ click: { sel: 'button[aria-label="Add content"]' }, to: 'picker' }] },
      picker: { app: 'iq', snap: 'picker', on: [{ type: SEARCH, to: 'picker-typed' }, { click: TAB, to: 'picker-plugins' }], fill: [{ ...SEARCH, value: 'Fabrikam' }] },
      'picker-typed': { app: 'iq', snap: 'picker-typed', on: [{ click: TAB, to: 'picker-plugins', keep: SEARCH }], fill: [{ ...SEARCH, value: 'Fabrikam' }] },
      'picker-plugins': { app: 'iq', snap: 'picker-plugins', on: [{ click: { sel: 'li[data-testid^="item-"]', textStarts: 'Fabrikam Orders' }, to: 'review' }] },
      review: { app: 'iq', snap: 'review' },
    },
    beats: [{ active: 'iq', states: { iq: 'page' } }], path: [],
  };
  const picker = (typed, tab) => `<h1>Operations</h1><div role="dialog" aria-label="Add content"><textarea data-testid="search" aria-label="Search contexts">${typed}</textarea>`
    + `<div role="tablist"><div role="tab" data-testid="tab-files" aria-selected="${!tab}">Files</div><div role="tab" data-testid="tab-plugins" aria-selected="${tab}">Plugins</div></div>`
    + (tab ? '<ul><li role="listitem" tabindex="0" data-testid="item-orders">Fabrikam Orders</li></ul>' : '<p>Spend policy</p>') + '</div>';
  const snaps = { page: '<h1>Operations</h1><button aria-label="Add content">Add</button>', picker: picker('', false), 'picker-typed': picker('Fabrikam', false), 'picker-plugins': picker('Fabrikam', true), review: '<h2>Review Fabrikam Orders</h2>' };
  mkdirSync(join(dir, 'data', 'snaps'), { recursive: true });
  for (const [id, body] of Object.entries(snaps)) writeFileSync(join(dir, 'data', 'snaps', id + '.html'), `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`);
  writeFileSync(join(dir, 'flow.json'), JSON.stringify(flow));
  const demo = { dir, out: join(dir, '.out'), raw: join(dir, 'no-raw'), cfg: { name: 't', apps: [{ id: 'iq', key: 'I', title: 'IQ' }] } };
  const steps = track => planFromTrack(parseTalkTrack(track, 'x.md'), { walker: walkerFromDemo(demo) });
  const { plan, flags } = steps('# T\n\n## 1. Add it\n\n> We add it.\n\n**Do:** Click "Add content". Click "Plugins". Click "Fabrikam Orders".\n');
  assert.deepEqual(plan.beats[0].steps.map(st => [formatStep(st), formatLands(st.lands || {})]), [
    ['Go to iq', 'page · "Operations"'],
    ['Click "Add content"', 'picker · "Spend policy"'],
    ['Type "Fabrikam" in "Search contexts"', 'picker-typed · box "Search contexts" says "Fabrikam"'],
    ['Click "Plugins"', 'picker-plugins · "Fabrikam Orders"'],
    ['Click "Fabrikam Orders"', 'review · "Review Fabrikam Orders"'],
  ]);
  const restored = flags.find(f => f.kind === 'restored');
  assert.match(restored.text, /^Before "Plugins", a step your script leaves out, as recorded: Type "Fabrikam" in "Search contexts"/);
  // It's from her own recording and isn't a write: the review lists it for information, not under Needs you.
  assert.ok(!needsYou({ planReview: { flags }, plan: { beats: [] } }).some(n => n.text === restored.text));
  assert.deepEqual(addedFromRecording({ flags }), [{ where: `line ${restored.line}`, text: restored.text }]);
  assert.match(reviewHtml({ title: 'T', beats: [], timings: [], needs: [], added: addedFromRecording({ flags }), stats: [] }), /<h2>Added from your recording<\/h2>.*Before &quot;Plugins&quot;, a step your script leaves out/s);
  // When her script types it, it's typed once.
  const own = steps('# T\n\n## 1. Add it\n\n> We add it.\n\n**Do:** Click "Add content". Type "Fabrikam" in "Search contexts". Click "Plugins". Click "Fabrikam Orders".\n');
  assert.equal(own.plan.beats[0].steps.filter(st => st.kind === 'type').length, 1);
  assert.equal(own.flags.filter(f => f.kind === 'added' || f.kind === 'restored').length, 0);
});

test('a control in a live region proves a step only when the next step clicks it; its words never do', () => {
  const sc = (items, controls = []) => ({ headings: [], controls, items: items.map((it, i) => ({ i, kind: 'text', role: 'generic', tag: 'span', ...(typeof it === 'string' ? { text: it } : it) })) });
  // An approval card arrives in a live region: its heading and its buttons. Nothing else on the page is new.
  const S = {
    chat: sc(['Ask anything'], [{ role: 'textbox', name: 'Message', editable: 'content' }]),
    card: sc(['Ask anything', { text: 'Save note', role: 'heading', live: true }, { text: 'Save', kind: 'control', role: 'button', live: true }],
      [{ role: 'textbox', name: 'Message', editable: 'content' }, { role: 'button', name: 'Save: Save note', live: true }, { role: 'button', name: 'Cancel: Save note', live: true }]),
    saved: sc(['Ask anything', 'Your note is saved'], [{ role: 'textbox', name: 'Message', editable: 'content' }]),
  };
  const walker = { screen: id => S[id], shown: id => S[id], states: Object.keys(S), flow: { states: Object.fromEntries(Object.keys(S).map(k => [k, { app: 'chat' }])) },
    control: (scr, name) => { const el = scr.controls.find(c => c.name.toLowerCase() === String(name).toLowerCase()); return el ? { el, score: 100 } : null; } };
  const plan = (nextTarget, role) => ({ beats: [{ steps: [
    { kind: 'app', app: 'chat', lands: { screen: 'chat' } },
    { kind: 'press', key: 'Enter', line: '1.1', lands: { screen: 'card', text: 'Save note' } },
    { kind: 'wait', line: '1.1' },
    { kind: 'click', target: nextTarget, ...(role ? { role } : {}), line: '1.2', lands: { screen: 'saved' } }] }] });
  const clicks = plan('Save: Save note');
  proveLandings(clicks, walker);
  assert.equal(formatLands(clicks.beats[0].steps[1].lands), 'card · control "Save: Save note"');
  // The next step clicks something else, or the same name in another role: the card's controls and words don't count.
  for (const other of [plan('Ask anything'), plan('Save: Save note', 'link')]) {
    const flags = proveLandings(other, walker);
    assert.equal(formatLands(other.beats[0].steps[1].lands), 'card');
    assert.deepEqual(flags.map(f => [f.kind, f.at]), [['landing', '1.1']]);
  }
});

test('typing lands on its own words, never what was recorded in the box: Differs when the recording has others', () => {
  const walker = walkerFromDemo(demoDir());
  const plan = { beats: [{ steps: [
    { kind: 'app', app: 'chat', lands: { screen: 'chat-home' } },
    { kind: 'type', value: "What's changed on PO-1?", target: 'Message', line: '1.1', lands: { screen: 'chat-typed', text: 'New chat' } },
    { kind: 'click', target: 'New chat', line: '1.2', lands: { screen: 'chat-home' } },
    { kind: 'type', value: 'Turn this into a note I can reuse.', target: 'Message', line: '1.3', lands: { screen: 'chat-typed', text: "What's changed on PO-1?" } }] }] };
  proveLandings(plan, walker);
  const [, same, , other] = plan.beats[0].steps;
  assert.deepEqual([same.lands, same.differs], [{ screen: 'chat-typed', kind: 'words', text: "What's changed on PO-1?" }, undefined]);
  assert.deepEqual([other.lands, other.differs], [{ screen: 'chat-typed', kind: 'words', text: 'Turn this into a note I can reuse.' }, 'the recording has “What\'s changed on PO-1?” typed here']);
  // Offline, the walker checks a step the same way; what the recording can't show, it says so.
  assert.deepEqual(walker.landed('chat-typed', same), { ok: true, why: null });
  assert.equal(walker.landed('chat-typed', other).ok, true);
  assert.match(walker.landed('chat-typed', other).why, /^the recording has other words typed here/);
  // Somewhere else, or a proof that doesn't hold (a hand edit), is a miss; nothing to land on passes.
  assert.deepEqual(walker.landed('chat-home', same), { ok: false, why: 'on chat-home, not chat-typed' });
  assert.deepEqual(walker.landed('chat-typed', { ...same, lands: { screen: 'chat-typed', kind: 'words', text: 'Not there' } }), { ok: false, why: '“Not there” isn\'t on chat-typed' });
  assert.deepEqual(walker.landed('chat-typed', { kind: 'wait' }), { ok: true, why: null });
  assert.deepEqual(walker.landed('chat-typed', { kind: 'press', key: 'Escape', lands: { screen: 'chat-typed', kind: null, text: null } }), { ok: true, why: 'nothing to check this step by' });
  // A box whose words aren't in the page's (an input): what it says.
  const field = { controls: [{ role: 'textbox', name: 'Promo code', editable: 'field', value: 'SPRING25' }], items: [{ text: 'Checkout' }], headings: [] };
  const empty = { controls: [{ role: 'textbox', name: 'Promo code', editable: 'field' }], items: [{ text: 'Checkout' }], headings: [] };
  const w2 = { screen: id => ({ empty, field })[id], shown: id => ({ empty, field })[id], states: ['empty', 'field'], flow: { states: { empty: { app: 'shop' }, field: { app: 'shop' } } },
    recorded: () => ({ control: empty.controls[0] }) };
  const p2 = { beats: [{ steps: [{ kind: 'app', app: 'shop', lands: { screen: 'empty' } }, { kind: 'type', value: 'SPRING25', target: 'Promo code', lands: { screen: 'field' } }] }] };
  proveLandings(p2, w2);
  assert.equal(formatLands(p2.beats[0].steps[1].lands), 'field · box "Promo code" says "SPRING25"');
  // Recorded in another box: the step says so.
  const gift = { controls: [{ role: 'textbox', name: 'Promo code', editable: 'field' }, { role: 'searchbox', name: 'Gift card', value: 'SPRING25' }], items: [{ text: 'Checkout' }], headings: [] };
  const w3 = { ...w2, screen: id => ({ empty, gift })[id], shown: id => ({ empty, gift })[id], states: ['empty', 'gift'], flow: { states: { empty: { app: 'shop' }, gift: { app: 'shop' } } } };
  const p3 = { beats: [{ steps: [{ kind: 'app', app: 'shop', lands: { screen: 'empty' } }, { kind: 'type', value: 'SPRING25', target: 'Promo code', lands: { screen: 'gift' } }] }] };
  proveLandings(p3, w3);
  assert.equal(p3.beats[0].steps[1].differs, 'the recording typed it in “Gift card”');
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
  assert.deepEqual([viaApi.steps, viaApi.note], [['Undo with the app pack: notes:save-note'], `an API call in the capture browser's own signed-in session, with {skill} from the demo's values (demo.json, apps[].values), else from the run; if it can't: Click "Delete kestrel-note"`]);
  // Two new chats the captures title the same: one undo, done for each.
  const send = '- Type "x" in "Message"\n- Press Enter — ask first\n  Writes: sends a prompt (a new chat)\n  Lands on: chat-answer\n';
  const twice = resetFor(parsePlan(`# T\n\n## Beat 1 · A\n\n- Go to chat\n${send}\n## Beat 2 · B\n\n- Click "New chat"\n${send}`), { walker });
  assert.deepEqual(twice.undo.map(u => [u.undoes, u.times]), [['beat 2, Press Enter; beat 1, Press Enter', 2]]);
  assert.match(formatReset(twice), /Note: do these steps 2 times, once for each/);
});

test('the start state: what the first screens show is set first and checked; a change no step makes is set before its step, or needs one', () => {
  const walker = walkerFromDemo(demoDir());
  const pack = { id: 'admin', writes: [{ id: 'sync', on: { kind: 'click', target: 'Enable Sync' }, undo: { open: 'https://admin.test/sync', steps: ['Click "Enable Sync"'] } }] };
  const writeFor = (p, step) => (p.writes || []).find(w => w.on.kind === step.kind && w.on.target.toLowerCase() === String(step.target).toLowerCase()) || null;
  const { plan } = planFromTrack(parseTalkTrack(SCRIPT, 'x.md'), { walker });
  const r = resetFor(plan, { walker, packs: { forApp: { admin: pack }, writeFor } });
  assert.deepEqual(r.set.map(s => [s.app, s.text, s.how.control, s.how.open]), [['admin', '"Sync" is off', 'Enable Sync', 'https://admin.test/sync']]);
  assert.deepEqual(r.checks.filter(c => /^start/.test(c.from)).map(c => `${c.app}: ${c.text}`), ['chat: "Notes" is picked (Chat | Notes)', 'chat: renders light', 'admin: "Sync" is off', 'admin: Plugin admin is version 2.1.0', 'admin: renders light']);
  // Off before the certify and on after it, with no step between that switches it: the pack can switch it, so the
  // capture pass does, off camera, just before that step. Set first puts it back.
  assert.deepEqual(r.needs.filter(n => n.kind === 'start'), []);
  assert.match(formatReset(r), /^## Set before beat 2, Click "Certified"$/m);
  assert.deepEqual(parseReset(formatReset(r)).before, [{ beat: 2, text: 'Click "Certified"', n: null, items: [{ what: 'admin: "Sync" is on', set: '"Enable Sync" · admin:sync', opens: 'https://admin.test/sync', seen: 'beat 2, admin-certified' }] }]);
  assert.deepEqual(parseReset(formatReset(r)).set, [{ what: 'admin: "Sync" is off', set: '"Enable Sync" · admin:sync', opens: 'https://admin.test/sync', seen: 'beat 2, admin-home' }]);
  // A step its beat has twice is named by its number.
  assert.deepEqual(parseReset(formatReset({ ...r, before: [{ ...r.before[0], text: 'Scroll down', n: 4 }] })).before.map(b => [b.beat, b.text, b.n]), [[2, 'Scroll down', 4]]);
  // When the pack has no write for that switch, a run can't show it: the plan needs that step.
  const other = resetFor(plan, { walker, packs: { forApp: { admin: { id: 'admin', writes: [{ id: 'seat', on: { kind: 'click', target: 'Add one seat' } }] } }, writeFor } });
  assert.deepEqual([other.before, other.set], [[], []]);
  assert.match(other.needs.find(n => n.kind === 'start').text, /^"Sync" is off before Click "Certified" and on after it.*Add Click "Enable Sync" after it$/);
  assert.doesNotMatch(formatReset(other), /## Set before/);
  // A check names the screen it's read on when the reset knows it; the capture pass gets there by the plan.
  const checks = parseReset(formatReset(r)).checks;
  assert.match(formatReset(r), /^- admin on admin-home: "Sync" is off$/m);
  assert.deepEqual(checks.find(c => c.text === '"Sync" is off'), { app: 'admin', screen: 'admin-home', text: '"Sync" is off', from: 'start: beat 2, admin-home' });
  assert.deepEqual(checks.find(c => c.text === 'no endorsement'), { app: 'admin', screen: null, text: 'no endorsement', from: 'beat 2' });
});

test('words a screen\'s captures show differently (a greeting each visit) never prove a step', () => {
  const demo = demoDir();
  const flow = JSON.parse(readFileSync(join(demo.dir, 'flow.json'), 'utf8'));
  writeFileSync(join(demo.dir, 'flow.json'), JSON.stringify({ ...flow, variants: ['tog-chat-home-collapsed', 'v200-admin-home'] }));
  writeFileSync(join(demo.dir, 'data', 'snaps', 'tog-chat-home-collapsed.html'), readFileSync(join(demo.dir, 'data', 'snaps', 'chat-home.html'), 'utf8').replace('<h1>New chat</h1>', '<h1>Ask me anything</h1>'));
  writeFileSync(join(demo.dir, 'data', 'snaps', 'v200-admin-home.html'), readFileSync(join(demo.dir, 'data', 'snaps', 'admin-home.html'), 'utf8').replace('17 curated here', '19 curated here'));
  const walker = walkerFromDemo(demo);
  assert.deepEqual(['New chat', 'Ask me anything', 'Plugin admin', '17 curated here'].map(t => walker.unstable(t, t === 'Plugin admin' || /curated/.test(t) ? 'admin' : 'chat')), [true, true, false, false]);
  // Only in its app: another app's words that read the same aren't touched.
  assert.equal(walker.unstable('New chat', 'admin'), false);
  const plan = { beats: [{ steps: [{ kind: 'app', app: 'admin', lands: { screen: 'admin-home' } }, { kind: 'app', app: 'chat', lands: { screen: 'chat-home', text: 'New chat' } }] }] };
  proveLandings(plan, walker);
  assert.notEqual(plan.beats[0].steps[1].lands.text, 'New chat');
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
  const flags = [];
  const plan = planFromRecording(rec, { walker, flags });
  assert.deepEqual(plan.beats.map(b => b.steps.map(s => s.text)), [['Go to chat', `Type "What's changed on PO-1?"`, 'Press Enter', 'Wait for the answer'], ['Click "Save: Save note"'], ['Go to admin', 'Click "Certified"']]);
  // Its landings prove each step too: what was typed shows in the chat box, and nothing needs her.
  assert.deepEqual([plan.beats[0].steps[1].lands, flags], [{ screen: 'chat-typed', kind: 'words', text: "What's changed on PO-1?" }, []]);
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

test('proofs on today\'s product: kept, new, today only, behind a write, missed; never a greeting, a passing tip or a page the guard broke', () => {
  // A shop, recorded; then a read-only walk of it today: its catalog's heading, an item's heading and a link renamed,
  // another greeting on the home screen, and a tip that changes between the walk's two reads.
  const dir = mkdtempSync(join(tmpdir(), 'sc-reground-'));
  const help = '<nav><a href="/help">Help</a></nav>';
  const item = v => `<h1>Contoso Outfitters</h1>${help}<h2>Fabrikam Boots details</h2><label>Promo code <input type="text"${v ? ` value="${v}"` : ''}></label><button>Add to cart</button><a href="/">Contoso home</a><a href="/sale">Sale</a>`;
  const snaps = {
    home: `<h1>Contoso Outfitters</h1><p>Hi, what are you shopping for?</p>${help}<a href="/catalog">Catalog</a>`,
    // The same screen captured again, with the greeting it gives on another visit.
    'tog-home-collapsed': `<h1>Contoso Outfitters</h1><p>Hello! Looking for something?</p>${help}<a href="/catalog">Catalog</a>`,
    catalog: `<h1>Contoso Outfitters</h1>${help}<h2>Spring catalog</h2><p>Filter by size</p><a href="/boots">Fabrikam Boots</a>`,
    item: item(''), 'item-typed': item('SPRING25'),
    cart: `<h1>Contoso Outfitters</h1>${help}<h2>Your cart</h2><button>Checkout</button>`,
    checkout: `<h1>Contoso Outfitters</h1>${help}<h2>Pay for your order</h2>`,
    sale: `<h1>Contoso Outfitters</h1>${help}<h2>Spring sale</h2>`,
  };
  const INPUT = { sel: 'input' };
  const flow = { apps: [{ id: 'shop', key: 'S' }], variants: ['tog-home-collapsed'], beats: [{ active: 'shop', states: { shop: 'home' } }], path: [],
    states: { home: { app: 'shop', snap: 'home' }, catalog: { app: 'shop', snap: 'catalog' }, item: { app: 'shop', snap: 'item', on: [{ type: INPUT, to: 'item-typed' }], fill: [{ ...INPUT, value: 'SPRING25' }] },
      'item-typed': { app: 'shop', snap: 'item-typed' }, cart: { app: 'shop', snap: 'cart' }, checkout: { app: 'shop', snap: 'checkout' }, sale: { app: 'shop', snap: 'sale' } } };
  const page = body => `<!doctype html><html><head><title>Contoso</title></head><body>${body}</body></html>`;
  mkdirSync(join(dir, 'data', 'snaps'), { recursive: true });
  for (const [id, body] of Object.entries(snaps)) writeFileSync(join(dir, 'data', 'snaps', id + '.html'), page(body));
  writeFileSync(join(dir, 'flow.json'), JSON.stringify(flow));
  const demo = { dir, out: join(dir, '.out'), raw: join(dir, 'no-raw'), cfg: { name: 't', apps: [{ id: 'shop', key: 'S', title: 'Contoso shop' }] } };
  const text = `# Boots

## Beat 1 · Browse

- Go to shop
  Lands on: home · "Contoso Outfitters"
- Click "Catalog"
  Lands on: catalog · "Spring catalog"
- Click "Fabrikam Boots"
  Lands on: item · "Fabrikam Boots details"
- Type "SPRING25" in "Promo code"
  Lands on: item-typed · box "Promo code" says "SPRING25"
- Click "Add to cart" — ask first
  Writes: adds the boots to the cart
  Lands on: cart · "Your cart"
- Click "Checkout"
  Lands on: checkout · "Pay for your order"

## Beat 2 · Look again

- Click "Contoso home"
  Lands on: home · control "Catalog"
- Click "Sale"
  Lands on: sale · "Spring sale"
`;
  writeFileSync(join(dir, 'plan.md'), text);
  // Today's screens, as the walk saves them: two reads of each, about a second apart, as the frames' markup.
  const home = tip => page(`<h1>Contoso Outfitters</h1><p>Good to see you again</p>${help}<a href="/catalog">Shop the catalog</a><h3>Tip of the day: ${tip}</h3>`);
  const today = v => page(`<h1>Contoso Outfitters</h1>${help}<h2>Boots by Fabrikam</h2><label>Promo code <input type="text"${v ? ` value="${v}"` : ''}></label><button>Add to cart</button><a href="/">Contoso home</a>`);
  const at = sec => new Date(Date.UTC(2026, 10, 24, 8, 0, sec)).toISOString();
  const two = (t, a, b = a) => [a, b].map((html, i) => ({ at: at(t + i), docs: [{ key: 'main', html }] }));
  const walkDir = join(dir, 'walk-12');
  const screens = { 'start-shop': two(0, home('wear thick socks'), home('try a half size up')), '1-1': two(10, home('wear thick socks'), home('try a half size up')),
    '1-2': two(20, page(`<h1>Contoso Outfitters</h1>${help}<h2>Summer catalog</h2><p>Filter by size</p><a href="/boots">Fabrikam Boots</a>`)),
    '1-3': two(30, today('')), '1-4': two(40, today('SPRING25')), '2-1': two(50, home('wear thick socks'), home('try a half size up')) };
  mkdirSync(join(walkDir, 'walk-screens'), { recursive: true });
  for (const [f, v] of Object.entries(screens)) writeFileSync(join(walkDir, 'walk-screens', f + '.reads.json.gz'), gzipSync(JSON.stringify(v)));
  const row = (step, t, status, why) => ({ step, text: t, status, ...(why ? { why } : {}) });
  const walk = { beats: [
    { beat: 1, steps: [row(0, 'Go to shop', 'reached'), row(1, 'Click "Catalog"', 'drifted'), row(2, 'Click "Fabrikam Boots"', 'drifted'), row(3, 'Type "SPRING25" in "Promo code"', 'reached'),
      row(4, 'Click "Add to cart"', 'write', 'adds the boots to the cart'), row(5, 'Click "Checkout"', 'after-write', 'needs beat 1\'s write: Click "Add to cart"')] },
    { beat: 2, steps: [row(0, 'Click "Contoso home"', 'drifted'), row(1, 'Click "Sale"', 'missed', 'no “Sale” on this screen')] }] };
  writeFileSync(join(walkDir, 'walk.json'), JSON.stringify(walk));
  const walker = walkerFromDemo(demo);
  const { plan, rows } = regroundPlan(parsePlan(text), { walker, walk, reads: walkReads(join(walkDir, 'walk-screens')) });
  assert.deepEqual(rows.map(r => [r.text, r.now, r.basis, r.why]), [
    ['Go to shop', 'home · "Contoso Outfitters"', 'both', null],
    ['Click "Catalog"', 'catalog · "Filter by size"', 'both', '“Spring catalog” isn\'t on today\'s screen'],
    ['Click "Fabrikam Boots"', 'item · "Promo code"', 'both', '“Fabrikam Boots details” isn\'t on today\'s screen'],
    ['Type "SPRING25" in "Promo code"', 'item-typed · box "Promo code" says "SPRING25"', 'both', null],
    ['Click "Add to cart"', 'cart · "Your cart"', 'write', 'a write: adds the boots to the cart'],
    ['Click "Checkout"', 'checkout · "Pay for your order"', 'write', 'needs beat 1\'s write: Click "Add to cart"'],
    // Nothing on both: today's alone. Not the greeting (the recording's changes on each visit), not the tip (it
    // changed between the two reads).
    ['Click "Contoso home"', 'home · "Shop the catalog"', 'today', 'the “Catalog” control isn\'t on today\'s screen'],
    ['Click "Sale"', 'sale · "Spring sale"', 'missed', 'no “Sale” on this screen'],
  ]);
  assert.equal(formatLands(plan.beats[1].steps[0].lands), 'home · "Shop the catalog"');
  // What a capture of today's product would lose: words and controls the recorded screen has, and both reads lack. The
  // greeting the recording's captures show differently varies between runs.
  const miss = r => (r.missing || []).map(e => [e.cls, e.kind, e.text]);
  assert.deepEqual([miss(rows[1]), miss(rows[2]), miss(rows[6])], [[['missing', 'words', 'Spring catalog']], [['missing', 'control', 'Sale'], ['missing', 'words', 'Fabrikam Boots details']],
    [['missing', 'control', 'Catalog'], ['varies', 'words', 'Hi, what are you shopping for?']]]);
  assert.match(formatReground(rows), /## Missing since the recording[\s\S]*\| Missing: look at these \| 4 \| 4 \|[\s\S]*\| Varies between runs \| 1 \| 1 \|[\s\S]*### Missing: look at these\n\n\| What \| Why it may be \| Screen \(steps\) \|\n\|---\|---\|---\|\n\| “Catalog” \(link\) \| {2}\| home \(1-1, 2-1\) \|\n\| “Spring catalog” \| {2}\| catalog \(1-2\) \|\n\| “Sale” \(link\) \| {2}\| item \(1-3\); item-typed \(1-4\) \|/);
  const greeting = regroundPlan(parsePlan(text), { walker: { ...walker, unstable: null }, walk, reads: walkReads(join(walkDir, 'walk-screens')) }).rows[6];
  assert.equal(greeting.now, 'home · "Good to see you again"');
  assert.match(formatReground(rows), /\| Kept: it holds today and in the recording \| 2 \|\n\| New: it holds today and in the recording \| 2 \|\n\| Today's product only: it changed since the recording \| 1 \|/);
  // Written beside the plan, which stays as it is (its approval is its exact text).
  assert.deepEqual(reground(demo, { from: walkDir }), { steps: 8, kept: 2, changed: 2, today: 1, suspect: 0, none: 0, write: 2, missed: 1, unreached: 0, file: 'reground.md', plan: 'plan.reground.md' });
  assert.equal(readFileSync(join(dir, 'plan.md'), 'utf8'), text);
  assert.match(readFileSync(join(demo.out, 'ai', 'plan.reground.md'), 'utf8'), /- Click "Contoso home"\n  Lands on: home · "Shop the catalog"\n/);
  // A walk of another plan isn't this plan's.
  const old = JSON.parse(JSON.stringify(walk));
  old.beats[0].steps[1].text = 'Click "Shoes"';
  assert.throws(() => regroundPlan(parsePlan(text), { walker, walk: old, reads: walkReads(join(walkDir, 'walk-screens')) }), /the walk was of another plan \(beat 1, step 2/);
  // The plan has moved on since the walk (a step added): the plan it walked, named.
  writeFileSync(join(walkDir, 'walked.md'), text);
  writeFileSync(join(dir, 'plan.md'), text.replace('- Click "Catalog"\n', '- Click "Menu"\n  Lands on: home\n- Click "Catalog"\n'));
  assert.throws(() => reground(demo, { from: walkDir }), /the walk was of another plan \(beat 1, step 2 was “Click "Catalog"”, now “Click "Menu"”\)/);
  assert.equal(reground(demo, { from: walkDir, plan: join(walkDir, 'walked.md') }).kept, 2);
  // A screen saved without its markup (only its words and controls: a walk from before reads were kept) isn't read:
  // the step says why.
  rmSync(join(walkDir, 'walk-screens', '1-2.reads.json.gz'));
  writeFileSync(join(walkDir, 'walk-screens', '1-2.json'), JSON.stringify({ beat: 1, step: 2, status: 'drifted', screen: 'catalog', words: ['Contoso Outfitters'], controls: [] }));
  const bare = regroundPlan(parsePlan(text), { walker, walk, reads: walkReads(join(walkDir, 'walk-screens')) }).rows[1];
  assert.deepEqual([bare.basis, bare.now, bare.why], ['unreached', 'catalog · "Spring catalog"', 'the walk saved its screen without the page\u2019s markup']);
  // The walk says a step needs a write it didn't make in this app (a missed one, the steps after it, or a drifted one):
  // behind that write, and never a proof from today alone.
  const needs = 'beat 1\'s write: Click "Add to cart"';
  const needing = { ...walk, beats: [walk.beats[0], { beat: 2, steps: walk.beats[1].steps.map(r => ({ ...r, needs })) }] };
  const nd = regroundPlan(parsePlan(text), { walker, walk: needing, reads: walkReads(join(walkDir, 'walk-screens')) }).rows;
  assert.deepEqual(nd.slice(6).map(r => [r.basis, r.now, r.why]), [
    ['write', 'home · control "Catalog"', `needs ${needs}`],
    ['write', 'sale · "Spring sale"', `needs ${needs} (the walk: no “Sale” on this screen)`],
  ]);
  // The guard held requests while the walk ran. Telemetry, and what a pack has reviewed as staying held, change
  // nothing; anything else may have broken its app's page, from then on: a step of that app that doesn't land as
  // planned keeps its proof and goes on Needs you, to check the pack first. By time (the walk's inputs and reads), or
  // the walk's own held list for a step.
  const events = { method: 'POST', host: 'telemetry.contoso.test', path: '/events' }, items = n => ({ method: 'POST', host: 'api.contoso.test', path: `/catalog/${n}/items` });
  const guarded = { ...walk, starts: [{ app: 'shop' }], inputs: [{ at: at(25), for: 'Click "Fabrikam Boots"' }], guard: { held: [{ ...events, at: at(5) }, { ...items(2026), at: at(27) }, { ...events, at: at(28) }] } };
  writeFileSync(join(walkDir, 'walk-screens', '2-1.json'), JSON.stringify({ beat: 2, step: 1, held: [items(2027)] }));
  const regrounded = (more = {}) => regroundPlan(parsePlan(text), { walker, walk: guarded, reads: walkReads(join(walkDir, 'walk-screens')), ...more }).rows;
  const g = regrounded();
  const held = 'the guard held POST api.contoso.test/catalog/*/items; check the pack before adopting';
  assert.deepEqual(g.map(r => r.basis), ['both', 'unreached', 'suspect', 'both', 'write', 'write', 'suspect', 'suspect']);
  assert.deepEqual([g[2].now, g[2].why, g[6].now, g[6].why, g[7].why], ['item · "Fabrikam Boots details"', held, 'home · control "Catalog"', held, `${held} (the walk: no “Sale” on this screen)`]);
  assert.match(formatReground(g), /\| Its app's page may be broken today \(Needs you\) \| 3 \|[\s\S]*## Needs you\n\nThese steps’ pages may have been broken/);
  // Reviewed in its pack as staying held: nothing to suspect.
  const reviewed = regrounded({ packs: { forApp: { shop: { guard: { stayHeld: ['/^POST api\\.contoso\\.test\\/catalog\\/[^/]+\\/items$/'] } } } } });
  assert.deepEqual(reviewed.map(r => r.basis), ['both', 'unreached', 'both', 'both', 'write', 'write', 'today', 'missed']);
  // Without the guard's log: an error today's screen shows that the recording doesn't, or words the app lost while
  // nothing ran in it (between its start screen and Go to).
  const broken = sec => page(`<h1>Contoso Outfitters</h1>${help}<h2>Boots by Fabrikam</h2><div role="alert">Couldn't load your cart. Check your connection and try again.</div><a href="/">Contoso home</a>`);
  writeFileSync(join(walkDir, 'walk-screens', '1-3.reads.json.gz'), gzipSync(JSON.stringify(two(30, broken(30)))));
  rmSync(join(walkDir, 'walk-screens', '2-1.json'));
  const e = regroundPlan(parsePlan(text), { walker, walk, reads: walkReads(join(walkDir, 'walk-screens')) }).rows;
  assert.deepEqual(e.map(r => r.basis), ['both', 'unreached', 'suspect', 'both', 'write', 'write', 'suspect', 'suspect']);
  assert.equal(e[2].why, 'today\'s screen shows an error the recording doesn\'t: “Couldn\'t load your cart. Check your connection and try again.”; check the app before adopting');
  writeFileSync(join(walkDir, 'walk-screens', '1-3.reads.json.gz'), gzipSync(JSON.stringify(two(30, page(`<h1>Contoso Outfitters</h1>${help}<h2>Boots by Fabrikam</h2><p>Sizes could not be loaded. Retry</p><a href="/">Contoso home</a>`)))));
  assert.match(regroundPlan(parsePlan(text), { walker, walk, reads: walkReads(join(walkDir, 'walk-screens')) }).rows[2].why, /^today's screen shows an error the recording doesn't: “Sizes could not be loaded\. Retry”/);
  writeFileSync(join(walkDir, 'walk-screens', '1-3.reads.json.gz'), gzipSync(JSON.stringify(two(30, today('')))));
  writeFileSync(join(walkDir, 'walk-screens', 'start-shop.reads.json.gz'), gzipSync(JSON.stringify(two(0, page(`<h1>Contoso Outfitters</h1><p>Good to see you again</p>${help}<a href="/catalog">Shop the catalog</a><p>Free returns on boots</p>`)))));
  const l = regroundPlan(parsePlan(text), { walker, walk, reads: walkReads(join(walkDir, 'walk-screens')) }).rows;
  assert.deepEqual(l.map(r => r.basis), ['both', 'unreached', 'suspect', 'both', 'write', 'write', 'suspect', 'suspect']);
  assert.equal(l[2].why, 'shop lost words while nothing ran in it, since its start screen: “Free returns on boots”; check the app before adopting');
  // A response of 500 or more to the app that asked: the service it names was down for it from then on. Not
  // telemetry's, or a 404.
  writeFileSync(join(walkDir, 'walk-screens', 'start-shop.reads.json.gz'), gzipSync(JSON.stringify(screens['start-shop'])));
  const net = [{ at: at(27), method: 'GET', host: 'api.contoso.test', path: '/catalog/2026/items', status: 503, app: 'shop' }, { at: at(14), method: 'GET', host: 'mail.contoso.test', path: '/inbox', status: 500 },
    { at: at(15), method: 'POST', host: 'telemetry.contoso.test', path: '/events', status: 500, app: 'shop' }, { at: at(16), method: 'GET', host: 'api.contoso.test', path: '/photo', status: 404, app: 'shop' }];
  const apps = [{ id: 'shop', url: 'https://shop.contoso.test/' }, { id: 'mail', url: 'https://mail.contoso.test/' }];
  const down = regroundPlan(parsePlan(text), { walker, walk: { ...walk, net }, reads: walkReads(join(walkDir, 'walk-screens')), apps }).rows;
  assert.deepEqual(down.map(r => r.basis), ['both', 'unreached', 'suspect', 'both', 'write', 'write', 'suspect', 'suspect']);
  assert.equal(down[2].why, 'GET api.contoso.test/catalog/*/items answered 503; check the app before adopting');
  // From when it answered: not for a step read before then.
  const gap = { ...walk, net: [{ ...net[0], at: at(33) }] };
  assert.deepEqual(regroundPlan(parsePlan(text), { walker, walk: gap, reads: walkReads(join(walkDir, 'walk-screens')), apps }).rows.filter((r, k) => k === 2 || k === 6).map(r => r.basis), ['both', 'suspect']);
  // A step the walk missed is when the walk's window for it ends: what the guard held after that isn't its doing.
  const missed = { ...walk, beats: [walk.beats[0], { ...walk.beats[1], steps: [walk.beats[1].steps[0], { ...walk.beats[1].steps[1], window: { from: at(60), to: at(62) } }] }] };
  const heldAt = sec => ({ ...missed, guard: { held: [{ method: 'POST', host: 'api.contoso.test', path: '/cart', at: at(sec), app: 'shop' }] } });
  assert.deepEqual([61, 65].map(sec => regroundPlan(parsePlan(text), { walker, walk: heldAt(sec), reads: walkReads(join(walkDir, 'walk-screens')), apps }).rows[7].basis), ['suspect', 'missed']);
  // A 500 while the walk looked for a step it missed: that step's, not the one before.
  const late = { ...missed, net: [{ ...net[0], at: at(61) }] };
  assert.deepEqual(regroundPlan(parsePlan(text), { walker, walk: late, reads: walkReads(join(walkDir, 'walk-screens')), apps }).rows.map(r => r.basis).slice(6), ['today', 'suspect']);
});

test('what a capture of today\'s product would lose, by why (renamed, a number, made by a write the walk didn\'t make, varies, missing), and show that the recording doesn\'t; a list\'s rows as one line', () => {
  // A shop, recorded with a write (an order); a read-only walk of it today, after the shop changed a little.
  const dir = mkdtempSync(join(tmpdir(), 'sc-missing-'));
  const page = body => `<!doctype html><html><head><title>Contoso</title></head><body>${body}</body></html>`;
  const head = (status, cart = 'Cart') => `<header><a href="/">Contoso home</a><button aria-label="Avery Chen, status ${status}">AC</button><a href="/cart">${cart}</a></header>`;
  const boots = (names, more = {}, before = {}) => `<ul aria-label="Boots">${names.map(n => `<li>${before[n] ? `<span>${before[n]}</span>` : ''}<a href="/b">${n}</a>${[].concat(more[n] || []).map(t => `<span>${t}</span>`).join('')}</li>`).join('')}</ul>`;
  const snaps = {
    home: `${head('Available')}<h2>Welcome back</h2><a href="/catalog">Catalog</a><button>Rewards</button><p>Deal 1 of 3</p><p>Deal 3 of 3</p>`,
    catalog: `${head('Available')}<h2>Spring catalog</h2><p>Showing 24 boots</p><p>Free shipping on Fabrikam Trail</p><p>Note: ships in a box</p><p>Note: free returns</p><p>Note: two colours</p><button>Filter</button>${boots(['Fabrikam Trail', 'Fabrikam Summit', 'Contoso Hiker', 'Contoso Ridge', 'Fabrikam Ranger', 'Contoso Peak', 'Fabrikam Canyon', 'Contoso Delta'], { 'Fabrikam Trail': ['Waterproof leather', '3 pairs left'], 'Contoso Hiker': ['Wide fit', '5 pairs left'], 'Contoso Delta': 'Last pair' })}<button>Add to cart</button>`,
    cart: `${head('Available', 'Cart (1)')}<h2>Your cart</h2><p>Fabrikam Trail boots</p>`,
    // Home again, after the order: at the same address as before it.
    'home-after': `${head('Available', 'Cart (1)')}<h2>Welcome back</h2><p>Thanks for your order</p><a href="/catalog">Catalog</a><button>Rewards</button>`,
    // An address the shop hadn't shown before the order.
    orders: `${head('Available', 'Cart (1)')}<h2>Your orders</h2><ul role="listbox" aria-label="Orders"><li role="option"><span>Order 1001 for Avery Chen</span><span>Ready to ship</span></li></ul><a href="/t">Fabrikam Trail boots, shipped</a>`,
  };
  const url = { home: '/', catalog: '/catalog', cart: '/cart', 'home-after': '/', orders: '/orders' };
  mkdirSync(join(dir, 'data', 'snaps'), { recursive: true });
  for (const [id, body] of Object.entries(snaps)) {
    writeFileSync(join(dir, 'data', 'snaps', id + '.html'), page(body));
    writeFileSync(join(dir, 'data', 'snaps', id + '.json'), JSON.stringify({ url: `https://shop.contoso.test${url[id]}` }));
  }
  writeFileSync(join(dir, 'flow.json'), JSON.stringify({ apps: [{ id: 'shop', key: 'S' }], beats: [{ active: 'shop', states: { shop: 'home' } }], path: [], states: Object.fromEntries(Object.keys(snaps).map(id => [id, { app: 'shop', snap: id }])) }));
  const demo = { dir, out: join(dir, '.out'), raw: join(dir, 'no-raw'), cfg: { name: 't', apps: [{ id: 'shop', key: 'S', title: 'Contoso shop', url: 'https://shop.contoso.test/' }] } };
  const text = '# Boots\n\n## Beat 1 · Shop\n\n- Go to shop\n  Lands on: home · "Welcome back"\n- Click "Catalog"\n  Lands on: catalog · "Spring catalog"\n'
    + '- Click "Add to cart" — ask first\n  Writes: orders the boots\n  Lands on: cart · "Your cart"\n\n## Beat 2 · Home again\n\n- Click "Contoso home"\n  Lands on: home-after · "Thanks for your order"\n'
    + '- Click "Orders"\n  Lands on: orders · "Your orders"\n';
  // Today: someone else's presence, a button with more words, other counts, another filter, other boots, no orders.
  const home = `${head('Away')}<h2>Welcome back</h2><a href="/catalog">Catalog</a><button>Rewards, 120 points</button><p>Deal 1 of 2</p>`;
  // Initials before a name aren't its row's name; a name in capitals is.
  const catalog = `${head('Away')}<h2>Spring catalog</h2><p>Showing 31 boots</p><button>Filter boots</button>${boots(['Contoso Alpine', 'Fabrikam Trail', 'Fabrikam Mesa', 'Contoso Hiker', 'Fabrikam Butte', 'Contoso Basin', 'XTR'], { XTR: 'Trail runner', 'Fabrikam Trail': '2 pairs left', 'Contoso Hiker': '4 pairs left' }, { 'Fabrikam Mesa': 'FM' })}<button>Add to cart</button>`;
  const at = sec => new Date(Date.UTC(2026, 10, 24, 8, 0, sec)).toISOString();
  const two = (t, html) => [0, 1].map(i => ({ at: at(t + i), docs: [{ key: 'main', html: page(html) }] }));
  const walkDir = join(dir, 'walk');
  mkdirSync(join(walkDir, 'walk-screens'), { recursive: true });
  const orders = `${head('Away')}<h2>Your orders</h2><p>No orders yet</p>`;
  for (const [f, v] of Object.entries({ 'start-shop': two(0, home), '1-1': two(10, home), '1-2': two(20, catalog), '2-1': two(50, home), '2-2': two(60, orders) })) writeFileSync(join(walkDir, 'walk-screens', f + '.reads.json.gz'), gzipSync(JSON.stringify(v)));
  // The guard held the catalog's items while the walk was on it.
  const walk = { beats: [{ beat: 1, steps: [{ step: 0, text: 'Go to shop', status: 'reached' }, { step: 1, text: 'Click "Catalog"', status: 'reached' }, { step: 2, text: 'Click "Add to cart"', status: 'write', why: 'orders the boots' }] },
    { beat: 2, steps: [{ step: 0, text: 'Click "Contoso home"', status: 'drifted' }, { step: 1, text: 'Click "Orders"', status: 'reached' }] }],
  starts: [{ app: 'shop' }], inputs: [{ at: at(14), for: 'Click "Catalog"' }], guard: { held: [{ method: 'POST', host: 'api.contoso.test', path: '/catalog/2026/items', at: at(15) }] } };
  const walker = walkerFromDemo(demo), reads = walkReads(join(walkDir, 'walk-screens'));
  const { rows } = regroundPlan(parsePlan(text), { walker, walk, reads, apps: demo.cfg.apps });
  const miss = r => r.missing.map(e => [e.cls, e.kind === 'list' ? `${e.changed ? 'in ' : ''}${e.count} of ${e.total} rows` : e.kind === 'like' ? `${e.count} like ${e.prefix}` : e.text, e.now || (e.nows && e.nows.join(', ')) || e.write || e.why || null]);
  const held = 'the guard held POST api.contoso.test/catalog/*/items';
  const ordered = 'Click "Add to cart" (step 1-3)';
  assert.deepEqual(rows.filter(r => r.read).map(miss), [
    // Each of today's numbers explains one recorded: "Deal 3 of 3" isn't "Deal 1 of 2".
    [['varies', 'Avery Chen, status Available', "someone's presence"], ['renamed', 'Rewards', 'Rewards, 120 points'], ['number', 'Deal 1 of 3', 'Deal 1 of 2'], ['missing', 'Deal 3 of 3', null]],
    // Not "Filter boots": a name with more words isn't the same control unless they're set off ("Rewards, …"). Words
    // holding others still there are missing all the same. Rows gone are one line; what's gone from rows still there
    // is another; words that start the same way ("Note: …") another.
    [['varies', 'Avery Chen, status Available', "someone's presence"], ['missing', 'Filter', held], ['number', 'Showing 24 boots', 'Showing 31 boots'], ['missing', 'Free shipping on Fabrikam Trail', held],
      ['missing', '6 of 8 rows', held], ['missing', 'in 2 of 8 rows', held], ['number', 'in 2 of 8 rows', '2 pairs left, 4 pairs left'], ['missing', '3 like Note', held]],
    // What the order made: on its own screen first (the cart), or on a screen at an address the app showed before it.
    [['varies', 'Avery Chen, status Available', "someone's presence"], ['expected', 'Cart (1)', ordered], ['renamed', 'Rewards', 'Rewards, 120 points'], ['expected', 'Thanks for your order', ordered]],
    // At a new address: what isn't the order's as far as the recording shows, but a name with more after it is first
    // shown where its name is (the cart). Not the order's option itself: it's named by what's in it.
    [['varies', 'Avery Chen, status Available', "someone's presence"], ['expected', 'Cart (1)', ordered], ['expected', 'Fabrikam Trail boots, shipped', ordered], ['missing', 'Order 1001 for Avery Chen', held], ['missing', 'Ready to ship', held]],
  ]);
  // Words the recording's captures show differently: in the page's own content they vary (a greeting), even after a
  // write; in the app's frame a write may have made them (a title in Recent).
  const vary = regroundPlan(parsePlan(text), { walker: { ...walker, unstable: t => /^(Thanks for your order|Cart \(1\))$/.test(t) }, walk, reads, apps: demo.cfg.apps }).rows;
  assert.deepEqual(miss(vary[3]).filter(([c]) => c !== 'renamed'), [['varies', 'Avery Chen, status Available', "someone's presence"], ['expected', 'Cart (1)', ordered], ['varies', 'Thanks for your order', "the recording's captures of this screen differ there"]]);
  // In a row named by words the recording's writes made: that write's. A row whose name a capture doesn't list (words
  // Copilot wrote) is gone all the same when today's screen doesn't have it, with what's in it.
  const named = regroundPlan(parsePlan(text), { walker: { ...walker, written: t => /^Order 1001|^Contoso Delta$/.test(t) }, walk, reads, apps: demo.cfg.apps }).rows;
  assert.deepEqual(miss(named[4]).slice(2), [['expected', 'Fabrikam Trail boots, shipped', ordered], ['expected', 'Ready to ship', ordered]]);
  assert.deepEqual(named[1].missing.filter(e => e.kind === 'list' && !e.changed).map(e => [e.count, e.entries, e.rows.length]), [[6, 6, 5]]);
  // A list's rows: how many, its first five as recorded, and today's first five.
  const boots6 = rows[1].missing.find(e => e.kind === 'list' && !e.changed);
  assert.deepEqual([boots6.name, boots6.rows, boots6.first.slice(0, 2), boots6.other], ['Boots', ['Fabrikam Summit', 'Contoso Ridge', 'Fabrikam Ranger', 'Contoso Peak', 'Fabrikam Canyon'], ['Fabrikam Trail', 'Fabrikam Summit'],
    { total: 7, first: ['Contoso Alpine', 'Fabrikam Trail', 'Fabrikam Mesa', 'Contoso Hiker', 'Fabrikam Butte'] }]);
  // What today shows that the recording doesn't, apart from what's renamed or a number that changed, and someone's
  // presence: the new boots as one line.
  assert.deepEqual(rows.filter(r => r.read).map(r => r.extra.map(e => e.kind === 'list' ? `${e.count} of ${e.total} rows: ${e.rows.join(', ')}` : e.text)),
    [[], ['Filter boots', '5 of 7 rows: Contoso Alpine, Fabrikam Mesa, Fabrikam Butte, Contoso Basin, XTR'], ['Deal 1 of 2'], ['No orders yet']]);
  const md = formatReground(rows);
  assert.deepEqual(missingCounts(rows), { missing: { entries: 16, lines: 8 }, renamed: { entries: 1, lines: 1 }, number: { entries: 4, lines: 3 }, expected: { entries: 3, lines: 3 }, varies: { entries: 1, lines: 1 }, beyond: { entries: 0, lines: 0 }, extra: { entries: 8, lines: 4 } });
  assert.match(md, /## Extra since the recording\n\n[^\n]*8 in 4 lines[^\n]*\n\n\| What \| Screen \(steps\) \|\n\|---\|---\|\n\| “Filter boots” \(button\) \| catalog \(1-2\) \|\n\| 5 of 7 rows of the list “Boots”: “Contoso Alpine”, “Fabrikam Mesa”, “Fabrikam Butte”, “Contoso Basin”, “XTR”\. Recorded: 8 rows, starting “Fabrikam Trail”/);
  assert.match(md, /\| 2 in 2 of 8 rows of the list “Boots” that are still there, starting “Waterproof leather”, “Wide fit” \|[^\n]*\n\| 3 like “Note: …”, starting “Note: ships in a box”, “Note: free returns”, “Note: two colours” \|/);
  assert.match(md, /\| 6 of 8 rows of the list “Boots”, from “Fabrikam Summit”, “Contoso Ridge”, “Fabrikam Ranger”, “Contoso Peak”, “Fabrikam Canyon”\. Recorded, it starts “Fabrikam Trail”, “Fabrikam Summit”, “Contoso Hiker”, “Contoso Ridge”, “Fabrikam Ranger”\. Today: 7 rows, starting “Contoso Alpine”, “Fabrikam Trail”, “Fabrikam Mesa”, “Contoso Hiker”, “Fabrikam Butte” \| the guard held POST api\.contoso\.test\/catalog\/\*\/items \| catalog \(1-2\) \|/);
  assert.match(md, /### Renamed\n\n\| Recorded \| Today \| Screen \(steps\) \|\n\|---\|---\|---\|\n\| “Rewards” \(button\) \| “Rewards, 120 points” \| home \(1-1\); home-after \(2-1\) \|/);
  // The page loaded again after what the guard held: nothing may be broken from then on.
  assert.equal(rows[3].basis, 'suspect');
  const reloaded = regroundPlan(parsePlan(text), { walker, walk: { ...walk, events: [{ kind: 'loaded', host: 'shop.contoso.test', path: '/', at: at(40) }] }, reads, apps: demo.cfg.apps }).rows;
  assert.deepEqual([reloaded[1].missing.find(e => e.kind === 'list').why, reloaded[3].basis], [held, 'both']);
});

test('a response of 500 or more counts for the app that asked, from then until it loads again, wherever the walk was', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-down-'));
  const page = body => `<!doctype html><html><head><title>Contoso</title></head><body>${body}</body></html>`;
  const snaps = { shop: '<h1>Contoso shop</h1><a href="/c">Catalog</a>', catalog: '<h1>Contoso shop</h1><h2>Spring catalog</h2>', mail: '<h1>Fabrikam mail</h1><a href="/i">Inbox</a>', inbox: '<h1>Fabrikam mail</h1><h2>Your inbox</h2>' };
  mkdirSync(join(dir, 'data', 'snaps'), { recursive: true });
  for (const [id, body] of Object.entries(snaps)) writeFileSync(join(dir, 'data', 'snaps', id + '.html'), page(body));
  const apps = [{ id: 'shop', key: 'S', url: 'https://shop.contoso.test/' }, { id: 'mail', key: 'M', url: 'https://mail.fabrikam.test/' }];
  writeFileSync(join(dir, 'flow.json'), JSON.stringify({ apps, beats: [{ active: 'shop', states: { shop: 'shop', mail: 'mail' } }], path: [], states: Object.fromEntries(Object.keys(snaps).map(id => [id, { app: /^(mail|inbox)$/.test(id) ? 'mail' : 'shop', snap: id }])) }));
  const demo = { dir, out: join(dir, '.out'), raw: join(dir, 'no-raw'), cfg: { name: 't', apps } };
  const text = '# Two apps\n\n## Beat 1 · Both\n\n- Go to shop\n  Lands on: shop · "Contoso shop"\n- Click "Catalog"\n  Lands on: catalog · "Spring catalog"\n'
    + '- Go to mail\n  Lands on: mail · "Fabrikam mail"\n- Click "Inbox"\n  Lands on: inbox · "Your inbox"\n';
  const at = sec => new Date(Date.UTC(2026, 10, 24, 10, 0, sec)).toISOString();
  const two = (t, body) => [0, 1].map(i => ({ at: at(t + i), docs: [{ key: 'main', html: page(body) }] }));
  const walkDir = join(dir, 'walk');
  mkdirSync(join(walkDir, 'walk-screens'), { recursive: true });
  // Today the inbox has another heading: a proof from today's reads alone, unless its page may be broken.
  const screens = { 'start-shop': two(0, snaps.shop), 'start-mail': two(2, snaps.mail), '1-1': two(10, snaps.shop), '1-2': two(20, snaps.catalog), '1-3': two(30, snaps.mail), '1-4': two(40, '<h1>Fabrikam mail</h1><h2>Inbox for Avery Chen</h2>') };
  for (const [f, v] of Object.entries(screens)) writeFileSync(join(walkDir, 'walk-screens', f + '.reads.json.gz'), gzipSync(JSON.stringify(v)));
  const steps = [['Go to shop', 'reached'], ['Click "Catalog"', 'reached'], ['Go to mail', 'reached'], ['Click "Inbox"', 'drifted']].map(([t, status], step) => ({ step, text: t, status }));
  const walk = { beats: [{ beat: 1, steps }], starts: [{ app: 'shop' }, { app: 'mail' }], inputs: [{ at: at(15), for: 'Click "Catalog"' }, { at: at(35), for: 'Click "Inbox"' }] };
  const down = (sec, host = 'mail.fabrikam.test', events = []) => ({ ...walk, events, net: [{ at: at(sec), method: 'GET', host, path: '/api/folders', status: 500 }] });
  const inbox = w => regroundPlan(parsePlan(text), { walker: walkerFromDemo(demo), walk: w, reads: walkReads(join(walkDir, 'walk-screens')), apps }).rows[3];
  // Mail's service down while the walk was in the shop: mail's later steps. Not after mail loads again, not a step read
  // before it answered, and not the shop's.
  assert.deepEqual([inbox(down(17)).basis, inbox(down(17)).why], ['suspect', 'GET mail.fabrikam.test/api/folders answered 500; check the app before adopting']);
  const reload = [{ kind: 'loaded', host: 'mail.fabrikam.test', path: '/', at: at(32) }];
  assert.deepEqual([down(17, undefined, reload), down(45), down(17, 'shop.contoso.test')].map(w => inbox(w).basis), ['today', 'today', 'today']);
});

test('a list that shows only the rows in view: rows the recording scrolled to, or past today\'s view of a list that grew, are beyond the walk\'s view; the rows it says it has a number', () => {
  // A ledger grid, recorded with the rows its capture scrolled to put back (data-d1-row), each row's tooltip in a portal;
  // today, the walk reads only the rows in view, in another order, and the grid says it has more.
  const dir = mkdtempSync(join(tmpdir(), 'sc-virtual-'));
  const page = body => `<!doctype html><html><head><title>Contoso</title></head><body>${body}</body></html>`;
  const grid = (count, rows) => `<h2>Ledgers</h2><div role="grid" aria-rowcount="${count}"><div role="row"><span>Name</span><span>Owner</span></div>`
    + rows.map(([n, back], k) => `<div role="row"${back ? ' data-d1-row=""' : ''}><span aria-describedby="tip-${k}">${n}</span><span>Finance</span></div>`).join('') + '</div>'
    + rows.filter(([, back]) => !back).map(([n], k) => `<div role="tooltip" id="tip-${k}"><span>Name: ${n}</span><span>Description: ${about[n]}</span></div>`).join('');
  const about = { 'Contoso Ledger': 'the general ledger', 'Fabrikam Payroll': 'pay runs', 'Contoso Notes': 'shared notes', 'Fabrikam Audit': 'audit trails', 'Contoso Fleet': 'vans and cars', 'Contoso Budget': 'next year' };
  const recorded = [['Contoso Ledger'], ['Fabrikam Payroll'], ['Contoso Notes'], ...['Contoso Fleet', 'Fabrikam Travel', 'Contoso Assets', 'Fabrikam Grants', 'Contoso Leases'].map(n => [n, true])];
  mkdirSync(join(dir, 'data', 'snaps'), { recursive: true });
  for (const [id, body] of Object.entries({ home: '<h1>Contoso</h1><a href="/l">Ledgers</a>', ledgers: grid(9, recorded) })) writeFileSync(join(dir, 'data', 'snaps', id + '.html'), page(body));
  writeFileSync(join(dir, 'flow.json'), JSON.stringify({ apps: [{ id: 'books', key: 'B' }], beats: [{ active: 'books', states: { books: 'home' } }], path: [], states: { home: { app: 'books', snap: 'home' }, ledgers: { app: 'books', snap: 'ledgers' } } }));
  const demo = { dir, out: join(dir, '.out'), raw: join(dir, 'no-raw'), cfg: { name: 't', apps: [{ id: 'books', key: 'B', title: 'Contoso books' }] } };
  const text = '# Books\n\n## Beat 1 · Look\n\n- Go to books\n  Lands on: home · "Contoso"\n- Click "Ledgers"\n  Lands on: ledgers · "Ledgers"\n';
  // Today's rows in view: one as recorded, one the recording scrolled to, two new; the grid says 12.
  const today = (count = 12) => grid(count, [['Fabrikam Audit'], ['Contoso Ledger'], ['Contoso Fleet'], ['Contoso Budget']].map(([n]) => [n]))
    + '<ul role="listbox" aria-label="Owners"><li role="option"><span>AC</span><span>Avery Chen</span><span>Finance lead</span></li><li role="option"><span>DH</span><span>Dana Hill</span><span>Auditor</span></li></ul>';
  const at = sec => new Date(Date.UTC(2026, 10, 24, 9, 0, sec)).toISOString();
  const two = (t, html) => [0, 1].map(i => ({ at: at(t + i), docs: [{ key: 'main', html: page(html) }] }));
  const walkDir = join(dir, 'walk');
  mkdirSync(join(walkDir, 'walk-screens'), { recursive: true });
  for (const [f, v] of Object.entries({ 'start-books': two(0, '<h1>Contoso</h1><a href="/l">Ledgers</a>'), '1-1': two(10, '<h1>Contoso</h1><a href="/l">Ledgers</a>'), '1-2': two(20, today()) })) writeFileSync(join(walkDir, 'walk-screens', f + '.reads.json.gz'), gzipSync(JSON.stringify(v)));
  const walk = { beats: [{ beat: 1, steps: [{ step: 0, text: 'Go to books', status: 'reached' }, { step: 1, text: 'Click "Ledgers"', status: 'reached' }] }], starts: [{ app: 'books' }] };
  const { rows } = regroundPlan(parsePlan(text), { walker: walkerFromDemo(demo), walk, reads: walkReads(join(walkDir, 'walk-screens')), apps: demo.cfg.apps });
  const show = e => [e.cls, e.kind === 'list' ? `${e.count} of ${e.total} rows (${e.entries}): ${e.rows.join(', ')}` : e.text, e.now || null];
  // 9 rows → 12. The rows the capture scrolled to that today's rows in view don't have, and the rows it showed that
  // today's view doesn't (the list shows part of its rows and has more today): beyond the walk's view, each a line.
  // Tooltips aren't on the screen until hovered: never listed.
  assert.deepEqual(rows[1].missing.map(show), [
    ['number', '9', '12'],
    ['beyond', '2 of 9 rows (2): Fabrikam Payroll, Contoso Notes', null],
    ['beyond', '4 of 9 rows (4): Fabrikam Travel, Contoso Assets, Fabrikam Grants, Contoso Leases', null],
  ]);
  // New in view: the two new rows as one line. A person's row is named by their name, not their initials; its option,
  // named by all of it, is what's in it.
  assert.deepEqual(rows[1].extra.map(show), [['extra', '2 of 5 rows (2): Fabrikam Audit, Contoso Budget', null], ['extra', '2 of 2 rows (6): Avery Chen, Dana Hill', null]]);
  const md = formatReground(rows);
  assert.match(md, /\| 2 of 9 rows of a list, from “Fabrikam Payroll”, “Contoso Notes” \| the list shows 5 of the 12 rows it says it has \(9 recorded\), and these aren’t among them \| ledgers \(1-2\) \|/);
  // A list that has fewer rows today: what its view lost is missing.
  writeFileSync(join(walkDir, 'walk-screens', '1-2.reads.json.gz'), gzipSync(JSON.stringify(two(20, today(8)))));
  const fewer = regroundPlan(parsePlan(text), { walker: walkerFromDemo(demo), walk, reads: walkReads(join(walkDir, 'walk-screens')), apps: demo.cfg.apps }).rows;
  assert.deepEqual(fewer[1].missing.map(show).slice(0, 2), [['number', '9', '8'], ['missing', '2 of 9 rows (2): Fabrikam Payroll, Contoso Notes', null]]);
  assert.match(formatReground(fewer), /\| 2 rows of a list, of the 4 in view \(9 with the ones its capture scrolled to\): “Fabrikam Payroll”, “Contoso Notes”\. Today: 5 rows, starting “Name”, “Fabrikam Audit”/);
  assert.match(md, /### Beyond the walk’s view: rows of a list it didn’t scroll\n\n\| What \| Why \| Screen \(steps\) \|\n\|---\|---\|---\|\n\| 2 of 9 rows [^\n]*\n\| 4 of 9 rows of a list, from “Fabrikam Travel”, “Contoso Assets”, “Fabrikam Grants”, “Contoso Leases” \| the recording’s capture scrolled the list to them; a walk doesn’t scroll \| ledgers \(1-2\) \|/);
  assert.match(md, /### A number changed\n\n\| Recorded \| Today \| Screen \(steps\) \|\n\|---\|---\|---\|\n\| The rows the list starting “Name”, “Contoso Ledger” says it has: “9” \| “12” \| ledgers \(1-2\) \|/);
});

test('a landing proven on the live page: what the plan expects is strong, any other change weak; a write goes on only after strong ones', () => {
  const sc = (items, controls = []) => ({ headings: [], controls, items: items.map((it, i) => ({ i, kind: 'text', role: 'generic', tag: 'span', ...(typeof it === 'string' ? { text: it } : it) })) });
  const tabs = (agents, plugins) => [{ role: 'tab', name: 'Agents', selected: agents }, { role: 'tab', name: 'Plugins', selected: plugins }];
  const page = sc(['Operations', 'Our numbers'], tabs(true, false));
  const tabbed = sc(['Operations', 'Our numbers', 'Fabrikam Orders'], tabs(false, true));
  const grade = (s, after, more = {}) => { const r = liveProof(s, { before: [page], afters: [after, after], ...more }); return [formatLands(r.lands), r.strength]; };
  // Strong: the plan's own proof; with none, the tab it clicked, now selected (before the new words, which are weaker).
  assert.deepEqual(grade({ kind: 'click', target: 'Plugins', lands: { screen: 'tabbed', kind: 'words', text: 'Fabrikam Orders' } }, tabbed), ['tabbed · "Fabrikam Orders"', 'strong']);
  assert.deepEqual(grade({ kind: 'click', target: 'Plugins' }, tabbed), ['control "Plugins" selected', 'strong']);
  // Weak: a panel with new words the plan doesn't name.
  const panel = sc(['Operations', 'Our numbers', { text: 'Use When', role: 'heading' }], tabs(true, false));
  assert.deepEqual(grade({ kind: 'click', target: 'Spend policy' }, panel), ['"Use When"', 'weak']);
  // Strong: what it typed, in its box; the control the next step needs, there now (in a live region too: an approval card).
  const field = sc(['Checkout'], [{ role: 'textbox', name: 'Promo code', editable: 'field', value: 'SPRING25' }]);
  assert.deepEqual(grade({ kind: 'type', value: 'SPRING25', target: 'Promo code' }, field, { before: [sc(['Checkout'], [{ role: 'textbox', name: 'Promo code', editable: 'field' }])] }), ['box "Promo code" says "SPRING25"', 'strong']);
  const card = sc(['Operations', 'Our numbers', { text: 'Save note', live: true }], [...tabs(true, false), { role: 'button', name: 'Save: Save note', live: true }]);
  assert.deepEqual(grade({ kind: 'press', key: 'Enter' }, card, { next: { kind: 'click', target: 'Save: Save note' } }), ['control "Save: Save note"', 'strong']);
  // None: only a time, a toast, a message's words, or the plan's own words in a toast; or words that change between the reads.
  const noise = sc(['Operations', 'Our numbers', { text: '2 min ago', time: true }, { text: 'Message sent', live: true }, { text: 'Fabrikam moved the ship date', article: 3 }], tabs(true, false));
  assert.deepEqual(grade({ kind: 'press', key: 'Enter', lands: { screen: 'x', kind: 'words', text: 'Message sent' } }, noise), ['x', 'none']);
  const tip = t => sc(['Operations', 'Our numbers', `Tip of the day: ${t}`], tabs(true, false));
  assert.equal(liveProof({ kind: 'press', key: 'Escape' }, { before: [page], afters: [tip('pin your agents'), tip('try a shorter prompt')] }).strength, 'none');
  // A "Show more" toggle clicked is a "Show less" one, open: the step's own control in its new state. And back.
  const more = (open, label) => sc(['Operations', 'Get started', 'Fabrikam Orders', ...(open ? ['Contoso Returns'] : [])], [{ role: 'button', name: `Show ${label} in Get started`, expanded: open }]);
  assert.deepEqual(liveProof({ kind: 'click', target: 'Show more in Get started' }, { before: [more(false, 'more')], afters: [more(true, 'less'), more(true, 'less')] }).strength, 'strong');
  assert.deepEqual(formatLands(liveProof({ kind: 'click', target: 'Show more in Get started' }, { before: [more(false, 'more')], afters: [more(true, 'less'), more(true, 'less')] }).lands), 'control "Show less in Get started" open');
  assert.deepEqual(liveProof({ kind: 'click', target: 'Show less in Get started' }, { before: [more(true, 'less')], afters: [more(false, 'more'), more(false, 'more')] }).strength, 'strong');
  // Before a write: the app's landings since its last write all strong.
  const L = (strength, more = {}) => ({ app: 'iq', strength, ...more });
  assert.deepEqual(writeGate([L('strong'), L('strong')], 'iq'), { ok: true, why: null });
  assert.deepEqual(writeGate([L('strong'), L('weak', { step: 'Click "Spend policy"' }), L('strong')], 'iq'), { ok: false, why: '“Click "Spend policy"” only shows the page changed, since the last write in iq' });
  assert.deepEqual(writeGate([L('weak'), L('strong', { wrote: true }), L('strong')], 'iq'), { ok: true, why: null });
  assert.deepEqual(writeGate([{ app: 'chat', strength: 'none', step: 'Press Escape' }, L('strong')], 'chat'), { ok: false, why: '“Press Escape” isn\'t proven' });
  assert.deepEqual(writeGate([], 'iq'), { ok: false, why: 'nothing in iq is proven yet' });
});

test('words only inside a message prove a step last, and say so, unless it\'s a write its app pack checks', () => {
  const sc = (items, controls = []) => ({ headings: [], controls, items: items.map((it, i) => ({ i, kind: 'text', role: 'generic', tag: 'span', ...(typeof it === 'string' ? { text: it } : it) })) });
  // A pull request whose review comments are messages (Copilot's among them), and a chat whose sent prompt is one.
  const S = {
    list: sc(['Pull requests', 'Fabrikam checkout fixes']),
    pr: sc(['Fabrikam checkout fixes', { text: 'Copilot reviewed', article: 7 }, { text: 'Approved', role: 'heading', article: 7 }, { text: 'Status and details', role: 'heading' }]),
    files: sc(['Fabrikam checkout fixes', { text: 'Copilot reviewed', article: 7 }, { text: 'Changes recommended', role: 'heading', article: 7 }, { text: 'Status and details', role: 'heading' }]),
    chat: sc(['New chat'], [{ role: 'textbox', name: 'Message', editable: 'content' }]),
    sent: sc(['New chat', { text: 'You said:', role: 'heading', article: 3 }, { text: 'What changed on PO-1?', article: 3 }], [{ role: 'textbox', name: 'Message', editable: 'content' }]),
  };
  const walker = { screen: id => S[id], shown: id => S[id], states: Object.keys(S), flow: { states: Object.fromEntries(Object.keys(S).map(k => [k, { app: /chat|sent/.test(k) ? 'chat' : 'pr' }])) } };
  const checked = packChecked({ forApp: { chat: { id: 'chat-app', writes: [{ id: 'send', check: { expect: 'a new chat' } }] } } });
  const plan = writes => ({ beats: [{ steps: [
    { kind: 'app', app: 'pr', lands: { screen: 'list' } },
    { kind: 'click', target: 'Fabrikam checkout fixes', line: '1.1', lands: { screen: 'pr', kind: 'words', text: 'Approved' } },
    { kind: 'click', target: 'Files changed', line: '1.2', lands: { screen: 'files' } },
    { kind: 'app', app: 'chat', lands: { screen: 'chat' } },
    { kind: 'press', key: 'Enter', line: '1.3', writes, lands: { screen: 'sent' } }] }] });
  const p = plan('sends a prompt · chat-app:send'), flags = proveLandings(p, walker, [], { checked });
  // Words outside a message first, the plan's own included; a message's only when nothing else tells the screens apart.
  assert.deepEqual(p.beats[0].steps.slice(1).map(s => formatLands(s.lands)), ['pr · "Status and details"', 'files · "Changes recommended"', 'chat · "New chat"', 'sent · "You said:"']);
  assert.deepEqual(flags.map(f => [f.kind, f.at]), [['message', '1.2']]);
  assert.match(flags[0].text, /^Click "Files changed": a run checks it by “Changes recommended”, words inside a message/);
  // The same send, which no pack checks: it says so too.
  assert.deepEqual(proveLandings(plan('sends a prompt'), walker, [], { checked }).map(f => [f.kind, f.at]), [['message', '1.2'], ['message', '1.3']]);
  assert.deepEqual(needsYou({ planReview: { flags }, plan: { beats: [] } }).map(n => n.kind), ['Words in a message']);
});

test('a tooltip, or a row a capture put back, never proves a step: neither is on the screen a run reads', () => {
  const sc = items => ({ headings: [], controls: [], items: items.map((it, i) => ({ i, kind: 'text', role: 'generic', tag: 'span', ...(typeof it === 'string' ? { text: it } : it) })) });
  // A tools list that shows only the rows in view (the capture put back the rest); a search shows one of those rows,
  // with its tooltip.
  const S = {
    tools: sc(['Tools', 'Contoso Ledger', { text: 'Fabrikam Payroll', restored: true }, { text: 'Name: Contoso Ledger', tip: true }]),
    found: sc(['Tools', 'Fabrikam Payroll', { text: 'Name: Fabrikam Payroll', tip: true }]),
  };
  const walker = { screen: id => S[id], shown: id => S[id], states: Object.keys(S), flow: { states: { tools: { app: 'admin' }, found: { app: 'admin' } } } };
  const p = { beats: [{ steps: [{ kind: 'app', app: 'admin', lands: { screen: 'tools' } }, { kind: 'press', key: 'Enter', line: '1.1', lands: { screen: 'found' } }] }] };
  proveLandings(p, walker, []);
  assert.equal(formatLands(p.beats[0].steps[1].lands), 'found · "Fabrikam Payroll"');
  assert.deepEqual([holds(S.tools, { kind: 'words', text: 'Fabrikam Payroll' }), holds(S.found, { kind: 'words', text: 'Name: Fabrikam Payroll' })], [false, false]);
});

test('a Go to step lands on what its page names itself by, when other pages of its site show its proof too', () => {
  const sc = (title, items) => ({ title, headings: [], controls: [], items: items.map((it, i) => ({ i, kind: 'text', role: 'generic', tag: 'span', ...(typeof it === 'string' ? { text: it } : it) })) });
  // Every pull request's page has "Status and details"; each names itself by its title, and the list shows the titles.
  const S = {
    chat: sc('Chat', ['Ask anything']),
    pr1: sc('Fix the cart total by Avery Chen · Pull Request #1 · contoso/shop', ['Merge info', { text: 'Status and details', role: 'heading' }, 'Fix the cart total - #1']),
    pr2: sc('Speed up checkout by Avery Chen · Pull Request #2 · contoso/shop', [{ text: 'Status and details', role: 'heading' }, 'Speed up checkout - #2']),
    list: sc('Pull requests · contoso/shop', ['Open pull requests', 'Fix the cart total', 'Speed up checkout']),
  };
  const url = { chat: 'https://chat.contoso.test/', pr1: 'https://code.contoso.test/contoso/shop/pull/1', pr2: 'https://code.contoso.test/contoso/shop/pull/2', list: 'https://code.contoso.test/contoso/shop/pulls' };
  const walker = { screen: id => S[id], shown: id => S[id], view: id => ({ url: url[id] }), states: Object.keys(S),
    flow: { states: { chat: { app: 'chat' }, pr1: { app: 'pr1' }, pr2: { app: 'pr2' }, list: { app: 'pulls' } } } };
  const plan = { beats: [{ steps: [
    { kind: 'app', app: 'chat', lands: { screen: 'chat' } },
    { kind: 'app', app: 'pr1', line: '1.1', lands: { screen: 'pr1', kind: 'words', text: 'Status and details' } },
    { kind: 'app', app: 'pr2', line: '1.2', lands: { screen: 'pr2' } },
    { kind: 'app', app: 'pulls', line: '1.3', lands: { screen: 'list' } }] }] };
  proveLandings(plan, walker);
  // Not the words only it shows ("Merge info"): what it's called. The list's own words show on no other page: kept.
  assert.deepEqual(plan.beats[0].steps.slice(1).map(s => formatLands(s.lands)), ['pr1 · "Fix the cart total - #1"', 'pr2 · "Speed up checkout - #2"', 'list · "Open pull requests"']);
  // One page with panels over it (one address): nothing to tell apart.
  const one = { ...walker, view: id => ({ url: id === 'chat' ? url.chat : 'https://code.contoso.test/app' }) };
  const p2 = { beats: [{ steps: [{ kind: 'app', app: 'chat', lands: { screen: 'chat' } }, { kind: 'app', app: 'pr1', lands: { screen: 'pr1', kind: 'words', text: 'Status and details' } }] }] };
  proveLandings(p2, one);
  assert.equal(formatLands(p2.beats[0].steps[1].lands), 'pr1 · "Status and details"');
});
