import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScript } from './parse.mjs';
import { words, facts, align, pickItems, textMatcher } from './match.mjs';
import { applyEditorOverrides, checkFocusJson, checkEditorOverrides } from '@stuntdouble/core/lib/overrides.mjs';
import { stateSequence, beatPositions, beatAt, orderFocus, mergeFocus } from '@stuntdouble/player/app/focus-order.js';

test('Markdown: headings are beats, quotes are lines, Do: is the line\'s cue', () => {
  const s = parseScript('# Demo\n\nnotes here\n\n## Beat 1 · Open\n\n> Hello there,\n> everyone.\n\n**Do:** Start (⌥0).\n\n> Second line.\n\n## Money\n> It costs $5.\n');
  assert.equal(s.title, 'Demo');
  assert.deepEqual(s.beats.map(b => b.title), ['Open', 'Money']);
  assert.deepEqual(s.lines.map(l => [l.id, l.text, l.cue]), [['1.1', 'Hello there, everyone.', 'Start (⌥0).'], ['1.2', 'Second line.', ''], ['2.1', 'It costs $5.', '']]);
});

test('plain text: one line per line, beats optional', () => {
  assert.deepEqual(parseScript('First thing.\n\n- Second thing.\n').lines.map(l => [l.id, l.text]), [['1', 'First thing.'], ['2', 'Second thing.']]);
  const s = parseScript('Beat 1: Start\nOne.\nBeat 2\nTwo.\n', 'x.txt');
  assert.deepEqual(s.lines.map(l => l.id), ['1.1', '2.1']);
});

test('RunLines: a row is a beat, each narrative line a line', () => {
  const s = parseScript(JSON.stringify({ title: 'T', rows: [{ narrative: 'a one\nb two', demo_actions: '[OPEN] cue' }, { narrative: 'c three', demo_actions: '' }] }), 'x.sk');
  assert.deepEqual(s.lines.map(l => [l.id, l.text]), [['1.1', 'a one'], ['1.2', 'b two'], ['2.1', 'c three']]);
  assert.equal(s.beats[0].title, 'OPEN');
});

test('words: stems, numbers and codes; facts: numbers and names, not sentence starts', () => {
  assert.deepEqual(words('Orders moved by $35,073 on PO-450101 in November'), ['order', 'mov', '35073', 'po-450101', 'nov']);
  assert.deepEqual(words('approved'), words('approve'));
  assert.deepEqual(facts('Then Kestrel pays $1,200 for alpha-6. Brightline agreed.').map(f => f.text), ['Kestrel', '$1,200', 'alpha-6']);
});

test('align: lines keep their order, and a line nothing backs stays on the screen before it', () => {
  // 3 places; line 0 fits place 1, line 1 fits nothing, line 2 fits place 0 better than 2 (but can't go back).
  assert.deepEqual(align([[0, 5, 0], [0, 0, 0], [6, 0, 4]], 3), [1, 1, 2]);
  assert.deepEqual(align([[0, 0, 0]], 3), [0]);
});

test('picks: the best item first, others only for new words, never one inside another', () => {
  const screen = { items: [
    { i: 0, kind: 'text', role: 'paragraph', text: 'Kestrel moved the ship date by six days. Two builds are at risk.', box: [0, 0, 500, 40] },
    { i: 1, kind: 'text', role: 'generic', text: 'six days', box: [100, 0, 160, 20] },
    { i: 2, kind: 'control', role: 'button', text: 'Share', box: [600, 0, 650, 20] },
    { i: 3, kind: 'text', role: 'generic', text: 'Unrelated footer', box: [0, 900, 100, 920] },
  ] };
  const w = () => 3;
  const picks = pickItems(words('Kestrel moved it by six days, and I can share it.'), screen, w);
  assert.deepEqual(picks.map(p => [p.item, p.phrase || null]), [[0, 'Kestrel moved the ship date by six days.'], [2, null]]);
});

test('the text matcher puts lines on screens in order and flags unbacked lines and missing facts', async () => {
  const sc = (state, texts) => ({ state, items: texts.map((t, i) => ({ i, kind: 'text', role: 'heading', text: t, box: [0, i * 30, 200, i * 30 + 20] })) });
  const screens = { a: sc('a', ['Welcome', 'Inbox']), b: sc('b', ['Quarterly revenue grew 12%', 'Inbox']), c: sc('c', ['Settings and privacy', 'Inbox']) };
  const sequence = [{ state: 'a' }, { state: 'b' }, { state: 'c' }];
  const lines = [{ text: 'Good morning.' }, { text: 'Revenue grew 12% this quarter.' }, { text: 'Privacy settings live here, approved by Contoso.' }];
  const r = await textMatcher.match({ lines, screens, sequence });
  assert.deepEqual(r.map(x => [x.pos, x.picks.length]), [[0, 0], [1, 1], [2, 1]]);
  assert.deepEqual(r[2].missing, ['Contoso']);
});

test('editor overrides: checked, then edits added and beat starts set', () => {
  assert.deepEqual(checkEditorOverrides({ edits: [{ replace: ['Nov 12', 'Nov 19'] }], beats: { 2: { active: 'chat', states: { chat: 'b' } } } }), []);
  assert.equal(checkEditorOverrides({ edits: [{ remove: 'x' }], beats: { 12: {} } }).length, 3);
  const flow = { edits: [{ remove: 'old' }], beats: [{ active: 'chat', states: { chat: 'a', admin: 'x' } }, { active: 'chat', label: '1 start', states: { chat: 'a', admin: 'x' } }] };
  applyEditorOverrides(flow, { edits: [{ replace: ['Nov 12', 'Nov 19'] }], beats: { 1: { active: 'admin', states: { admin: 'y' } }, 2: { active: 'chat', states: { chat: 'c' } } } });
  assert.deepEqual(flow.edits, [{ remove: 'old' }, { replace: ['Nov 12', 'Nov 19'] }]);
  assert.deepEqual(flow.beats[1], { active: 'admin', label: '1 start', states: { chat: 'a', admin: 'y' } });
  assert.deepEqual(flow.beats[2].states, { chat: 'c', admin: 'y' });
  assert.deepEqual(checkFocusJson({ points: [{ id: 'a', beat: 1, app: 'chat', states: ['s'], find: 'x' }, { id: 'a', beat: 11, app: 'chat', states: [], union: [{ evil: 1 }] }] }).length, 4);
});

test('focus order: by beat, then where the screen comes in the run-through, keeping order on a screen', () => {
  const flow = { states: { a: { app: 'x' }, b: { app: 'x' }, c: { app: 'x' } }, beats: [{ active: 'x', states: { x: 'a' } }, { active: 'x', states: { x: 'b' } }], path: [{ checkpoint: 'a' }, { checkpoint: 'b' }, { checkpoint: 'c' }, { checkpoint: 'b' }] };
  const seq = stateSequence(flow);
  assert.deepEqual(seq.map(s => s.state), ['a', 'b', 'c', 'b']);
  assert.deepEqual(beatPositions(flow, seq), [0, 1]);
  assert.equal(beatAt(2, [0, 1]), 1);
  const pts = [{ id: 'c1', beat: 1, states: ['c'] }, { id: 'b1', beat: 1, states: ['b'] }, { id: 'a0', beat: 0, states: ['a'] }, { id: 'b2', beat: 1, states: ['b'] }];
  assert.deepEqual(orderFocus(pts, flow).map(p => p.id), ['a0', 'b1', 'b2', 'c1']);
});

// ---- Make it from my script: reading talk tracks and captures ----------------------------------------------------
import { deflateRawSync } from 'node:zlib';
import { docxToMarkdown } from './docx.mjs';
import { parseTalkTrack } from './talk.mjs';
import { readScreen } from './html.mjs';

// A .docx as Word writes one: a zip of XML parts (document.xml deflated, styles.xml stored).
function docx(body, styles) {
  const files = [['word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`, true], ['word/styles.xml', `<w:styles xmlns:w="w">${styles}</w:styles>`, false]];
  const parts = [], central = [];
  let off = 0;
  for (const [name, text, deflate] of files) {
    const raw = Buffer.from(text), data = deflate ? deflateRawSync(raw) : raw, nm = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(deflate ? 8 : 0, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(deflate ? 8 : 0, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    parts.push(lh, nm, data); central.push(ch, nm); off += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}
const p = (text, style, extra = '') => `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${extra}</w:pPr>${text}</w:p>`;
const r = (t, bold) => `<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${t}</w:t></w:r>`;
const cell = t => `<w:tc>${p(r(t))}</w:tc>`;

test('Word: headings by style name (any language), tables, lists, bold; deleted text and pictures left out', () => {
  const styles = '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style><w:style w:type="paragraph" w:styleId="berschrift2"><w:name w:val="heading 2"/></w:style>';
  const body = p(r('Delay demo'), 'Title') + p(r('1. One question'), 'berschrift2')
    + `<w:tbl><w:tr>${cell('#')}${cell('Say')}${cell('Screen')}</w:tr><w:tr>${cell('1')}<w:tc>${p(r('So I ask Copilot ') + '<w:del><w:r><w:delText>OLD </w:delText></w:r></w:del>' + r('what this puts at risk.'))}</w:tc>${cell('Teams › Supply alerts. Then ⌥C, type prompt 1 and send.')}</w:tr></w:tbl>`
    + p(r('Prompts'), 'berschrift2') + p(r('1. Ask: ', true) + r('“What does this put at risk?”') + '<w:r><w:drawing><w:t>picture text</w:t></w:drawing></w:r>', null, '<w:numPr><w:ilvl w:val="0"/></w:numPr>');
  const md = docxToMarkdown(docx(body, styles));
  assert.match(md, /^# Delay demo\n\n### 1\. One question\n\n\| # \| Say \| Screen \|/m);
  assert.match(md, /^- \*\*1\. Ask:\*\* “What does this put at risk\?”$/m);
  assert.doesNotMatch(md, /OLD|picture text/);
  const t = parseTalkTrack(md, 'x.docx');
  assert.deepEqual(t.beats.map(b => [b.title, b.lines.map(l => [l.id, l.say, l.screen])]), [['One question', [['1.1', 'So I ask Copilot what this puts at risk.', 'Teams › Supply alerts. Then ⌥C, type prompt 1 and send.']]]]);
  assert.deepEqual(t.prompts, [{ n: 1, label: 'Ask', text: 'What does this put at risk?' }]);
});

test('talk tracks: quotes with Do and Screen under them, Do and Say sections, RunLines stage cues, plain Say/Do', () => {
  const md = parseTalkTrack('# T\n\n## Beat 1 · OPEN (~10s)\n\n*Stage:* CUE — Arun speaks\n\n> Hello there.\n\n**Do:** Start on Teams (⌥0).\n*Screen:* No facts here.\n\n## 2. Merge it? · 0:45–1:30\n\n**Do**\n\n- Press **⌥B**.\n- **⌥F**: the merge box\n\n**Say**\n\n> One.\n>\n> Two.\n', 'x.md');
  assert.deepEqual(md.beats.map(b => [b.title, b.time, b.stage.length, b.do.map(d => d.text), b.lines.map(l => [l.say, l.do, l.notes])]),
    [['OPEN', '~10s', 1, [], [['Hello there.', ['Start on Teams (⌥0).'], ['No facts here.']]]], ['Merge it?', '0:45–1:30', 0, ['Press ⌥B.', '⌥F: the merge box'], [['One.', [], []], ['Two.', [], []]]]]);
  const sk = parseTalkTrack(JSON.stringify({ title: 'S', rows: [{ narrative: 'Hi.\nThen this.', demo_actions: 'ARUN: over to you <Jessica enters> DO NOT CLICK', time: '~10s' }, { narrative: 'Next.', demo_actions: '[OPEN] Click Plugins' }] }), 'x.sk');
  assert.deepEqual(sk.beats.map(b => [b.title, b.stage.length, b.do.map(d => d.text), b.lines.length]), [['Hi.', 3, [], 2], ['OPEN', 0, ['Click Plugins'], 1]]);
  const plain = parseTalkTrack('Beat 1: Start\nSay: Hello.\nDo: Click Plugins.\nSay: Bye.\n', 'x.txt');
  assert.deepEqual(plain.beats[0].lines.map(l => [l.say, l.do]), [['Hello.', ['Click Plugins.']], ['Bye.', []]]);
});

test('a capture read without a browser: controls as the outline names them, words as the screen shows them', () => {
  const sc = readScreen([{ key: 'main', html: '<html><head><style>b{}</style></head><body><header><h1>Catalog</h1></header><h1>Tools</h1><div role="tab">Users<span>Users</span></div><button aria-label="Save: Save skill"><span>Save</span></button><span aria-hidden="true">Certified</span><button style="display:none">Hidden</button><a href="/x">Agents&#x200e;</a><div role="textbox" contenteditable="true" aria-label="Message"></div></body></html>' }, { key: 'f4', html: '<button data-testid="badge">Add endorsement</button>' }]);
  assert.deepEqual(sc.controls.map(c => [c.role, c.name, c.frame || null]), [['tab', 'Users', null], ['button', 'Save: Save skill', null], ['link', 'Agents', null], ['textbox', 'Message', null], ['button', 'Add endorsement', 'f4']]);
  assert.equal(sc.controls[3].multiline, true);
  assert.match(sc.text, /Certified/);
  assert.doesNotMatch(sc.text, /Hidden/);
  // The page's own title before the app bar's.
  assert.deepEqual(sc.headings, ['Tools', 'Catalog']);
});

test('focus.mjs points keep their order within a beat; focus.json points go in by beat and screen', () => {
  const flow = { states: { a: { app: 'x' }, b: { app: 'x' }, c: { app: 'y' } }, beats: [{ active: 'x', states: { x: 'a' } }, { active: 'x', states: { x: 'b' } }], path: [{ checkpoint: 'a' }, { checkpoint: 'b' }, { checkpoint: 'c' }] };
  // Beat 1 goes b, then c, then back to b: the hand order stays, though b comes before c in the run-through.
  const hand = [{ id: 'b1', beat: 1, states: ['b'] }, { id: 'c1', beat: 1, states: ['c'] }, { id: 'b2', beat: 1, states: ['b'] }, { id: 'a0', beat: 0, states: ['a'] }];
  assert.deepEqual(mergeFocus([], hand, flow).map(p => p.id), ['a0', 'b1', 'c1', 'b2']);
  const json = [{ id: 'jc', beat: 1, states: ['c'] }, { id: 'jb', beat: 1, states: ['b'] }, { id: 'j2', beat: 2, states: ['a'] }];
  assert.deepEqual(mergeFocus(json, hand, flow).map(p => p.id), ['a0', 'jb', 'b1', 'jc', 'c1', 'b2', 'j2']);
});
