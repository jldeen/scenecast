// The AI modes' rules that don't need a browser: the plan's plain words, what asks first, the stand-in model, the
// coach's matching, and what leaves the computer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePlan, parseStep, formatPlan, risk } from './plan.mjs';
import { redact, compactOutline, makeModel } from './model.mjs';
import { findItem } from './find.mjs';
import { matches } from './coach.mjs';
import { ask } from './stub.mjs';
import { loginFlow } from './copilot.mjs';

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
