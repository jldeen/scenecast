// The AI modes' rules that don't need a browser: the plan's plain words, what asks first, the stand-in model, the
// coach's matching, and what leaves the computer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePlan, parseStep, formatPlan, risk, writesOf, parseLands, formatLands } from './plan.mjs';
import { redact, compactOutline, makeModel } from './model.mjs';
import { findItem, nameFits, norm } from './find.mjs';
import { matches } from './coach.mjs';
import { ask } from './stub.mjs';
import { loginFlow } from './copilot.mjs';
import { fillApi, checkLine } from './reset-run.mjs';

test('plan: plain words to steps and back', () => {
  const text = `# Demo\n\n## Beat 1 · The question\n\n- Go to chat\n- Click “Message”\n- Type "Summarize it" in "Message"\n- Press enter\n- Wait for the answer\n- You: sign in\n- Open the first tool\n\n> I ask about it.\n`;
  const p = parsePlan(text);
  assert.equal(p.title, 'Demo');
  assert.deepEqual(p.beats[0].steps.map(s => s.kind), ['app', 'click', 'type', 'press', 'wait', 'manual', 'free']);
  assert.equal(p.beats[0].steps[3].key, 'Enter');
  assert.deepEqual(p.beats[0].say, ['I ask about it.']);
  assert.deepEqual(parsePlan(formatPlan(p)).beats[0].steps.map(s => s.kind), p.beats[0].steps.map(s => s.kind));
  assert.match(formatPlan(p), /- Press Enter — ask first/);
  assert.equal(parseStep('Press Enter — ask first').key, 'Enter');
  // A prompt with an apostrophe keeps all its words (it was cut at "I").
  assert.deepEqual(parseStep(`Type "I'll check Kestrel's date" in "Message"`), { kind: 'type', value: "I'll check Kestrel's date", target: 'Message', text: `Type "I'll check Kestrel's date" in "Message"` });
  assert.equal(parseStep('Click “Copy file”').target, 'Copy file');
  assert.equal(parseStep("Click 'Save'").target, 'Save');
});

test('what proves a step: words, a control (and its state), a box\'s text, words gone; read and written back', () => {
  const forms = {
    'chat-answer · "Kestrel moved the ship date"': { screen: 'chat-answer', kind: 'words', text: 'Kestrel moved the ship date' },
    'iq-certified · control "Endorsement: Certified"': { screen: 'iq-certified', kind: 'control', text: null, control: 'Endorsement: Certified', state: null },
    'picker · control "Plugins" selected': { screen: 'picker', kind: 'control', text: null, control: 'Plugins', state: 'selected' },
    'menu · control "More" open': { screen: 'menu', kind: 'control', text: null, control: 'More', state: 'open' },
    'search-typed · box "Search tools by name" says "IQ"': { screen: 'search-typed', kind: 'box', text: null, box: 'Search tools by name', says: 'IQ' },
    'landing · gone "Delegation of spend authority", still "Supply Chain Operations"': { screen: 'landing', kind: 'gone', text: null, gone: 'Delegation of spend authority', still: 'Supply Chain Operations' },
    'landing · gone "Spend policy"': { screen: 'landing', kind: 'gone', text: null, gone: 'Spend policy', still: null },
    'landing · "Fabric IQ · Semantic model"': { screen: 'landing', kind: 'words', text: 'Fabric IQ · Semantic model' },
    'chat-saved': { screen: 'chat-saved', kind: null, text: null },
    '"words only"': { screen: null, kind: 'words', text: 'words only' },
    'x · box "Message" says “He said "go"”': { screen: 'x', kind: 'box', text: null, box: 'Message', says: 'He said "go"' },
  };
  for (const [text, shape] of Object.entries(forms)) {
    assert.deepEqual(parseLands(text), shape, text);
    assert.equal(formatLands(parseLands(text)), text);
  }
  // In a plan, under a step, as any other detail.
  const plan = '# D\n\n## Beat 1 · B\n\n- Click "Plugins"\n  Lands on: picker · control "Plugins" selected\n- Press Escape\n  Lands on: landing · gone "Plugins", still "Operations"\n';
  assert.equal(formatPlan(parsePlan(plan)), plan);
  assert.deepEqual(parsePlan(plan).beats[0].steps.map(s => s.lands.kind), ['control', 'gone']);
});

test('plan v2: details under steps and lines, written back as read; steps the same as without them', () => {
  const text = [
    '# Demo', '', '## Beat 1 · Keep it', '',
    '- Type "Summarize it" in "Message"',
    '- Press Enter — ask first', '  Writes: sends a prompt (a new chat)', '  Lands on: chat-answer · "Kestrel moved the ship date"',
    '- Click "Save" — ask first', '  Script: Click "Approve" on the "Copy file" card', '  Differs: this screen has "Save", not "Approve"',
    '  Writes: saves the skill "triage"', '  Undo: delete the skill "triage"', '  Lands on: chat-saved', '',
    '> Now I can share it · with my team.', '  Focus: "Share" · arrow sw', '  Focus: the card around "Work IQ", "Fabric IQ · Semantic model" · via Hover over "Work IQ" · on chat-saved',
    '  Focus: “Under our agreement, "the supplier pays."” · on chat-saved', '',
  ].join('\n');
  const p = parsePlan(text);
  const [, enter, save] = p.beats[0].steps;
  assert.deepEqual([enter.writes, enter.lands], ['sends a prompt (a new chat)', { screen: 'chat-answer', kind: 'words', text: 'Kestrel moved the ship date' }]);
  assert.deepEqual([save.kind, save.target, save.script, save.undo, save.lands], ['click', 'Save', 'Click "Approve" on the "Copy file" card', 'delete the skill "triage"', { screen: 'chat-saved', kind: null, text: null }]);
  assert.deepEqual(p.beats[0].say, ['Now I can share it · with my team.']);
  const [share, card, quote] = p.beats[0].lines[0].focus;
  assert.deepEqual(share, { texts: ['Share'], mark: 'arrow', dir: 'sw' });
  assert.deepEqual([card.around, card.texts, card.via.kind, card.via.target, card.on], ['card', ['Work IQ', 'Fabric IQ · Semantic model'], 'hover', 'Work IQ', 'chat-saved']);
  assert.deepEqual(quote.texts, ['Under our agreement, "the supplier pays."']);
  assert.equal(formatPlan(p), text);
  assert.deepEqual(writesOf(p).map(w => [w.beat, w.step, w.text]), [[0, 1, 'Press Enter'], [0, 2, 'Click "Save"']]);
  // A version 1 reader sees only the steps and lines: the same steps, details or not.
  const v1 = parsePlan(text.split('\n').filter(l => !/^\s+\w[\w ]*:/.test(l)).join('\n'));
  assert.deepEqual(v1.beats[0].steps.map(s => [s.kind, s.target || s.key || s.value]), p.beats[0].steps.map(s => [s.kind, s.target || s.key || s.value]));
});

test('ask first: sends, approvals, purchases, deletes and settings; not reading or searching', () => {
  const click = name => parseStep(`Click "${name}"`);
  for (const n of ['Send', 'Approve', 'Save', 'Add to cart', 'Delete', 'Buy now', 'Post', 'Submit', 'Share']) assert.ok(risk(click(n)), n);
  for (const n of ['Plugins', 'alpha-6', 'Close workspace', 'New', 'Show more', 'Details']) assert.equal(risk(click(n)), null, n);
  assert.ok(risk(click('Dark mode'), { role: 'switch', name: 'Dark mode' }));
  const enter = parseStep('Press Enter');
  assert.ok(risk(enter, null, { name: 'Message', role: 'textbox', editable: 'content', multiline: true }));
  assert.equal(risk(enter, null, { name: 'Search tools by name', role: 'textbox', editable: 'field' }), null);
  assert.ok(risk(enter), 'Enter in an unknown field asks');
  assert.equal(risk(parseStep('Type "hello" in "Message"')), null, 'typing is a draft');
});

test('find: by name, exact first, then words', () => {
  const items = [{ role: 'button', name: 'Close workspace' }, { role: 'link', name: 'Plugins' }, { role: 'textbox', name: 'Search tools by name', editable: 'field' }, { role: 'gridcell', name: 'alpha-6' }, { role: 'gridcell', name: 'alpha-60' }];
  assert.equal(findItem(items, 'plugins').name, 'Plugins');
  assert.equal(findItem(items, 'the workspace close button').name, 'Close workspace');
  assert.equal(findItem(items, 'search', 'field').name, 'Search tools by name');
  assert.equal(findItem(items, 'alpha-6').name, 'alpha-6');
  assert.equal(findItem(items, 'Settings'), null);
});

test('find in a frame: the name has to fit, not only share a word', () => {
  assert.ok(nameFits('SC Supply Chain Operations', 'Supply Chain Operations'));
  assert.ok(nameFits('Plugins (12)', 'Plugins'));
  assert.ok(!nameFits('Search business plugins', 'Plugins'));
  assert.ok(!nameFits('Our numbers', 'Add content to Our numbers'));
  assert.ok(!nameFits('Add content', 'Add content to Our numbers'));
  // Invisible marks don't count (the admin center wraps numbers and names in them).
  assert.equal(norm('Showing \u200e16\u200e items'), 'showing 16 items');
  assert.ok(nameFits('About this \u200ePlugin\u200e', 'About this Plugin'));
});

test('what leaves the computer: no emails, IDs, tokens or URL queries; page words only if allowed', () => {
  // A made-up token, put together here so secret scanners don't flag the test itself.
  const jwt = ['eyJ' + 'x'.repeat(16), 'y'.repeat(16), 'z'.repeat(12)].join('.');
  const s = redact(`mail someone@example.com id 1b4e28ba-2fa1-11d2-883f-0016d3cca427 at https://x.test/a?code=abc#t key ${jwt}`);
  assert.doesNotMatch(s, /example\.com|1b4e28ba|code=abc|eyJx/);
  assert.match(s, /\[email\].*\[id\].*https:\/\/x\.test\/a .*\[token\]/);
  const o = { title: 'T', url: 'https://x.test/?s=1', items: [{ i: 0, role: 'button', name: 'Send' }], headings: ['H'], text: 'secret words' };
  assert.equal(compactOutline(o, { pageText: false }).text, undefined);
  assert.equal(compactOutline(o).text, 'secret words');
  assert.deepEqual(compactOutline(o).controls, ['[0] button "Send"']);
});

test('every request is kept where the presenter can see it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-sent-'));
  const m = await makeModel({ kind: 'stub', sentDir: dir, settings: { pageText: false } });
  await m.ask('adapt', { step: 'Click "Plugins"', outline: { controls: ['[0] link "Plugins"'] } });
  const f = readdirSync(dir);
  assert.deepEqual(f, ['001-adapt.json']);
  const r = JSON.parse(readFileSync(join(dir, f[0]), 'utf8'));
  assert.equal(r.task, 'adapt'); assert.equal(r.pageText, false); assert.match(r.prompt, /Plugins/);
});

test('the stand-in: a plan from a goal, the same every time', async () => {
  const apps = [{ id: 'chat', outline: { controls: ['[0] link "Plugins"', '[1] button "Close workspace"', '[2] textbox "Message" (multi-line field)', '[3] button "Send"'] } },
    { id: 'admin', outline: { controls: ['[0] textbox "Search tools by name" (field)'] } }];
  const goal = 'Ask "What changed?", then close the workspace, then open Plugins. In admin, search "alpha" and open alpha-6.';
  const a = await ask('plan', { goal, apps }), b = await ask('plan', { goal, apps });
  assert.deepEqual(a, b);
  assert.deepEqual(a.beats.flatMap(x => x.steps), ['Type "What changed?" in "Message"', 'Press Enter', 'Wait for the answer', 'Click "Close workspace"', 'Click "Plugins"', 'Go to admin', 'Type "alpha" in "Search tools by name"', 'Press Enter', 'Click "alpha-6"']);
  assert.deepEqual((await ask('adapt', { step: 'Click "plugin page"', outline: apps[0].outline })), { do: 'Click "Plugins"' });
  assert.ok((await ask('adapt', { step: 'Click "Billing"', outline: apps[0].outline })).ask);
});

test('coach: what the recorder saw, matched to the plan', () => {
  assert.ok(matches(parseStep('Click "Plugins"'), { click: { sel: 'a[aria-label="Plugins"]' } }));
  assert.ok(matches(parseStep('Type "alpha" in "Search"'), { type: { sel: 'input' }, text: 'alpha' }));
  assert.ok(matches(parseStep('Press Enter'), { enter: { sel: 'span' } }));
  assert.ok(matches(parseStep('Press Enter'), { click: { sel: 'button[aria-label="Send"]' }, typedFrom: {} }));
  assert.ok(matches(parseStep('Go to admin'), { app: 'admin' }));
  assert.ok(!matches(parseStep('Click "Plugins"'), { click: { sel: 'a[aria-label="New"]' } }));
});

test('sign-in: GitHub accepted the code but the keychain is unreachable: the sign-in is kept, not dropped', async () => {
  process.env.SCENECAST_AI_HOME = mkdtempSync(join(tmpdir(), 'sc-ai-'));
  const said = [];
  const steps = [{ kind: 'device-code', userCode: 'AB12-CD34', verificationUri: 'https://github.com/login/device', expiresIn: 900 },
    { kind: 'completed', result: { status: 'needs-plaintext-consent' } }];
  const login = {
    begin: async () => ({ flowId: 'f', step: steps[0] }),
    advance: async ({ input }) => { said.push(input); return said.length === 1 ? steps[1] : input === 'allow' ? { kind: 'completed', result: { status: 'completed', login: 'someone' } } : { kind: 'completed', result: { status: 'declined' } }; },
  };
  const ev = [];
  const r = await loginFlow(login, e => ev.push(e));
  assert.equal(r.login, 'someone');
  assert.deepEqual(said, [undefined, 'allow']);
  assert.equal(ev[0].userCode, 'AB12-CD34');
  // Declined (or anything unknown) is an error that says so, never a quiet "not signed in".
  const no = { begin: async () => ({ flowId: 'f', step: { kind: 'completed', result: { status: 'declined' } } }), advance: async () => ({}) };
  await assert.rejects(loginFlow(no), /ended as "declined"/);
  assert.match(readFileSync(join(process.env.SCENECAST_AI_HOME, 'logs', 'ai.log'), 'utf8'), /needs-plaintext-consent/);
});

test('record for me: each click is counted by the recorder before the next step or Stop', async () => {
  // As on the admin center (Nov 20): the page holds the click until the recorder's loop picks it up, over a second
  // later, while status already says not busy. Stopping then dropped the last click.
  const { writeFileSync } = await import('node:fs');
  const { recordForMe } = await import('./drive.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'sc-drive-'));
  writeFileSync(join(dir, 'plan.md'), '# T\n\n## Beat 1 · Agents\n\n- Click "All agents"\n');
  const demo = { dir, out: join(dir, '.out'), cfg: { apps: [{ id: 'admin', match: 'admin.test', url: 'https://admin.test/' }] } };
  let actions = 0, recording = false, countedAtStop = null;
  const cmd = async op => {
    if (op === 'recordStart') { recording = true; return {}; }
    if (op === 'recordStatus') return recording ? { recording: true, busy: false, typing: [], actions, states: { admin: 'admin-start' } } : { recording: false };
    if (op === 'observe') return { vw: 1000, vh: 800, items: [{ name: 'All agents', role: 'treeitem', x: 140, y: 296 }] };
    if (op === 'click') { setTimeout(() => { actions++; }, 1500); return {}; }
    if (op === 'recordStop') { countedAtStop = actions; recording = false; return { states: 2 }; }
    return {};
  };
  const r = await recordForMe({ demo, model: { ask: async () => ({}) }, cmd });
  process.stdin.destroy();
  assert.equal(r.steps, 1);
  assert.equal(countedAtStop, 1, 'the click was still held when the recording stopped');
});

test("an API undo filled in: the demo's values win, each one a single encoded segment, the body's fields fixed", () => {
  const api = { path: '/v1/plugins/{pluginId}/sections/{section}/{item}.md?resource=context', body: { stage: 0, note: '{item}' } };
  const f = fillApi(api, { item: '../admin?x=1', pluginId: 'from-the-run' }, { pluginId: 'p1', section: 'Our numbers' });
  assert.equal(f.path, '/v1/plugins/p1/sections/Our%20numbers/..%2Fadmin%3Fx%3D1.md?resource=context');
  assert.deepEqual(f.body, { stage: 0, note: '../admin?x=1' });
  assert.deepEqual(fillApi(api, {}, { pluginId: 'p1' }).left, ['{section}', '{item}']);
});

test("a Check line reads the same from either parser: a string, or { app, screen, text } with the claim alone", () => {
  assert.equal(checkLine('tasks: no "Call Kestrel"'), 'tasks: no "Call Kestrel"');
  assert.equal(checkLine({ app: 'tasks', screen: 'tasks-home', text: 'no "Call Kestrel"' }), 'tasks: no "Call Kestrel"');
  assert.equal(checkLine({ app: null, screen: null, text: 'no app here' }), 'no app here');
});
