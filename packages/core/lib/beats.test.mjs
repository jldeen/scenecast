import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beatSteps, plainLabels, scriptFromFlow } from './beats.mjs';
import { parseScript } from './notes.mjs';

// Jessica, Nov 20: "the screens show, but I can't tell if the prompts work (or if there are prompts)". The beats were
// named "copilot: copilot-03-kestrel-po-450101-ship-date-" and nothing said where to type or click.
const flow = {
  apps: [{ id: 'chat', title: 'Copilot', key: 'C' }, { id: 'admin', title: 'Admin', key: 'A' }],
  states: { 'chat-start': { app: 'chat' }, 'chat-01-typed': { app: 'chat' }, 'chat-02-answer': { app: 'chat' }, 'admin-start': { app: 'admin' }, 'admin-01-tools': { app: 'admin' } },
  path: [
    { app: 'chat', checkpoint: 'chat-start' },
    { type: { sel: '[role=textbox]' }, text: 'Summarize the supplier delay on PO-450101\u200B\u200C', checkpoint: 'chat-01-typed' },
    { enter: { sel: '[role=textbox]' }, checkpoint: 'chat-02-answer' },
    { app: 'admin', checkpoint: 'admin-start' },
    { click: { sel: 'a[aria-label="Tools"]' }, checkpoint: 'admin-01-tools' },
  ],
  beats: [
    { label: '0 Reset', active: 'chat', states: { chat: 'chat-start', admin: 'admin-start' } },
    { label: '1 start', active: 'chat', states: { chat: 'chat-start', admin: 'admin-start' } },
    { label: '2 chat: chat-02-answer', active: 'chat', states: { chat: 'chat-02-answer', admin: 'admin-start' } },
    { label: '3 admin: admin-start', active: 'admin', states: { chat: 'chat-02-answer', admin: 'admin-start' } },
  ],
};

test('each beat has a plain name and says where to type and click', () => {
  const s = beatSteps(flow);
  assert.equal(s[1].title, 'Copilot: start');
  assert.deepEqual(s[1].do, ['Type `Summarize the supplier delay on PO-450101` (**⌥P** types it)', 'Press **Enter**: the answer streams in']);
  assert.equal(s[2].title, 'Copilot: after “Summarize the supplier delay on PO-450101”');
  assert.deepEqual(s[2].do, ['Switch to **Admin** (**⌥A**)']);
  assert.equal(s[3].title, 'Admin: start');
  assert.deepEqual(s[3].do, ['Click **Tools**']);
  assert.equal(plainLabels(structuredClone(flow)).beats[2].label, '2 Copilot: after “Summarize the supplier delay on PO-450101”');
});

test('the guide reads them as a script: one beat each, with its steps under Do', () => {
  const s = parseScript(scriptFromFlow(flow, 'Demo'), 'recording.md');
  assert.equal(s.beats.length, 3);
  assert.equal(s.beats[0].title, 'Copilot: start');
  assert.match(s.beats[0].do.map(d => d.text).join(' | '), /Type `Summarize/);
});

test('every beat of a script has its time, minutes and seconds too', () => {
  const s = parseScript('# Demo\n\n## 1. Open · ~10s\n\n## 2. The payoff · ~1m15s\n\n## 3. Close · (1 min 5 s)\n', 'script.md');
  assert.deepEqual(s.beats.map(b => [b.title, b.start, b.end]), [['Open', 0, 10], ['The payoff', 10, 85], ['Close', 85, 150]]);
});
